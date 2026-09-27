import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

export const MIGRATION_FILE_RE = /^(\d{4})_(expand|contract)_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 72_021_001; // произвольный постоянный ключ advisory lock

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function defaultMigrationsDir(): string {
  return join(__dirname, '..', 'migrations');
}

export function loadMigrations(dir = defaultMigrationsDir()): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  return names.map((name) => {
    if (!MIGRATION_FILE_RE.test(name)) {
      throw new Error(`Имя миграции ${name} не соответствует NNNN_(expand|contract)_описание.sql`);
    }
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Применяет миграции под advisory lock: несколько экземпляров, стартующих одновременно,
 * не мешают друг другу. Уже применённая миграция с изменённым содержимым — ошибка.
 */
export async function migrate(
  pool: Pool,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrateResult> {
  const log = opts.log ?? (() => undefined);
  const files = loadMigrations(opts.dir);
  const client = await pool.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const f of files) {
      const prev = done.get(f.name);
      if (prev) {
        if (prev !== f.checksum) throw new Error(`Миграция ${f.name} изменена после применения`);
        result.skipped.push(f.name);
        continue;
      }
      log(`применяю ${f.name}`);
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          f.name,
          f.checksum,
        ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      result.applied.push(f.name);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
