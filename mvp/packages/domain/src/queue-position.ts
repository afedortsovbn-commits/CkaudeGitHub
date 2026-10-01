import type { Pool, PoolClient } from 'pg';

/**
 * Позиция обращения в очереди (Ф14, M-TEL-07) — в порядке распределения router: приоритет, затем время постановки
 * (`assignQueued`). Считаются только ожидающие (`queued`) обращения той же очереди и того же вида ёмкости: звонок
 * ждёт только звонки (чаты голос не занимают, Ф5a), чат — только текстовые обращения; задачи «перезвонить» живого
 * вызова не ждут и звонящих не задерживают. null — обращение не ждёт в очереди.
 */
export async function queuePosition(db: Pool | PoolClient, conversationId: string): Promise<number | null> {
  const { rows } = await db.query<{ pos: number }>(
    `SELECT 1 + (SELECT count(*)::int FROM conversation o
                  WHERE o.queue_id = c.queue_id AND o.status = 'queued' AND o.id <> c.id
                    AND (o.channel_kind = 'voice') = (c.channel_kind = 'voice') AND NOT o.callback_requested
                    AND (o.priority > c.priority
                         OR (o.priority = c.priority AND (o.queued_at < c.queued_at
                             OR (o.queued_at = c.queued_at AND o.id < c.id))))) AS pos
       FROM conversation c WHERE c.id = $1 AND c.status = 'queued' AND c.queue_id IS NOT NULL`,
    [conversationId],
  );
  return rows[0]?.pos ?? null;
}

/** Сообщать ли позицию в очереди обращения (опция очереди, по умолчанию выключена) и как часто. */
export async function positionSettings(
  db: Pool | PoolClient,
  queueId: string | null,
): Promise<{ enabled: boolean; everySec: number }> {
  if (!queueId) return { enabled: false, everySec: 60 };
  const { rows } = await db.query<{ announce_position: boolean; announce_position_every_s: number }>(
    `SELECT announce_position, announce_position_every_s FROM queue WHERE id = $1 AND is_active`,
    [queueId],
  );
  return {
    enabled: !!rows[0]?.announce_position,
    everySec: rows[0]?.announce_position_every_s ?? 60,
  };
}
