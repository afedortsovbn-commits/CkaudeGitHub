import { Body, Controller, Get, HttpCode, Inject, Put, Query } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { parse } from '../lib/errors';

const Module = z
  .string()
  .trim()
  .regex(/^\/[a-z0-9/_-]{1,80}$/, 'Неверный раздел');
const PageBody = z
  .object({
    module: Module,
    title: z.string().trim().min(1).max(200),
    body: z.string().max(100_000).default(''),
    videoAssetId: z.string().uuid().nullable().default(null),
    posterAssetId: z.string().uuid().nullable().default(null),
  })
  .strict();

/**
 * Инструкции по разделам программы (Д-101): текст и видео для пункта меню. Читают все сотрудники; меняет
 * администратор (настройки системы). Нет записи — интерфейс показывает «пока не загружено».
 */
@Controller('api/v1/help')
export class HelpController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Какие разделы уже с инструкцией (для списка «Справка»). */
  @Get()
  async list() {
    const list = await rows(
      this.ctx.pool,
      `SELECT module, title, length(body) > 0 AS has_text, video_asset_id IS NOT NULL AS has_video, updated_at
         FROM help_page ORDER BY module`,
    );
    return list.map((r) => toApi(r));
  }

  @Get('page')
  async page(@Query('module') module: string) {
    const m = parse(Module, module);
    const p = await one(this.ctx.pool, `SELECT * FROM help_page WHERE module = $1`, [m]);
    return p ? { ...toApi(p), empty: false } : { module: m, empty: true };
  }

  @Put('page')
  @RequirePerm('settings.manage')
  @HttpCode(200)
  async save(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(PageBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const before = await one(
        tx,
        `SELECT title, length(body) AS len, video_asset_id FROM help_page WHERE module = $1`,
        [b.module],
      );
      await tx.query(
        `INSERT INTO help_page (module, title, body, video_asset_id, poster_asset_id, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (module) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body,
           video_asset_id = EXCLUDED.video_asset_id, poster_asset_id = EXCLUDED.poster_asset_id,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [b.module, b.title, b.body, b.videoAssetId, b.posterAssetId, p.id],
      );
      await audit(tx, p, 'update', 'help_page', null, before, {
        module: b.module,
        title: b.title,
        len: b.body.length,
        video: b.videoAssetId,
      });
    });
    return this.page(b.module);
  }
}
