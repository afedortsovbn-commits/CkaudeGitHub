import { z } from 'zod';
import { uuidv7 } from 'uuidv7';

/**
 * Оболочка любого события шины (02-архитектура, 6.2 п.7).
 * Правила совместимости: поля только добавляются; потребители игнорируют неизвестные поля;
 * несовместимое изменение — новый `type` с суффиксом `.v2` и период двойной публикации.
 */
export const EventEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'тип вида domain.entity.action'),
    version: z.number().int().positive(),
    occurredAt: z.string().datetime({ offset: true }),
    traceId: z.string().min(1).optional(),
    source: z.string().min(1),
    data: z.record(z.unknown()),
  })
  .passthrough();

export interface EventEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  traceId?: string;
  source: string;
  data: T;
}

export interface MakeEventInput<T extends Record<string, unknown>> {
  type: string;
  data: T;
  source: string;
  version?: number;
  traceId?: string;
  id?: string;
  occurredAt?: Date;
}

export function makeEvent<T extends Record<string, unknown>>(input: MakeEventInput<T>): EventEnvelope<T> {
  const event: EventEnvelope<T> = {
    id: input.id ?? uuidv7(),
    type: input.type,
    version: input.version ?? 1,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    source: input.source,
    data: input.data,
    ...(input.traceId ? { traceId: input.traceId } : {}),
  };
  EventEnvelopeSchema.parse(event);
  return event;
}

export function parseEvent(raw: unknown): EventEnvelope {
  return EventEnvelopeSchema.parse(raw) as EventEnvelope;
}

/** Subject NATS для события: `cc.events.<type>` */
export function subjectFor(type: string): string {
  return `cc.events.${type}`;
}

export { uuidv7 as newId };
