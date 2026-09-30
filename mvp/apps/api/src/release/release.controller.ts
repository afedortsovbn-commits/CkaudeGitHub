import { Body, Controller, Get, Inject, Param, Patch } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { FEATURE_FLAGS } from '@cc/contracts';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { notFound, parse } from '../lib/errors';

/**
 * Выпуск релизов без простоя (Ф11): фиче-флаги и журнал выпусков.
 * Флаги включает `ops/release.sh` (FEATURE_FLAGS=…) после обновления всех экземпляров или администратор;
 * значения читаются из БД при каждом запросе — действуют без перезапуска (событие config.changed для кэшей).
 */
@Controller('api/v1')
export class ReleaseController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Включённые флаги для интерфейса (любой вошедший сотрудник). Неизвестные БД флаги — со значением по умолчанию. */
  @Get('features')
  async features() {
    const list = await rows<{ key: string; enabled: boolean }>(
      this.ctx.pool,
      'SELECT key, enabled FROM feature_flag',
    );
    const out: Record<string, boolean> = Object.fromEntries(
      Object.keys(FEATURE_FLAGS).map((k) => [k, false]),
    );
    for (const r of list) out[r.key] = r.enabled;
    return out;
  }

  @Get('admin/feature-flags')
  @RequirePerm('admin.settings')
  async flags() {
    const list = await rows(
      this.ctx.pool,
      'SELECT key, enabled, description, updated_at FROM feature_flag ORDER BY key',
    );
    return list.map((r) => toApi(r));
  }

  @Patch('admin/feature-flags/:key')
  @RequirePerm('admin.settings')
  async setFlag(@CurrentUser() p: Principal, @Param('key') key: string, @Body() body: unknown) {
    const b = parse(z.object({ enabled: z.boolean() }).strict(), body);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, 'SELECT key, enabled FROM feature_flag WHERE key = $1 FOR UPDATE', [key]);
      if (!before) throw notFound('Флаг');
      const after = await one(
        tx,
        'UPDATE feature_flag SET enabled = $2, updated_at = now() WHERE key = $1 RETURNING key, enabled, description, updated_at',
        [key, b.enabled],
      );
      await audit(tx, p, 'update', 'feature_flag', key, before, { enabled: b.enabled });
      return toApi(after!);
    });
  }

  /** Журнал выпусков (ops/release.sh): тег, предыдущий тег, итог, отчёт по шагам. */
  @Get('admin/releases')
  @RequirePerm('admin.settings')
  async releases() {
    const list = await rows(
      this.ctx.pool,
      `SELECT id, tag, prev_tag, status, started_at, finished_at, report
         FROM release_log ORDER BY started_at DESC LIMIT 50`,
    );
    return list.map((r) => toApi(r));
  }
}
