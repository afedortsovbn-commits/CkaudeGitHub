import { z } from 'zod';

/**
 * Входящее сообщение канала в едином формате (02-архитектура 4.1, контракт коннектора M-CH-07).
 * Публикуется коннектором в поток CC_INBOUND (subject cc.inbound.<kind>) с Nats-Msg-Id = id.
 */
export const InboundMessageSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  channelKind: z.enum(['webchat', 'app', 'telegram', 'email', 'review', 'api']),
  /** Идентификатор сообщения в канале — ключ идемпотентности в БД. */
  externalId: z.string().min(1).max(200),
  identity: z.object({
    kind: z.enum(['phone', 'email', 'telegram', 'webchat', 'app', 'other']),
    value: z.string().min(1).max(300),
  }),
  /** Если клиент уже известен (например, выдан токен виджета) — идентификатор клиента. */
  contactId: z.string().uuid().optional(),
  contact: z
    .object({
      displayName: z.string().max(200).optional(),
      phone: z.string().max(64).optional(),
      email: z.string().max(200).optional(),
    })
    .optional(),
  body: z.string().max(20000).default(''),
  attachments: z
    .array(
      z.object({
        id: z.string().uuid(),
        filename: z.string(),
        contentType: z.string(),
        size: z.number().int(),
      }),
    )
    .default([]),
  /** Время приёма системой (мс) — определяет порядок показа. */
  receivedAt: z.number().int(),
  meta: z.record(z.unknown()).optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const inboundSubject = (kind: string) => `cc.inbound.${kind}`;

/** Метаданные письма во входящем (InboundMessage.meta.email) — для цепочек писем (M-CH-06). */
export interface EmailMeta {
  subject: string;
  messageId: string | null;
  /** Message-ID из In-Reply-To и References — по ним письмо относится к существующему обращению. */
  references: string[];
}

/** Каналы, доставку в которые выполняют коннекторы (веб-чат и приложение доставляет realtime). */
export const CONNECTOR_CHANNELS = ['telegram', 'email'] as const;
export type ConnectorChannel = (typeof CONNECTOR_CHANNELS)[number];

/**
 * Исходящее сообщение оператора во внешний канал (контракт коннектора M-CH-07).
 * Публикуется через outbox в поток CC_OUTBOUND (subject cc.outbound.<kind>) с Nats-Msg-Id = messageId;
 * коннектор доставляет его и публикует DeliveryStatus.
 */
export const OutboundMessageSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  channelId: z.string().uuid(),
  channelKind: z.enum(CONNECTOR_CHANNELS),
  /** Адрес клиента в канале: chat id Telegram или email. */
  to: z.string().min(1),
  body: z.string().default(''),
  attachments: z
    .array(
      z.object({
        id: z.string().uuid(),
        filename: z.string(),
        contentType: z.string(),
        size: z.number().int(),
      }),
    )
    .default([]),
  email: z
    .object({
      subject: z.string(),
      inReplyTo: z.string().nullable(),
      references: z.array(z.string()),
    })
    .optional(),
  /**
   * Кнопки бота (Ф7, M-AUTO-04): Telegram — клавиатура ответа (нажатие приходит текстом кнопки),
   * email — нумерованный список в тексте письма.
   */
  buttons: z.array(z.string().max(64)).max(10).optional(),
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;
export const outboundSubject = (kind: string) => `cc.outbound.${kind}`;

/** Результат доставки исходящего (коннектор → worker, subject cc.delivery.<kind>). */
export const DeliveryStatusSchema = z.object({
  messageId: z.string().uuid(),
  channelId: z.string().uuid(),
  status: z.enum(['sent', 'failed']),
  /** Идентификатор сообщения в канале (Telegram message_id, email Message-ID). */
  externalId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  at: z.number().int(),
});
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;
export const deliverySubject = (kind: string) => `cc.delivery.${kind}`;

/** Детерминированный Message-ID исходящего письма: ответ клиента (In-Reply-To) находит обращение. */
export const emailMessageId = (messageId: string, domain: string) => `<${messageId}@${domain}>`;

