import { CONVERSATION_EVENTS, newId } from '@cc/contracts';
import type { Pool, PoolClient } from 'pg';
import { callEvent, emitCallState } from './calls';
import { appendMessage, emitConversation, loadRef } from './conversations';

/**
 * Голосовой вызов в сценарии IVR (Ф6, M-IVR-*, M-TEL-07/08/09): переходы между сценарием и очередью,
 * оценка, обращение-задача «перезвонить». Общая логика call-control и интеграционных тестов.
 */

export interface PublishedFlow {
  flowId: string;
  flowName: string;
  versionId: string;
  version: number;
  graph: unknown;
}

/** Опубликованный голосовой сценарий, назначенный на номер (M-IVR-07). */
export async function publishedFlowForDid(tx: PoolClient, did: string): Promise<PublishedFlow | null> {
  const { rows } = await tx.query<{
    flow_id: string;
    name: string;
    version_id: string;
    version: number;
    graph: unknown;
  }>(
    `SELECT f.id AS flow_id, f.name, v.id AS version_id, v.version, v.graph
       FROM flow f JOIN flow_version v ON v.id = f.published_version_id
      WHERE f.is_active AND f.kind = 'voice' AND $1 = ANY (f.dids)
      ORDER BY f.created_at LIMIT 1`,
    [did],
  );
  const r = rows[0];
  return r
    ? { flowId: r.flow_id, flowName: r.name, versionId: r.version_id, version: r.version, graph: r.graph }
    : null;
}

