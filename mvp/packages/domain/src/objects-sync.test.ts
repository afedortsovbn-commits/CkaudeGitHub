import { describe, expect, it } from 'vitest';
import { decodeFeed, parseObjectFeed } from './objects-sync';

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
    expect(() => parseObjectFeed('{"objects": "нет"}', 'json')).toThrow(/массив/);
    expect(parseObjectFeed('{"stations": []}', 'json').items).toEqual([]);
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

  it('АСУ НПО ЭК (Приложение 2): GUID — ключ, название с населённым пунктом, предприятие ПОН и исключения, статус', () => {
    // Структура — как на рисунке Приложения 2, данные вымышленные.
    const station = (o: Record<string, unknown>) => ({
      objguid: 'B89F84F7E2A54F70E043BF0BA8C03722',
      azsnum: '21',
      complex: '530',
      complexdesc: 'АЗК 21',
      typeshortname: 'ААЗС',
      name1: 'ААЗС №21',
      status: 'действующий',
      unit: 'РУП "Условнефтепродукт"',
      unitshort: 'УНП',
      unitcode: '20',
      mailaddress: 'Брестская обл., г. Барановичи, ул. Условная, д. 1',
      town: 'Барановичи',
      fuels: [{ id: 1, name: 'АИ-95' }],
      ...o,
    });
    const r = parseObjectFeed(
      JSON.stringify([
        station({}),
        station({
          objguid: '5eb806f7-5ad4-1dd3-e053-bf0ba8c05f2f',
          unitcode: '30',
          status: 'закрыта',
          town: '',
        }),
        station({ objguid: '', name1: 'Без GUID' }),
      ]),
      'asu',
      { enterpriseCode: 'ПОН', enterpriseMap: { '30': 'MALANKA' } },
    );
    expect(r.items).toEqual([
      {
        code: 'B89F84F7E2A54F70E043BF0BA8C03722',
        name: 'ААЗС №21, Барановичи',
        address: 'Брестская обл., г. Барановичи, ул. Условная, д. 1',
        enterprise_code: 'ПОН',
        external_ids: {
          objguid: 'B89F84F7E2A54F70E043BF0BA8C03722',
          azsnum: '21',
          complex: '530',
          unitcode: '20',
        },
        is_active: true,
        line: 1,
      },
      expect.objectContaining({
        code: '5EB806F75AD41DD3E053BF0BA8C05F2F',
        name: 'ААЗС №21',
        enterprise_code: 'MALANKA',
        is_active: false,
        line: 2,
      }),
    ]);
    expect(r.problems).toEqual([{ line: 3, message: expect.stringMatching(/^code:/) }]);
  });

  it('кодировка выгрузки — из Content-Type (windows-1251), по умолчанию UTF-8', () => {
    const cp1251 = Buffer.from([0xc0, 0xc7, 0xd1]); // «АЗС» в windows-1251
    expect(decodeFeed(cp1251, 'application/json; charset=windows-1251')).toBe('АЗС');
    expect(decodeFeed(Buffer.from('АЗС'), 'text/html')).toBe('АЗС');
    expect(decodeFeed(Buffer.from('АЗС'), null)).toBe('АЗС');
  });
});
