import {
  ChannelJournal,
  type ChannelInstance,
  ChannelRegistry,
  ConnectorConfigSchema,
  OutboundWorker,
  PermanentError,
} from '@cc/connector-kit';
import { type RocketDataChannelConfig, RocketDataChannelConfigSchema } from '@cc/contracts';
import { createPool } from '@cc/db';
import {
  connectNats,
  createLogger,
  createMetrics,
  ensureStream,
  retryJs,
  INBOUND_STREAM,
  KvLease,
  leaseBucket,
  Lifecycle,
  loadConfig,
  natsServers,
  OUTBOUND_STREAM,
  startHealthServer,
} from '@cc/service-kit';
import { ReviewPoller } from './poller';

/**
 * connector-rocketdata (Ф13, M-CH-10): отзывы с Google и Яндекс Карт через интегратора Rocket Data. Каждое
 * подключение к Rocket Data — экземпляр канала «Отзыв»: периодическая загрузка отзывов (владелец аренды) →
 * CC_INBOUND → обращения; ответ оператора из CC_OUTBOUND → Rocket Data → площадка. Выход в интернет нужен только к
 * API Rocket Data (через прокси: HTTPS_PROXY и NODE_USE_ENV_PROXY=1). Каналы добавляются и меняются без перезапуска.
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

  const pool = createPool(config.DATABASE_URL, { max: 5 });
  pool.on('error', (err) => logger.error({ err: String(err) }, 'ошибка соединения с PostgreSQL'));
  const nc = await connectNats({ servers: natsServers(config), name: config.SERVICE_NAME, logger });
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  const replicas = config.NATS_STREAM_REPLICAS;
  await ensureStream(jsm, { ...INBOUND_STREAM, replicas });
  await ensureStream(jsm, { ...OUTBOUND_STREAM, replicas });
  const leases = await leaseBucket(js, 'cc_leases', 45_000, replicas);
  const state = await retryJs(() => js.views.kv('cc_rd_state', { history: 1, replicas }));
  const sent = await leaseBucket(js, 'cc_outbound_sent', 7 * 24 * 3600_000, replicas);

  const journal = new ChannelJournal(pool, (err) => logger.warn({ err: String(err) }, 'журнал канала'));
  const pollers = new Map<string, ReviewPoller>();

  const reconcile = async (channels: ChannelInstance<RocketDataChannelConfig>[]) => {
    const wanted = new Map(channels.map((c) => [c.id, c]));
    for (const [id, p] of pollers) {
      const next = wanted.get(id);
      if (next && next.version === p.channel.version) continue;
      pollers.delete(id);
      await p.stop();
      if (!next) journal.status(id, 'disabled', 'канал выключен');
    }
    for (const c of channels) {
      if (pollers.has(c.id)) continue;
      const p = new ReviewPoller(c, {
        js,
        lease: new KvLease(leases, `rd.${c.id}`, config.INSTANCE_ID),
        state,
        journal,
        logger,
      });
      pollers.set(c.id, p);
      p.start();
      logger.info({ channelId: c.id, intervalS: c.config.poll_interval_s }, 'канал Rocket Data подключён');
    }
  };
  const registry = new ChannelRegistry<RocketDataChannelConfig>({
    pool,
    js,
    jsm,
    kind: 'review',
    schema: RocketDataChannelConfigSchema,
    secretsKey: config.SECRETS_KEY,
    reloadMs: config.CHANNEL_RELOAD_MS,
    replicas,
    logger,
    journal,
    onChange: reconcile,
  });

  const server = startHealthServer({ port: config.PORT, lifecycle, metrics });

  await registry.start();
  // Ответы на отзывы: общий durable-потребитель всех экземпляров; повтор POST безопасен — ключ идемпотентности
  // (id сообщения) в Rocket Data плюс отметка «отправлено» в NATS KV.
  const outbound = new OutboundWorker({
    js,
    jsm,
    kind: 'review',
    sent,
    maxAttempts: config.OUTBOUND_MAX_ATTEMPTS,
    logger,
    journal,
    send: async (msg) => {
      const p = pollers.get(msg.channelId);
      if (!p) throw new Error('канал выключен или ещё не загружен');
      if (msg.attachments.length) throw new PermanentError('площадка отзывов не принимает файлы');
      if (!msg.body.trim()) throw new PermanentError('пустой ответ на отзыв');
      const r = await p.api.answer(msg.to, msg.body, msg.messageId);
      journal.log(
        msg.channelId,
        'out',
        `ответ на отзыв: ${r.status === 'published' ? 'опубликован' : 'принят, ждёт публикации'}`,
      );
      return { externalId: `rd-answer:${msg.channelId}:${r.id ?? msg.messageId}` };
    },
  });
  await outbound.start();

  lifecycle.onShutdown('outbound', 20, () => outbound.stop());
  lifecycle.onShutdown('pollers', 21, async () => {
    registry.stop();
    await Promise.all([...pollers.values()].map((p) => p.stop()));
  });
  lifecycle.onShutdown('nats', 30, () => nc.drain());
  lifecycle.onShutdown('postgres', 31, () => pool.end());
  lifecycle.onShutdown('http', 40, () => new Promise<void>((r) => server.close(() => r())));
  lifecycle.markReady();
  logger.info('connector-rocketdata запущен');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({ level: 'fatal', msg: 'ошибка запуска connector-rocketdata', err: String(err) }),
  );
  process.exit(1);
});
