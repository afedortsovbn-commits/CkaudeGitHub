import type { PoolClient } from 'pg';
import type { Candidate } from './strategies';
import { rows } from './db';

/**
 * Ёмкость голоса — один вызов (02-архитектура, Ф3 «голос 1, чаты N»): оператор занят, пока у него идёт или
 * звонит вызов, либо ему уже предложено голосовое обращение. Чаты голос не блокируют и наоборот.
 */
export const VOICE_BUSY = `(EXISTS (SELECT 1 FROM call cl WHERE cl.agent_user_id = user_id AND cl.state IN ('dialing', 'talking'))
  OR EXISTS (SELECT 1 FROM conversation cv WHERE cv.assignee_id = user_id AND cv.status = 'offered' AND cv.channel_kind = 'voice'))`;

/**
 * Операторы, которым можно предложить обращение этой очереди (M-RT-02/03):
 * состоят в очереди (`user_queue`), активны, статус «Готов», не исчерпали ёмкость чатов,
 * ещё не отказывались от этого обращения. Навык, привязанный к теме, — только для ранжирования
 * внутри стратегии (мягкий приоритет, не жёсткий фильтр — иначе обращение может зависнуть без
 * подходящего специалиста).
 */
export async function eligibleCandidates(
  tx: PoolClient,
  opts: { queueId: string; topicPath: string[]; maxChats: number; excludeUserIds: string[]; voice?: boolean },
): Promise<Candidate[]> {
  return rows<{
    user_id: string;
    active_count: number;
    last_assigned_at: string | null;
    skill_level: number;
  }>(
    tx,
    `WITH cand AS (
       SELECT u.id AS user_id, ag.last_assigned_at,
         (SELECT count(*)::int FROM conversation c2 WHERE c2.assignee_id = u.id
            AND c2.status IN ('active', 'hold', 'offered') AND c2.channel_kind <> 'voice') AS active_count,
         COALESCE((SELECT max(us.level) FROM user_skill us JOIN skill sk ON sk.id = us.skill_id
                    WHERE us.user_id = u.id AND sk.topic_id = ANY($4::uuid[])), 0) AS skill_level
       FROM app_user u
       JOIN user_queue uq ON uq.user_id = u.id AND uq.queue_id = $1
       LEFT JOIN agent_status ag ON ag.user_id = u.id
       WHERE u.is_active AND u.can_login AND COALESCE(ag.status, 'offline') = 'ready'
         AND NOT (u.id = ANY($3::uuid[]))
     )
     SELECT * FROM cand WHERE ${opts.voice ? `$2::int >= 0 AND NOT ${VOICE_BUSY}` : 'active_count < $2'}`,
    [opts.queueId, opts.maxChats, opts.excludeUserIds, opts.topicPath],
  ).then((r) =>
    r.map((c) => ({
      userId: c.user_id,
      activeCount: c.active_count,
      lastAssignedAt: c.last_assigned_at,
      skillLevel: c.skill_level,
    })),
  );
}

/** Операторы, уже отказавшиеся от этого обращения — не предлагаем им снова (M-RT-05). */
export async function declinedUserIds(tx: PoolClient, conversationId: string): Promise<string[]> {
  const r = await rows<{ user_id: string }>(
    tx,
    `SELECT user_id FROM routing_offer WHERE conversation_id = $1 AND outcome = 'declined'`,
    [conversationId],
  );
  return r.map((x) => x.user_id);
}
