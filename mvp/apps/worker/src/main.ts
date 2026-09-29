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
  createJobQueue,
  natsServers,
  OUTBOUND_STREAM,
  OutboxRelay,
  startHealthServer,
} from '@cc/service-kit';
import { z } from 'zod';
import { Automation } from './automation';
import { DeliveryProcessor } from './delivery';
import { InboundProcessor } from './inbound';
import { TicketMailer } from './tickets';

const ConfigSchema = BaseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  NATS_STREAM_REPLICAS: z.coerce.number().int().min(1).max(5).default(3),
  /** Период обхода дедлайнов автоматизации (автозакрытие, зависшие шаги бота). */
  AUTOMATION_SWEEP_MS: z.coerce.number().int().min(200).default(2000),
  // ---- Письма по тикетам 2-й линии (Ф8): SMTP заказчика. Без SMTP_HOST письма копятся в очереди. ----
  SMTP_HOST: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  SMTP_PORT: z.coerce.number().int().default(25),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_TLS_INSECURE: z.enum(['true', 'false']).default('false'),
  SMTP_FROM: z.string().default('Контакт-центр <cc@cc.local>'),
  /** Адрес системы для ссылок в письмах. */
  PUBLIC_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().default('https://localhost'),
  ),
  MAIL_POLL_MS: z.coerce.number().int().min(200).default(2000),
});

/** worker: фоновая обработка — входящие сообщения каналов, автоответы и боты (Ф7), статусы доставки, outbox-relay. */
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

  const automation = new Automation({ pool, nc, logger, sweepMs: config.AUTOMATION_SWEEP_MS });
  const inbound = new InboundProcessor({
    pool,
    js: nc.jetstream(),
    jsm,
    logger,
    registry: metrics.registry,
    onBotHttp: automation.runHttp,
  });
  await inbound.start();
  const delivery = new DeliveryProcessor({ pool, js: nc.jetstream(), jsm, logger });
  await delivery.start();
  const relay = new OutboxRelay({ pool, js: nc.jetstream(), logger });
  if (config.OUTBOX_RELAY_ENABLED) relay.start();
  automation.start();
  const boss = await createJobQueue({ connectionString: config.DATABASE_URL, logger });
  const mailer = new TicketMailer({
    pool,
    boss,
    logger,
    pollMs: config.MAIL_POLL_MS,
    smtp: {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE === 'true',
      user: config.SMTP_USER,
      password: config.SMTP_PASSWORD,
      tlsInsecure: config.SMTP_TLS_INSECURE === 'true',
      mail: { from: config.SMTP_FROM, baseUrl: config.PUBLIC_BASE_URL },
    },
  });
  await mailer.start();

  lifecycle.onShutdown('inbound', 20, () => inbound.stop());
  lifecycle.onShutdown('delivery', 20, () => delivery.stop());
  lifecycle.onShutdown('automation', 21, () => automation.stop());
  lifecycle.onShutdown('outbox-relay', 21, () => relay.stop());
  lifecycle.onShutdown('ticket-mailer', 21, () => mailer.stop());
  lifecycle.onShutdown('pg-boss', 25, () => boss.stop({ graceful: true, timeout: 10_000 }));
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
