// Генератор музыки на удержании (M-TEL-07): собственная мелодия без сторонних лицензий.
// WAV 8 кГц, 16 бит, моно — родной формат Asterisk для G.711, без транскодирования при воспроизведении.
// Запуск: node infra/asterisk/moh/gen-moh.mjs > infra/asterisk/moh/default.wav
import { Buffer } from 'node:buffer';

const RATE = 8000;
const BPM = 84;
const beat = 60 / BPM;
// Мягкие арпеджио аккордов Am – F – C – G, по 4 доли на аккорд, дважды.
const chords = [
  [220.0, 261.63, 329.63],
  [174.61, 220.0, 261.63],
  [261.63, 329.63, 392.0],
  [196.0, 246.94, 293.66],
];
const notes = [];
for (let rep = 0; rep < 2; rep++)
  for (const ch of chords)
    for (let i = 0; i < 4; i++) notes.push({ f: ch[i % 3], bass: ch[0] / 2 });

const total = Math.round(notes.length * beat * RATE);
const pcm = new Int16Array(total);
notes.forEach((n, idx) => {
  const start = Math.round(idx * beat * RATE);
  const len = Math.round(beat * 1.8 * RATE); // лёгкое перекрытие нот
  for (let i = 0; i < len && start + i < total; i++) {
    const t = i / RATE;
    const env = Math.min(1, t / 0.02) * Math.exp(-t * 2.2);
    const v =
      Math.sin(2 * Math.PI * n.f * t) * 0.5 +
      Math.sin(2 * Math.PI * n.f * 2 * t) * 0.12 +
      Math.sin(2 * Math.PI * n.bass * t) * 0.25;
    pcm[start + i] = Math.max(-32767, Math.min(32767, pcm[start + i] + v * env * 6000));
  }
});

const data = Buffer.from(pcm.buffer);
const h = Buffer.alloc(44);
h.write('RIFF', 0);
h.writeUInt32LE(36 + data.length, 4);
h.write('WAVE', 8);
h.write('fmt ', 12);
h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20);
h.writeUInt16LE(1, 22);
h.writeUInt32LE(RATE, 24);
h.writeUInt32LE(RATE * 2, 28);
h.writeUInt16LE(2, 32);
h.writeUInt16LE(16, 34);
h.write('data', 36);
h.writeUInt32LE(data.length, 40);
process.stdout.write(Buffer.concat([h, data]));
