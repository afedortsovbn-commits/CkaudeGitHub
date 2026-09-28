// Проверка лицензий npm-зависимостей, попадающих в продукт (M-NFR-10).
// Разрешены только свободные бессрочные лицензии; иное — ошибка CI до явного решения.
import { execSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'CC-BY-4.0',
  'MIT OR Apache-2.0',
  '(MIT OR Apache-2.0)',
  'Apache-2.0 OR MIT',
  '(MIT OR CC0-1.0)',
  'MIT-0',
  // Двойная лицензия — используем на условиях MIT (@zone-eu/mailsplit, зависимость mailparser, Ф4).
  '(MIT OR EUPL-1.1+)',
]);
const raw = execSync('pnpm licenses list --prod --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const byLicense = JSON.parse(raw);
const bad = [];
let total = 0;
for (const [license, pkgs] of Object.entries(byLicense)) {
  total += pkgs.length;
  if (!ALLOWED.has(license))
    for (const p of pkgs) bad.push(`${p.name}@${p.versions?.join(',')} — ${license}`);
}
console.log(`проверено пакетов: ${total}; лицензии: ${Object.keys(byLicense).join(', ')}`);
if (bad.length) {
  console.error(`недопустимые или неизвестные лицензии (${bad.length}):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('лицензии в порядке');
