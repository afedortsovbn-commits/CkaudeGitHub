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

/** Сводка обращения в событиях — достаточна для фильтрации по правам и областям без запроса к БД. */
export interface ConversationRef {
  conversationId: string;
  contactId: string;
  channelKind: string;
  status: string;
  queueId: string | null;
  assigneeId: string | null;
  enterpriseId: string | null;
  departmentId: string | null;
  topicPath: string[];
  isImportant: boolean;
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
}

/** Типы событий обращений (payload — ConversationRef [+ message]). */
export const CONVERSATION_EVENTS = {
  created: 'conversation.created',
  updated: 'conversation.updated',
  message: 'conversation.message_created',
} as const;
