import { createPool } from '@cc/db';
import {
  BaseConfigSchema,
  createJobQueue,
  createLogger,
  createMetrics,
  Lifecycle,
  loadConfig,
  startHealthServer,
} from '@cc/service-kit';
import { z } from 'zod';
import { registerJobs } from './jobs';
import { Ticker } from './ticker';

const ConfigSchema = BaseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  /** Ёмкость оператора по текстовым каналам — тот же смысл, что и в `system_setting.operator.max_chats`. */
  ROUTER_MAX_CHATS_FALLBACK: z.coerce.number().int().min(1).default(5),
  ROUTER_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),
  ROUTER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(300),
});

/**
 * router: ACD — распределение обращений операторам (02-архитектура 2.2, 4.1, 6.2 п.6).
 * Не подключается к NATS напрямую: события пишет через тот же outbox, что и остальные сервисы
 * (`packages/service-kit` outbox + уже работающие экземпляры worker публикуют его в JetStream) —
 * опрос БД каждые ROUTER_POLL_INTERVAL_MS достаточно быстр для текстовых каналов MVP и не требует
 * отдельного durable-потребителя.
 */
async function main(): Promise<void> {
  const config = loadConfig(ConfigSchema);
  const logger = createLogger({
    service: config.SERVICE_NAME,
    version: config.APP_VERSION,
    level: config.LOG_LEVEL,
  });
  const lifecycle = new Lifecycle({
    logger,
    drainDelayMs: config.SHUTDOWN_DRAIN_DELAY_MS,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });
  lifecycle.installSignalHandlers();
  const metrics = createMetrics(config.SERVICE_NAME);
  const server = startHealthServer({ port: config.PORT, lifecycle, metrics });

  const pool = createPool(config.DATABASE_URL);
  pool.on('error', (err) => logger.error({ err: String(err) }, 'ошибка соединения с PostgreSQL'));
  const boss = await createJobQueue({ connectionString: config.DATABASE_URL, logger });
  await registerJobs(boss, pool, logger);

  const ticker = new Ticker({
    pool,
    boss,
    logger,
    registry: metrics.registry,
    maxChatsFallback: config.ROUTER_MAX_CHATS_FALLBACK,
    batchSize: config.ROUTER_BATCH_SIZE,
    idleDelayMs: config.ROUTER_POLL_INTERVAL_MS,
  });
  ticker.start();

  lifecycle.onShutdown('ticker', 20, () => ticker.stop());
  lifecycle.onShutdown('pg-boss', 30, () => boss.stop({ graceful: true, timeout: 10_000 }));
  lifecycle.onShutdown('postgres', 31, () => pool.end());
  lifecycle.onShutdown('http', 40, () => new Promise<void>((r) => server.close(() => r())));
  lifecycle.markReady();
  logger.info('router запущен');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'ошибка запуска router', err: String(err) }));
  process.exit(1);
});
