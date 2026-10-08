import 'reflect-metadata';
import { createPool, migrate } from '@cc/db';
import {
  connectNats,
  createJobQueue,
  createLogger,
  ensureJobQueue,
  createMetrics,
  ensureStream,
  EVENTS_STREAM,
  INBOUND_STREAM,
  Lifecycle,
  loadConfig,
  natsServers,
  OUTBOUND_STREAM,
  OutboxRelay,
} from '@cc/service-kit';
import { createApp } from './app.factory';
import { PrincipalLoader } from '@cc/auth';
import { TokenService } from '@cc/auth';
import { ApiConfigSchema, type AppContext } from './context';
import { originsCache } from './chat/origins';
import { createS3Storage } from './lib/storage';
import { serveIntegrations } from './ivr/responder';
import { runRecordingRetention } from './privacy/privacy';

/** Очистка записей разговоров по сроку хранения (M-NFR-07, В-11): раз в час, один экземпляр api (pg-boss). */
const RETENTION_QUEUE = 'recording-retention';

async function bootstrap(): Promise<void> {
  const config = loadConfig(ApiConfigSchema);
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

  const pool = createPool(config.DATABASE_URL, { max: config.PG_POOL_MAX });
  // Экземпляр отчётов (API_ROLE=reports) только отвечает на запросы: фоновые задачи — у основных экземпляров.
  const full = config.API_ROLE === 'full';
  pool.on('error', (err) => logger.error({ err: String(err) }, 'ошибка соединения с PostgreSQL'));
  if (config.RUN_MIGRATIONS === 'true') {
    await migrate(pool, { log: (m) => logger.info(m) });
  }

  const nc = await connectNats({ servers: natsServers(config), name: config.SERVICE_NAME, logger });
  await ensureStream(await nc.jetstreamManager(), {
    ...EVENTS_STREAM,
    replicas: config.NATS_STREAM_REPLICAS,
  });
  await ensureStream(await nc.jetstreamManager(), {
    ...INBOUND_STREAM,
    replicas: config.NATS_STREAM_REPLICAS,
  });
  // Исходящие коннекторов публикует и outbox-relay api — поток должен существовать до его запуска.
  await ensureStream(await nc.jetstreamManager(), {
    ...OUTBOUND_STREAM,
    replicas: config.NATS_STREAM_REPLICAS,
  });
  const storage = createS3Storage({
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
  });
  await storage.ensureBucket();
  const relay = new OutboxRelay({ pool, js: nc.jetstream(), logger });
  if (config.OUTBOX_RELAY_ENABLED && full) relay.start();

  const ctx: AppContext = {
    config,
    logger,
    lifecycle,
    metrics,
    pool,
    tokens: new TokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SEC),
    principals: new PrincipalLoader(pool),
    js: nc.jetstream(),
    nc,
    storage,
    allowedOrigins: originsCache(pool),
  };
  const app = await createApp(ctx);
  // Интеграционные операции для IVR и ботов (NATS request/reply, группа очереди — любой экземпляр api).
  const integrations = full
    ? serveIntegrations(nc, { pool, secretsKey: config.SECRETS_KEY, logger })
    : { stop: async () => undefined };
  const fastify = app.getHttpAdapter().getInstance();

  // Освободившиеся keep-alive соединения закрываем сами, иначе закрытие ждало бы keepAliveTimeout.
  lifecycle.onShutdown('http', 10, async () => {
    const t = setInterval(() => fastify.server.closeIdleConnections(), 250);
    try {
      await app.close();
    } finally {
      clearInterval(t);
    }
  });
  if (full) {
    const boss = await createJobQueue({ connectionString: config.DATABASE_URL, logger });
    await ensureJobQueue(boss, RETENTION_QUEUE);
    await boss.work(RETENTION_QUEUE, async () => {
      const r = await runRecordingRetention(pool, storage);
      if (r.deleted) logger.info(r, 'записи разговоров удалены по сроку хранения');
    });
    await boss.schedule(RETENTION_QUEUE, '17 * * * *');
    lifecycle.onShutdown('pg-boss', 24, () => boss.stop({ graceful: true, timeout: 10_000 }));
  }
  lifecycle.onShutdown('outbox-relay', 20, () => relay.stop());
  lifecycle.onShutdown('integrations', 25, () => integrations.stop());
  lifecycle.onShutdown('nats', 30, () => nc.drain());
  lifecycle.onShutdown('postgres', 31, () => pool.end());

  await app.listen(config.PORT, '0.0.0.0');
  lifecycle.markReady();
  logger.info({ port: config.PORT, role: config.API_ROLE }, 'api запущен');
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'ошибка запуска', err: String(err) }));
  process.exit(1);
});
