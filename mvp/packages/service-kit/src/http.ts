import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Lifecycle } from './lifecycle';
import type { Metrics } from './metrics';

/**
 * HTTP-сервер проверок для сервисов без веб-фреймворка: /healthz, /readyz, /metrics.
 * handler — дополнительные маршруты (возвращает true, если запрос обработан).
 */
export function startHealthServer(opts: {
  port: number;
  lifecycle: Lifecycle;
  metrics: Metrics;
  handler?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
}): Server {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz') {
      res
        .writeHead(opts.lifecycle.isLive ? 200 : 503)
        .end(JSON.stringify({ status: opts.lifecycle.current }));
      return;
    }
    if (path === '/readyz') {
      res
        .writeHead(opts.lifecycle.isReady ? 200 : 503)
        .end(JSON.stringify({ status: opts.lifecycle.current }));
      return;
    }
    if (path === '/metrics') {
      res
        .writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        .end(await opts.metrics.registry.metrics());
      return;
    }
    if (opts.handler && (await opts.handler(req, res))) return;
    res.writeHead(404).end();
  });
  server.keepAliveTimeout = 120_000;
  server.listen(opts.port, '0.0.0.0');
  return server;
}
