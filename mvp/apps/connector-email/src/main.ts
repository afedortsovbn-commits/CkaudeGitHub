import {
  ChannelJournal,
  type ChannelInstance,
  ChannelRegistry,
  ConnectorConfigSchema,
  ConnectorStorage,
  OutboundWorker,
} from '@cc/connector-kit';
import { type EmailChannelConfig, EmailChannelConfigSchema } from '@cc/contracts';
import { createPool } from '@cc/db';
import {
  connectNats,
  createLogger,
  createMetrics,
  ensureStream,
  INBOUND_STREAM,
  KvLease,
  leaseBucket,
  Lifecycle,
  loadConfig,
  natsServers,
  OUTBOUND_STREAM,
  startHealthServer,
} from '@cc/service-kit';
import { MailboxRunner } from './mailbox';

/**
 * connector-email: почтовые ящики как экземпляры канала (M-CH-06/07). Каждый ящик опрашивает ровно один
 * экземпляр (аренда в NATS KV) — ящики распределяются между экземплярами; ответы операторов отправляет
 * любой экземпляр по SMTP. Ящики добавляются и выключаются в админке без перезапуска.
 */
async function main(): Promise<void> {
  const config = loadConfig(ConnectorConfigSchema);
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

  const pool = createPool(config.DATABASE_URL, { max: 5 });
  pool.on('error', (err) => logger.error({ err: String(err) }, 'ошибка соединения с PostgreSQL'));
  const nc = await connectNats({ servers: natsServers(config), name: config.SERVICE_NAME, logger });
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  const replicas = config.NATS_STREAM_REPLICAS;
  await ensureStream(jsm, { ...INBOUND_STREAM, replicas });
  await ensureStream(jsm, { ...OUTBOUND_STREAM, replicas });
  const leases = await leaseBucket(js, 'cc_leases', 45_000, replicas);
  const state = await js.views.kv('cc_mail_state', { history: 1, replicas });
  const sent = await leaseBucket(js, 'cc_outbound_sent', 7 * 24 * 3600_000, replicas);

  const journal = new ChannelJournal(pool, (err) => logger.warn({ err: String(err) }, 'журнал канала'));
  const storage = new ConnectorStorage({
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    pool,
  });
  const runners = new Map<string, MailboxRunner>();

  const reconcile = async (channels: ChannelInstance<EmailChannelConfig>[]) => {
    const wanted = new Map(channels.map((c) => [c.id, c]));
    for (const [id, r] of runners) {
      const next = wanted.get(id);
      if (next && next.version === r.channel.version) continue;
      runners.delete(id);
      await r.stop();
      if (!next) journal.status(id, 'disabled', 'канал выключен');
    }
    for (const c of channels) {
      if (runners.has(c.id)) continue;
      const r = new MailboxRunner(c, {
        js,
        lease: new KvLease(leases, `mail.${c.id}`, config.INSTANCE_ID),
        state,
        storage,
        journal,
        logger,
      });
      runners.set(c.id, r);
      r.start();
      logger.info({ channelId: c.id }, 'почтовый ящик подключён');
    }
  };
  const registry = new ChannelRegistry<EmailChannelConfig>({
    pool,
    js,
    jsm,
    kind: 'email',
    schema: EmailChannelConfigSchema,
    secretsKey: config.SECRETS_KEY,
    reloadMs: config.CHANNEL_RELOAD_MS,
    replicas,
    logger,
    journal,
    onChange: reconcile,
  });
  await registry.start();

  const outbound = new OutboundWorker({
    js,
    jsm,
    kind: 'email',
    sent,
    maxAttempts: config.OUTBOUND_MAX_ATTEMPTS,
    logger,
    journal,
    send: async (msg) => {
      const runner = runners.get(msg.channelId);
      if (!runner) throw new Error('почтовый ящик выключен или ещё не загружен');
      return runner.send(msg);
    },
  });
  await outbound.start();

  lifecycle.onShutdown('outbound', 20, () => outbound.stop());
  lifecycle.onShutdown('mailboxes', 21, async () => {
    registry.stop();
    await Promise.all([...runners.values()].map((r) => r.stop()));
  });
  lifecycle.onShutdown('nats', 30, () => nc.drain());
  lifecycle.onShutdown('postgres', 31, () => pool.end());
  lifecycle.onShutdown('http', 40, () => new Promise<void>((r) => server.close(() => r())));
  lifecycle.markReady();
  logger.info('connector-email запущен');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'ошибка запуска connector-email', err: String(err) }));
  process.exit(1);
});
