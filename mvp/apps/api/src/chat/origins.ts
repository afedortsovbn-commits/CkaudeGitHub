import type { Pool } from 'pg';

/** Кэш разрешённых доменов виджета (обновляется раз в 10 с — изменения каналов применяются без перезапуска). */
export function originsCache(pool: Pool): (origin: string) => Promise<boolean> {
  let cache: { at: number; all: boolean; set: Set<string> } | null = null;
  return async (origin) => {
    if (!cache || Date.now() - cache.at > 10_000) {
      const { rows } = await pool.query<{ o: string }>(
        `SELECT DISTINCT lower(jsonb_array_elements_text(config -> 'allowed_origins')) AS o
           FROM channel WHERE is_active AND kind IN ('webchat', 'app') AND config ? 'allowed_origins'`,
      );
      cache = { at: Date.now(), all: rows.some((r) => r.o === '*'), set: new Set(rows.map((r) => r.o)) };
    }
    return cache.all || cache.set.has(origin.toLowerCase());
  };
}
