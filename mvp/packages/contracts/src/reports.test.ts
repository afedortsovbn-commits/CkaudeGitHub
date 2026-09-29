import { describe, expect, it } from 'vitest';
import { ReportFilterSchema, reportToCsv, SupervisorThresholdsSchema } from './reports';

describe('отчёты: контракты', () => {
  it('CSV: BOM, «;», десятичная запятая, экранирование, итог', () => {
    const csv = reportToCsv({
      columns: [
        { key: 'label', label: 'Канал', type: 'text' },
        { key: 'n', label: 'Кол-во', type: 'int' },
        { key: 'pct', label: 'SL, %', type: 'pct' },
        { key: 'asa', label: 'ASA', type: 'dur' },
      ],
      rows: [
        { label: 'Чат; "сайт"', n: 3, pct: 57.14, asa: 23.6 },
        { label: 'Телефон', n: 0, pct: null, asa: null },
      ],
      totals: { label: 'Итого', n: 3, pct: 57.14, asa: 23.6 },
    });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'Канал;Кол-во;SL, %;ASA',
      '"Чат; ""сайт""";3;57,14;24',
      'Телефон;0;;',
      'Итого;3;57,14;24',
      '',
    ]);
  });

  it('фильтры: пустые значения игнорируются, «особо важные» — булево, неверная дата — ошибка', () => {
    expect(ReportFilterSchema.parse({ from: '', channel: '', important: '1' })).toEqual({ important: true });
    expect(ReportFilterSchema.safeParse({ from: '10.03.2026' }).success).toBe(false);
    expect(ReportFilterSchema.safeParse({ groupBy: 'nope' }).success).toBe(false);
  });

  it('пороги панели супервизора — значения по умолчанию', () => {
    expect(SupervisorThresholdsSchema.parse({ waitWarnS: 30 })).toMatchObject({
      waitWarnS: 30,
      waitCritS: 180,
    });
  });
});
