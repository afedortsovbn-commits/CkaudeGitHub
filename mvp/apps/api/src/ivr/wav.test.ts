import { describe, expect, it } from 'vitest';
import { parseWav } from './wav';

function wav(rate: number, channels: number, samples: number): Buffer {
  const data = samples * 2 * channels;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

describe('проверка WAV для IVR', () => {
  it('принимает PCM 16 бит моно 8 кГц и считает длительность', () => {
    expect(parseWav(wav(8000, 1, 12000))).toEqual({ durationMs: 1500 });
  });
  it('отклоняет другой формат', () => {
    expect(parseWav(wav(44100, 2, 44100))).toBe('Нужен WAV PCM 16 бит, моно, 8000 Гц');
    expect(parseWav(Buffer.from('ID3 mp3 data...................................'))).toBe('Нужен файл WAV');
  });
});
