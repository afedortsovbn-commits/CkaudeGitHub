import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { one, rows, toApi } from '../lib/db';
import { notFound } from '../lib/errors';

/**
 * Состояние экземпляров каналов для администратора (M-CH-07): статус подключения, который пишут коннекторы,
 * и журнал последних событий канала (приём, отправка, ошибки). Сами настройки — справочник /dict/channels.
 */
@Controller('api/v1/channels')
export class ChannelsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get(':id/log')
  @RequirePerm('channels.manage')
  async log(@Param('id') id: string, @Query('limit') limit?: string) {
    const ch = await one(
      this.ctx.pool,
      `SELECT id, status, status_detail, status_at FROM channel WHERE id = $1`,
      [id],
    );
    if (!ch) throw notFound('Канал');
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const entries = await rows(
      this.ctx.pool,
      `SELECT id, at, direction, ok, summary FROM channel_log WHERE channel_id = $1 ORDER BY at DESC LIMIT ${n}`,
      [id],
    );
    return { ...toApi(ch), entries: entries.map((r) => toApi(r)) };
  }
}