/** Сводка обращения в событиях — достаточна для фильтрации по правам и областям без запроса к БД. */
export interface ConversationRef {
  conversationId: string;
  contactId: string;
  /** Канал обращения (Ф9: фильтр подписок webhooks по каналам). */
  channelId?: string;
  channelKind: string;
  status: string;
  queueId: string | null;
  assigneeId: string | null;
  enterpriseId: string | null;
  departmentId: string | null;
  topicPath: string[];
  isImportant: boolean;
  /** Тема или подтема обращения (последний элемент topicPath; Ф10 — измерение отчётов). */
  topicId?: string | null;
  /** Объект (АЗС/ЭЗС) обращения (Ф10 — измерение отчётов). */
  objectId?: string | null;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  direction: 'in' | 'out' | 'system' | 'note';
  authorUserId: string | null;
  authorName?: string | null;
  body: string;
  attachments: { id: string; filename: string; contentType: string; size: number }[];
  sentAt: string;
  /** Идентификатор в канале (для веб-чата — clientMessageId): клиент сопоставляет отправленное с подтверждённым. */
  externalId?: string | null;
  /** Доставка исходящего во внешний канал (Telegram, email): pending → sent | failed. */
  deliveryStatus?: 'pending' | 'sent' | 'failed' | null;
  /** Служебные признаки (Ф7): автоответ/бот, кнопки бота, запрос оценки чата. */
  meta?: MessageMeta;
}

export interface MessageMeta {
  /** Сообщение отправлено автоматически: правило автоответа (вид правила) или бот. */
  auto?: 'greeting' | 'queued' | 'after_hours' | 'keyword' | 'inactivity' | 'bot' | 'ticket';
  /** Кнопки бота — клиент нажимает (в виджете) или пишет текст кнопки. */
  buttons?: { id: string; label: string }[];
  /** Запрос оценки обслуживания после закрытия чата (виджет показывает 1–5). */
  csat?: boolean;
  /** Сообщение или заметка от внешней системы по ключу API (Ф9): название ключа. */
  external?: string;
}

/** Типы событий обращений (payload — ConversationRef [+ message]). */
export const CONVERSATION_EVENTS = {
  created: 'conversation.created',
  updated: 'conversation.updated',
  message: 'conversation.message_created',
  /** Изменился статус доставки исходящего во внешний канал (payload — ConversationRef + messageId, status). */
  messageStatus: 'conversation.message_status',
  /** Изменилось состояние голосового вызова обращения (payload — ConversationRef + CallStateEvent, Ф5). */
  call: 'conversation.call',
} as const;

/** Ключи config канала, которые хранятся зашифрованными и никогда не отдаются в интерфейс. */
export const CHANNEL_SECRET_KEYS = ['bot_token', 'webhook_secret', 'imap_password', 'smtp_password'] as const;
/** Маска секрета в ответах api; пришедшая обратно маска означает «не менять». */
export const SECRET_MASK = '********';

/** Экземпляр канала Telegram (бот). Режим webhook требует доступности адреса КЦ из интернета. */
export const TelegramChannelConfigSchema = z
  .object({
    bot_token: z.string().min(10),
    mode: z.enum(['polling', 'webhook']).default('polling'),
    /** Адрес Bot API; по умолчанию api.telegram.org (другой — локальный Bot API-сервер или мок в тестах). */
    api_root: z.string().url().optional(),
    webhook_secret: z.string().min(16).optional(),
  })
  .passthrough();
export type TelegramChannelConfig = z.infer<typeof TelegramChannelConfigSchema>;

/** Экземпляр канала email (почтовый ящик): приём по IMAP, отправка по SMTP (M-CH-06). */
export const EmailChannelConfigSchema = z
  .object({
    address: z.string().email(),
    display_name: z.string().max(200).optional(),
    imap_host: z.string().min(1),
    imap_port: z.coerce.number().int().default(993),
    imap_secure: z.boolean().default(true),
    imap_user: z.string().min(1),
    imap_password: z.string().min(1),
    mailbox: z.string().default('INBOX'),
    smtp_host: z.string().min(1),
    smtp_port: z.coerce.number().int().default(465),
    smtp_secure: z.boolean().default(true),
    smtp_user: z.string().optional(),
    smtp_password: z.string().optional(),
    /** Не проверять TLS-сертификат почтового сервера (самоподписанный внутри контура). */
    tls_insecure: z.boolean().default(false),
  })
  .passthrough();
export type EmailChannelConfig = z.infer<typeof EmailChannelConfigSchema>;
