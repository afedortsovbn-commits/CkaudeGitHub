import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import type { AppContext } from './context';
import { ErrorFilter } from './lib/errors';

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
