// Проверка совместимости контрактов с предыдущим релизом (Ф11, 02-архитектура 6.6 п.1).
// Сравнивает события и команды шины (`@cc/contracts`) и OpenAPI публичного API текущего кода с базовой
// ревизией: допустимы только аддитивные изменения (ops/compat/diff.mjs).
// Использование:
//   node ops/compat/check.mjs [--base <ref>] [--report <файл.json>]
// База: --base, иначе COMPAT_BASE, иначе последний релизный тег release-*, иначе origin/main.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareSnapshots } from './diff.mjs';
import { MVP, snapshot } from './snapshot.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function defaultBase() {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'release-*'], {
      cwd: MVP,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (tag) return tag;
  } catch {
    /* релизных тегов ещё нет */
  }
  return 'origin/main';
}

const base = arg('--base') ?? process.env.COMPAT_BASE ?? defaultBase();
const allowFile = join(MVP, 'ops/compat/allow.json');
const allow = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, 'utf8')) : [];

let baseSnap;
try {
  baseSnap = snapshot(base);
} catch (e) {
  console.error(`базовая ревизия ${base} недоступна: ${String(e.stderr ?? e.message ?? e).trim()}`);
  process.exit(2);
}
const next = snapshot();
const r = compareSnapshots(baseSnap, next, allow);
const count = (s) => Object.keys(s.types).length + Object.keys(s.values).length;
console.log(
  `совместимость контрактов: ${base} → рабочий каталог; типов и констант ${count(baseSnap)} → ${count(next)}, ` +
    `операций API ${Object.keys(baseSnap.openapi?.operations ?? {}).length} → ${Object.keys(next.openapi?.operations ?? {}).length}`,
);
for (const a of r.added) console.log(`  + ${a}`);
for (const w of r.warnings) console.log(`  ! ${w}`);
for (const a of r.allowed) console.log(`  ~ ${a}`);
for (const e of r.errors) console.error(`  ✗ ${e}`);
const report = arg('--report');
if (report) writeFileSync(report, JSON.stringify({ base, ...r }, null, 2));
if (r.errors.length) {
  console.error(
    `НЕСОВМЕСТИМО: ${r.errors.length} изменений ломают совместную работу версий N и N+1. ` +
      'Сделайте изменение аддитивным (новое необязательное поле, новый тип события …v2 с двойной публикацией) ' +
      'или, если несовместимость осознанная и безопасна, опишите её в ops/compat/allow.json с причиной.',
  );
  process.exit(1);
}
console.log(`контракты совместимы (предупреждений: ${r.warnings.length})`);
