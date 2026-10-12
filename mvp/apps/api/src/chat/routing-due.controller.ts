import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { loadRoutingPolicy } from '@cc/domain';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, withTx } from '../lib/db';
import { parse } from '../lib/errors';

const DueBody = z
  .object({
    byChannel: z.record(
      z.string().uuid(),
      z
        .object({
          businessDays: z.number().int().min(0).max(30).nullable().optional(),
          hours: z.number().int().min(1).max(720).nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Сроки ответа по каналам поступления (Д-020): администратор или супервизор задаёт для канала срок в рабочих днях
 * (по производственному календарю) или часах; срок ставится обращению при постановке в очередь (`due_at`),
 * виден в очереди, учитывается старением «по загрузке» и счётчиком просроченных. Хранится в `routing.policy`
 * (`dueByChannel`), применяется без перезапуска.
 */
@Controller('api/v1/routing')
@RequirePerm('settings.manage', 'supervisor.monitor')
export class RoutingDueController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('due')
  async get() {
    const policy = await loadRoutingPolicy(this.ctx.pool);
    const channels = await rows<{ id: string; kind: string; name: string }>(
      this.ctx.pool,
      `SELECT id, kind, name FROM channel WHERE is_active ORDER BY name`,
    );
    return {
      channels: channels.map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        businessDays: policy.dueByChannel[c.id]?.businessDays ?? null,
        hours: policy.dueByChannel[c.id]?.hours ?? null,
      })),
      defaults: {
        emailBusinessDays: policy.emailDueBusinessDays,
        reviewPositiveHours: policy.reviews.positiveDueHours,
        reviewNegativeHours: policy.reviews.negativeDueHours,
      },
    };
  }

  @Put('due')
  @HttpCode(200)
  async put(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(DueBody, body);
    const next: Record<string, { businessDays?: number; hours?: number }> = {};
    for (const [id, v] of Object.entries(b.byChannel)) {
      const e: { businessDays?: number; hours?: number } = {};
      if (v.businessDays != null && v.businessDays > 0) e.businessDays = v.businessDays;
      if (v.hours != null) e.hours = v.hours;
      if (Object.keys(e).length) next[id] = e;
    }
    await withTx(this.ctx.pool, async (tx) => {
      const before = await one<{ value: Record<string, unknown> }>(
        tx,
        `SELECT value FROM system_setting WHERE key = 'routing.policy' FOR UPDATE`,
      );
      const value = { ...(before?.value ?? {}), dueByChannel: next };
      await tx.query(
        `INSERT INTO system_setting (key, value) VALUES ('routing.policy', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(value)],
      );
      await audit(tx, p, 'update', 'system_setting', 'routing.policy', before, { value });
    });
    return this.get();
  }
}
