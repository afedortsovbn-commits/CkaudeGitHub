import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import type { AppContext } from './context';
import { ErrorFilter } from './lib/errors';
import { correlationIdFrom, withCorrelation } from '@cc/service-kit';

/** Создаёт HTTP-приложение (используется в main и в интеграционных тестах). */
export async function createApp(ctx: AppContext): Promise<NestFastifyApplication> {
  // keepAliveTimeout больше idle-таймаута Traefik (90 с): соединение закрывает балансировщик, а не сервис.
  const adapter = new FastifyAdapter({
    keepAliveTimeout: 120_000,
    return503OnClosing: false,
    trustProxy: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(ctx), adapter, {
    logger: false,
    abortOnError: false,
  });
  await app.register(fastifyCookie as never);
  app.useGlobalFilters(new ErrorFilter((err) => ctx.logger.error({ err }, 'необработанная ошибка')));
  const fastify = app.getHttpAdapter().getInstance();
  // Файлы (вложения) — сырыми байтами (в т.ч. text/plain: текстовые файлы бывают не в UTF-8); JSON — как обычно.
  const raw = { parseAs: 'buffer' as const, bodyLimit: (ctx.config.MAX_UPLOAD_MB + 1) * 1024 * 1024 };
  fastify.removeContentTypeParser('text/plain');
  fastify.addContentTypeParser('text/plain', raw, (_req, body, done) => done(null, body));
  fastify.addContentTypeParser('*', raw, (_req, body, done) => done(null, body));
  // correlation-id (M-NFR-04): из заголовка x-request-id или новый; возвращается в ответе, попадает в логи и в
  // traceId событий, созданных запросом (service-kit trace.ts).
  fastify.addHook('onRequest', (req, reply, done) => {
    const id = correlationIdFrom(req.headers['x-request-id']);
    reply.header('x-request-id', id);
    withCorrelation(id, done);
  });
  // CORS только для клиентского API виджета: он встраивается на сайты заказчика (разрешённые домены — в настройках канала).
  fastify.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/client/')) return;
    const origin = req.headers.origin;
    if (origin && (await ctx.allowedOrigins?.(origin))) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-headers', 'authorization, content-type, x-filename');
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      reply.header('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') return reply.status(204).send();
  });
  fastify.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unknown';
    ctx.metrics.httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) });
    ctx.metrics.httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });
  // Во время остановки просим клиента/балансировщик не переиспользовать соединение.
  fastify.addHook('onSend', async (_req, reply) => {
    if (!ctx.lifecycle.isReady) reply.header('connection', 'close');
  });
  return app;
}
