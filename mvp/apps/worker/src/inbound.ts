import { type InboundMessage, InboundMessageSchema } from '@cc/contracts';
import { afterInbound, type BotHttp, ingestInbound } from '@cc/domain';
import { type Logger, retryJs, withCorrelation } from '@cc/service-kit';
import { AckPolicy, type Consumer, type JetStreamClient, type JetStreamManager, type JsMsg } from 'nats';
import type { Pool } from 'pg';
import { Counter } from 'prom-client';

const CONSUMER = 'worker-inbound';
const MAX_DELIVER = 20;

/**
 * Ключ очерёдности: сообщения одного клиента в канале обрабатываются строго по очереди, разных клиентов —
 * параллельно (Ф11: под нагрузкой 100 чатов последовательная обработка не успевала, хвост рос при обновлении).
 */
export function orderingKey(raw: unknown): string {
  const m = raw as { channelId?: string; identity?: { kind?: string; value?: string } } | null;
  return `${m?.channelId ?? ''}:${m?.identity?.kind ?? ''}:${m?.identity?.value ?? ''}`;
}

/**
 * Исполнитель задач с ограничением параллельности и порядком внутри ключа: задача ключа начинается после
 * завершения предыдущей задачи того же ключа.
 */
export class KeyedRunner {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly limit: number) {}

  /** Ставит задачу; ждёт, только если достигнут предел одновременных задач. */
  async push(key: string, task: () => Promise<void>): Promise<void> {
    while (this.inflight.size >= this.limit) await Promise.race(this.inflight);
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Ошибки задачи обрабатывает сама задача (handle — nak и журнал); очередь ключа не прерывается.
    const p: Promise<void> = prev
      .then(task)
      .catch(() => undefined)
      .finally(() => {
        this.inflight.delete(p);
        if (this.tails.get(key) === p) this.tails.delete(key);
      });
    this.tails.set(key, p);
    this.inflight.add(p);
  }

  /** Дожидается всех поставленных задач. */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.all(this.inflight);
  }
}

/**
 * Обработчик потока CC_INBOUND. Durable-потребитель общий для всех экземпляров worker:
 * сообщение подтверждается только после фиксации транзакции; при остановке экземпляра
 * неподтверждённые сообщения будут доставлены другому (ack_wait).
 */
export class InboundProcessor {
  private running = false;
  private loop?: Promise<void>;
  private consumer?: Consumer;
  readonly processed: Counter;

  constructor(
    private readonly o: {
      pool: Pool;
      js: JetStreamClient;
      jsm: JetStreamManager;
      logger: Logger;
      registry: import('prom-client').Registry;
      /** Запрос бота во внешнюю систему — выполняется после фиксации транзакции (Ф7). */
      onBotHttp?: (h: BotHttp) => void;
      /** Одновременно обрабатываемых сообщений (разных клиентов) в экземпляре; по умолчанию 8. */
      concurrency?: number;
    },
  ) {
    this.processed = new Counter({
      name: 'inbound_messages_total',
      help: 'Обработанные входящие сообщения',
      labelNames: ['result'] as const,
      registers: [o.registry],
    });
  }

  async start(): Promise<void> {
    await retryJs(() =>
      this.o.jsm.consumers
        .add('CC_INBOUND', {
          durable_name: CONSUMER,
          ack_policy: AckPolicy.Explicit,
          ack_wait: 30_000_000_000,
          max_deliver: MAX_DELIVER,
        })
        .catch((e: unknown) => {
          if (!String(e).includes('already')) throw e;
        }),
    );
    this.consumer = await this.o.js.consumers.get('CC_INBOUND', CONSUMER);
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    const runner = new KeyedRunner(Math.max(1, this.o.concurrency ?? 8));
    while (this.running) {
      try {
        const batch = await this.consumer!.fetch({ max_messages: 50, expires: 1000 });
        for await (const m of batch) {
          let key = '';
          try {
            key = orderingKey(m.json());
          } catch {
            /* некорректное сообщение отбросит handle */
          }
          await runner.push(key, () => this.handle(m));
          if (!this.running) break;
        }
        // Следующая пачка запрашивается, не дожидаясь завершения начатых: медленное сообщение одного клиента
        // не задерживает остальных (порядок внутри ключа держит runner, объём в работе — его предел).
      } catch (err) {
        this.o.logger.warn({ err: String(err) }, 'ошибка чтения потока CC_INBOUND, повтор');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    // Остановка — после завершения начатых: подтверждение только после фиксации.
    await runner.drain();
  }

  private async handle(m: JsMsg): Promise<void> {
    let parsed;
    try {
      parsed = InboundMessageSchema.parse(m.json());
    } catch (err) {
      this.o.logger.error(
        { err: String(err), subject: m.subject },
        'некорректное входящее сообщение — отброшено',
      );
      this.processed.inc({ result: 'invalid' });
      m.term();
      return;
    }
    // correlation-id обработки — id входящего сообщения: логи и события (traceId) этой обработки связаны с ним.
    return withCorrelation(parsed.id, () => this.process(m, parsed));
  }

  private async process(m: JsMsg, parsed: InboundMessage): Promise<void> {
    const client = await this.o.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await ingestInbound(client, parsed);
      // Автоответы и бот (Ф7) — в той же транзакции: повторная доставка не даст ни дубля сообщения,
      // ни повторного ответа бота.
      const http = r.duplicate
        ? null
        : await afterInbound(client, {
            conversationId: r.conversationId,
            created: r.created,
            body: parsed.body,
          });
      await client.query('COMMIT');
      m.ack();
      if (http) this.o.onBotHttp?.(http);
      this.processed.inc({ result: r.skipped ? 'skipped' : r.duplicate ? 'duplicate' : 'ok' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const attempt = m.info.redeliveryCount;
      this.o.logger.error(
        { err: String(err), id: parsed.id, attempt },
        'ошибка обработки входящего сообщения, повторю',
      );
      this.processed.inc({ result: 'error' });
      m.nak(Math.min(1000 * 2 ** attempt, 30_000));
    } finally {
      client.release();
    }
  }
}
