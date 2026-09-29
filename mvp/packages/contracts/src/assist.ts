import { z } from 'zod';

/**
 * Assist API (M-AI-01, 02-архитектура 7) — контракт подключения провайдера подсказок оператору.
 * Система отправляет контекст обращения `POST {url}` и ждёт ответ не дольше таймаута провайдера;
 * подсказки всех провайдеров объединяются по score. Сбой или таймаут провайдера не мешает оператору —
 * остаются подсказки встроенного провайдера (шаблоны и база знаний).
 */
export const AssistRequestSchema = z.object({
  conversationId: z.string().uuid(),
  channel: z.string(),
  /** Тема обращения (название) — если выбрана. */
  topic: z.string().nullable(),
  /** Последние сообщения клиента и оператора по порядку. */
  lastMessages: z
    .array(z.object({ direction: z.enum(['in', 'out']), text: z.string(), at: z.string() }))
    .max(50),
  contact: z.object({ name: z.string().nullable(), phone: z.string().nullable() }),
  /** Что нужно: подсказки в панель или черновик ответа (кнопка «Черновик»). */
  function: z.enum(['suggest', 'draft']).default('suggest'),
});
export type AssistRequest = z.infer<typeof AssistRequestSchema>;

export const AssistSuggestionSchema = z.object({
  type: z.enum(['template', 'article', 'draft']),
  /** Заголовок карточки подсказки (название шаблона/статьи). */
  title: z.string().max(300).optional(),
  /** Текст, который вставляется в ответ одним кликом. */
  text: z.string().max(10000),
  /** Релевантность 0..1 — по ней подсказки разных провайдеров объединяются. */
  score: z.number().min(0).max(1).default(0.5),
  /** Источник: провайдер, id шаблона/статьи. */
  source: z.string().max(200).optional(),
  refId: z.string().max(100).optional(),
});
export type AssistSuggestion = z.infer<typeof AssistSuggestionSchema>;

export const AssistResponseSchema = z.object({ suggestions: z.array(AssistSuggestionSchema).max(50) });
export type AssistResponse = z.infer<typeof AssistResponseSchema>;
