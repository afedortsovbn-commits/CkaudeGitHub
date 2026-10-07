import type { Pool, PoolClient } from 'pg';

/**
 * Политика распределения обращений (доработки 07.10.2026). Группы каналов: звонки, почта, остальное — текстовые
 * (чат, Telegram, приложение, отзывы, API).
 * - Режим группы: `auto` — назначать оператору (кто дольше без обращений по стратегии очереди); `pull` —
 *   показывать всем в очереди, кто первый взял. Звонки — всегда `auto` (звонок не может ждать в списке).
 * - `idleScope`: `combined` — «дольше без обращений» считается по всем каналам вместе; `split` — отдельно по
 *   группе канала (текстовые, голосовые, почта).
 */
export type ChannelGroup = 'text' | 'voice' | 'email';
export interface RoutingPolicy {
  text: 'auto' | 'pull';
  voice: 'auto';
  email: 'auto' | 'pull';
  idleScope: 'combined' | 'split';
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  text: 'auto',
  voice: 'auto',
  email: 'auto',
  idleScope: 'combined',
};

export const channelGroup = (kind: string): ChannelGroup =>
  kind === 'voice' ? 'voice' : kind === 'email' ? 'email' : 'text';

/** Столбец «когда последний раз назначали» для ранжирования по политике. */
export const idleColumn = (p: RoutingPolicy, group: ChannelGroup): string =>
  p.idleScope === 'split' ? `last_${group}_at` : 'last_assigned_at';

export async function loadRoutingPolicy(db: Pool | PoolClient): Promise<RoutingPolicy> {
  const r = await db.query<{ value: Partial<RoutingPolicy> }>(
    `SELECT value FROM system_setting WHERE key = 'routing.policy'`,
  );
  const v = r.rows[0]?.value ?? {};
  return {
    text: v.text === 'pull' ? 'pull' : 'auto',
    voice: 'auto',
    email: v.email === 'pull' ? 'pull' : 'auto',
    idleScope: v.idleScope === 'split' ? 'split' : 'combined',
  };
}

/** Отметить, что оператору назначено обращение (общая отметка и отметка группы канала). */
export async function markAssigned(
  db: Pool | PoolClient,
  userId: string,
  channelKind: string,
): Promise<void> {
  const col = `last_${channelGroup(channelKind)}_at`;
  await db.query(
    `UPDATE agent_status SET last_assigned_at = now(), ${col} = now(), updated_at = now() WHERE user_id = $1`,
    [userId],
  );
}
