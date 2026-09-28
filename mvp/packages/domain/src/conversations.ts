import {
  CONVERSATION_EVENTS,
  type ConversationRef,
  type InboundMessage,
  makeEvent,
  type MessageDto,
  newId,
} from '@cc/contracts';
import { enqueueEvent } from '@cc/service-kit';
import type { PoolClient } from 'pg';

interface ConvRow {
  id: string;
  contact_id: string;
  channel_kind: string;
  status: string;
  queue_id: string | null;
  assignee_id: string | null;
  enterprise_id: string | null;
  department_id: string | null;
  topic_path: string[];
  is_important: boolean;
}

export function refOf(c: ConvRow): ConversationRef {
  return {
    conversationId: c.id,
    contactId: c.contact_id,
    channelKind: c.channel_kind,
    status: c.status,
    queueId: c.queue_id,
    assigneeId: c.assignee_id,
    enterpriseId: c.enterprise_id,
    departmentId: c.department_id,
    topicPath: c.topic_path ?? [],
    isImportant: c.is_important,
  };
}

export async function loadRef(tx: PoolClient, conversationId: string): Promise<ConversationRef> {
  const { rows } = await tx.query<ConvRow>('SELECT * FROM conversation WHERE id = $1', [conversationId]);
  if (!rows[0]) throw new Error(`обращение ${conversationId} не найдено`);
  return refOf(rows[0]);
}

/** Публикует событие обращения через outbox (в той же транзакции). */
export async function emitConversation(
  tx: PoolClient,
  type: string,
  ref: ConversationRef,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await enqueueEvent(tx, makeEvent({ type, source: 'conversations', data: { ...ref, ...extra } }));
}

export interface AppendInput {
  conversationId: string;
  direction: MessageDto['direction'];
  body: string;
  attachments?: MessageDto['attachments'];
  authorUserId?: string | null;
  channelKind: string;
  externalId?: string | null;
  sentAt?: Date;
  id?: string;
}

/**
 * Добавляет сообщение: номер (seq) по обращению, время, событие conversation.message_created.
 * Возвращает null, если сообщение с таким externalId уже есть (повторная доставка).
 */
export async function appendMessage(tx: PoolClient, m: AppendInput): Promise<MessageDto | null> {
  if (m.externalId) {
    const dup = await tx.query('SELECT 1 FROM message WHERE channel_kind = $1 AND external_id = $2', [
      m.channelKind,
      m.externalId,
    ]);
    if (dup.rowCount) return null;
  }
  const { rows } = await tx.query<{ seq: string }>(
    `UPDATE conversation SET seq = seq + 1,
       last_message_at = CASE WHEN $2 IN ('in', 'out') THEN now() ELSE last_message_at END,
       first_response_at = CASE WHEN $2 = 'out' AND first_response_at IS NULL THEN now() ELSE first_response_at END,
       updated_at = now()
     WHERE id = $1 RETURNING seq`,
    [m.conversationId, m.direction],
  );
  if (!rows[0]) throw new Error('обращение не найдено');
  const id = m.id ?? newId();
  const sentAt = m.sentAt ?? new Date();
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO message (id, conversation_id, seq, direction, author_user_id, body, attachments, channel_kind, external_id, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (channel_kind, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,
    [
      id,
      m.conversationId,
      rows[0].seq,
      m.direction,
      m.authorUserId ?? null,
      m.body,
      JSON.stringify(m.attachments ?? []),
      m.channelKind,
      m.externalId ?? null,
      sentAt,
    ],
  );
  if (!ins.rowCount) return null;
  if (m.attachments?.length) {
    await tx.query(
      'UPDATE attachment SET conversation_id = $2 WHERE id = ANY($1) AND conversation_id IS NULL',
      [m.attachments.map((a) => a.id), m.conversationId],
    );
  }
  const msg: MessageDto = {
    id,
    conversationId: m.conversationId,
    seq: Number(rows[0].seq),
    direction: m.direction,
    authorUserId: m.authorUserId ?? null,
    body: m.body,
    attachments: m.attachments ?? [],
    sentAt: sentAt.toISOString(),
    externalId: m.externalId ?? null,
  };
  await emitConversation(tx, CONVERSATION_EVENTS.message, await loadRef(tx, m.conversationId), {
    message: msg,
  });
  return msg;
}

/**
 * Обработка входящего сообщения канала: клиент по идентификатору (или известный contactId),
 * открытое обращение клиента в этом канале (иначе новое в очереди канала), сообщение.
 * Параллельная обработка сообщений одного клиента сериализуется advisory lock по идентификатору.
 */
export async function ingestInbound(
  tx: PoolClient,
  m: InboundMessage,
): Promise<{ conversationId: string; created: boolean; duplicate: boolean }> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${m.identity.kind}:${m.identity.value}`]);
  const dup = await tx.query<{ conversation_id: string }>(
    'SELECT conversation_id FROM message WHERE channel_kind = $1 AND external_id = $2',
    [m.channelKind, m.externalId],
  );
  if (dup.rows[0]) return { conversationId: dup.rows[0].conversation_id, created: false, duplicate: true };

  let contactId = m.contactId;
  if (!contactId) {
    const ident = await tx.query<{ contact_id: string }>(
      'SELECT contact_id FROM contact_identity WHERE kind = $1 AND value = $2',
      [m.identity.kind, m.identity.value],
    );
    contactId = ident.rows[0]?.contact_id;
  }
  if (!contactId) {
    contactId = newId();
    await tx.query('INSERT INTO contact (id, display_name, phone, email) VALUES ($1, $2, $3, $4)', [
      contactId,
      m.contact?.displayName ?? null,
      m.contact?.phone ?? null,
      m.contact?.email ?? null,
    ]);
  }
  await tx.query(
    `INSERT INTO contact_identity (id, contact_id, kind, value) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, value) DO NOTHING`,
    [newId(), contactId, m.identity.kind, m.identity.value],
  );

  const open = await tx.query<{ id: string }>(
    `SELECT id FROM conversation WHERE contact_id = $1 AND channel_id = $2 AND status NOT IN ('closed', 'waiting_2nd_line')
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [contactId, m.channelId],
  );
  let conversationId = open.rows[0]?.id;
  let created = false;
  if (!conversationId) {
    conversationId = newId();
    created = true;
    await tx.query(
      `INSERT INTO conversation (id, channel_id, channel_kind, contact_id, status, queue_id)
       SELECT $1, c.id, c.kind, $2, 'queued', c.queue_id FROM channel c WHERE c.id = $3`,
      [conversationId, contactId, m.channelId],
    );
    await emitConversation(tx, CONVERSATION_EVENTS.created, await loadRef(tx, conversationId));
  }
  const msg = await appendMessage(tx, {
    conversationId,
    direction: 'in',
    body: m.body,
    attachments: m.attachments,
    channelKind: m.channelKind,
    externalId: m.externalId,
    sentAt: new Date(m.receivedAt),
    id: m.id,
  });
  return { conversationId, created, duplicate: msg === null };
}
