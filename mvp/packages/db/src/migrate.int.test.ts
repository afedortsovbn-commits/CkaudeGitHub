import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrate';

// Интеграционный тест раннера (Ф11): lock_timeout с повтором и миграции без транзакции.
const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!ADMIN_URL)('раннер миграций на PostgreSQL', () => {
  const dbName = `cc_mig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString(), max: 4 });
    pool.on('error', () => undefined);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('ждёт блокировку не дольше lock_timeout, повторяет и применяет после её снятия', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_expand_t.sql'), 'CREATE TABLE t (id int PRIMARY KEY);');
    await migrate(pool, { dir });
    writeFileSync(join(dir, '0002_expand_col.sql'), 'ALTER TABLE t ADD COLUMN note text;');

    // «Долгая транзакция работающего сервиса» держит блокировку таблицы.
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE t IN ACCESS SHARE MODE');
    const logs: string[] = [];
    const run = migrate(pool, { dir, lockTimeoutMs: 200, retryDelayMs: 100, log: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 700));
    // Пока миграция ждёт, обычные запросы к таблице не встают в очередь за её блокировкой.
    const t0 = Date.now();
    await pool.query('SELECT count(*) FROM t');
    expect(Date.now() - t0).toBeLessThan(500);
    await holder.query('COMMIT');
    holder.release();
    const r = await run;
    expect(r.applied).toEqual(['0002_expand_col.sql']);
    expect(logs.some((l) => l.includes('повтор'))).toBe(true);
  });

  it('после исчерпания повторов — ошибка, миграция не отмечена применённой', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_expand_t.sql'), 'CREATE TABLE t (id int PRIMARY KEY);');
    writeFileSync(join(dir, '0003_expand_col2.sql'), 'ALTER TABLE t ADD COLUMN note2 text;');
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE t IN ACCESS SHARE MODE');
    await expect(
      migrate(pool, { dir, lockTimeoutMs: 100, lockRetries: 1, retryDelayMs: 10 }),
    ).rejects.toThrow(/lock timeout/);
    await holder.query('ROLLBACK');
    holder.release();
    const { rowCount } = await pool.query(
      `SELECT 1 FROM schema_migrations WHERE name = '0003_expand_col2.sql'`,
    );
    expect(rowCount).toBe(0);
  });

  it('cc:no-transaction: CREATE INDEX CONCURRENTLY выполняется, повтор идемпотентен', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_expand_t.sql'), 'CREATE TABLE t (id int PRIMARY KEY);');
    writeFileSync(
      join(dir, '0004_expand_idx.sql'),
      '-- cc:no-transaction\nALTER TABLE t ADD COLUMN IF NOT EXISTS v int;\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON t (v);\n',
    );
    const r = await migrate(pool, { dir });
    expect(r.applied).toContain('0004_expand_idx.sql');
    const { rows } = await pool.query(
      `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 't_v_idx'`,
    );
    expect(rows[0].indisvalid).toBe(true);
    expect((await migrate(pool, { dir })).applied).toEqual([]);
  });
});
