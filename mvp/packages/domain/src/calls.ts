import {
  type CallState,
  type CallStateEvent,
  CONVERSATION_EVENTS,
  newId,
  normalizePhone,
  VoiceChannelConfigSchema,
} from '@cc/contracts';
import type { PoolClient } from 'pg';
import { appendMessage, emitConversation, loadRef, resolveRouting } from './conversations';

/**
 * Голосовые вызовы (Ф5, M-CH-02, M-TEL-*): общая логика call-control и api. Вызов живёт в таблице `call`
 * рядом с обращением голосового канала; очередь, предложение оператору и принятие — те же, что у текста
 * (router, routing_offer), поэтому голос и чаты распределяются единообразно.
 */

interface CallRow {
  id: string;
  conversation_id: string;
  direction: 'in' | 'out';
  state: CallState;
  on_hold: boolean;
  agent_user_id: string | null;
  end_reason: string | null;
}

/** Клиент по номеру телефона (идентификатор `phone`), при необходимости — новый (M-CARD-01). */
export async function contactByPhone(
  tx: PoolClient,
  phone: string,
  displayName?: string | null,
): Promise<string> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`phone:${phone}`]);
  const found = await tx.query<{ contact_id: string }>(
    `SELECT contact_id FROM contact_identity WHERE kind = 'phone' AND value = $1`,
    [phone],
  );
  if (found.rows[0]) return found.rows[0].contact_id;
  const contactId = newId();
  await tx.query('INSERT INTO contact (id, display_name, phone) VALUES ($1, $2, $3)', [
    contactId,
    displayName ?? null,
    phone,
  ]);
  await tx.query(
    `INSERT INTO contact_identity (id, contact_id, kind, value) VALUES ($1, $2, 'phone', $3) ON CONFLICT (kind, value) DO NOTHING`,
    [newId(), contactId, phone],
  );
  return contactId;
}

/** Голосовой канал по набранному номеру (DID); если номер не настроен — первый активный голосовой канал. */
export async function voiceChannelByDid(
  tx: PoolClient,
  did: string,
): Promise<{ id: string; record: boolean } | null> {
  const { rows } = await tx.query<{ id: string; config: Record<string, unknown>; exact: boolean }>(
    `SELECT id, config, (config -> 'dids') ? $1 AS exact FROM channel
      WHERE kind = 'voice' AND is_active ORDER BY (config -> 'dids') ? $1 DESC, created_at LIMIT 1`,
    [did],
  );
  const r = rows[0];
  if (!r) return null;
  const cfg = VoiceChannelConfigSchema.safeParse(r.config);
  return { id: r.id, record: cfg.success ? cfg.data.record : true };
}

export async function callEvent(
  tx: PoolClient,
  callId: string,
  type: string,
  userId: string | null = null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(`INSERT INTO call_event (id, call_id, type, user_id, data) VALUES ($1, $2, $3, $4, $5)`, [
    newId(),
    callId,
    type,
    userId,
    JSON.stringify(data),
  ]);
}

/** Событие `conversation.call` — рабочее место и панель супервизора обновляют состояние звонка. */
export async function emitCallState(tx: PoolClient, callId: string): Promise<void> {
  const { rows } = await tx.query<CallRow>(`SELECT * FROM call WHERE id = $1`, [callId]);
  const c = rows[0];
  if (!c) return;
  const data: CallStateEvent = {
    callId: c.id,
    state: c.state,
    direction: c.direction,
    onHold: c.on_hold,
    agentUserId: c.agent_user_id,
    endReason: c.end_reason,
  };
  await emitConversation(tx, CONVERSATION_EVENTS.call, await loadRef(tx, c.conversation_id), { ...data });
}

export interface InboundCallInput {
  callId?: string;
  node: string;
  clientChannel: string;
  callerNumber: string | null;
  callerName?: string | null;
  did: string;
}

/**
 * Входящий вызов (02-архитектура 4.2): клиент по АОН, новое обращение голосового канала в очереди канала
 * (правила маршрутизации проверяются по набранному номеру), запись вызова в состоянии «ожидает».
 */
