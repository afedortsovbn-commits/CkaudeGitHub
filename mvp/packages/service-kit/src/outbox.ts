import { subjectFor, type EventEnvelope } from '@cc/contracts';
import { headers, type JetStreamClient } from 'nats';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';

/**
 * Записывает событие в журнал `event` и в `outbox` в рамках транзакции вызывающего кода
 * (transactional outbox, 02-архитектура, принцип 4). Публикацию выполняет OutboxRelay.
 */
export async function enqueueEvent(tx: PoolClient, event: EventEnvelope): Promise<void> {
  await tx.query(
    `INSERT INTO event (id, type, version, occurred_at, source, trace_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
    [event.id, event.type, event.version, event.occurredAt, event.source, event.traceId ?? null, event.data],
  );
  await tx.query(
    `INSERT INTO outbox (id, subject, payload) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [event.id, subjectFor(event.type), event],
  );
}

/**
 * Команда (не доменное событие) в outbox той же транзакцией: например, исходящее сообщение для коннектора
 * (subject cc.outbound.<kind>). В журнал `event` не пишется. id — ключ идемпотентности (Nats-Msg-Id).
 */
export async function enqueueCommand(tx: PoolClient, id: string, subject: string, payload: unknown): Promise<void> {
  await tx.query(`INSERT INTO outbox (id, subject, payload) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
    id,
    subject,
    JSON.stringify(payload),
  ]);
}

export interface OutboxRelayOptions {
  pool: Pool;
  js: JetStreamClient;
  logger: Logger;
  batchSize?: number;
  idleDelayMs?: number;
}

/**
 * Публикует неотправленные записи outbox в JetStream. Несколько экземпляров работают конкурентно
 * (FOR UPDATE SKIP LOCKED). Nats-Msg-Id = id события — повторная публикация после сбоя отсекается
 * в окне дедупликации потока; потребители дополнительно идемпотентны.
 */
export class OutboxRelay {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly o: OutboxRelayOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Дожидается завершения текущей пачки и останавливается. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  /** Публикует одну пачку; возвращает число опубликованных записей. */
  async publishBatch(): Promise<number> {
    const client = await this.o.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; subject: string; payload: unknown }>(
        `SELECT id, subject, payload FROM outbox WHERE published_at IS NULL
         ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.o.batchSize ?? 100],
      );
      const published: string[] = [];
      for (const r of rows) {
        try {
          const h = headers();
          h.set('Nats-Msg-Id', r.id);
          await this.o.js.publish(r.subject, JSON.stringify(r.payload), { msgID: r.id, headers: h });
          published.push(r.id);
        } catch (err) {
          await client.query('UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
            r.id,
            String(err),
          ]);
          this.o.logger.warn({ id: r.id, err: String(err) }, 'не удалось опубликовать событие, повторю');
          break; // сохраняем порядок: следующие записи — в следующей пачке
        }
      }
      if (published.length) {
        await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])', [published]);
      }
      await client.query('COMMIT');
      return published.length;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      let n = 0;
      try {
        n = await this.publishBatch();
      } catch (err) {
        this.o.logger.error({ err: String(err) }, 'ошибка outbox-relay');
      }
      if (n === 0 && this.running) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.o.idleDelayMs ?? 200);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
    }
  }
}
