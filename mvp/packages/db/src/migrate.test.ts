import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations } from './migrate';

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
