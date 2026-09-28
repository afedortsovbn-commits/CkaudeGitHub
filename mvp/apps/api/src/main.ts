import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPool, migrate } from '@cc/db';
import {
  connectNats,
  createLogger,
  createMetrics,
  ensureStream,
  EVENTS_STREAM,
  Lifecycle,
  loadConfig,
  natsServers,
  OutboxRelay,
} from '@cc/service-kit';
import { AppModule } from './app.module';
import { ApiConfigSchema, type AppContext } from './context';

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

  const pool = createPool(config.DATABASE_URL);
  pool.on('error', (err) => logger.error({ err: String(err) }, 'ошибка соединения с PostgreSQL'));
  if (config.RUN_MIGRATIONS === 'true') {
    await migrate(pool, { log: (m) => logger.info(m) });
  }

  const nc = await connectNats({ servers: natsServers(config), name: config.SERVICE_NAME, logger });
  await ensureStream(await nc.jetstreamManager(), {
    ...EVENTS_STREAM,
    replicas: config.NATS_STREAM_REPLICAS,
  });
  const relay = new OutboxRelay({ pool, js: nc.jetstream(), logger });
  if (config.OUTBOX_RELAY_ENABLED) relay.start();

  const ctx: AppContext = { config, logger, lifecycle, metrics, pool };
  // keepAliveTimeout больше idle-таймаута Traefik (90 с): соединение закрывает балансировщик, а не сервис.
  const adapter = new FastifyAdapter({ keepAliveTimeout: 120_000, return503OnClosing: false });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(ctx), adapter, {
    logger: false,
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unknown';
    metrics.httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) });
    metrics.httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });

  // Во время остановки: просим клиента/балансировщик не переиспользовать соединение и закрываем
  // освободившиеся keep-alive соединения, иначе закрытие ждало бы keepAliveTimeout.
  fastify.addHook('onSend', async (_req, reply) => {
    if (!lifecycle.isReady) reply.header('connection', 'close');
  });
  lifecycle.onShutdown('http', 10, async () => {
    const t = setInterval(() => fastify.server.closeIdleConnections(), 250);
    try {
      await app.close();
    } finally {
      clearInterval(t);
    }
  });
  lifecycle.onShutdown('outbox-relay', 20, () => relay.stop());
  lifecycle.onShutdown('nats', 30, () => nc.drain());
  lifecycle.onShutdown('postgres', 31, () => pool.end());

  await app.listen(config.PORT, '0.0.0.0');
  lifecycle.markReady();
  logger.info({ port: config.PORT }, 'api запущен');
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'ошибка запуска', err: String(err) }));
  process.exit(1);
});
