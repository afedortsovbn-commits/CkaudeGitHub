import { CONVERSATION_EVENTS } from '@cc/contracts';
import { appendMessage, emitConversation, loadRef, setAgentStatus } from '@cc/domain';
import type { Pool } from 'pg';
import { rows, withTx } from './db';

/**
 * Перелив в резервную группу по таймеру (M-RT-04): обращение ждёт в очереди дольше `overflow_after_s` —
 * переводится в `overflow_queue_id`. Состояние (когда встало в очередь) — в БД (`queued_at`), поэтому
 * проверка — обычный периодический опрос, а не таймер в памяти процесса (переживает перезапуск/замену).
 */
export async function sweepOverflow(pool: Pool): Promise<number> {
  const due = await rows<{ id: string; channel_kind: string; overflow_queue_id: string }>(
    pool,
    `SELECT c.id, c.channel_kind, q.overflow_queue_id FROM conversation c
       JOIN queue q ON q.id = c.queue_id
      WHERE c.status = 'queued' AND q.overflow_queue_id IS NOT NULL AND q.overflow_after_s IS NOT NULL
        AND q.overflow_queue_id <> q.id
        AND c.queued_at + (q.overflow_after_s || ' seconds')::interval <= now()`,
  );
  for (const c of due) {
    await withTx(pool, async (tx) => {
      const r = await tx.query(
        `UPDATE conversation SET queue_id = $2, version = version + 1, updated_at = now()
           WHERE id = $1 AND status = 'queued' AND queue_id <> $2`,
        [c.id, c.overflow_queue_id],
      );
      if (!r.rowCount) return; // уже назначено/переведено другим экземпляром
      await appendMessage(tx, {
        conversationId: c.id,
        direction: 'system',
        body: 'Превышено время ожидания в очереди — обращение переведено в резервную группу',
        channelKind: c.channel_kind,
      });
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.id), {
        action: 'overflowed',
      });
    });
  }
  return due.length;
}

/** Эскалация по времени ожидания (M-RT-04): надбавка приоритета один раз, когда истёк `max_wait_s`. */
export async function sweepEscalation(pool: Pool): Promise<number> {
  const boostRow = await rows<{ value: number }>(
    pool,
    `SELECT value FROM system_setting WHERE key = 'routing.escalation_boost'`,
  );
  const boost = Number(boostRow[0]?.value ?? 1000);
  const r = await pool.query(
    `UPDATE conversation c SET priority = c.priority + $1, escalated = true, version = c.version + 1, updated_at = now()
       FROM queue q
      WHERE c.status = 'queued' AND c.queue_id = q.id AND NOT c.escalated AND q.max_wait_s IS NOT NULL
        AND c.queued_at + (q.max_wait_s || ' seconds')::interval <= now()`,
    [boost],
  );
  return r.rowCount ?? 0;
}

/**
 * «Отложено / перезвонить» (M-CARD-05): наступил срок — закрытое обращение снова встаёт в очередь,
 * в которой было до закрытия. Дедлайн хранится в `conversation.callback_at` — обычный периодический опрос.
 */
export async function sweepCallbacks(pool: Pool): Promise<number> {
  const due = await rows<{ id: string; channel_kind: string; queue_id: string; priority: number }>(
    pool,
    `SELECT c.id, c.channel_kind, c.queue_id, q.priority FROM conversation c
       JOIN queue q ON q.id = c.queue_id
      WHERE c.status = 'closed' AND c.callback_at IS NOT NULL AND c.callback_at <= now() AND q.is_active`,
  );
  for (const c of due) {
    await withTx(pool, async (tx) => {
      const r = await tx.query(
        `UPDATE conversation SET status = 'queued', assignee_id = NULL, callback_at = NULL, priority = $2,
           escalated = false, queued_at = now(), offered_at = NULL, version = version + 1, updated_at = now()
         WHERE id = $1 AND status = 'closed' AND callback_at IS NOT NULL`,
        [c.id, c.priority],
      );
      if (!r.rowCount) return;
      await appendMessage(tx, {
        conversationId: c.id,
        direction: 'system',
        body: 'Наступило время отложенного перезвона/контакта — обращение снова в очереди',
        channelKind: c.channel_kind,
      });
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.id), {
        action: 'callback_due',
      });
    });
  }
  return due.length;
}

/** Постобработка (M-RT-06): по истечении `wrap_up_until` оператор автоматически становится «Готов». */
export async function sweepWrapUp(pool: Pool): Promise<number> {
  const due = await rows<{ user_id: string }>(
    pool,
    `SELECT user_id FROM agent_status WHERE status = 'wrap_up' AND wrap_up_until IS NOT NULL AND wrap_up_until <= now()`,
  );
  for (const a of due) {
    await withTx(pool, async (tx) => {
      const cur = await tx.query(
        `SELECT 1 FROM agent_status WHERE user_id = $1 AND status = 'wrap_up' AND wrap_up_until <= now() FOR UPDATE`,
        [a.user_id],
      );
      if (!cur.rowCount) return;
      await setAgentStatus(tx, a.user_id, 'ready');
    });
  }
  return due.length;
}
