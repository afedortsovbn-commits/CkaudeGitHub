import { createPool } from '@cc/db';
import {
  connectNats,
  createLogger,
  createMetrics,
  ensureStream,
  EVENTS_STREAM,
  INBOUND_STREAM,
  Lifecycle,
  loadConfig,
  BaseConfigSchema,
  natsServers,
  OUTBOUND_STREAM,
  OutboxRelay,
  startHealthServer,
} from '@cc/service-kit';
import { z } from 'zod';
import { DeliveryProcessor } from './delivery';
import { InboundProcessor } from './inbound';

const ConfigSchema = BaseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  NATS_STREAM_REPLICAS: z.coerce.number().int().min(1).max(5).default(3),
});

/** worker: фоновая обработка — входящие сообщения каналов, outbox-relay; далее автоответы, боты, уведомления. */
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
  const nc = await connectNats({ servers: natsServers(config), name: config.SERVICE_NAME, logger });
  const jsm = await nc.jetstreamManager();
  await ensureStream(jsm, { ...EVENTS_STREAM, replicas: config.NATS_STREAM_REPLICAS });
  await ensureStream(jsm, { ...INBOUND_STREAM, replicas: config.NATS_STREAM_REPLICAS });
  await ensureStream(jsm, { ...OUTBOUND_STREAM, replicas: config.NATS_STREAM_REPLICAS });

  const inbound = new InboundProcessor({ pool, js: nc.jetstream(), jsm, logger, registry: metrics.registry });
  await inbound.start();
  const delivery = new DeliveryProcessor({ pool, js: nc.jetstream(), jsm, logger });
  await delivery.start();
  const relay = new OutboxRelay({ pool, js: nc.jetstream(), logger });
  if (config.OUTBOX_RELAY_ENABLED) relay.start();

  lifecycle.onShutdown('inbound', 20, () => inbound.stop());
  lifecycle.onShutdown('delivery', 20, () => delivery.stop());
  lifecycle.onShutdown('outbox-relay', 21, () => relay.stop());
  lifecycle.onShutdown('nats', 30, () => nc.drain());
  lifecycle.onShutdown('postgres', 31, () => pool.end());
  lifecycle.onShutdown('http', 40, () => new Promise<void>((r) => server.close(() => r())));
  lifecycle.markReady();
  logger.info('worker запущен');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'ошибка запуска worker', err: String(err) }));
  process.exit(1);
});
