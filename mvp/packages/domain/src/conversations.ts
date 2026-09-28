import {
  CONNECTOR_CHANNELS,
  type ConnectorChannel,
  CONVERSATION_EVENTS,
  type ConversationRef,
  type DeliveryStatus,
  type EmailMeta,
  type InboundMessage,
  makeEvent,
  type MessageDto,
  newId,
  type OutboundMessage,
  outboundSubject,
} from '@cc/contracts';
import { enqueueCommand, enqueueEvent } from '@cc/service-kit';
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
  if (m.direction === 'out' && (CONNECTOR_CHANNELS as readonly string[]).includes(m.channelKind)) {
    msg.deliveryStatus = await queueOutbound(tx, msg, m.channelKind as ConnectorChannel);
  }
  await emitConversation(tx, CONVERSATION_EVENTS.message, await loadRef(tx, m.conversationId), {
    message: msg,
  });
  return msg;
}

interface Routing {
  queueId: string | null;
  priority: number;
  isUrgent: boolean;
}

/**
 * Куда поставить новое обращение и с каким эффективным приоритетом (M-RT-01/07/08):
 * правило маршрутизации текста (канал/ключевые слова/regex) переопределяет очередь по умолчанию канала;
 * приоритет = приоритет очереди + надбавка правила + приоритет сегмента клиента. Дальнейшая эскалация
 * по времени ожидания и перелив в резервную группу — задача router (Ф3).
 */
