import { describe, expect, it } from 'vitest';
import { buildGrid, compareRange, type Config, presetRange, type Result, toQuery } from './pivotModel';

const L = { empty: '-', total: 'T', totalOf: (s: string) => `T ${s}`, cmp: 'C', delta: 'D', cur: 'V' };

/** Результат «канал × месяц» с подытогами: g — маска GROUPING (старший бит — первое поле). */
function result(withCompare = false): Result {
  const row = (g: number, k: (string | null)[], v: number, c?: number) => ({
    g,
    k,
    l: k.map((x) => (x === 'web' ? 'Chat' : x === 'voice' ? 'Phone' : x)),
    v: [v],
    ...(withCompare ? { c: [c ?? null] } : {}),
  });
  return {
    needConfirm: false,
    dims: [
      { id: 'conv.channel', label: 'Channel', sort: 'label' },
      { id: 'time.period', label: 'Period', sort: 'key' },
    ],
    measures: [{ id: 'conv.count', label: 'Count', format: 'int' }],
    rows: [
      row(0, ['web', '2026-01-01'], 2, 1),
      row(0, ['web', '2026-02-01'], 3, 3),
      row(0, ['voice', '2026-01-01'], 4, 2),
      row(1, ['web', null], 5),
      row(1, ['voice', null], 4),
      row(2, [null, '2026-01-01'], 6),
      row(2, [null, '2026-02-01'], 3),
      row(3, [null, null], 9, 6),
    ],
    period: { from: '2026-01-01', to: '2026-02-28' },
    compare: withCompare ? { from: '2025-01-01', to: '2025-02-28' } : null,
    warnings: [],
    truncated: false,
    estimate: {
      sourceRows: 0,
      groups: 0,
      measures: 1,
      facts: 1,
      periods: 1,
      seconds: 0,
      heavy: false,
      warnSeconds: 5,
      timeoutSeconds: 60,
    },
    ms: 10,
  };
}

describe('конструктор отчётов: раскладка (Д-041)', () => {
  it('перекрёстная таблица: строки по подписи, столбцы по ключу, итог справа и внизу', () => {
    const g = buildGrid(result(), 1, 'cross', L, null);
    // Один показатель — его имя не повторяется под каждым столбцом.
    expect(g.cols.map((c) => c.header)).toEqual([['2026-01-01'], ['2026-02-01'], ['T']]);
    expect(g.rows.map((r) => [r.labels[0], ...r.cells])).toEqual([
      ['Chat', 2, 3, 5],
      ['Phone', 4, null, 4],
      ['T', 6, 3, 9],
    ]);
  });

  it('сортировка по столбцу итога — по убыванию', () => {
    const g0 = buildGrid(result(), 1, 'cross', L, null);
    const total = g0.cols[2]!.id;
    const g = buildGrid(result(), 1, 'cross', L, { col: total, dir: 'asc' });
    expect(g.rows.map((r) => r.labels[0])).toEqual(['Phone', 'Chat', 'T']);
  });

  it('прямая таблица — поля столбцами, сравнение и изменение в %', () => {
    const g = buildGrid(result(true), 2, 'flat', L, null);
    expect(g.rowHeaders).toEqual(['Channel', 'Period']);
    expect(g.cols.map((c) => c.part)).toEqual(['v', 'c', 'd']);
    const chatJan = g.rows.find((r) => r.labels[0] === 'Chat' && r.labels[1] === '2026-01-01')!;
    expect(chatJan.cells).toEqual([2, 1, 100]);
    expect(g.rows[g.rows.length - 1]!.cells).toEqual([9, 6, 50]);
  });

  it('шапка: объединение ячейки столбца над тремя вариантами сравнения', () => {
    const g = buildGrid(result(true), 1, 'cross', L, null);
    expect(g.head).toHaveLength(2);
    expect(g.head[0]![0]).toMatchObject({ text: '2026-01-01', span: 3 });
    expect(g.head[1]!.map((c) => c.text).slice(0, 3)).toEqual(['V', 'C', 'D']);
  });

  it('период сравнения и быстрые периоды', () => {
    const c = { from: '2026-09-01', to: '2026-09-30', compare: 'prev' } as Config;
    expect(compareRange(c)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(compareRange({ ...c, from: '2026-10-08', to: '2026-10-14' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-07',
    });
    expect(compareRange({ ...c, compare: 'year' })).toEqual({ from: '2025-09-01', to: '2025-09-30' });
    expect(presetRange('prevMonth', '2026-03-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('quarter', '2026-11-02')).toEqual({ from: '2026-10-01', to: '2026-11-02' });
  });

  it('запрос: подписи фильтров не уходят на сервер, пустые фильтры отбрасываются', () => {
    const q = toQuery({
      rows: ['a'],
      cols: ['b'],
      values: ['m'],
      filters: [
        { field: 'x', mode: 'in', values: ['1'], labels: ['One'] },
        { field: 'y', mode: 'in', values: [] },
      ],
      preset: null,
      from: '2026-01-01',
      to: '2026-01-31',
      grain: 'day',
      compare: 'none',
      view: 'flat',
      subtotals: true,
    });
    expect(q.rows).toEqual(['a', 'b']);
    expect(q.cols).toEqual([]);
    expect(q.filters).toEqual([{ field: 'x', mode: 'in', values: ['1'] }]);
    expect(q.subtotals).toBe(false);
  });
});