export async function startInboundCall(
  tx: PoolClient,
  input: InboundCallInput,
): Promise<{ callId: string; conversationId: string; record: boolean } | null> {
  const channel = await voiceChannelByDid(tx, input.did);
  if (!channel) return null;
  const phone = input.callerNumber ? normalizePhone(input.callerNumber) : null;
  const contactId = phone
    ? await contactByPhone(tx, phone, input.callerName)
    : await anonymousContact(tx, input.callerName);
  const routing = await resolveRouting(tx, contactId, channel.id, 'voice', input.did);
  const conversationId = newId();
  await tx.query(
    `INSERT INTO conversation (id, channel_id, channel_kind, contact_id, status, queue_id, priority, is_urgent, queued_at)
     VALUES ($1, $2, 'voice', $3, 'queued', $4, $5, $6, now())`,
    [conversationId, channel.id, contactId, routing.queueId, routing.priority, routing.isUrgent],
  );
  const callId = input.callId ?? newId();
  await tx.query(
    `INSERT INTO call (id, conversation_id, direction, node, state, from_number, to_number, did, client_channel)
     VALUES ($1, $2, 'in', $3, 'queued', $4, $5, $5, $6)`,
    [callId, conversationId, input.node, phone ?? input.callerNumber, input.did, input.clientChannel],
  );
  await callEvent(tx, callId, 'queued', null, { did: input.did, queueId: routing.queueId });
  await emitConversation(tx, CONVERSATION_EVENTS.created, await loadRef(tx, conversationId));
  await appendMessage(tx, {
    conversationId,
    direction: 'system',
    body: `Входящий звонок${phone ? ` с номера ${phone}` : ''} на ${input.did}`,
    channelKind: 'voice',
  });
  await emitCallState(tx, callId);
  return { callId, conversationId, record: channel.record };
}

async function anonymousContact(tx: PoolClient, name?: string | null): Promise<string> {
  const id = newId();
  await tx.query('INSERT INTO contact (id, display_name) VALUES ($1, $2)', [id, name || 'Скрытый номер']);
  return id;
}

/**
 * Исходящий вызов оператора (M-TEL-06): к обращению из карточки (если оператор ведёт его) или к новому
 * обращению голосового канала с клиентом по номеру.
 */
export async function startOutboundCall(
  tx: PoolClient,
  input: {
    callId?: string;
    node: string;
    agentChannel: string;
    /** Канал абонента (id задаётся заранее при вызове через транк). */
    peerChannel: string;
    userId: string;
    number: string;
    conversationId?: string | null;
  },
): Promise<{ callId: string; conversationId: string; record: boolean } | { error: string }> {
  const phone = normalizePhone(input.number);
  if (!phone) return { error: 'Некорректный номер' };
  let conversationId: string | null = null;
  if (input.conversationId) {
    const own = await tx.query<{ id: string }>(
      `SELECT id FROM conversation WHERE id = $1 AND assignee_id = $2 AND status <> 'closed' FOR UPDATE`,
      [input.conversationId, input.userId],
    );
    conversationId = own.rows[0]?.id ?? null;
  }
  const channel = await voiceChannelByDid(tx, '');
  if (!channel) return { error: 'Голосовой канал не настроен' };
  if (!conversationId) {
    const contactId = await contactByPhone(tx, phone);
    conversationId = newId();
    await tx.query(
      `INSERT INTO conversation (id, channel_id, channel_kind, contact_id, status, assignee_id, assigned_at, queue_id)
       VALUES ($1, $2, 'voice', $3, 'active', $4, now(), (SELECT queue_id FROM channel WHERE id = $2))`,
      [conversationId, channel.id, contactId, input.userId],
    );
    await emitConversation(tx, CONVERSATION_EVENTS.created, await loadRef(tx, conversationId));
  }
  const callId = input.callId ?? newId();
  await tx.query(
    `INSERT INTO call (id, conversation_id, direction, node, state, to_number, client_channel, agent_channel, agent_user_id)
     VALUES ($1, $2, 'out', $3, 'dialing', $4, $5, $6, $7)`,
    [callId, conversationId, input.node, phone, input.peerChannel, input.agentChannel, input.userId],
  );
  await callEvent(tx, callId, 'dialing_out', input.userId, { number: phone });
  await appendMessage(tx, {
    conversationId,
    direction: 'system',
    body: `Исходящий звонок на номер ${phone}`,
    channelKind: 'voice',
    authorUserId: input.userId,
  });
  await emitCallState(tx, callId);
  return { callId, conversationId, record: channel.record };
}

