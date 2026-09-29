import { describe, expect, it } from 'vitest';
import { diffDevices, resolveDevice } from './audio-devices';

const d = (id: string, label: string) => ({ id, label });
const MICS = [
  d('default', 'По умолчанию'),
  d('usb1', 'Jabra Evolve2 40'),
  d('bt7', 'Jabra Evolve2 65 (Bluetooth)'),
];

describe('выбор аудиоустройства', () => {
  it('предпочтение по id, затем по названию (у Bluetooth id может смениться), иначе — по умолчанию', () => {
    expect(resolveDevice(MICS, d('usb1', 'Jabra Evolve2 40'))?.id).toBe('usb1');
    expect(resolveDevice(MICS, d('bt-old', 'Jabra Evolve2 65 (Bluetooth)'))?.id).toBe('bt7');
    expect(resolveDevice(MICS, d('gone', 'Нет такого'))?.id).toBe('default');
    expect(resolveDevice([], d('usb1', 'x'))).toBeNull();
  });

  it('пропал используемый микрофон — переход на другое устройство с уведомлением; вернулся — «снова используется»', () => {
    const preferred = { mic: d('bt7', 'Jabra Evolve2 65 (Bluetooth)') };
    const without = MICS.filter((m) => m.id !== 'bt7');
    const before = { mic: MICS[2]!, speaker: null, ringer: null };
    const after = { mic: resolveDevice(without, preferred.mic), speaker: null, ringer: null };
    expect(diffDevices(before, after, preferred, { mic: without, speaker: [], ringer: [] })).toEqual([
      { type: 'fallback', kind: 'mic', lost: MICS[2], now: MICS[0] },
    ]);
    const back = { mic: resolveDevice(MICS, preferred.mic), speaker: null, ringer: null };
    expect(diffDevices(after, back, preferred, { mic: MICS, speaker: [], ringer: [] })).toEqual([
      { type: 'returned', kind: 'mic', device: MICS[2] },
    ]);
    expect(diffDevices(back, back, preferred, { mic: MICS, speaker: [], ringer: [] })).toEqual([]);
  });
});

describe('качество связи', async () => {
  const { qualityLevel } = await import('./softphone');
  it('пороги: хорошее / удовлетворительное / плохое', () => {
    expect(qualityLevel({ rttMs: 40, jitterMs: 5, lossPct: 0 })).toBe('good');
    expect(qualityLevel({ rttMs: 300, jitterMs: 5, lossPct: 0 })).toBe('fair');
    expect(qualityLevel({ rttMs: 40, jitterMs: 5, lossPct: 2 })).toBe('fair');
    expect(qualityLevel({ rttMs: 40, jitterMs: 80, lossPct: 0 })).toBe('poor');
    expect(qualityLevel({ rttMs: null, jitterMs: null, lossPct: null })).toBe('good');
  });
});
