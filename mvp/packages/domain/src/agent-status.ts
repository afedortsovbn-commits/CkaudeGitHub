import { newId } from '@cc/contracts';
import type { PoolClient } from 'pg';

export type AgentStatusValue = 'ready' | 'break' | 'wrap_up' | 'offline';

export interface AgentStatusDto {
  userId: string;
  status: AgentStatusValue;
  reasonId: string | null;
  wrapUpUntil: string | null;
  since: string;
}

/**
 * Меняет статус оператора (M-OP-04) и ведёт журнал `agent_status_log`: закрывает текущий открытый
 * период (ставит `ended_at`) и открывает новый. Используется и явным переключением (api), и
 * автоматическими переходами (router: постобработка → «Готов», предложение → автовозврат при отказе).
 */
export async function setAgentStatus(
  tx: PoolClient,
  userId: string,
  status: AgentStatusValue,
  opts: { reasonId?: string | null; wrapUpUntil?: Date | null } = {},
): Promise<AgentStatusDto> {
  await tx.query(`UPDATE agent_status_log SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL`, [
    userId,
  ]);
  await tx.query(
    `INSERT INTO agent_status_log (id, user_id, status, reason_id, started_at) VALUES ($1, $2, $3, $4, now())`,
    [newId(), userId, status, opts.reasonId ?? null],
  );
  const { rows } = await tx.query<{
    user_id: string;
    status: AgentStatusValue;
    reason_id: string | null;
    wrap_up_until: string | null;
    since: string;
  }>(
    `INSERT INTO agent_status (user_id, status, reason_id, wrap_up_until, since, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET status = $2, reason_id = $3, wrap_up_until = $4, since = now(), updated_at = now()
     RETURNING user_id, status, reason_id, wrap_up_until, since`,
    [userId, status, opts.reasonId ?? null, opts.wrapUpUntil ?? null],
  );
  const r = rows[0]!;
  return {
    userId: r.user_id,
    status: r.status,
    reasonId: r.reason_id,
    wrapUpUntil: r.wrap_up_until,
    since: r.since,
  };
}