/** Оператор ответил на звонок: предложение принято, обращение «в работе», вызов — разговор. */
export async function connectAgent(
  tx: PoolClient,
  callId: string,
  opts: { bridgeId: string; userName: string; message?: string },
): Promise<void> {
  const { rows } = await tx.query<CallRow>(`SELECT * FROM call WHERE id = $1 FOR UPDATE`, [callId]);
  const c = rows[0];
  if (!c || !c.agent_user_id) return;
  await tx.query(
    `UPDATE call SET state = 'talking', bridge_id = $2, connected_at = COALESCE(connected_at, now()),
       version = version + 1, updated_at = now() WHERE id = $1`,
    [callId, opts.bridgeId],
  );
  const conv = await tx.query<{ status: string; assignee_id: string | null }>(
    `SELECT status, assignee_id FROM conversation WHERE id = $1 FOR UPDATE`,
    [c.conversation_id],
  );
  if (conv.rows[0]?.status === 'offered') {
    await tx.query(
      `UPDATE conversation SET status = 'active', assignee_id = $2, assigned_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
      [c.conversation_id, c.agent_user_id],
    );
    await tx.query(
      `UPDATE routing_offer SET outcome = 'accepted', decided_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND outcome IS NULL`,
      [c.conversation_id, c.agent_user_id],
    );
    await tx.query(
      `UPDATE agent_status SET last_assigned_at = now(), updated_at = now() WHERE user_id = $1`,
      [c.agent_user_id],
    );
  }
  await callEvent(tx, callId, 'agent_connected', c.agent_user_id);
  await appendMessage(tx, {
    conversationId: c.conversation_id,
    direction: 'system',
    body: opts.message ?? `Оператор ${opts.userName} на связи`,
    channelKind: 'voice',
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
    action: 'accepted',
  });
  await emitCallState(tx, callId);
}

/**
 * Оператор не ответил / отклонил звонок / недоступен: вызов снова ждёт в очереди, предложение закрыто.
 * `declined` исключает оператора из повторных предложений этого обращения (как отказ в тексте).
 */
export async function agentLegFailed(
  tx: PoolClient,
  callId: string,
  outcome: 'declined' | 'timeout',
  note: string,
): Promise<void> {
  const { rows } = await tx.query<CallRow & { agent_channel: string | null }>(
    `SELECT * FROM call WHERE id = $1 FOR UPDATE`,
    [callId],
  );
  const c = rows[0];
  if (!c || c.state !== 'dialing' || c.direction !== 'in') return;
  await tx.query(
    `UPDATE call SET state = 'queued', agent_channel = NULL, agent_user_id = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
    [callId],
  );
  if (c.agent_user_id) {
    await tx.query(
      `UPDATE routing_offer SET outcome = $3, decided_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND outcome IS NULL`,
      [c.conversation_id, c.agent_user_id, outcome],
    );
    await tx.query(
      `UPDATE conversation SET status = 'queued', assignee_id = NULL, offered_at = NULL, version = version + 1, updated_at = now()
        WHERE id = $1 AND status = 'offered' AND assignee_id = $2`,
      [c.conversation_id, c.agent_user_id],
    );
  }
  await callEvent(tx, callId, outcome === 'declined' ? 'agent_declined' : 'agent_no_answer', c.agent_user_id);
  await appendMessage(tx, {
    conversationId: c.conversation_id,
    direction: 'note',
    body: note,
    channelKind: 'voice',
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
    action: outcome === 'declined' ? 'declined' : 'offer_timeout',
  });
  await emitCallState(tx, callId);
}

/**
 * Вызов завершён. Если клиент не дождался оператора — обращение закрывается как «пропущенный звонок»
 * (оператору в нём делать нечего); иначе обращение остаётся в работе у оператора до закрытия с темой.
 */
export async function endCall(tx: PoolClient, callId: string, reason: string): Promise<boolean> {
  const { rows } = await tx.query<CallRow>(`SELECT * FROM call WHERE id = $1 FOR UPDATE`, [callId]);
  const c = rows[0];
  if (!c || c.state === 'ended') return false;
  const neverConnected = c.state === 'queued' || (c.state === 'dialing' && c.direction === 'in');
  await tx.query(
    `UPDATE call SET state = 'ended', ended_at = now(), end_reason = $2, on_hold = false,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [callId, reason],
  );
  await callEvent(tx, callId, 'ended', null, { reason });
  const conv = await tx.query<{ status: string; assignee_id: string | null }>(
    `SELECT status, assignee_id FROM conversation WHERE id = $1 FOR UPDATE`,
    [c.conversation_id],
  );
  const cs = conv.rows[0];
  if (neverConnected && c.direction === 'in' && cs && ['queued', 'offered'].includes(cs.status)) {
    await tx.query(
      `UPDATE routing_offer SET outcome = 'superseded', decided_at = now() WHERE conversation_id = $1 AND outcome IS NULL`,
      [c.conversation_id],
    );
    await tx.query(
      `UPDATE conversation SET status = 'closed', assignee_id = NULL, closed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
      [c.conversation_id],
    );
    await appendMessage(tx, {
      conversationId: c.conversation_id,
      direction: 'system',
      body: 'Пропущенный звонок: клиент положил трубку, не дождавшись оператора',
      channelKind: 'voice',
    });
    await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
      action: 'closed',
      disposition: 'Пропущенный звонок',
    });
  } else {
    await appendMessage(tx, {
      conversationId: c.conversation_id,
      direction: 'system',
      body: reason === 'failed' ? 'Звонок не состоялся' : 'Звонок завершён',
      channelKind: 'voice',
    });
  }
  await emitCallState(tx, callId);
  return true;
}

