import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

export const MIGRATION_FILE_RE = /^(\d{4})_(expand|contract)_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 72_021_001; // произвольный постоянный ключ advisory lock

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
  /** `-- cc:no-transaction` в файле: операторы выполняются по одному вне транзакции (CREATE INDEX CONCURRENTLY). */
  noTransaction: boolean;
}

/** Директива для миграций, которые нельзя выполнять в транзакции (`CREATE INDEX CONCURRENTLY`). */
export const NO_TRANSACTION_RE = /^--\s*cc:no-transaction\s*$/m;
/** Код PostgreSQL «lock_not_available» — истёк lock_timeout. */
const LOCK_NOT_AVAILABLE = '55P03';

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
    return {
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      noTransaction: NO_TRANSACTION_RE.test(sql),
    };
  });
}

/**
 * Делит SQL на отдельные операторы для режима без транзакции. Поддерживаются комментарии `--`, строки в
 * одинарных кавычках и тела в `$$`/`$тег$` — этого достаточно для миграций проекта.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      cur += '\n';
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? sql.length : end + m[0].length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface MigrateOptions {
  dir?: string;
  log?: (msg: string) => void;
  /**
   * lock_timeout для операторов миграции (мс, по умолчанию MIGRATION_LOCK_TIMEOUT_MS или 5000): миграция не
   * ждёт блокировку дольше и не выстраивает за собой очередь запросов работающих сервисов (02, 6.6 п.2).
   * При истечении — повтор через паузу (до `lockRetries` раз).
   */
  lockTimeoutMs?: number;
  lockRetries?: number;
  retryDelayMs?: number;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Применяет миграции под advisory lock: несколько экземпляров, стартующих одновременно,
 * не мешают друг другу. Уже применённая миграция с изменённым содержимым — ошибка.
 */
export async function migrate(pool: Pool, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const log = opts.log ?? (() => undefined);
  const lockTimeoutMs = Math.max(
    100,
    Math.floor(opts.lockTimeoutMs ?? Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 5000)),
  );
  const lockRetries = opts.lockRetries ?? Number(process.env.MIGRATION_LOCK_RETRIES ?? 20);
  const retryDelayMs = opts.retryDelayMs ?? 1000;
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
      log(`применяю ${f.name}${f.noTransaction ? ' (без транзакции)' : ''}`);
      for (let attempt = 0; ; attempt++) {
        try {
          await applyOne(client, f, lockTimeoutMs);
          break;
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code !== LOCK_NOT_AVAILABLE || attempt >= lockRetries) throw e;
          log(
            `${f.name}: блокировка не получена за ${lockTimeoutMs} мс — повтор ${attempt + 1}/${lockRetries}`,
          );
          await new Promise((r) => setTimeout(r, retryDelayMs * Math.min(attempt + 1, 5)));
        }
      }
      result.applied.push(f.name);
    }
    return result;
  } finally {
    await client.query('RESET lock_timeout').catch(() => undefined);
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

type Client = PoolClient;

/**
 * Одна миграция. Обычная — в транзакции целиком (при ошибке ничего не остаётся). Без транзакции — операторы по
 * одному; такие миграции обязаны быть повторяемыми (`IF NOT EXISTS`), т.к. повтор после сбоя выполнит их заново.
 * Невалидный индекс, оставшийся от прерванного `CREATE INDEX CONCURRENTLY`, раннер удаляет перед повтором сам:
 * `IF NOT EXISTS` увидел бы его и ничего не сделал.
 */
async function applyOne(client: Client, f: MigrationFile, lockTimeoutMs: number): Promise<void> {
  await client.query(`SET lock_timeout = ${lockTimeoutMs}`);
  if (f.noTransaction) {
    for (const stmt of splitStatements(f.sql)) {
      await dropInvalidIndex(client, stmt);
      await client.query(stmt);
    }
    await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
      f.name,
      f.checksum,
    ]);
    return;
  }
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
}

/** Прерванный `CREATE INDEX CONCURRENTLY` оставляет невалидный индекс — перед повтором его нужно удалить. */
async function dropInvalidIndex(client: Client, stmt: string): Promise<void> {
  const m = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w]+"?)/i.exec(stmt);
  if (!m?.[1]) return;
  const name = m[1].replace(/"/g, '');
  const { rows } = await client.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
    [name],
  );
  if (rows[0] && !rows[0].valid) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
}
