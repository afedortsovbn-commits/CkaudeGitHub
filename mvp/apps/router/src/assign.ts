import { CONVERSATION_EVENTS, newId } from '@cc/contracts';
import { appendMessage, emitConversation, loadRef } from '@cc/domain';
import type { Logger } from '@cc/service-kit';
import type { Pool } from 'pg';
import { declinedUserIds, eligibleCandidates, VOICE_BUSY } from './candidates';
import { one, withTx } from './db';
import { pickCandidate } from './strategies';

export interface AssignConfig {
  /** Фолбэк, если настройка `operator.max_chats` не задана. */
  maxChatsFallback: number;
  batchSize: number;
}

/** Читается на каждом тике, а не один раз при старте — настройка применяется без перезапуска (M-ADM-04). */
async function currentMaxChats(pool: Pool, fallback: number): Promise<number> {
  const r = await one<{ value: number }>(
    pool,
    `SELECT value FROM system_setting WHERE key = 'operator.max_chats'`,
  );
  return Number(r?.value ?? fallback);
}

export interface OfferCreated {
  conversationId: string;
  offerId: string;
  userId: string;
  offerTimeoutS: number;
}

interface QueuedConv {
  id: string;
  channel_kind: string;
  topic_path: string[];
  queue_id: string;
}
interface QueueRow {
  id: string;
  is_active: boolean;
  strategy: string;
  offer_timeout_s: number;
}

/**
 * Пытается назначить одно обращение: блокирует его строку (SKIP LOCKED — конкурентная безопасность
 * нескольких экземпляров router, 02-архитектура 6.2), подбирает оператора по стратегии очереди,
 * переводит обращение в статус «offered» и заводит запись предложения. Ничего не делает, если
 * обращение уже забрал другой экземпляр/тик, очередь неактивна или свободных операторов нет.
 */
