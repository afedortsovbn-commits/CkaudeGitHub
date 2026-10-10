import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { loadRoutingPolicy, setAgentStatus } from '@cc/domain';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { one, withTx } from '../lib/db';
import { ApiError, badRequest, parse } from '../lib/errors';

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
      `SELECT user_id, status, reason_id, wrap_up_until, since, wrap_up_extends FROM agent_status WHERE user_id = $1`,
      [p.id],
    );
    // Режим распределения (Д-017) — интерфейсу: «Взять следующее» и «+2 мин» показываются только «по загрузке».
    const policy = await loadRoutingPolicy(this.ctx.pool);
    const routing = {
      routingMode: policy.mode,
      wrapUpExtendSeconds: policy.wrapUp.extendSeconds,
      wrapUpExtendRepeat: policy.wrapUp.extendRepeat,
      wrapUpExtends: Number(row?.wrap_up_extends ?? 0),
    };
    return row
      ? {
          userId: row.user_id,
          status: row.status,
          reasonId: row.reason_id,
          wrapUpUntil: row.wrap_up_until,
          since: row.since,
          ...routing,
        }
      : { userId: p.id, status: 'offline', reasonId: null, wrapUpUntil: null, since: null, ...routing };
  }

  /**
   * «+2 мин» к постобработке (Д-017, п.7): продлевает таймер на `wrapUp.extendSeconds`; каждое продление считается
   * (`wrap_up_extends`, видно супервизору). Повторно — по настройке `wrapUp.extendRepeat` (В-017-2).
   */
  @Post('wrap-up/extend')
  @HttpCode(200)
  async extendWrapUp(@CurrentUser() p: Principal) {
    return withTx(this.ctx.pool, async (tx) => {
      const policy = await loadRoutingPolicy(tx);
      const cur = await one<{ status: string; wrap_up_extends: number }>(
        tx,
        `SELECT status, wrap_up_extends FROM agent_status WHERE user_id = $1 FOR UPDATE`,
        [p.id],
      );
      if (cur?.status !== 'wrap_up')
        throw new ApiError(409, 'not_wrap_up', 'Продлить можно только во время постобработки');
      if (!policy.wrapUp.extendRepeat && Number(cur.wrap_up_extends) >= 1)
        throw new ApiError(409, 'already_extended', 'Постобработку можно продлить только один раз');
      const r = await one<{ wrap_up_until: string; wrap_up_extends: number }>(
        tx,
        `UPDATE agent_status SET wrap_up_until = GREATEST(COALESCE(wrap_up_until, now()), now()) + make_interval(secs => $2),
           wrap_up_extends = wrap_up_extends + 1, updated_at = now()
         WHERE user_id = $1 RETURNING wrap_up_until, wrap_up_extends`,
        [p.id, policy.wrapUp.extendSeconds],
      );
      return { wrapUpUntil: r?.wrap_up_until ?? null, wrapUpExtends: Number(r?.wrap_up_extends ?? 0) };
    });
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
