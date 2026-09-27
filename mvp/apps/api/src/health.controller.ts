import { Controller, Get, Header, HttpCode, HttpException, Inject } from '@nestjs/common';
import { Public } from './auth/guard';
import { APP_CONTEXT, type AppContext } from './context';

@Public()
@Controller()
export class HealthController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Живость: процесс работает (перезапуск контейнера при отказе). */
  @Get('healthz')
  @HttpCode(200)
  healthz() {
    if (!this.ctx.lifecycle.isLive) throw new HttpException({ status: 'stopped' }, 503);
    return { status: 'ok' };
  }

  /** Готовность принимать трафик: 503 во время запуска и корректной остановки. */
  @Get('readyz')
  readyz() {
    if (!this.ctx.lifecycle.isReady) {
      throw new HttpException({ status: this.ctx.lifecycle.current }, 503);
    }
    return { status: 'ready' };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics() {
    return this.ctx.metrics.registry.metrics();
  }
}
