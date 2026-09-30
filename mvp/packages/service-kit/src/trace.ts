import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Сквозной идентификатор обработки (correlation-id, M-NFR-04): HTTP-запрос (`x-request-id`) или входящее
 * сообщение. Хранится в асинхронном контексте: попадает в каждую строку журнала (`correlationId`) и в `traceId`
 * событий, записанных в outbox во время обработки, — по нему находится вся цепочка в логах разных сервисов.
 */
const store = new AsyncLocalStorage<{ correlationId: string }>();

export const currentCorrelationId = (): string | undefined => store.getStore()?.correlationId;

/** Допустимый внешний идентификатор (из заголовка) или новый. */
export function correlationIdFrom(header: unknown): string {
  return typeof header === 'string' && /^[\w.:-]{1,100}$/.test(header) ? header : randomUUID();
}

/** Выполнить обработку с идентификатором: логи и события внутри получат его. */
export function withCorrelation<T>(id: string | undefined, fn: () => T): T {
  return id ? store.run({ correlationId: id }, fn) : fn();
}

/** Установить идентификатор для оставшейся части текущей асинхронной цепочки (хук HTTP-сервера). */
export function enterCorrelation(id: string): void {
  store.enterWith({ correlationId: id });
}