/** Операторы очереди на смене (готов или в постобработке) — для выхода «нет операторов». */
export async function agentsOnShift(tx: Pool | PoolClient, queueId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_queue uq JOIN app_user u ON u.id = uq.user_id
       JOIN agent_status ag ON ag.user_id = u.id
      WHERE uq.queue_id = $1 AND u.is_active AND u.can_login AND ag.status IN ('ready', 'wrap_up')`,
    [queueId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Ёмкость голоса — один вызов (02-архитектура, Ф3 «голос 1, чаты N»): оператор занят, пока у него идёт или
 * звонит вызов, либо ему уже предложено голосовое обращение. Чаты голос не блокируют и наоборот.
 * Предложенная задача «перезвонить» из IVR (Ф6, без живого вызова) голос не занимает — иначе оператор, не
 * успевший её принять, не получал бы входящие звонки. Условие — над столбцом user_id внешнего запроса.
 */
export const VOICE_BUSY = `(EXISTS (SELECT 1 FROM call cl WHERE cl.agent_user_id = user_id AND cl.state IN ('dialing', 'talking'))
  OR EXISTS (SELECT 1 FROM conversation cv WHERE cv.assignee_id = user_id AND cv.status = 'offered' AND cv.channel_kind = 'voice'
               AND NOT cv.callback_requested))`;

/** Лимит одновременных чатов оператора (настройка «operator.max_chats»; без неё — 5, как у router). */
const MAX_CHATS_SQL = `COALESCE((SELECT (value #>> '{}')::int FROM system_setting WHERE key = 'operator.max_chats'), 5)`;

/**
 * Свободные операторы очереди прямо сейчас («все операторы заняты», п.4 требований заказчика): статус «Готов» и
 * не заняты — для голоса нет идущего или звонящего вызова, для чата не исчерпан лимит одновременных чатов.
 * В отличие от agentsOnShift, занятый разговором оператор здесь не считается.
 */
export async function freeAgents(
  tx: Pool | PoolClient,
  queueId: string,
  channel: 'voice' | 'chat',
): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `WITH cand AS (
       SELECT u.id AS user_id,
         (SELECT count(*)::int FROM conversation c2 WHERE c2.assignee_id = u.id
            AND c2.status IN ('active', 'hold', 'offered') AND c2.channel_kind <> 'voice') AS active_count
       FROM app_user u
       JOIN user_queue uq ON uq.user_id = u.id AND uq.queue_id = $1
       JOIN agent_status ag ON ag.user_id = u.id
       WHERE u.is_active AND u.can_login AND ag.status = 'ready'
     )
     SELECT count(*)::int AS n FROM cand
      WHERE ${channel === 'voice' ? `NOT ${VOICE_BUSY}` : `active_count < ${MAX_CHATS_SQL}`}`,
    [queueId],
  );
  return rows[0]?.n ?? 0;
}

async function queueInfo(tx: PoolClient, queueId: string) {
  const { rows } = await tx.query<{ name: string; priority: number }>(
    `SELECT name, priority FROM queue WHERE id = $1`,
    [queueId],
  );
  return rows[0];
}

/**
 * Узел «Поставить в очередь»: обращение встаёт в очередь с темой (навык — через тему, M-RT-02) и
 * приоритетом (очередь + надбавка узла + сегмент клиента), вызов ждёт оператора с музыкой.
 */
export async function enqueueFromIvr(
  tx: PoolClient,
  callId: string,
  o: { queueId: string; topicId: string | null; priority: number },
): Promise<boolean> {
  const { rows } = await tx.query<{ conversation_id: string; state: string }>(
    `SELECT conversation_id, state FROM call WHERE id = $1 FOR UPDATE`,
    [callId],
  );
  const c = rows[0];
  if (!c || c.state !== 'ivr') return false;
  const q = await queueInfo(tx, o.queueId);
  if (!q) return false;
  const conv = await tx.query<{ contact_id: string }>(
    `SELECT contact_id FROM conversation WHERE id = $1 FOR UPDATE`,
    [c.conversation_id],
  );
  const seg = await tx.query<{ boost: number }>(
    `SELECT sp.boost FROM contact ct JOIN segment_priority sp ON sp.segment = ct.segment AND sp.is_active WHERE ct.id = $1`,
    [conv.rows[0]?.contact_id],
  );
  const topic = o.topicId
    ? (
        await tx.query<{ path: string[]; is_important: boolean; name: string }>(
          `SELECT path, is_important, name FROM topic WHERE id = $1 AND is_active`,
          [o.topicId],
        )
      ).rows[0]
    : undefined;
  const priority = q.priority + o.priority + (seg.rows[0]?.boost ?? 0);
  await tx.query(
    `UPDATE conversation SET status = 'queued', queue_id = $2, assignee_id = NULL, priority = $3, escalated = false,
       queued_at = now(), offered_at = NULL,
       topic_id = COALESCE($4, topic_id), topic_path = COALESCE($5, topic_path),
       is_important = is_important OR $6, version = version + 1, updated_at = now()
     WHERE id = $1`,
    [
      c.conversation_id,
      o.queueId,
      priority,
      topic ? o.topicId : null,
      topic?.path ?? null,
      !!topic?.is_important,
    ],
  );
  await tx.query(
    `UPDATE call SET state = 'queued', agent_channel = NULL, on_hold = false, version = version + 1, updated_at = now()
      WHERE id = $1`,
    [callId],
  );
  await callEvent(tx, callId, 'queued', null, {
    queueId: o.queueId,
    topicId: topic ? o.topicId : null,
    from: 'ivr',
  });
  await appendMessage(tx, {
    conversationId: c.conversation_id,
    direction: 'system',
    body: `IVR: звонок в очереди «${q.name}»${topic ? `, тема «${topic.name}»` : ''}`,
    channelKind: 'voice',
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
    action: 'queued',
  });
  await emitCallState(tx, callId);
  return true;
}

/**
 * Вызов уходит из очереди обратно в сценарий (долгое ожидание, нет операторов). false — обращение уже
 * предложено оператору (звонок ему идёт) — тогда вызов остаётся в очереди.
 */
export async function leaveQueueToIvr(
  tx: PoolClient,
  callId: string,
  reason: 'timeout' | 'noAgents',
): Promise<boolean> {
  const { rows } = await tx.query<{ conversation_id: string; state: string }>(
    `SELECT conversation_id, state FROM call WHERE id = $1 FOR UPDATE`,
    [callId],
  );
  const c = rows[0];
  if (!c || c.state !== 'queued') return false;
  const u = await tx.query(
    `UPDATE conversation SET status = 'bot', assignee_id = NULL, offered_at = NULL, version = version + 1, updated_at = now()
      WHERE id = $1 AND status = 'queued' RETURNING id`,
    [c.conversation_id],
  );
  if (!u.rowCount) return false;
  await tx.query(`UPDATE call SET state = 'ivr', version = version + 1, updated_at = now() WHERE id = $1`, [
    callId,
  ]);
  await callEvent(tx, callId, 'queue_left', null, { reason });
  await appendMessage(tx, {
    conversationId: c.conversation_id,
    direction: 'system',
    body:
      reason === 'timeout'
        ? 'IVR: долгое ожидание — звонок ушёл из очереди по сценарию'
        : 'IVR: нет операторов на смене — звонок ушёл из очереди по сценарию',
    channelKind: 'voice',
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
    action: 'dequeued',
  });
  await emitCallState(tx, callId);
  return true;
}

/**
 * Оператор завершил разговор, а у сценария есть продолжение «после разговора» (автосообщение, CSAT —
 * M-TEL-09): клиент возвращается в сценарий, обращение остаётся у оператора до закрытия.
 */
export async function agentDoneToIvr(tx: PoolClient, callId: string): Promise<boolean> {
  const { rows } = await tx.query<{ conversation_id: string; state: string }>(
    `SELECT conversation_id, state FROM call WHERE id = $1 FOR UPDATE`,
    [callId],
  );
  const c = rows[0];
  if (!c || c.state !== 'talking') return false;
  await tx.query(
    `UPDATE call SET state = 'ivr', agent_channel = NULL, bridge_id = NULL, on_hold = false,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [callId],
  );
  await callEvent(tx, callId, 'agent_done');
  await appendMessage(tx, {
    conversationId: c.conversation_id,
    direction: 'system',
    body: 'Оператор завершил разговор, клиент продолжает в IVR',
    channelKind: 'voice',
  });
  await emitCallState(tx, callId);
  return true;
}

/** Оценка обслуживания 1–5 (M-TEL-09) — привязывается к обращению и оператору разговора. */
export async function saveCsat(tx: PoolClient, callId: string, score: number): Promise<boolean> {
  const { rows } = await tx.query<{ conversation_id: string; agent_user_id: string | null }>(
    `SELECT conversation_id, agent_user_id FROM call WHERE id = $1`,
    [callId],
  );
  const c = rows[0];
  if (!c) return false;
  const ins = await tx.query(
    `INSERT INTO csat_rating (id, conversation_id, call_id, channel_kind, agent_user_id, score)
     VALUES ($1, $2, $3, 'voice', $4, $5) ON CONFLICT (call_id) WHERE call_id IS NOT NULL DO NOTHING`,
    [newId(), c.conversation_id, callId, c.agent_user_id, score],
  );
  if (!ins.rowCount) return false;
  await callEvent(tx, callId, 'csat', null, { score });
  await appendMessage(tx, {
    conversationId: c.conversation_id,
    direction: 'system',
    body: `Оценка клиента: ${score} из 5`,
    channelKind: 'voice',
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
    action: 'csat',
    score,
    agentUserId: c.agent_user_id,
  });
  return true;
}

/**
 * Голосовое сообщение / заказ обратного звонка (M-TEL-08): обращение становится задачей «перезвонить» в
 * указанной очереди — router предлагает её оператору, оператор звонит клиенту из карточки.
 */
export async function createCallbackTask(
  tx: PoolClient,
  callId: string,
  o: { queueId: string; mode: 'voicemail' | 'callback'; withRecording: boolean },
): Promise<boolean> {
  const { rows } = await tx.query<{ conversation_id: string; from_number: string | null }>(
    `SELECT conversation_id, from_number FROM call WHERE id = $1`,
    [callId],
  );
  const c = rows[0];
  if (!c) return false;
  const q = await queueInfo(tx, o.queueId);
  const conv = await tx.query<{ status: string; callback_requested: boolean }>(
    `SELECT status, callback_requested FROM conversation WHERE id = $1 FOR UPDATE`,
    [c.conversation_id],
  );
  if (!q || !conv.rows[0] || conv.rows[0].callback_requested) return false;
  const reassign = conv.rows[0].status === 'bot';
  await tx.query(
    `UPDATE conversation SET callback_requested = true,
       status = CASE WHEN $4 THEN 'queued' ELSE status END,
       queue_id = CASE WHEN $4 THEN $2 ELSE queue_id END,
       priority = CASE WHEN $4 THEN $3 ELSE priority END,
       queued_at = CASE WHEN $4 THEN now() ELSE queued_at END,
       escalated = false, version = version + 1, updated_at = now()
     WHERE id = $1`,
    [c.conversation_id, o.queueId, q.priority, reassign],
  );
  await callEvent(tx, callId, o.mode === 'voicemail' ? 'voicemail' : 'callback_requested', null, {
    queueId: o.queueId,
  });
  const number = c.from_number ? `по номеру ${c.from_number}` : '(номер скрыт — перезвонить невозможно)';
  await appendMessage(tx, {
    conversationId: c.conversation_id,
    direction: 'system',
    body:
      o.mode === 'voicemail' && o.withRecording
        ? `Клиент оставил голосовое сообщение (вкладка «Звонки») — перезвоните ${number}`
        : `Клиент заказал обратный звонок — перезвоните ${number}`,
    channelKind: 'voice',
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
    action: 'queued',
    callback: true,
  });
  return true;
}
