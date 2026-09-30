import { describe, expect, it } from 'vitest';
import { parseObjectFeed } from './objects-sync';

describe('разбор выгрузки справочника объектов (Ф13, контракт-заглушка В-42)', () => {
  it('JSON: массив, {items}, camelCase и внешние идентификаторы', () => {
    const a = parseObjectFeed(
      JSON.stringify([
        {
          code: 'AZS-1',
          name: 'АЗС № 1',
          address: 'Минск',
          enterprise_code: 'NORTH',
          external_ids: { rocketdata: 'rd-1' },
        },
        { code: 'AZS-2', name: 'АЗС № 2', enterpriseCode: 'SOUTH', isActive: false, externalIds: { gis: 7 } },
      ]),
      'json',
    );
    expect(a.problems).toEqual([]);
    expect(a.items).toEqual([
      {
        code: 'AZS-1',
        name: 'АЗС № 1',
        address: 'Минск',
        enterprise_code: 'NORTH',
        external_ids: { rocketdata: 'rd-1' },
        is_active: true,
        line: 1,
      },
      {
        code: 'AZS-2',
        name: 'АЗС № 2',
        address: null,
        enterprise_code: 'SOUTH',
        external_ids: { gis: '7' },
        is_active: false,
        line: 2,
      },
    ]);
    const b = parseObjectFeed(
      JSON.stringify({ items: [{ code: 1, name: 'x', enterprise_code: 'E' }] }),
      'json',
    );
    expect(b.items[0]).toMatchObject({ code: '1', name: 'x' });
  });

  it('JSON: некорректные строки — замечания с номером строки, остальные разбираются', () => {
    const r = parseObjectFeed(
      JSON.stringify([{ code: 'A', name: 'A', enterprise_code: 'E' }, { code: 'B' }, 'мусор']),
      'json',
    );
    expect(r.items.map((i) => i.code)).toEqual(['A']);
    expect(r.problems.map((p) => [p.line, p.code])).toEqual([
      [2, 'B'],
      [3, undefined],
    ]);
    expect(() => parseObjectFeed('{"objects": []}', 'json')).toThrow(/массив/);
    expect(() => parseObjectFeed('<html>', 'json')).toThrow(/не JSON/);
  });

  it('CSV: колонки ручного импорта, rocketdata и ext_<ключ>, признак закрытия', () => {
    const csv =
      '﻿code;name;address;enterprise_code;rocketdata;ext_gis;is_active\n' +
      'AZS-1;АЗС № 1;Минск, пр. Независимости 1;NORTH;rd-1;g1;1\n' +
      'AZS-2;АЗС № 2;;SOUTH;;;нет\n' +
      ';без кода;;NORTH;;;\n';
    const r = parseObjectFeed(csv, 'csv');
    expect(r.items).toEqual([
      {
        code: 'AZS-1',
        name: 'АЗС № 1',
        address: 'Минск, пр. Независимости 1',
        enterprise_code: 'NORTH',
        external_ids: { rocketdata: 'rd-1', gis: 'g1' },
        is_active: true,
        line: 2,
      },
      {
        code: 'AZS-2',
        name: 'АЗС № 2',
        address: null,
        enterprise_code: 'SOUTH',
        external_ids: {},
        is_active: false,
        line: 3,
      },
    ]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.line).toBe(4);
    expect(() => parseObjectFeed('name;address\nx;y', 'csv')).toThrow(/code/);
  });
});
