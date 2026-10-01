import { describe, expect, it } from 'vitest';
import { numberKeys, parseAmount, plural, POSITION_FRAGMENTS, positionKeys } from './numbers';
import { sayNumber } from './engine';
import { getPath, render, toVar } from './template';
import { isOpen } from './schedule';

describe('числа из фрагментов', () => {
  it('разложение с учётом рода и падежа', () => {
    expect(numberKeys(0)).toEqual(['0']);
    expect(numberKeys(1)).toEqual(['1']);
    expect(numberKeys(1, 'f')).toEqual(['1f']);
    expect(numberKeys(12)).toEqual(['12']);
    expect(numberKeys(21, 'f')).toEqual(['20', '1f']);
    expect(numberKeys(305)).toEqual(['300', '5']);
    expect(numberKeys(2000)).toEqual(['2f', 'thousand_few']);
    expect(numberKeys(11_000)).toEqual(['11', 'thousand_many']);
    expect(numberKeys(1_234_567)).toEqual([
      '1',
      'million_one',
      '200',
      '30',
      '4',
      'thousand_few',
      '500',
      '60',
      '7',
    ]);
    expect(numberKeys(-40)).toEqual(['minus', '40']);
  });

  it('форма единицы', () => {
    expect([1, 2, 5, 11, 14, 21, 22, 25, 111, 101].map(plural)).toEqual([
      'one',
      'few',
      'many',
      'many',
      'many',
      'one',
      'few',
      'many',
      'many',
      'one',
    ]);
  });

  it('сумма с копейками', () => {
    expect(parseAmount('45,07')).toEqual({ int: 45, frac: 7, negative: false });
    expect(parseAmount('1 200.5')).toEqual({ int: 1200, frac: 50, negative: false });
    expect(parseAmount('abc')).toBeNull();
    const media = sayNumber(
      {
        variable: 'sum',
        gender: 'm',
        unit: { one: 'rub1', few: 'rub2', many: 'rub5' },
        fraction: { gender: 'f', one: 'kop1', few: 'kop2', many: 'kop5' },
      },
      { sum: '21.02' },
    );
    expect(media.map((m) => (m.kind === 'audio' ? m.id : m.kind === 'fragment' ? m.key : '?'))).toEqual([
      '20',
      '1',
      'rub1',
      '2f',
      'kop2',
    ]);
  });
});

describe('шаблоны и путь в JSON', () => {
  it('подстановка и извлечение', () => {
    expect(render('/balance?phone={{ phone }}&x={{nope}}', { phone: '+375 29' }, encodeURIComponent)).toBe(
      '/balance?phone=%2B375%2029&x=',
    );
    const body = { data: { items: [{ amount: 12.5 }], ok: true } };
    expect(getPath(body, '$.data.items[0].amount')).toBe(12.5);
    expect(getPath(body, 'data.ok')).toBe(true);
    expect(getPath(body, '$.data.missing.x')).toBeUndefined();
    expect(toVar(getPath(body, '$.data.items'))).toBe('[{"amount":12.5}]');
  });
});

describe('расписание', () => {
  it('интервал через полночь', () => {
    const s = {
      timezone: 'Europe/Minsk',
      week: { tue: [['22:00', '02:00']] as [string, string][] },
      holidays: [],
    };
    expect(isOpen(s, new Date('2026-09-29T20:30:00Z'))).toBe(true); // вт 23:30
    expect(isOpen(s, new Date('2026-09-29T18:30:00Z'))).toBe(false); // вт 21:30
  });
  it('позиция в очереди (Ф14): «Вы второй в очереди», составные порядковые, за пределами — не озвучивается', () => {
    expect(positionKeys(2)).toEqual(['pos_you', 'ord_2', 'pos_in_queue']);
    expect(positionKeys(20)).toEqual(['pos_you', 'ord_20', 'pos_in_queue']);
    expect(positionKeys(21)).toEqual(['pos_you', '20', 'ord_1', 'pos_in_queue']);
    expect(positionKeys(99)).toEqual(['pos_you', '90', 'ord_9', 'pos_in_queue']);
    expect(positionKeys(0)).toEqual([]);
    expect(positionKeys(100)).toEqual([]);
    const keys = new Set(POSITION_FRAGMENTS.map((f) => f.key));
    for (let n = 1; n <= 99; n++)
      for (const k of positionKeys(n)) expect(keys.has(k) || /^\d+$/.test(k), `${n}: ${k}`).toBe(true);
  });
});
