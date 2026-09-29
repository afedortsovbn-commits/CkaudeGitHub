import { Controller, Get, Inject } from '@nestjs/common';
import { type Principal, scopeFilter } from '@cc/auth';
import { SupervisorThresholdsSchema } from '@cc/contracts';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { one, rows, toApi } from '../lib/db';
import { todayServiceLevel } from '../reports/reports';

const CONV_SCOPE = {
  enterprise: 'c.enterprise_id',
  department: 'c.department_id',
  topicPath: 'c.topic_path',
};

/**
 * Панель супервизора в реальном времени [УПР] (M-REP-02): очереди (ожидают, макс. ожидание, SL за сегодня),
 * операторы по статусам, активные обращения; пороги подсветки — настройка `supervisor.thresholds` (без
 * перезапуска). Обращения ограничены областью видимости супервизора. Опрос раз в несколько секунд.
 */
@Controller('api/v1/supervisor')
@RequirePerm('supervisor.monitor')
export class SupervisorController {
  /** SL за сегодня пересчитывается по журналу не чаще раза в 10 с на сотрудника (панель опрашивает каждые 4 с). */
  private readonly slCache = new Map<
    string,
    { at: number; value: Awaited<ReturnType<typeof todayServiceLevel>> }
  >();
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  private async todaySl(p: Principal) {
    const hit = this.slCache.get(p.id);
    if (hit && Date.now() - hit.at < 10_000) return hit.value;
    const value = await todayServiceLevel(this.ctx.pool, p);
    if (this.slCache.size > 1000) this.slCache.clear();
    this.slCache.set(p.id, { at: Date.now(), value });
    return value;
  }

  @Get('overview')
  async overview(@CurrentUser() p: Principal) {
    const sc = scopeFilter(p.scope, CONV_SCOPE, 1);
    const queues = await rows(
      this.ctx.pool,
      `SELECT q.id, q.name, q.max_wait_s,
         count(c.id) FILTER (WHERE c.status = 'queued')::int AS waiting,
         count(c.id) FILTER (WHERE c.status = 'offered')::int AS offered,
         count(c.id) FILTER (WHERE c.status = 'active')::int AS active,
         count(c.id) FILTER (WHERE c.status = 'queued' AND c.is_important)::int AS important_waiting,
         COALESCE(extract(epoch FROM now() - min(c.queued_at) FILTER (WHERE c.status = 'queued'))::int, 0) AS oldest_wait_s
       FROM queue q
       LEFT JOIN conversation c ON c.queue_id = q.id AND c.status IN ('queued', 'offered', 'active') AND ${sc.sql}
       WHERE q.is_active GROUP BY q.id ORDER BY q.priority DESC, q.name`,
      sc.params,
    );
    const operators = await rows(
      this.ctx.pool,
      `SELECT u.id, u.full_name, COALESCE(ag.status, 'offline') AS status, br.name AS reason_name,
         extract(epoch FROM now() - COALESCE(ag.since, u.created_at))::int AS since_s,
         (SELECT count(*)::int FROM conversation c WHERE c.assignee_id = u.id
            AND c.status IN ('active', 'hold', 'offered') AND c.channel_kind <> 'voice') AS active_chats,
         -- Идущий разговор оператора (Ф5): для кнопки «Прослушать» (M-TEL-10).
         (SELECT cl.id FROM call cl WHERE cl.agent_user_id = u.id AND cl.state = 'talking' LIMIT 1) AS call_id,
         (SELECT COALESCE(cl.from_number, cl.to_number) FROM call cl
           WHERE cl.agent_user_id = u.id AND cl.state = 'talking' LIMIT 1) AS call_number
       FROM app_user u
       LEFT JOIN agent_status ag ON ag.user_id = u.id
       LEFT JOIN break_reason br ON br.id = ag.reason_id
       WHERE u.is_active AND u.can_login AND EXISTS (
         SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
          WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))
       ORDER BY u.full_name`,
    );
    // Активные обращения по статусам и каналам (в области видимости).
    const active = await rows<{ status: string; channel_kind: string; n: number }>(
      this.ctx.pool,
      `SELECT c.status, c.channel_kind, count(*)::int AS n FROM conversation c
        WHERE c.status <> 'closed' AND ${sc.sql} GROUP BY 1, 2 ORDER BY 1, 2`,
      sc.params,
    );
    const th = await one<{ value: unknown }>(
      this.ctx.pool,
      `SELECT value FROM system_setting WHERE key = 'supervisor.thresholds'`,
    );
    const parsed = SupervisorThresholdsSchema.safeParse(th?.value ?? {});
    const thresholds = parsed.success ? parsed.data : SupervisorThresholdsSchema.parse({});
    const sl = new Map((await this.todaySl(p)).map((s) => [s.queueId, s]));
    return {
      queues: queues.map((r) => {
        const s = sl.get(r.id as string);
        return {
          ...toApi(r),
          todayAnswered: s?.answered ?? 0,
          todayAbandoned: s?.abandoned ?? 0,
          todaySlPct: s?.slPct ?? null,
          todayAsa: s?.asa ?? null,
        };
      }),
      operators: operators.map((r) => toApi(r)),
      active: active.map((r) => ({ status: r.status, channelKind: r.channel_kind, count: r.n })),
      thresholds,
      at: new Date().toISOString(),
    };
  }
}
