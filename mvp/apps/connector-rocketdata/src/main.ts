import {
  ChannelJournal,
  type ChannelInstance,
  ChannelRegistry,
  ConnectorConfigSchema,
  OutboundWorker,
  PermanentError,
  publishInbound,
} from '@cc/connector-kit';
import { newId, type RocketDataChannelConfig, RocketDataChannelConfigSchema } from '@cc/contracts';
import { createPool } from '@cc/db';
import {
  connectNats,
  createLogger,
  createMetrics,
  ensureStream,
  INBOUND_STREAM,
  leaseBucket,
  Lifecycle,
  loadConfig,
  natsServers,
  OUTBOUND_STREAM,
  startHealthServer,
} from '@cc/service-kit';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseRdReview, RdFormatError, sendRdAnswer } from './rocketdata-api';
import { reviewToInbound } from './reviews';

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new RdFormatError('слишком большой запрос'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));

/**
 * connector-rocketdata (Ф13, M-CH-10): отзывы с карт через интегратора Rocket Data — по описанию заказчика (В-32).
 * Каждое подключение — экземпляр канала «Отзыв»:
 *  - отзыв Rocket Data присылает сама: POST <адрес КЦ>/rd/<id канала> (маршрут Traefik, принимают все экземпляры) →
 *    CC_INBOUND → обращение; HTTP 200 — только после записи в поток (отзыв уже не потеряется);
 *  - ответ оператора из CC_OUTBOUND → POST на адрес сервиса ответов канала. Адрес не задан — ответ не отправляется.
 * Каналы добавляются и меняются без перезапуска. Выход в интернет — только к сервису ответов (через прокси:
 * HTTPS_PROXY и NODE_USE_ENV_PROXY=1).
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
  const sent = await leaseBucket(js, 'cc_outbound_sent', 7 * 24 * 3600_000, replicas);

  const journal = new ChannelJournal(pool, (err) => logger.warn({ err: String(err) }, 'журнал канала'));
  let channels = new Map<string, ChannelInstance<RocketDataChannelConfig>>();

  const reconcile = (list: ChannelInstance<RocketDataChannelConfig>[]) => {
    const next = new Map(list.map((c) => [c.id, c]));
    for (const id of channels.keys()) if (!next.has(id)) journal.status(id, 'disabled', 'канал выключен');
    for (const c of list) {
      const before = channels.get(c.id);
      if (before?.version === c.version) continue;
      journal.status(
        c.id,
        'connected',
        c.config.answer_url ? 'приём отзывов; ответы отправляются' : 'приём отзывов; адрес ответов не задан',
      );
      logger.info({ channelId: c.id, answers: !!c.config.answer_url }, 'канал Rocket Data подключён');
    }
    channels = next;
    return Promise.resolve();
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

  // Приём отзыва: POST /rd/<id канала>. Неизвестный или выключенный канал — 404, ошибка формата — 400.
  const webhook = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const m = /^\/rd\/([0-9a-f-]{36})\/?$/.exec((req.url ?? '').split('?')[0]!);
    if (!m) return false;
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return true;
    }
    const channel = channels.get(m[1]!);
    if (!channel) {
      json(res, 404, { error: 'not_found', message: 'канал отзывов не найден или выключен' });
      return true;
    }
    try {
      const review = parseRdReview(await readBody(req));
      await publishInbound(js, { ...reviewToInbound(review, channel), id: newId(), receivedAt: Date.now() });
      journal.log(channel.id, 'in', `отзыв ${review.TicketMapId} принят`);
      json(res, 200, { result: 'ok', TicketMapId: review.TicketMapId });
    } catch (err) {
      if (err instanceof RdFormatError) {
        journal.log(channel.id, 'in', `отзыв отклонён: ${err.message}`, false);
        json(res, 400, { error: 'validation', message: err.message, details: err.details });
      } else {
        // Поток недоступен — Rocket Data получит ошибку и сможет повторить (повтор не создаст дубля).
        logger.warn({ err: String(err), channelId: channel.id }, 'отзыв не принят — ошибка записи в поток');
        json(res, 503, { error: 'unavailable', message: 'временная ошибка, повторите запрос' });
      }
    }
    return true;
  };
  const server = startHealthServer({ port: config.PORT, lifecycle, metrics, handler: webhook });

  await registry.start();
  // Ответы на отзывы: общий durable-потребитель всех экземпляров; повторную отправку исключает отметка
  // «отправлено» в NATS KV.
  const outbound = new OutboundWorker({
    js,
    jsm,
    kind: 'review',
    sent,
    maxAttempts: config.OUTBOUND_MAX_ATTEMPTS,
    logger,
    journal,
    send: async (msg) => {
      const c = channels.get(msg.channelId);
      if (!c) throw new Error('канал выключен или ещё не загружен');
      if (msg.attachments.length) throw new PermanentError('площадка отзывов не принимает файлы');
      if (!msg.body.trim()) throw new PermanentError('пустой ответ на отзыв');
      if (!c.config.answer_url)
        throw new PermanentError('не задан адрес сервиса ответов Rocket Data (настройки канала)');
      await sendRdAnswer(c.config.answer_url, {
        reviewId: msg.to,
        text: msg.body,
        at: new Date(),
        idempotencyKey: msg.messageId,
      });
      journal.log(msg.channelId, 'out', `ответ на отзыв ${msg.to} передан в Rocket Data`);
      return { externalId: `rd-answer:${msg.channelId}:${msg.messageId}` };
    },
  });
  await outbound.start();

  lifecycle.onShutdown('outbound', 20, () => outbound.stop());
  lifecycle.onShutdown('channels', 21, () => {
    registry.stop();
    return Promise.resolve();
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
