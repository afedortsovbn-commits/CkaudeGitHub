// Сигнал перед записью голосового сообщения (ARI record beep=true проигрывает звук «beep»): 1000 Гц, 0,3 с.
// WAV 8 кГц, 16 бит, моно. Запуск: node infra/asterisk/moh/gen-beep.mjs > infra/asterisk/moh/beep.wav
import { Buffer } from 'node:buffer';

const RATE = 8000;
const n = Math.round(0.3 * RATE);
const pcm = new Int16Array(n);
for (let i = 0; i < n; i++) {
  const env = Math.min(1, i / 80, (n - i) / 80);
  pcm[i] = Math.round(Math.sin((2 * Math.PI * 1000 * i) / RATE) * env * 0.4 * 32767);
}
const data = Buffer.from(pcm.buffer);
const h = Buffer.alloc(44);
h.write('RIFF', 0, 'ascii');
h.writeUInt32LE(36 + data.length, 4);
h.write('WAVE', 8, 'ascii');
h.write('fmt ', 12, 'ascii');
h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20);
h.writeUInt16LE(1, 22);
h.writeUInt32LE(RATE, 24);
h.writeUInt32LE(RATE * 2, 28);
h.writeUInt16LE(2, 32);
h.writeUInt16LE(16, 34);
h.write('data', 36, 'ascii');
h.writeUInt32LE(data.length, 40);
process.stdout.write(Buffer.concat([h, data]));
