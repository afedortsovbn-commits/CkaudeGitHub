import { z } from 'zod';

/**
 * Выполнение интеграционной операции (M-INT-03, 02-архитектура 7): операцию выполняет api — единое место
 * для журнала и секретов. Из call-control (узел IVR «Запрос во внешнюю систему») и worker (боты, Ф7) —
 * NATS request/reply на `cc.integration.execute`, отвечает любой экземпляр api (группа очереди).
 */
export const INTEGRATION_SUBJECT = 'cc.integration.execute';

export const IntegrationRequestSchema = z.object({
  operationId: z.string().uuid(),
  input: z.record(z.string().max(2000)).default({}),
  source: z.enum(['ivr', 'bot', 'card', 'test']),
  conversationId: z.string().uuid().nullable().optional(),
  callId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
});
export type IntegrationRequest = z.infer<typeof IntegrationRequestSchema>;

export interface IntegrationReply {
  ok: boolean;
  /** Выходные значения по маппингу операции; при ошибке — фолбэк-значения. */
  outputs: Record<string, string>;
  error?: string;
  httpStatus?: number;
  durationMs: number;
}
