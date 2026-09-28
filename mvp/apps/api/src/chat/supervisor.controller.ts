import { Controller, Get, Inject } from '@nestjs/common';
import { RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { rows, toApi } from '../lib/db';

/** Панель супервизора в реальном времени [УПР] (M-REP-02): очереди и операторы, опрос раз в несколько секунд. */
@Controller('api/v1/supervisor')
@RequirePerm('supervisor.monitor')
export class SupervisorController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('overview')
  async overview() {
    const queues = await rows(
      this.ctx.pool,
      `SELECT q.id, q.name, q.max_wait_s,
         (SELECT count(*)::int FROM conversation c WHERE c.queue_id = q.id AND c.status = 'queued') AS waiting,
         (SELECT COALESCE(extract(epoch FROM now() - min(c.queued_at))::int, 0)
            FROM conversation c WHERE c.queue_id = q.id AND c.status = 'queued') AS oldest_wait_s
       FROM queue q WHERE q.is_active ORDER BY q.priority DESC, q.name`,
    );
    const operators = await rows(
      this.ctx.pool,
      `SELECT u.id, u.full_name, COALESCE(ag.status, 'offline') AS status, br.name AS reason_name,
         extract(epoch FROM now() - COALESCE(ag.since, u.created_at))::int AS since_s,
         (SELECT count(*)::int FROM conversation c WHERE c.assignee_id = u.id
            AND c.status IN ('active', 'hold', 'offered') AND c.channel_kind <> 'voice') AS active_chats
       FROM app_user u
       LEFT JOIN agent_status ag ON ag.user_id = u.id
       LEFT JOIN break_reason br ON br.id = ag.reason_id
       WHERE u.is_active AND u.can_login AND EXISTS (
         SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
          WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))
       ORDER BY u.full_name`,
    );
    return { queues: queues.map((r) => toApi(r)), operators: operators.map((r) => toApi(r)) };
  }
}
