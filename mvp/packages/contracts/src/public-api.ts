import { z } from 'zod';
import type { EventEnvelope } from './event';

/**
 * Публичный API и webhooks (Ф9; M-INT-01/02, M-AI-02/03, M-CH-09; 02-архитектура, 7).
 * Контракт внешних систем: меняется только аддитивно (новые права, типы событий, поля).
 */

/** Права ключа API. Ключ не имеет прав сотрудника — только перечисленные действия публичного API. */
export const API_KEY_PERMISSIONS = {
  'conversations.read': 'Чтение обращений, сообщений, клиентов и записей разговоров',
  'conversations.write': 'Запись результатов анализа: поля, теги, заметки',
  'bot.reply': 'Внешний бот: ответ клиенту и перевод на оператора',
  inbound: 'Внешний канал: приём сообщений сторонней системы как обращений',
} as const;
export type ApiKeyPermission = keyof typeof API_KEY_PERMISSIONS;
export const API_KEY_PERMISSION_LIST = Object.keys(API_KEY_PERMISSIONS) as ApiKeyPermission[];

/** Префикс ключа: по нему guard отличает ключ API от токена сессии сотрудника. */
export const API_KEY_PREFIX = 'cck_';

/** Типы событий webhooks с описаниями (каталог для админки и OpenAPI). */
export const WEBHOOK_EVENTS = {
  'conversation.created': 'Новое обращение',
  'conversation.assigned': 'Обращение назначено оператору',
  'conversation.transferred': 'Обращение передано оператору или в очередь',
  'conversation.classified': 'Изменены тема, поля или теги обращения',
  'conversation.closed': 'Обращение закрыто',
  'conversation.updated': 'Прочие изменения обращения (очередь, предложение оператору, перелив)',
  'message.created': 'Новое сообщение клиента, оператора, бота или системное (без внутренних заметок)',
  'message.status': 'Статус доставки сообщения во внешний канал',
  'call.state_changed': 'Изменилось состояние звонка',
  'recording.ready': 'Запись разговора сохранена',
  'csat.received': 'Клиент оценил обслуживание',
  'ticket.created': 'Тикет 2-й линии создан',
  'ticket.assigned': 'Изменены назначенные тикета',
  'ticket.status_changed': 'Изменён статус тикета',
  'ticket.redirected': 'Тикет переадресован',
  'ticket.commented': 'Комментарий к тикету',
  'ticket.client_message': 'Клиент написал в обращение с открытым тикетом',
  'ticket.needs_reassign': 'Тикет требует переназначения',
} as const;
export type WebhookEventType = keyof typeof WEBHOOK_EVENTS;
export const WEBHOOK_EVENT_TYPES = Object.keys(WEBHOOK_EVENTS) as WebhookEventType[];
/** Ход внешнего бота (только подпискам вида «внешний бот»). */
export const BOT_TURN_EVENT = 'conversation.bot_turn';
/** Проверочная доставка из админки. */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

const UPDATED_ACTIONS: Record<string, WebhookEventType> = {
  closed: 'conversation.closed',
  assigned: 'conversation.assigned',
  accepted: 'conversation.assigned',
  transferred: 'conversation.transferred',
  classified: 'conversation.classified',
  recording_ready: 'recording.ready',
  csat: 'csat.received',
};

/**
 * Публичное событие по внутреннему событию шины (или null — наружу не отдаётся): внутренние типы
 * `conversation.updated` с action разворачиваются в понятные типы, внутренние заметки и служебные поля
 * (кому показать уведомление) не выходят за контур.
 */
