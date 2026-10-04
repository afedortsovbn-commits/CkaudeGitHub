import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { ObjectSyncSettingsSchema, SECRET_MASK } from '@cc/contracts';
import { OBJECT_SYNC_SETTING, objectSyncSettings, syncObjects } from '@cc/domain';
import { isSealed, sealSecret } from '@cc/service-kit';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, notFound, parse } from '../lib/errors';

const SettingsBody = ObjectSyncSettingsSchema.extend({ token: z.string().max(2000).nullable().optional() })
  .partial()
  .strict();

/**
 * Синхронизация справочника объектов (Ф13, M-ORG-06): настройки источника, запуск вручную (в т.ч. проверка без
 * изменений) и журнал запусков. Плановый ежедневный запуск выполняет worker; логика сверки — `@cc/domain`.
 */
@Controller('api/v1/objects/sync')
@RequirePerm('objects.manage')
export class ObjectSyncController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Токен источника не отдаётся: вместо него — маска (есть) или null (нет). */
  @Get('settings')
  async settings() {
    const s = await objectSyncSettings(this.ctx.pool);
    return { ...s, token: s.token ? SECRET_MASK : null };
  }

  @Put('settings')
  async saveSettings(@CurrentUser() p: Principal, @Body() body: unknown) {
    const input = parse(SettingsBody, body);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await objectSyncSettings(tx);
      const next = { ...before, ...input };
      // Маска или отсутствие поля — «не менять»; пустая строка или null — удалить токен.
      if (input.token === undefined || input.token === SECRET_MASK) next.token = before.token;
      else if (!input.token) next.token = null;
      else {
        const key = this.ctx.config.SECRETS_KEY;
        next.token = key && !isSealed(input.token) ? sealSecret(input.token, key) : input.token;
      }
      const value = parse(ObjectSyncSettingsSchema, next);
      await tx.query(
        `INSERT INTO system_setting (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [OBJECT_SYNC_SETTING, JSON.stringify(value)],
      );
      const masked = (v: typeof value) => ({ ...v, token: v.token ? SECRET_MASK : null });
      await audit(tx, p, 'update', 'system_setting', OBJECT_SYNC_SETTING, masked(before), masked(value));
      return masked(value);
    });
  }

  /** Запуск сейчас; `dryRun=true` — проверка: что изменилось бы, без изменений справочника. */
  @Post('run')
  @HttpCode(200)
  async run(@CurrentUser() p: Principal, @Query('dryRun') dryRun?: string) {
    const r = await syncObjects(this.ctx.pool, {
      trigger: 'manual',
      dryRun: dryRun === 'true' || dryRun === '1',
      userId: p.id,
      secretsKey: this.ctx.config.SECRETS_KEY,
      source: 'api',
    });
    if (r.status === 'skipped')
      throw new ApiError(409, 'sync_busy', 'Синхронизация уже выполняется — дождитесь её окончания');
    if (!r.dryRun)
      await withTx(this.ctx.pool, (tx) =>
        audit(
          tx,
          p,
          'sync',
          'service_object',
          null,
          null,
          {
            runId: r.runId,
            status: r.status,
            added: r.added,
            updated: r.updated,
            deactivated: r.deactivated,
          },
          { configChanged: false },
        ),
      );
    return r;
  }

  @Get('runs')
  async runs(@Query('limit') limit?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT r.id, r.trigger, r.dry_run, r.started_at, r.finished_at, r.status, r.total, r.added, r.updated,
              r.deactivated, r.reactivated, r.skipped, r.error, u.full_name AS started_by_name
         FROM object_sync_run r LEFT JOIN app_user u ON u.id = r.started_by
        ORDER BY r.started_at DESC LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 30, 1), 200)],
    );
    return list.map((r) => toApi(r));
  }

  @Get('runs/:id')
  async runDetails(@Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Запуск');
    const r = await one(
      this.ctx.pool,
      `SELECT r.*, u.full_name AS started_by_name FROM object_sync_run r
         LEFT JOIN app_user u ON u.id = r.started_by WHERE r.id = $1`,
      [id],
    );
    if (!r) throw notFound('Запуск');
    return toApi(r);
  }
}
