import type { Logger } from 'pino';

export type LifecycleState = 'starting' | 'ready' | 'draining' | 'stopping' | 'stopped';

interface Hook {
  name: string;
  order: number;
  fn: () => Promise<void> | void;
}

export interface LifecycleOptions {
  logger: Logger;
  drainDelayMs: number;
  timeoutMs: number;
  exit?: (code: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Жизненный цикл сервиса и корректная остановка (02-архитектура, 6.2 п.3):
 * 1) readiness → 503 (балансировщик и docker healthcheck снимают экземпляр);
 * 2) пауза drainDelayMs — запросы, уже направленные на экземпляр, ещё обслуживаются;
 * 3) хуки остановки по возрастанию order: HTTP-сервер → потребители → ресурсы;
 * 4) выход; при превышении timeoutMs — аварийный выход с кодом 1.
 */
export class Lifecycle {
  private state: LifecycleState = 'starting';
  private readonly hooks: Hook[] = [];
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly opts: LifecycleOptions) {}

  get current(): LifecycleState {
    return this.state;
  }
  get isReady(): boolean {
    return this.state === 'ready';
  }
  get isLive(): boolean {
    return this.state !== 'stopped';
  }

  markReady(): void {
    if (this.state === 'starting') {
      this.state = 'ready';
      this.opts.logger.info('сервис готов');
    }
  }

  /** order: 10 — HTTP, 20 — потребители/фоновые задачи, 30 — соединения (NATS, БД). */
  onShutdown(name: string, order: number, fn: () => Promise<void> | void): void {
    this.hooks.push({ name, order, fn });
  }

  installSignalHandlers(): void {
    const handler = (signal: string) => {
      this.opts.logger.info({ signal }, 'получен сигнал остановки');
      void this.shutdown();
    };
    process.once('SIGTERM', () => handler('SIGTERM'));
    process.once('SIGINT', () => handler('SIGINT'));
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    const { logger, drainDelayMs, timeoutMs } = this.opts;
    const exit = this.opts.exit ?? ((code: number) => process.exit(code));
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, 'корректная остановка не уложилась в тайм-аут');
      exit(1);
    }, timeoutMs);
    timer.unref?.();

    this.state = 'draining';
    logger.info({ drainDelayMs }, 'readiness=503, ожидание снятия экземпляра с балансировки');
    await sleep(drainDelayMs);

    this.state = 'stopping';
    let failed = false;
    for (const h of [...this.hooks].sort((a, b) => a.order - b.order)) {
      try {
        await h.fn();
        logger.info({ hook: h.name }, 'остановлено');
      } catch (err) {
        failed = true;
        logger.error({ hook: h.name, err }, 'ошибка при остановке');
      }
    }
    this.state = 'stopped';
    clearTimeout(timer);
    logger.info('сервис остановлен');
    exit(failed ? 1 : 0);
  }
}
