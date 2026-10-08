import { ApiError } from './errors';

/**
 * Тяжёлые запросы (отчёты, выгрузки в Excel) — не больше `max` одновременно в экземпляре API; остальные ждут
 * своей очереди до `waitMs`, затем получают понятный отказ. Так несколько больших отчётов не забирают все
 * подключения к базе и процессор у чатов и звонков.
 */
export class HeavyGate {
  private running = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    readonly max: number,
    private readonly waitMs = 30_000,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max)
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const i = this.waiters.indexOf(go);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(
            new ApiError(
              503,
              'busy',
              'Сейчас строятся другие отчёты — чтобы не замедлять работу с клиентами, повторите через минуту',
            ),
          );
        }, this.waitMs);
        this.waiters.push(go);
      });
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiters.shift()?.();
    }
  }
}

/** Общий ограничитель экземпляра API (REPORTS_MAX_CONCURRENT, по умолчанию 2). */
export const heavy = new HeavyGate(Math.max(1, Number(process.env.REPORTS_MAX_CONCURRENT) || 2));

/**
 * Настройки сеанса базы для тяжёлого запроса (внутри транзакции): не дольше 60 с и без параллельных
 * процессов PostgreSQL — один отчёт занимает не больше одного ядра процессора базы.
 */
export const HEAVY_SESSION_SQL = `SET LOCAL statement_timeout = '60s'; SET LOCAL max_parallel_workers_per_gather = 0`;
