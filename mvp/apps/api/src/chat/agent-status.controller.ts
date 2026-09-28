import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { setAgentStatus } from '@cc/domain';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { one, withTx } from '../lib/db';
import { badRequest, parse } from '../lib/errors';

/** Оператор сам переключает только эти статусы; «Постобработка» выставляется системой при закрытии (M-RT-06). */
const SetStatusBody = z
  .object({
    status: z.enum(['ready', 'break', 'offline']),
    reasonId: z.string().uuid().nullable().optional(),
  })
  .strict();

/** Статус оператора (M-OP-04): «Готов» / «Перерыв» (с причиной) / «Постобработка» / «Офлайн». */
@Controller('api/v1/agent-status')
@RequirePerm('conversations.work')
export class AgentStatusController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('me')
  async me(@CurrentUser() p: Principal) {
    const row = await one(
      this.ctx.pool,
      `SELECT user_id, status, reason_id, wrap_up_until, since FROM agent_status WHERE user_id = $1`,
      [p.id],
    );
    return row
      ? {
          userId: row.user_id,
          status: row.status,
          reasonId: row.reason_id,
          wrapUpUntil: row.wrap_up_until,
          since: row.since,
        }
      : { userId: p.id, status: 'offline', reasonId: null, wrapUpUntil: null, since: null };
  }

  @Post()
  @HttpCode(200)
  async set(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(SetStatusBody, body);
    if (b.status === 'break' && !b.reasonId) throw badRequest('Укажите причину перерыва');
    return withTx(this.ctx.pool, (tx) =>
      setAgentStatus(tx, p.id, b.status, { reasonId: b.reasonId ?? null }),
    );
  }
}