export function publicEventOf(
  e: EventEnvelope,
): { type: WebhookEventType; data: Record<string, unknown> } | null {
  const { notifyUserIds: _hidden, ...data } = e.data as Record<string, unknown> & { notifyUserIds?: unknown };
  void _hidden;
  switch (e.type) {
    case 'conversation.created':
      return { type: 'conversation.created', data };
    case 'conversation.updated':
      return { type: UPDATED_ACTIONS[String(data.action)] ?? 'conversation.updated', data };
    case 'conversation.message_created': {
      const m = data.message as { direction?: string } | undefined;
      if (!m || m.direction === 'note') return null;
      return { type: 'message.created', data };
    }
    case 'conversation.message_status':
      return { type: 'message.status', data };
    case 'conversation.call':
      return { type: 'call.state_changed', data };
    default:
      if (e.type.startsWith('ticket.') && e.type in WEBHOOK_EVENTS)
        return { type: e.type as WebhookEventType, data };
      return null;
  }
}

/** Тело запроса webhook: id события — ключ идемпотентности у получателя (доставка «хотя бы один раз»). */
export interface WebhookBody {
  id: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/**
 * Заголовки подписи: X-CC-Timestamp (секунды Unix) и X-CC-Signature: sha256=<hex HMAC-SHA256(secret,
 * `${timestamp}.${body}`)>. Получатель сверяет подпись и отбрасывает запросы старше 5 минут.
 */
export const SIGNATURE_HEADER = 'x-cc-signature';
export const TIMESTAMP_HEADER = 'x-cc-timestamp';
export const signaturePayload = (timestamp: number | string, body: string) => `${timestamp}.${body}`;

/** Ход внешнего бота: новое сообщение клиента в обращении, которое ведёт бот. */
export interface BotTurnData {
  conversationId: string;
  channel: { id: string; kind: string };
  contact: { id: string; name: string | null; phone: string | null; email: string | null };
  message: { id: string; text: string; attachments: { id: string; filename: string }[] };
  /** Последние сообщения диалога (старые первыми). */
  history: { direction: string; text: string; sentAt: string }[];
  /** Куда отвечать (ключ API с правом bot.reply). */
  replyUrl: string;
  handoffUrl: string;
  /** Не ответил до этого момента — диалог уйдёт оператору. */
  deadline: string;
}

// ---------------------------------------------------------------- тела запросов публичного API

export const ExtInboundSchema = z
  .object({
    /** Идентификатор сообщения в сторонней системе — повтор с тем же значением не создаёт дубля. */
    externalId: z.string().trim().min(1).max(200),
    contact: z
      .object({
        /** Идентификатор клиента в сторонней системе (если нет телефона/email). */
        externalId: z.string().trim().min(1).max(200).optional(),
        name: z.string().trim().max(200).optional(),
        phone: z.string().trim().max(64).optional(),
        email: z.string().trim().email().max(200).optional(),
      })
      .strict()
      .refine((c) => c.externalId || c.phone || c.email, 'Укажите contact.externalId, phone или email'),
    text: z.string().max(20000).default(''),
    /** Произвольные данные формы — сохраняются в поля обращения (fields). */
    fields: z.record(z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
  })
  .strict()
  .refine((m) => m.text.trim() || (m.fields && Object.keys(m.fields).length), 'Пустое сообщение');
export type ExtInbound = z.infer<typeof ExtInboundSchema>;

export const ExtConversationPatchSchema = z
  .object({
    /** Поля обращения (объединяются с имеющимися; null — удалить поле). */
    fields: z.record(z.union([z.string().max(5000), z.number(), z.boolean(), z.null()])).optional(),
    /** Добавить теги (по названию существующих тегов). */
    addTags: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    /** Внутренняя заметка для оператора. */
    note: z.string().trim().min(1).max(10000).optional(),
  })
  .strict()
  .refine((b) => b.fields || b.addTags?.length || b.note, 'Нечего изменять');

export const ExtBotMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(4000),
    buttons: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  })
  .strict();

export const ExtHandoffSchema = z
  .object({
    queueId: z.string().uuid().optional(),
    topicId: z.string().uuid().optional(),
    /** Сообщение клиенту перед переводом. */
    text: z.string().trim().max(2000).optional(),
    /** Внутренняя заметка оператору (что выяснил бот). */
    note: z.string().trim().max(10000).optional(),
  })
  .strict();
