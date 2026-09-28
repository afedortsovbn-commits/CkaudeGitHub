import { createPool } from '@cc/db';
import {
  BaseConfigSchema,
  connectNats,
  createLogger,
  createMetrics,
  leaseBucket,
  Lifecycle,
  loadConfig,
  natsServers,
  startHealthServer,
} from '@cc/service-kit';
import { Gauge } from 'prom-client';
import { z } from 'zod';
import { Ari } from './ari';
import { MediaNode } from './node';
import { RecordingStore } from './recordings';

const ConfigSchema = BaseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  NATS_STREAM_REPLICAS: z.coerce.number().int().min(1).max(5).default(3),
  ARI_USER: z.string().default('cc'),
  ARI_PASSWORD: z.string().min(1),
  /** Узлы Asterisk: имя[:порт ARI], через запятую. */
  MEDIA_NODES: z.string().default('asterisk-1,asterisk-2'),
  SIP_PROXY: z.string().default('kamailio:5060'),
  /** Номер КЦ, который видит абонент при исходящем вызове и прямом переводе. */
  OUTBOUND_CALLER_ID: z.string().default('"Контакт-центр" <1000>'),
  CALL_TICK_MS: z.coerce.number().int().min(50).default(300),
  /** TTL аренды узла: за это время резервный подхватит узел при аварийном падении активного. */
  MEDIA_LEASE_TTL_MS: z.coerce.number().int().min(2000).default(4000),
  S3_ENDPOINT: z.string().url().default('http://s3:8333'),
  S3_BUCKET: z.string().default('cc-files'),
  S3_ACCESS_KEY: z.string().default('cc'),
  S3_SECRET_KEY: z.string().default('cc-secret'),
  INSTANCE_ID: z.string().default(process.env.HOSTNAME ?? 'call-control'),
});

/**
 * call-control: ARI-приложение «cc» (02-архитектура 2.2, 4.2, 6.3). На каждый узел Asterisk — активный
 * экземпляр (аренда узла в NATS KV) и резервный; разговоры держит мост Asterisk, поэтому переключение
 * экземпляров их не прерывает. Пока без IVR (Ф6): вызов → обращение → очередь с музыкой → router →
 * звонок оператору → мост и запись → выгрузка записи → журнал вызова.
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
  const leading = new Gauge({
    name: 'cc_call_control_leading_nodes',
    help: 'Узлы Asterisk, для которых этот экземпляр call-control — активный',
    registers: [metrics.registry],
  });
  const server = startHealthServer({ port: config.PORT, lifecycle, metrics });

  const pool = createPool(config.DATABASE_URL, { max: 10 });
  pool.on('error', (err) => logger.error({ err: String(err) }, 'ошибка соединения с PostgreSQL'));
  const nc = await connectNats({ servers: natsServers(config), name: config.SERVICE_NAME, logger });
  const js = nc.jetstream();
  const leases = await leaseBucket(
    js,
    'cc_media_leases',
    config.MEDIA_LEASE_TTL_MS,
    config.NATS_STREAM_REPLICAS,
  );
  const store = new RecordingStore({
    pool,
    logger,
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
  });

  const nodes = config.MEDIA_NODES.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const [host, port = '8088'] = spec.split(':');
      return new MediaNode({
        name: host!,
        ari: new Ari(`http://${host}:${port}/ari`, config.ARI_USER, config.ARI_PASSWORD),
        pool,
        nc,
        leases,
        instanceId: config.INSTANCE_ID,
        logger,
        store,
        sipProxy: config.SIP_PROXY,
        tickMs: config.CALL_TICK_MS,
        outboundCallerId: config.OUTBOUND_CALLER_ID,
        onLeadership: (_node, leader) => leading.inc(leader ? 1 : -1),
      });
    });
  for (const n of nodes) n.start();

  lifecycle.onShutdown('media-nodes', 20, () =>
    Promise.all(nodes.map((n) => n.stop())).then(() => undefined),
  );
  lifecycle.onShutdown('nats', 30, () => nc.drain());
  lifecycle.onShutdown('postgres', 31, () => pool.end());
  lifecycle.onShutdown('http', 40, () => new Promise<void>((r) => server.close(() => r())));
  lifecycle.markReady();
  logger.info({ nodes: nodes.map((n) => n.name) }, 'call-control запущен');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'ошибка запуска call-control', err: String(err) }));
  process.exit(1);
});