/** Удержание (M-TEL-07): клиент слышит музыку, оператор остаётся в разговоре. */
export async function setCallHold(
  tx: PoolClient,
  callId: string,
  onHold: boolean,
  userId: string,
): Promise<void> {
  await tx.query(`UPDATE call SET on_hold = $2, version = version + 1, updated_at = now() WHERE id = $1`, [
    callId,
    onHold,
  ]);
  await callEvent(tx, callId, onHold ? 'hold' : 'unhold', userId);
  await emitCallState(tx, callId);
}

async function detachAgent(
  tx: PoolClient,
  callId: string,
): Promise<{ conversation_id: string; agent_user_id: string | null }> {
  const { rows } = await tx.query<{ conversation_id: string; agent_user_id: string | null }>(
    `SELECT conversation_id, agent_user_id FROM call WHERE id = $1 FOR UPDATE`,
    [callId],
  );
  await tx.query(
    `UPDATE call SET state = 'queued', agent_channel = NULL, agent_user_id = NULL, on_hold = false,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [callId],
  );
  return rows[0]!;
}

/** Слепой перевод в очередь (M-OP-05, M-TKT-11): новая постановка в очередь, отсчёт ожидания заново. */
export async function transferCallToQueue(
  tx: PoolClient,
  callId: string,
  o: { queueId: string; byUserId: string | null; message: string; data?: Record<string, unknown> },
): Promise<void> {
  const c = await detachAgent(tx, callId);
  const q = await tx.query<{ priority: number }>(`SELECT priority FROM queue WHERE id = $1`, [o.queueId]);
  await tx.query(
    `UPDATE conversation SET assignee_id = NULL, queue_id = $2, status = 'queued', priority = $3, escalated = false,
       queued_at = now(), offered_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
    [c.conversation_id, o.queueId, q.rows[0]?.priority ?? 0],
  );
  await callEvent(tx, callId, 'transfer_queue', o.byUserId, { queueId: o.queueId, ...o.data });
  await appendMessage(tx, {
    conversationId: c.conversation_id,
    direction: 'system',
    body: o.message,
    channelKind: 'voice',
    authorUserId: o.byUserId,
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
    action: 'transferred',
  });
  await emitCallState(tx, callId);
}

/** Слепой перевод оператору: звонок сразу предлагается ему (call-control вызывает его софтфон). */
export async function transferCallToUser(
  tx: PoolClient,
  callId: string,
  o: { toUserId: string; byUserId: string; message: string },
): Promise<void> {
  const c = await detachAgent(tx, callId);
  const conv = await tx.query<{ queue_id: string | null }>(
    `SELECT queue_id FROM conversation WHERE id = $1`,
    [c.conversation_id],
  );
  const timeout = await tx.query<{ offer_timeout_s: number }>(
    `SELECT offer_timeout_s FROM queue WHERE id = $1`,
    [conv.rows[0]?.queue_id],
  );
  await tx.query(
    `UPDATE conversation SET assignee_id = $2, status = 'offered', offered_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
    [c.conversation_id, o.toUserId],
  );
  await tx.query(
    `INSERT INTO routing_offer (id, conversation_id, user_id, queue_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)`,
    [
      newId(),
      c.conversation_id,
      o.toUserId,
      conv.rows[0]?.queue_id ?? null,
      timeout.rows[0]?.offer_timeout_s ?? 20,
    ],
  );
  await callEvent(tx, callId, 'transfer_user', o.byUserId, { toUserId: o.toUserId });
  await appendMessage(tx, {
    conversationId: c.conversation_id,
    direction: 'system',
    body: o.message,
    channelKind: 'voice',
    authorUserId: o.byUserId,
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
    action: 'transferred',
  });
  await emitCallState(tx, callId);
}

/**
 * Прямой перевод на внешний номер подразделения (M-TKT-11): оператор отключается, клиент ждёт с музыкой,
 * пока ответит подразделение. Обращение остаётся у оператора для классификации и закрытия.
 */
export async function transferCallExternal(
  tx: PoolClient,
  callId: string,
  o: { extChannel: string; number: string; byUserId: string; message: string; data: Record<string, unknown> },
): Promise<void> {
  const { rows } = await tx.query<{ conversation_id: string }>(
    // on_hold = true — клиент слушает музыку, пока подразделение не ответит.
    `UPDATE call SET state = 'external', agent_channel = $2, agent_user_id = NULL, on_hold = true,
       version = version + 1, updated_at = now() WHERE id = $1 RETURNING conversation_id`,
    [callId, o.extChannel],
  );
  const conversationId = rows[0]!.conversation_id;
  await callEvent(tx, callId, 'transfer_external', o.byUserId, { number: o.number, ...o.data });
  await appendMessage(tx, {
    conversationId,
    direction: 'system',
    body: o.message,
    channelKind: 'voice',
    authorUserId: o.byUserId,
  });
  await emitCallState(tx, callId);
}