async function assignOne(pool: Pool, conversationId: string, maxChats: number): Promise<OfferCreated | null> {
  return withTx(pool, async (tx) => {
    const conv = await one<QueuedConv>(
      tx,
      `SELECT id, channel_kind, topic_path, queue_id FROM conversation
        WHERE id = $1 AND status = 'queued' FOR UPDATE SKIP LOCKED`,
      [conversationId],
    );
    if (!conv || !conv.queue_id) return null;
    const queue = await one<QueueRow>(
      tx,
      `SELECT id, is_active, strategy, offer_timeout_s FROM queue WHERE id = $1`,
      [conv.queue_id],
    );
    if (!queue?.is_active) return null;
    const excluded = await declinedUserIds(tx, conv.id);
    const candidates = await eligibleCandidates(tx, {
      queueId: queue.id,
      topicPath: conv.topic_path ?? [],
      maxChats,
      excludeUserIds: excluded,
      voice: conv.channel_kind === 'voice',
    });
    const picked = pickCandidate(queue.strategy, candidates);
    if (!picked) return null;

    // Ёмкость в eligibleCandidates — снимок без блокировки: два конкурентных тика могли выбрать
    // одного и того же оператора одновременно, оба увидев ещё свободную ёмкость. Блокируем строку
    // статуса оператора и пересчитываем занятость под блокировкой — так конкурентная безопасность
    // (02-архитектура 6.2) распространяется и на лимит одновременных чатов, а не только на обращение.
    const locked = await tx.query(`SELECT 1 FROM agent_status WHERE user_id = $1 FOR UPDATE`, [
      picked.userId,
    ]);
    if (!locked.rowCount) return null;
    if (conv.channel_kind === 'voice') {
      const busy = await one<{ busy: boolean }>(
        tx,
        `SELECT ${VOICE_BUSY} AS busy FROM (SELECT $1::uuid AS user_id) u`,
        [picked.userId],
      );
      if (busy?.busy) return null;
    } else {
      const stillFree = await one<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM conversation WHERE assignee_id = $1
           AND status IN ('active', 'hold', 'offered') AND channel_kind <> 'voice'`,
        [picked.userId],
      );
      if ((stillFree?.n ?? 0) >= maxChats) return null;
    }

    const offerId = newId();
    await tx.query(
      `UPDATE conversation SET status = 'offered', assignee_id = $2, offered_at = now(),
         version = version + 1, updated_at = now() WHERE id = $1`,
      [conv.id, picked.userId],
    );
    await tx.query(
      `INSERT INTO routing_offer (id, conversation_id, user_id, queue_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)`,
      [offerId, conv.id, picked.userId, queue.id, queue.offer_timeout_s],
    );
    await tx.query(
      `UPDATE agent_status SET last_assigned_at = now(), updated_at = now() WHERE user_id = $1`,
      [picked.userId],
    );
    await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, conv.id), {
      action: 'offered',
      offerId,
    });
    return { conversationId: conv.id, offerId, userId: picked.userId, offerTimeoutS: queue.offer_timeout_s };
  });
}

/** Один проход распределения: перебирает ожидающие обращения по приоритету и пытается их назначить. */
export async function assignQueued(
  pool: Pool,
  cfg: AssignConfig,
  onOffer: (o: OfferCreated) => Promise<void>,
  logger?: Logger,
): Promise<number> {
  const waiting = await one<{ ids: string[] }>(
    pool,
    `SELECT coalesce(array_agg(id), '{}') AS ids FROM (
       SELECT id FROM conversation WHERE status = 'queued' ORDER BY priority DESC, queued_at ASC LIMIT $1
     ) x`,
    [cfg.batchSize],
  );
  const maxChats = await currentMaxChats(pool, cfg.maxChatsFallback);
  let assigned = 0;
  for (const id of waiting?.ids ?? []) {
    try {
      const offer = await assignOne(pool, id, maxChats);
      if (offer) {
        assigned++;
        await onOffer(offer);
      }
    } catch (err) {
      logger?.error({ err: String(err), conversationId: id }, 'ошибка назначения обращения оператору');
    }
  }
  return assigned;
}

/** Таймаут принятия оператором (M-RT-05, pg-boss): вызывается pg-boss после `offer_timeout_s`. */
export async function handleOfferTimeout(
  pool: Pool,
  data: { conversationId: string; offerId: string },
): Promise<void> {
  await withTx(pool, async (tx) => {
    const offer = await one<{ id: string; user_id: string }>(
      tx,
      `SELECT id, user_id FROM routing_offer WHERE id = $1 AND outcome IS NULL FOR UPDATE`,
      [data.offerId],
    );
    if (!offer) return; // уже принято/отклонено/просрочено
    const conv = await one<{ id: string; channel_kind: string }>(
      tx,
      `SELECT id, channel_kind FROM conversation WHERE id = $1 AND status = 'offered' AND assignee_id = $2 FOR UPDATE`,
      [data.conversationId, offer.user_id],
    );
    if (!conv) {
      await tx.query(`UPDATE routing_offer SET outcome = 'superseded', decided_at = now() WHERE id = $1`, [
        offer.id,
      ]);
      return;
    }
    await tx.query(`UPDATE routing_offer SET outcome = 'timeout', decided_at = now() WHERE id = $1`, [
      offer.id,
    ]);
    await tx.query(
      `UPDATE conversation SET status = 'queued', assignee_id = NULL, offered_at = NULL,
         version = version + 1, updated_at = now() WHERE id = $1`,
      [conv.id],
    );
    await appendMessage(tx, {
      conversationId: conv.id,
      direction: 'note', // служебное уведомление ACD — клиенту не показывается
      body: 'Оператор не принял предложенное обращение вовремя — оно возвращено в очередь',
      channelKind: conv.channel_kind,
    });
    await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, conv.id), {
      action: 'offer_timeout',
      userId: offer.user_id,
    });
  });
}
