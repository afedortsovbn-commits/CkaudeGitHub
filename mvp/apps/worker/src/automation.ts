import { INTEGRATION_SUBJECT, type IntegrationReply } from '@cc/contracts';
import {
  type BotHttp,
  claimStaleBotSteps,
  resumeBotHttp,
  sweepExternalBots,
  sweepInactivity,
} from '@cc/domain';
import type { Logger } from '@cc/service-kit';
import type { NatsConnection } from 'nats';
import type { Pool, PoolClient } from 'pg';

/**
 * Фоновая часть автоматизации текстовых каналов (Ф7): запросы бота во внешние системы (узел «Запрос во
 * внешнюю систему» → api по NATS request/reply, как у IVR) и периодический обход дедлайнов — автозакрытие
 * при молчании клиента и шаги бота, чей запрос не завершился (экземпляр worker остановили посреди запроса).
 * Обход выполняют все экземпляры: строки забираются FOR UPDATE SKIP LOCKED.
 */
export class Automation {
  private timer?: ReturnType<typeof setInterval>;
  private readonly inflight = new Set<Promise<void>>();
  private sweeping = false;
  private stopped = false;

  constructor(private readonly o: { pool: Pool; nc: NatsConnection; logger: Logger; sweepMs: number }) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), this.o.sweepMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    // Начатые запросы завершаются; не начатые подхватит другой экземпляр по дедлайну.
    await Promise.all([...this.inflight]);
  }

  /** Выполнить запрос бота (не блокирует обработку входящих). */
  runHttp = (h: BotHttp): void => {
    if (this.stopped) return;
    const p = this.execute(h)
      .catch((err: unknown) =>
        this.o.logger.error({ err: String(err), conversationId: h.conversationId }, 'шаг бота: ошибка'),
      )
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  };

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.o.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  private async execute(h: BotHttp): Promise<void> {
    let reply: IntegrationReply;
    try {
      const msg = await this.o.nc.request(
        INTEGRATION_SUBJECT,
        JSON.stringify({
          operationId: h.operationId,
          input: h.input,
          source: 'bot',
          conversationId: h.conversationId,
        }),
        { timeout: 35_000 },
      );
      reply = msg.json<IntegrationReply>();
    } catch (err) {
      // api недоступен или не ответил — бот идёт по ветке «ошибка», клиент не остаётся без ответа.
      reply = { ok: false, outputs: {}, error: String(err), durationMs: 0 };
    }
    const next = await this.tx((c) => resumeBotHttp(c, h, reply));
    if (next) await this.execute(next);
  }

  private async sweep(): Promise<void> {
    if (this.sweeping || this.stopped) return;
    this.sweeping = true;
    try {
      const n = await this.tx((c) => sweepInactivity(c));
      if (n) this.o.logger.info({ n }, 'автозакрытие: предупреждения и закрытия по молчанию клиента');
      const ext = await this.tx((c) => sweepExternalBots(c));
      if (ext) this.o.logger.warn({ n: ext }, 'внешний бот не ответил вовремя — диалоги переданы операторам');
      const stale = await this.tx((c) => claimStaleBotSteps(c));
      for (const h of stale) {
        this.o.logger.warn(
          { conversationId: h.conversationId },
          'шаг бота не завершён вовремя — повтор запроса',
        );
        this.runHttp(h);
      }
    } catch (err) {
      this.o.logger.warn({ err: String(err) }, 'обход автоматизации: ошибка, повтор на следующем тике');
    } finally {
      this.sweeping = false;
    }
  }
}
