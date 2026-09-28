import { describe, expect, it } from 'vitest';
import { inScope, scopeFilter } from './scope';

const E1 = '00000000-0000-7000-8000-000000000001';
const E2 = '00000000-0000-7000-8000-000000000002';
const D1 = '00000000-0000-7000-8000-0000000000d1';
const T1 = '00000000-0000-7000-8000-0000000000a1';
const cols = { enterprise: 'x.e', department: 'x.d', topicPath: 'x.p' };

describe('scopeFilter', () => {
  it('scope.all — без ограничений', () => {
    expect(scopeFilter({ all: true, rules: [] }, cols)).toEqual({ sql: 'TRUE', params: [] });
  });
  it('нет правил — ничего не видно', () => {
    expect(scopeFilter({ all: false, rules: [] }, cols).sql).toBe('FALSE');
  });
  it('правило «всё» (все измерения null) — TRUE', () => {
    expect(
      scopeFilter({ all: false, rules: [{ enterpriseIds: null, departmentIds: null, topicIds: null }] }, cols)
        .sql,
    ).toBe('(TRUE)');
  });
  it('правила объединяются по ИЛИ, измерения — по И, нумерация параметров со startIndex', () => {
    const r = scopeFilter(
      {
        all: false,
        rules: [
          { enterpriseIds: [E1], departmentIds: [D1], topicIds: null },
          { enterpriseIds: [E2], departmentIds: null, topicIds: [T1] },
        ],
      },
      cols,
      3,
    );
    expect(r.sql).toBe(
      '((x.e = ANY($3::uuid[]) AND x.d = ANY($4::uuid[])) OR (x.e = ANY($5::uuid[]) AND x.p && $6::uuid[]))',
    );
    expect(r.params).toEqual([[E1], [D1], [E2], [T1]]);
  });
  it('отсутствующее у строки измерение не ограничивает', () => {
    const r = scopeFilter(
      { all: false, rules: [{ enterpriseIds: [E1], departmentIds: null, topicIds: [T1] }] },
      { enterprise: 'e.id' },
    );
    expect(r.sql).toBe('((e.id = ANY($1::uuid[])))');
  });
});

describe('inScope (та же семантика в памяти)', () => {
  const subject = { all: false, rules: [{ enterpriseIds: [E1], departmentIds: null, topicIds: [T1] }] };
  it('подходит строка своего предприятия в поддереве темы', () => {
    expect(inScope(subject, { enterpriseId: E1, departmentId: D1, topicPath: ['root', T1, 'leaf'] })).toBe(
      true,
    );
  });
  it('чужое предприятие — нет', () => {
    expect(inScope(subject, { enterpriseId: E2, topicPath: [T1] })).toBe(false);
  });
  it('тема вне поддерева — нет', () => {
    expect(inScope(subject, { enterpriseId: E1, topicPath: ['other'] })).toBe(false);
  });
  it('пустое значение измерения при ограничении — нет', () => {
    expect(inScope(subject, { enterpriseId: null, topicPath: [T1] })).toBe(false);
  });
});
