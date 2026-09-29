import { describe, expect, it } from 'vitest';
import { buildOutput, type HidCollection, mapTelephony, readField, TelephonyInput, USAGE } from './headset';

/** Типичная гарнитура: вход — Hook Switch (абсолютный) + Phone Mute (относительный) + паддинг; выход — 3 LED. */
const JABRA_LIKE: HidCollection[] = [
  {
    usagePage: 0x0b,
    usage: 0x05,
    inputReports: [
      {
        reportId: 2,
        items: [
          { usages: [USAGE.hookSwitch], reportSize: 1, reportCount: 1, isAbsolute: true },
          { usages: [0x000b0021], reportSize: 1, reportCount: 1, isAbsolute: false }, // Flash
          { usages: [USAGE.phoneMute], reportSize: 1, reportCount: 1, isAbsolute: false },
          { isConstant: true, reportSize: 5, reportCount: 1 },
        ],
      },
    ],
    outputReports: [
      {
        reportId: 3,
        items: [
          { usages: [USAGE.ledMute, USAGE.ledOffHook, USAGE.ledRing], reportSize: 1, reportCount: 3 },
          { isConstant: true, reportSize: 5, reportCount: 1 },
        ],
      },
    ],
  },
];

const dv = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe('WebHID: стандартная Telephony page', () => {
  it('находит поля Hook Switch, Mute и индикаторы с правильными смещениями', () => {
    const m = mapTelephony(JABRA_LIKE);
    expect(m.hook).toMatchObject({ reportId: 2, bitOffset: 0, bitSize: 1, absolute: true });
    expect(m.mute).toMatchObject({ reportId: 2, bitOffset: 2, absolute: false });
    expect(m.out.mute).toMatchObject({ reportId: 3, bitOffset: 0 });
    expect(m.out.offHook).toMatchObject({ reportId: 3, bitOffset: 1 });
    expect(m.out.ring).toMatchObject({ reportId: 3, bitOffset: 2 });
    expect(m.outSizes[3]).toBe(1);
    expect(readField(dv(0b101), m.mute!)).toBe(1);
  });

  it('подъём и опускание Hook Switch → ответ/отбой, нажатие Mute → переключение', () => {
    const input = new TelephonyInput(mapTelephony(JABRA_LIKE));
    expect(input.handle(2, dv(0b001))).toEqual(['answer']);
    expect(input.handle(2, dv(0b001))).toEqual([]); // повтор отчёта — без действия
    expect(input.handle(2, dv(0b101))).toEqual(['mute']);
    expect(input.handle(2, dv(0b001))).toEqual([]); // отпускание кнопки Mute
    expect(input.handle(2, dv(0b000))).toEqual(['hangup']);
    expect(input.handle(9, dv(0xff))).toEqual([]); // чужой отчёт
  });

  it('софтфон ответил сам — следующее опускание рычага воспринимается как отбой', () => {
    const input = new TelephonyInput(mapTelephony(JABRA_LIKE));
    input.syncHook(true);
    expect(input.handle(2, dv(0b000))).toEqual(['hangup']);
  });

  it('выходной отчёт индикаторов: звонок, разговор с выключенным микрофоном', () => {
    const m = mapTelephony(JABRA_LIKE);
    expect([...buildOutput(m, 3, { ring: true, offHook: false, mute: false })]).toEqual([0b100]);
    expect([...buildOutput(m, 3, { ring: false, offHook: true, mute: true })]).toEqual([0b011]);
  });

  it('диапазон usage (usageMinimum..Maximum) и устройство без Telephony page', () => {
    const m = mapTelephony([
      {
        inputReports: [
          {
            reportId: 1,
            items: [{ usageMinimum: 0x000b0020, usageMaximum: 0x000b0021, reportSize: 1, reportCount: 2 }],
          },
        ],
      },
    ]);
    expect(m.hook).toMatchObject({ bitOffset: 0 });
    expect(
      mapTelephony([
        { inputReports: [{ reportId: 1, items: [{ usages: [0x00010030], reportSize: 8, reportCount: 1 }] }] },
      ]).hook,
    ).toBeUndefined();
  });
});
