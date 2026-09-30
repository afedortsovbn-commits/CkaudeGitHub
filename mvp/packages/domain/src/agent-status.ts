import { AGENT_EVENTS, type AgentStatusEventData, makeEvent, newId } from '@cc/contracts';
import { enqueueEvent } from '@cc/service-kit';
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
  const prev = await tx.query<{ status: string; reason_id: string | null }>(
    `SELECT status, reason_id FROM agent_status WHERE user_id = $1`,
    [userId],
  );
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
  // Журнал событий (Ф10, M-REP-01): отчёт по статусам операторов строится по нему. Повтор того же статуса
  // (например, «Готов» → «Готов») тоже пишется — он продлевает период и ничего не искажает.
  const data: AgentStatusEventData = {
    userId,
    status,
    prevStatus: prev.rows[0]?.status ?? null,
    reasonId: opts.reasonId ?? null,
  };
  await enqueueEvent(tx, makeEvent({ type: AGENT_EVENTS.status, source: 'agents', data }));
  return {
    userId: r.user_id,
    status: r.status,
    reasonId: r.reason_id,
    wrapUpUntil: r.wrap_up_until,
    since: r.since,
  };
}
