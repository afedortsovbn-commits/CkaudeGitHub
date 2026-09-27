import { hostname } from 'node:os';
import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { makeEvent } from '@cc/contracts';
import { enqueueEvent } from '@cc/service-kit';
import { z } from 'zod';
import { Public, RequirePerm } from './auth/guard';
import { APP_CONTEXT, type AppContext } from './context';

const DemoEventsBody = z.object({ count: z.number().int().min(1).max(1000).default(1) });

@Controller('api/v1')
export class PingController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Проверка доступности; delayMs (≤ 2000) имитирует долгий запрос для тестов корректной остановки. */
  @Public()
  @Get('ping')
  async ping(@Query('delayMs') delayMs?: string) {
    const d = Math.min(Math.max(Number(delayMs) || 0, 0), 2000);
    if (d) await new Promise((r) => setTimeout(r, d));
    return {
      pong: true,
      version: this.ctx.config.APP_VERSION,
      instance: hostname(),
      at: new Date().toISOString(),
    };
  }

  /** Демонстрация transactional outbox: события пишутся в БД и публикуются в NATS фоновым relay. */
  @RequirePerm('admin.settings')
  @Post('demo/events')
  async demoEvents(@Body() body: unknown) {
    const { count } = DemoEventsBody.parse(body ?? {});
    const client = await this.ctx.pool.connect();
    const ids: string[] = [];
    try {
      await client.query('BEGIN');
      for (let i = 0; i < count; i++) {
        const e = makeEvent({ type: 'demo.ping.created', source: 'api', data: { seq: i } });
        await enqueueEvent(client, e);
        ids.push(e.id);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return { ids };
  }
}