async function resolveRouting(
  tx: PoolClient,
  contactId: string,
  channelId: string,
  channelKind: string,
  body: string,
): Promise<Routing> {
  const rules = await tx.query<{
    queue_id: string;
    match_type: string;
    pattern: string;
    priority_boost: number;
    is_urgent: boolean;
  }>(
    `SELECT queue_id, match_type, pattern, priority_boost, is_urgent FROM routing_rule
      WHERE is_active AND (channel_kind IS NULL OR channel_kind = $1) ORDER BY sort_order`,
    [channelKind],
  );
  let rule: (typeof rules.rows)[number] | undefined;
  for (const r of rules.rows) {
    let matched = false;
    try {
      matched =
        r.match_type === 'regex'
          ? new RegExp(r.pattern, 'i').test(body)
          : body.toLowerCase().includes(r.pattern.toLowerCase());
    } catch {
      matched = false; // некорректное регулярное выражение — правило пропускается, а не роняет обработку
    }
    if (matched) {
      rule = r;
      break;
    }
  }
  let queueId: string | null = rule?.queue_id ?? null;
  if (!queueId) {
    const ch = await tx.query<{ queue_id: string | null }>('SELECT queue_id FROM channel WHERE id = $1', [
      channelId,
    ]);
    queueId = ch.rows[0]?.queue_id ?? null;
  }
  let priority = 0;
  if (queueId) {
    const q = await tx.query<{ priority: number }>('SELECT priority FROM queue WHERE id = $1', [queueId]);
    priority += q.rows[0]?.priority ?? 0;
  }
  priority += rule?.priority_boost ?? 0;
  const contact = await tx.query<{ segment: string | null }>('SELECT segment FROM contact WHERE id = $1', [
    contactId,
  ]);
  const segment = contact.rows[0]?.segment;
  if (segment) {
    const sp = await tx.query<{ boost: number }>(
      'SELECT boost FROM segment_priority WHERE segment = $1 AND is_active',
      [segment],
    );
    priority += sp.rows[0]?.boost ?? 0;
  }
  return { queueId, priority, isUrgent: rule?.is_urgent ?? false };
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

  const email = m.channelKind === 'email' ? (m.meta?.email as EmailMeta | undefined) : undefined;
  // Цепочка писем (M-CH-06): ответ на письмо обращения (In-Reply-To/References) попадает в это обращение,
  // пока оно не закрыто — даже если клиент пишет с другого адреса.
  let conversationId: string | undefined;
  if (email?.references.length) {
    const thread = await tx.query<{ id: string }>(
      `SELECT c.id FROM message msg JOIN conversation c ON c.id = msg.conversation_id
        WHERE msg.channel_kind = 'email' AND msg.external_id = ANY($1) AND c.channel_id = $2
          AND c.status NOT IN ('closed', 'waiting_2nd_line')
        ORDER BY msg.sent_at DESC LIMIT 1 FOR UPDATE OF c`,
      [email.references, m.channelId],
    );
    conversationId = thread.rows[0]?.id;
  }
  if (!conversationId) {
    const open = await tx.query<{ id: string }>(
      `SELECT id FROM conversation WHERE contact_id = $1 AND channel_id = $2 AND status NOT IN ('closed', 'waiting_2nd_line')
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [contactId, m.channelId],
    );
    conversationId = open.rows[0]?.id;
  }
  let created = false;
  if (!conversationId) {
    conversationId = newId();
    created = true;
    const routing = await resolveRouting(tx, contactId, m.channelId, m.channelKind, m.body);
    await tx.query(
      `INSERT INTO conversation (id, channel_id, channel_kind, contact_id, status, queue_id, priority, is_urgent, queued_at)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, now())`,
      [
        conversationId,
        m.channelId,
        m.channelKind,
        contactId,
        routing.queueId,
        routing.priority,
        routing.isUrgent,
      ],
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
  if (msg && email) {
    // Тема — от первого письма обращения; Message-ID и References — для ответа в ту же цепочку.
    await tx.query(
      `UPDATE conversation SET channel_meta = channel_meta
          || jsonb_build_object('subject', COALESCE(channel_meta ->> 'subject', $2::text))
          || jsonb_build_object('lastMessageId', $3::text)
          || jsonb_build_object('references', $4::jsonb)
        WHERE id = $1`,
      [
        conversationId,
        email.subject,
        email.messageId,
        JSON.stringify([...email.references, ...(email.messageId ? [email.messageId] : [])].slice(-20)),
      ],
    );
  }
  return { conversationId, created, duplicate: msg === null };
}

const REPLY_PREFIX = /^\s*(re|ответ|отв)\s*:/i;

/**
 * Ставит ответ оператора в исходящие коннектора (M-CH-08) той же транзакцией, что и само сообщение:
 * outbox → CC_OUTBOUND → коннектор канала → статус доставки. Возвращает начальный статус доставки.
 */
async function queueOutbound(
  tx: PoolClient,
  msg: MessageDto,
  kind: ConnectorChannel,
): Promise<'pending' | 'failed'> {
  const { rows } = await tx.query<{
    channel_id: string;
    contact_id: string;
    channel_meta: { subject?: string; lastMessageId?: string | null; references?: string[] };
  }>('SELECT channel_id, contact_id, channel_meta FROM conversation WHERE id = $1', [msg.conversationId]);
  const c = rows[0]!;
  const ident = await tx.query<{ value: string }>(
    `SELECT value FROM contact_identity WHERE contact_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1`,
    [c.contact_id, kind],
  );
  if (!ident.rows[0]) {
    await tx.query(
      `UPDATE message SET delivery_status = 'failed', delivery_error = 'У клиента нет адреса в этом канале' WHERE id = $1`,
      [msg.id],
    );
    return 'failed';
  }
  const meta = c.channel_meta ?? {};
  const subject = meta.subject
    ? REPLY_PREFIX.test(meta.subject)
      ? meta.subject
      : `Re: ${meta.subject}`
    : '';
  const out: OutboundMessage = {
    messageId: msg.id,
    conversationId: msg.conversationId,
    channelId: c.channel_id,
    channelKind: kind,
    to: ident.rows[0].value,
    body: msg.body,
    attachments: msg.attachments,
    ...(kind === 'email'
      ? {
          email: {
            subject: subject || 'Ответ на ваше обращение',
            inReplyTo: meta.lastMessageId ?? null,
            references: meta.references ?? [],
          },
        }
      : {}),
  };
  await tx.query(`UPDATE message SET delivery_status = 'pending' WHERE id = $1`, [msg.id]);
  await enqueueCommand(tx, msg.id, outboundSubject(kind), out);
  return 'pending';
}

/**
 * Статус доставки исходящего от коннектора (идемпотентно): уже доставленное не откатывается повторной или
 * запоздавшей доставкой статуса. Возвращает false, если статус ничего не изменил.
 */
export async function applyDeliveryStatus(tx: PoolClient, s: DeliveryStatus): Promise<boolean> {
  const r = await tx.query<{ conversation_id: string }>(
    `UPDATE message m SET delivery_status = $2, delivery_error = $3,
        delivered_at = CASE WHEN $2 = 'sent' THEN to_timestamp($4::bigint / 1000.0) ELSE m.delivered_at END,
        external_id = CASE
          WHEN $5::text IS NULL OR m.external_id IS NOT NULL THEN m.external_id
          WHEN EXISTS (SELECT 1 FROM message x WHERE x.channel_kind = m.channel_kind AND x.external_id = $5) THEN NULL
          ELSE $5 END
      WHERE m.id = $1 AND m.delivery_status IS DISTINCT FROM 'sent'
        AND NOT (m.delivery_status = $2 AND m.delivery_error IS NOT DISTINCT FROM $3)
      RETURNING m.conversation_id`,
    [s.messageId, s.status, s.error, s.at, s.externalId],
  );
  if (!r.rows[0]) return false;
  await emitConversation(
    tx,
    CONVERSATION_EVENTS.messageStatus,
    await loadRef(tx, r.rows[0].conversation_id),
    {
      messageId: s.messageId,
      deliveryStatus: s.status,
      deliveryError: s.error,
    },
  );
  return true;
}
