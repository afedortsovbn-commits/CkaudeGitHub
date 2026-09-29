import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { buildOpenApi } from './openapi';

/** Описание публичного API (OpenAPI 3.1) — без входа: документ не содержит данных. */
@Controller('api/v1')
@Public()
export class DocsController {
  private cached?: Record<string, unknown>;
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('openapi.json')
  openapi() {
    this.cached ??= buildOpenApi(this.ctx.config.PUBLIC_BASE_URL);
    return this.cached;
  }
}
