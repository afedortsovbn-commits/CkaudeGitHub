import type { IncomingMessage } from 'node:http';
import { PrincipalLoader, TokenService } from '@cc/auth';
import type { EventEnvelope } from '@cc/contracts';
import { createPool } from '@cc/db';
import {
  BaseConfigSchema,
  connectNats,
  createLogger,
  createMetrics,
  ensureStream,
  EVENTS_STREAM,
  Lifecycle,
  loadConfig,
  natsServers,
  startHealthServer,
} from '@cc/service-kit';
import { DeliverPolicy, JSONCodec } from 'nats';
import { Gauge } from 'prom-client';
import { type WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { deliver, deliverApp, deliverTicket, type Peer } from './routing';

const ConfigSchema = BaseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  NATS_STREAM_REPLICAS: z.coerce.number().int().min(1).max(5).default(3),
});

const TYPING = 'cc.ephemeral.typing';
const jc = JSONCodec<Record<string, unknown>>();

interface Conn {
  ws: WebSocket;
  peer: Peer;
  alive: boolean;
  sessionId?: string;
}

/**
 * realtime: WebSocket-шлюз операторов и клиентов (02-архитектура 2.2, 6.2 п.3–4).
 * Каждый экземпляр читает все события из CC_EVENTS (эфемерный потребитель «только новые») и доставляет
 * их своим подключениям. Пропущенное за время переподключения клиенты догружают по REST — источник истины БД.
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
  const gauge = new Gauge({
    name: 'ws_connections',
    help: 'Открытые WebSocket-соединения',
    labelNames: ['kind'] as const,
    registers: [metrics.registry],
  });

  const pool = createPool(config.DATABASE_URL, { max: 5 });
  const tokens = new TokenService(config.JWT_SECRET, 900);
  const principals = new PrincipalLoader(pool, 5000);
  const conns = new Set<Conn>();
  const count = () => {
    gauge.set({ kind: 'operator' }, [...conns].filter((c) => c.peer.kind === 'operator').length);
    gauge.set({ kind: 'client' }, [...conns].filter((c) => c.peer.kind === 'client').length);
  };

  const server = startHealthServer({ port: config.PORT, lifecycle, metrics });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  async function authenticate(req: IncomingMessage): Promise<{ peer: Peer; sessionId?: string } | null> {
    const url = new URL(req.url ?? '/', 'http://x');
    const opToken = url.searchParams.get('token');
    const clientToken = url.searchParams.get('client');
    try {
      if (opToken) {
        const c = await tokens.verifyAccess(opToken);
        const principal = await principals.load(c.sub, c.sid);
        return principal ? { peer: { kind: 'operator', principal }, sessionId: c.sid } : null;
      }
      if (clientToken) {
        const c = await tokens.verifyClient(clientToken);
        const { rows } = await pool.query<{ ok: boolean }>(
          `SELECT (config -> 'allowed_origins') ? '*' OR (config -> 'allowed_origins') ? lower($2) OR ($2 = '' AND kind = 'app') AS ok
             FROM channel WHERE id = $1 AND is_active`,
          [c.channelId, String(req.headers.origin ?? '')],
        );
        return rows[0]?.ok
          ? { peer: { kind: 'client', contactId: c.contactId, channelId: c.channelId } }
          : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws') || !lifecycle.isReady) {
      socket.destroy();
      return;
    }
    void authenticate(req).then((auth) => {
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn: Conn = { ws, peer: auth.peer, alive: true, sessionId: auth.sessionId };
        conns.add(conn);
        count();
        ws.send(JSON.stringify({ type: 'hello', server: config.APP_VERSION }));
        ws.on('pong', () => (conn.alive = true));
        ws.on('close', () => {
          conns.delete(conn);
          count();
        });
        ws.on('message', (raw) => {
          let m: { type?: string; conversationId?: string; contactId?: string };
          try {
            m = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (m.type !== 'typing') return;
          if (conn.peer.kind === 'operator' && m.contactId) {
            nc.publish(
              TYPING,
              jc.encode({
                from: 'operator',
                contactId: m.contactId,
                conversationId: m.conversationId,
                name: conn.peer.principal.fullName.split(' ')[1] ?? '',
              }),
            );
          } else if (conn.peer.kind === 'client') {
            nc.publish(TYPING, jc.encode({ from: 'client', contactId: conn.peer.contactId }));
          }
        });
      });
    });
  });

  const nc = await connectNats({ servers: natsServers(config), name: config.SERVICE_NAME, logger });
  const jsm = await nc.jetstreamManager();
  await ensureStream(jsm, { ...EVENTS_STREAM, replicas: config.NATS_STREAM_REPLICAS });
  const consumer = await nc.jetstream().consumers.get('CC_EVENTS', {
    filterSubjects: ['cc.events.conversation.>', 'cc.events.ticket.>', 'cc.events.app.>'],
    deliver_policy: DeliverPolicy.New,
  });
  const messages = await consumer.consume();
  void (async () => {
    for await (const m of messages) {
      let e: EventEnvelope;
      try {
        e = m.json<EventEnvelope>();
      } catch {
        continue;
      }
      const isTicket = e.type.startsWith('ticket.');
      const isApp = e.type.startsWith('app.');
      for (const c of conns) {
        const out = isApp
          ? deliverApp(c.peer, e as never)
          : isTicket
            ? deliverTicket(c.peer, e as never)
            : deliver(c.peer, e as never);
        if (out && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(out));
      }
    }
  })();

  const typingSub = nc.subscribe(TYPING);
  void (async () => {
    for await (const m of typingSub) {
      const t = jc.decode(m.data) as { from: string; contactId: string };
      for (const c of conns) {
        const toOperator = t.from === 'client' && c.peer.kind === 'operator';
        const toClient =
          t.from === 'operator' && c.peer.kind === 'client' && c.peer.contactId === t.contactId;
        if ((toOperator || toClient) && c.ws.readyState === c.ws.OPEN)
          c.ws.send(JSON.stringify({ type: 'typing', ...t }));
      }
    }
  })();

  // Проверка живости соединений и актуальности прав операторов (отзыв сессии/прав — отключение).
  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 25_000);
  const refresh = setInterval(async () => {
    for (const c of conns) {
      if (c.peer.kind !== 'operator') continue;
      const p = await principals
        .load(c.peer.principal.id, c.sessionId!)
        .catch(() => (c.peer.kind === 'operator' ? c.peer.principal : null));
      if (!p) c.ws.close(4001, 'session revoked');
      else c.peer = { kind: 'operator', principal: p };
    }
  }, 30_000);

  lifecycle.onShutdown('websockets', 10, async () => {
    clearInterval(heartbeat);
    clearInterval(refresh);
    // 1012 Service Restart — клиенты переподключаются к другому экземпляру и догружают пропущенное.
    for (const c of conns) c.ws.close(1012, 'service restart');
    await new Promise((r) => setTimeout(r, 200));
  });
  lifecycle.onShutdown('events', 20, async () => {
    messages.stop();
    typingSub.unsubscribe();
  });
  lifecycle.onShutdown('nats', 30, () => nc.drain());
  lifecycle.onShutdown('postgres', 31, () => pool.end());
  lifecycle.onShutdown('http', 40, () => new Promise<void>((r) => server.close(() => r())));
  lifecycle.markReady();
  logger.info('realtime запущен');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'ошибка запуска realtime', err: String(err) }));
  process.exit(1);
});
