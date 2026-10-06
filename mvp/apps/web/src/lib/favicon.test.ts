import { describe, expect, it } from 'vitest';
import { roleFaviconUrl, roleIconKey } from './favicon';

describe('значок вкладки по роли', () => {
  it('выбирается по старшинству роли; куратор — как 2-я линия; неизвестная — оператор', () => {
    expect(roleIconKey(['operator'])).toBe('operator');
    expect(roleIconKey(['operator', 'supervisor'])).toBe('supervisor');
    expect(roleIconKey(['responsible', 'admin'])).toBe('admin');
    expect(roleIconKey(['curator'])).toBe('responsible');
    expect(roleIconKey(['custom_role'])).toBe('operator');
  });
  it('разные роли — разные значки', () => {
    const urls = new Set(['operator', 'responsible', 'supervisor', 'admin'].map((r) => roleFaviconUrl([r])));
    expect(urls.size).toBe(4);
    expect(roleFaviconUrl(['admin'])).toMatch(/^data:image\/svg\+xml,/);
  });
});
