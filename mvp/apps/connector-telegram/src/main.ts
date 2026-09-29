import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ChannelJournal,
  type ChannelInstance,
  ChannelRegistry,
  ConnectorConfigSchema,
  ConnectorStorage,
  OutboundWorker,
} from '@cc/connector-kit';
import { type TelegramChannelConfig, TelegramChannelConfigSchema } from '@cc/contracts';
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
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BotRunner } from './bot';
import type { TgUpdate } from './telegram-api';

const ConfigSchema = ConnectorConfigSchema.extend({
  /** Внешний адрес КЦ для режима webhook (Telegram присылает обновления на <адрес>/tg/<id канала>). */
  PUBLIC_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
});

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new Error('слишком большой запрос'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sameSecret = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * connector-telegram: боты Telegram как экземпляры канала (M-CH-05/07). Приём — long-polling (владелец
 * аренды) или webhook (все экземпляры); ответы операторов — из CC_OUTBOUND. Добавление, выключение и
 * изменение ботов в админке применяются без перезапуска.
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

  const pool = createPool(config.DATABASE_URL, { max: 5 });
  pool.on('error', (err) => logger.error({ err: String(err) }, 'ошибка соединения с PostgreSQL'));
  const nc = await connectNats({ servers: natsServers(config), name: config.SERVICE_NAME, logger });
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  const replicas = config.NATS_STREAM_REPLICAS;
  await ensureStream(jsm, { ...INBOUND_STREAM, replicas });
  await ensureStream(jsm, { ...OUTBOUND_STREAM, replicas });
  const leases = await leaseBucket(js, 'cc_leases', 45_000, replicas);
  const offsets = await js.views.kv('cc_tg_offsets', { history: 1, replicas });
  const sent = await leaseBucket(js, 'cc_outbound_sent', 7 * 24 * 3600_000, replicas);

  const journal = new ChannelJournal(pool, (err) => logger.warn({ err: String(err) }, 'журнал канала'));
  const storage = new ConnectorStorage({
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    pool,
  });
  const runners = new Map<string, BotRunner>();

  const reconcile = async (channels: ChannelInstance<TelegramChannelConfig>[]) => {
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
      const r = new BotRunner(c, {
        js,
        lease: new KvLease(leases, `tg.${c.id}`, config.INSTANCE_ID),
        offsets,
        storage,
        journal,
        logger,
        publicBaseUrl: config.PUBLIC_BASE_URL,
      });
      runners.set(c.id, r);
      r.start();
      logger.info({ channelId: c.id, mode: c.config.mode }, 'бот Telegram подключён');
    }
  };
  const registry = new ChannelRegistry<TelegramChannelConfig>({
    pool,
    js,
    jsm,
    kind: 'telegram',
    schema: TelegramChannelConfigSchema,
    secretsKey: config.SECRETS_KEY,
    reloadMs: config.CHANNEL_RELOAD_MS,
    replicas,
    logger,
    journal,
    onChange: reconcile,
  });

  // Webhook: POST /tg/<id канала>, секрет — заголовок X-Telegram-Bot-Api-Secret-Token.
  const webhook = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const m = /^\/tg\/([0-9a-f-]{36})$/.exec((req.url ?? '').split('?')[0]!);
    if (!m || req.method !== 'POST') return false;
    const runner = runners.get(m[1]!);
    const secret = String(req.headers['x-telegram-bot-api-secret-token'] ?? '');
    const expected = runner?.channel.config.webhook_secret;
    if (!runner || runner.channel.config.mode !== 'webhook' || !expected || !sameSecret(secret, expected)) {
      res.writeHead(404).end();
      return true;
    }
    try {
      await runner.handleUpdate(JSON.parse(await readBody(req)) as TgUpdate);
      res.writeHead(200).end('{}');
    } catch (err) {
      logger.warn({ err: String(err), channelId: m[1] }, 'не удалось принять webhook — Telegram повторит');
      res.writeHead(500).end();
    }
    return true;
  };
  const server = startHealthServer({ port: config.PORT, lifecycle, metrics, handler: webhook });

  await registry.start();
  const outbound = new OutboundWorker({
    js,
    jsm,
    kind: 'telegram',
    sent,
    maxAttempts: config.OUTBOUND_MAX_ATTEMPTS,
    logger,
    journal,
    send: async (msg) => {
      const runner = runners.get(msg.channelId);
      if (!runner) throw new Error('бот выключен или ещё не загружен');
      let last: { message_id: number } | undefined;
      if (msg.body) last = await runner.api.sendMessage(msg.to, msg.body, msg.buttons);
      for (const a of msg.attachments) last = await runner.api.sendDocument(msg.to, await storage.read(a.id));
      return { externalId: last ? `tg-out:${msg.channelId}:${msg.to}:${last.message_id}` : null };
    },
  });
  await outbound.start();

  lifecycle.onShutdown('outbound', 20, () => outbound.stop());
  lifecycle.onShutdown('bots', 21, async () => {
    registry.stop();
    await Promise.all([...runners.values()].map((r) => r.stop()));
  });
  lifecycle.onShutdown('nats', 30, () => nc.drain());
  lifecycle.onShutdown('postgres', 31, () => pool.end());
  lifecycle.onShutdown('http', 40, () => new Promise<void>((r) => server.close(() => r())));
  lifecycle.markReady();
  logger.info('connector-telegram запущен');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({ level: 'fatal', msg: 'ошибка запуска connector-telegram', err: String(err) }),
  );
  process.exit(1);
});
