import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations, splitStatements } from './migrate';

describe('загрузка миграций', () => {
  it('все миграции пакета названы по правилу и идут по порядку', () => {
    const files = loadMigrations();
    expect(files.length).toBeGreaterThan(0);
    const nums = files.map((f) => f.name.slice(0, 4));
    expect([...nums].sort()).toEqual(nums);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it('отклоняет файл с неправильным именем', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_add_table.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/expand\|contract/);
  });
});

describe('миграции без транзакции', () => {
  it('директива cc:no-transaction распознаётся', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_expand_a.sql'), 'SELECT 1;');
    writeFileSync(
      join(dir, '0002_expand_b.sql'),
      '-- cc:no-transaction\nCREATE INDEX CONCURRENTLY x ON t (a);',
    );
    expect(loadMigrations(dir).map((f) => f.noTransaction)).toEqual([false, true]);
  });

  it('SQL делится на операторы с учётом строк, комментариев и $$-тел', () => {
    const sql = `-- комментарий; с точкой с запятой
CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON a (x);
INSERT INTO t VALUES ('a;b', 'it''s;');
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END; $$;
DO $body$ BEGIN PERFORM 2; END $body$`;
    expect(splitStatements(sql)).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON a (x)',
      "INSERT INTO t VALUES ('a;b', 'it''s;')",
      'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END; $$',
      'DO $body$ BEGIN PERFORM 2; END $body$',
    ]);
  });
});
