import type { Logger } from '@cc/service-kit';
import type { Pool } from 'pg';
import type PgBoss from 'pg-boss';
import { Counter } from 'prom-client';
import { assignQueued } from './assign';
import { scheduleOfferTimeout } from './jobs';
import { sweepCallbacks, sweepEscalation, sweepOverflow, sweepWrapUp } from './sweep';

export interface TickerOptions {
  pool: Pool;
  boss: PgBoss;
  logger: Logger;
  registry: import('prom-client').Registry;
  maxChatsFallback: number;
  batchSize: number;
  idleDelayMs: number;
}

/**
 * Цикл router (02-архитектура 2.2, 6.2): на каждом проходе — перелив, эскалация, автовозврат из
 * постобработки (периодический опрос по хранимым в БД дедлайнам — переживает перезапуск/замену
 * экземпляра), затем попытка назначить ожидающие обращения операторам. Несколько экземпляров работают
 * конкурентно: конкурентная безопасность — в транзакциях `assignOne`/`sweep*` (FOR UPDATE SKIP LOCKED).
 */
export class Ticker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private readonly assigned: Counter;

  constructor(private readonly o: TickerOptions) {
    this.assigned = new Counter({
      name: 'router_assigned_total',
      help: 'Обращений предложено операторам',
      registers: [o.registry],
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  /** Один проход; возвращает число вновь назначенных обращений (для тестов и логов). */
  async tick(): Promise<number> {
    await sweepOverflow(this.o.pool).catch((e: unknown) =>
      this.o.logger.error({ err: String(e) }, 'ошибка перелива в резервную группу'),
    );
    await sweepEscalation(this.o.pool).catch((e: unknown) =>
      this.o.logger.error({ err: String(e) }, 'ошибка эскалации по времени ожидания'),
    );
    await sweepWrapUp(this.o.pool).catch((e: unknown) =>
      this.o.logger.error({ err: String(e) }, 'ошибка автовозврата из постобработки'),
    );
    await sweepCallbacks(this.o.pool).catch((e: unknown) =>
      this.o.logger.error({ err: String(e) }, 'ошибка возврата отложенных обращений в очередь'),
    );
    const assigned = await assignQueued(
      this.o.pool,
      { maxChatsFallback: this.o.maxChatsFallback, batchSize: this.o.batchSize },
      async (offer) => {
        await scheduleOfferTimeout(this.o.boss, offer, offer.offerTimeoutS).catch((e: unknown) =>
          this.o.logger.error(
            { err: String(e), conversationId: offer.conversationId },
            'не удалось завести таймаут предложения — потребуется ручное вмешательство при отказе',
          ),
        );
      },
      this.o.logger,
    );
    if (assigned) this.assigned.inc(assigned);
    return assigned;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let n = 0;
      try {
        n = await this.tick();
      } catch (err) {
        this.o.logger.error({ err: String(err) }, 'ошибка тика router');
      }
      if (n === 0 && this.running) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.o.idleDelayMs);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
    }
  }
}
