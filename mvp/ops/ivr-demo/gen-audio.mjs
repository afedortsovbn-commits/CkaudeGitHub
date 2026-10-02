// Демо-фразы IVR и фрагменты чисел для демо-стенда (Ф6). Синтез — espeak-ng (инструмент разработчика,
// в продукт не входит; сгенерированные файлы — данные, лицензия инструмента на них не распространяется).
// На реальном стенде фразы записывает диктор и загружает администратор в «Аудиобиблиотеку».
// Запуск: node ops/ivr-demo/gen-audio.mjs  (нужен espeak-ng) → apps/api/assets/ivr-demo/*.wav
// Ф14: ONLY=position — только фрагменты позиции в очереди (прежние файлы не перезаписываются).
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = new URL('../../apps/api/assets/ivr-demo/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const {
  prompts,
  fragments,
  position = {},
} = JSON.parse(readFileSync(new URL('../../apps/api/assets/ivr-demo/phrases.json', import.meta.url), 'utf8'));

function wav8k(src) {
  // Разбор WAV espeak-ng (PCM 16 бит моно 22050 Гц) и передискретизация в 8 кГц с простым ФНЧ.
  const rate = src.readUInt32LE(24);
  let off = 12;
  while (src.toString('ascii', off, off + 4) !== 'data') off += 8 + src.readUInt32LE(off + 4);
  const n = Math.floor(Math.min(src.readUInt32LE(off + 4), src.length - off - 8) / 2);
  const inp = new Float64Array(n);
  for (let i = 0; i < n; i++) inp[i] = src.readInt16LE(off + 8 + i * 2);
  const k = Math.max(1, Math.round(rate / 8000 / 1.2));
  const lp = inp.map((_, i) => {
    let s = 0;
    for (let j = -k; j <= k; j++) s += inp[Math.min(n - 1, Math.max(0, i + j))];
    return s / (2 * k + 1);
  });
  const m = Math.floor((n * 8000) / rate);
  const pad = 800; // 0,1 с тишины в конце — фраза не обрезается на стыке фрагментов
  const data = Buffer.alloc((m + pad) * 2);
  for (let i = 0; i < m; i++) {
    const x = (i * rate) / 8000;
    const a = Math.floor(x);
    const v = lp[a] + (lp[Math.min(n - 1, a + 1)] - lp[a]) * (x - a);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 1.3))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const say = (file, text, speed = 150) => {
  const raw = execFileSync('espeak-ng', ['-v', 'ru', '-s', String(speed), '--stdout', text]);
  writeFileSync(`${OUT}${file}.wav`, wav8k(raw));
};
const only = process.env.ONLY;
if (!only) for (const [key, text] of Object.entries(prompts)) say(key, text);
if (!only) for (const [key, text] of Object.entries(fragments)) say(`n_${key}`, text, 165);
// Ф14: фраза позиции в очереди «Вы второй в очереди» (фрагменты p_<ключ>).
for (const [key, text] of Object.entries(position)) say(`p_${key}`, text, 165);
writeFileSync(`${OUT}phrases.json`, JSON.stringify({ prompts, fragments, position }, null, 2) + '\n');
console.log(`готово: ${Object.keys(prompts).length} фраз, ${Object.keys(fragments).length} фрагментов`);
