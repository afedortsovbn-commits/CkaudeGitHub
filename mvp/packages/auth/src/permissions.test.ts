import { describe, expect, it } from 'vitest';
import { CATALOG_CODES, compressPermissions, expandPermissions, UMBRELLA_PERMISSIONS } from './permissions';
import { PERMISSIONS } from './principal';

describe('каталог прав', () => {
  it('все права каталога и общих прав известны системе', () => {
    for (const c of [...CATALOG_CODES, ...Object.values(UMBRELLA_PERMISSIONS).flat()])
      expect(PERMISSIONS as readonly string[]).toContain(c);
  });
  it('общее право раскрывается в разделы и остаётся само', () => {
    const p = expandPermissions(['admin.directories', 'reports.view']);
    expect(p.has('admin.directories')).toBe(true);
    expect(p.has('kb.manage')).toBe(true);
    expect(p.has('settings.manage')).toBe(false);
  });
  it('при записи все разделы общего права сворачиваются в него, часть — остаётся разделами', () => {
    expect(compressPermissions([...UMBRELLA_PERMISSIONS['admin.settings']!, 'reports.view'])).toEqual([
      'admin.settings',
      'reports.view',
    ]);
    expect(compressPermissions(['admin.directories']).includes('admin.directories')).toBe(true);
    const part = compressPermissions(['kb.manage', 'templates.manage']);
    expect(part).toEqual(['kb.manage', 'templates.manage']);
  });
});
