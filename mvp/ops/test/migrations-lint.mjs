// Линтер миграций: expand-миграции не должны ломать работающую предыдущую версию (02-архитектура, 6.2 п.7).
// Запрещено в *_expand_*.sql: DROP, RENAME, смена типа столбца, SET NOT NULL,
// добавление NOT NULL-столбца без DEFAULT. Такие изменения — только в *_contract_*.sql следующего релиза.
// Исключение — расширение CHECK: `DROP CONSTRAINT IF EXISTS x` допустим, если в том же файле ограничение x
// создаётся заново как CHECK (набор допустимых значений только расширяется — предыдущая версия совместима).
//
// Ф11 (релизный конвейер, 02 — 6.6):
//  - contract-миграция обязана нести пометку `-- contract-of: NNNN[, MMMM]` — номера expand-миграций, после
//    которых удаляемое больше не используется; эти expand-миграции должны быть уже выпущены (есть в базовой
//    ревизии) — contract в том же релизе, что и expand, запрещён (старые экземпляры ещё работают);
//  - `CREATE INDEX CONCURRENTLY` — только в файле с директивой `-- cc:no-transaction` (в транзакции не работает),
//    а такой файл должен быть повторяемым: CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS;
//  - с базовой ревизией (`MIGRATIONS_BASE` или `--base <ref>`, например предыдущий релизный тег или origin/main):
//    выпущенные миграции не изменяются и не удаляются, новые идут после них по номеру.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../../packages/db/migrations/', import.meta.url).pathname;
const argBase = process.argv.indexOf('--base');
const BASE = argBase > 0 ? process.argv[argBase + 1] : process.env.MIGRATIONS_BASE;
const RULES = [
  [/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|TRIGGER|FUNCTION|VIEW|CONSTRAINT|SCHEMA)\b/i, 'DROP'],
  [/\bRENAME\b/i, 'RENAME'],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, 'смена типа столбца'],
  [/\bSET\s+NOT\s+NULL\b/i, 'SET NOT NULL'],
  [
    /\bADD\s+COLUMN\b(?:(?!,|;)[\s\S])*\bNOT\s+NULL\b(?![\s\S]*?\bDEFAULT\b)/i,
    'NOT NULL-столбец без DEFAULT',
  ],
];
let errors = 0;
const fail = (msg) => {
  errors++;
  console.error(msg);
};

const files = readdirSync(dir)
  .filter((n) => n.endsWith('.sql'))
  .sort();
const read = (f) => readFileSync(join(dir, f), 'utf8');

/** Миграции базовой ревизии: имя → содержимое (или null, если база недоступна). */
function baseMigrations() {
  if (!BASE) return null;
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  // Пути в ls-tree/show считаются от корня репозитория только при запуске из корня.
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const rel = dir.slice(root.length + 1);
  let list;
  try {
    list = git('ls-tree', '--name-only', `${BASE}:${rel}`).split('\n').filter(Boolean);
  } catch (e) {
    fail(`базовая ревизия ${BASE} недоступна: ${String(e.stderr ?? e).trim()}`);
    return null;
  }
  return new Map(list.filter((n) => n.endsWith('.sql')).map((n) => [n, git('show', `${BASE}:${rel}${n}`)]));
}
const base = baseMigrations();

for (const f of files) {
  const raw = read(f);
  const sql = raw.replace(/--.*$/gm, '');
  const noTx = /^--\s*cc:no-transaction\s*$/m.test(raw);

  if (/\bCONCURRENTLY\b/i.test(sql) && !noTx) {
    fail(`${f}: CONCURRENTLY работает только вне транзакции — добавьте строку «-- cc:no-transaction»`);
  }
  if (noTx) {
    for (const stmt of sql.split(';')) {
      const s = stmt.trim();
      if (/^CREATE\s+(UNIQUE\s+)?(INDEX|TABLE)\b/i.test(s) && !/\bIF\s+NOT\s+EXISTS\b/i.test(s)) {
        fail(`${f}: миграция без транзакции должна быть повторяемой (IF NOT EXISTS): ${s.slice(0, 100)}`);
      }
      if (/\bADD\s+COLUMN\b/i.test(s) && !/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i.test(s)) {
        fail(`${f}: миграция без транзакции должна быть повторяемой (ADD COLUMN IF NOT EXISTS)`);
      }
    }
  }

  if (/_contract_/.test(f)) {
    const mark = /^--\s*contract-of:\s*([\d,\s]+)$/m.exec(raw);
    if (!mark) {
      fail(
        `${f}: contract-миграция без пометки «-- contract-of: NNNN» (какие expand-миграции она завершает)`,
      );
      continue;
    }
    for (const num of mark[1].split(/[,\s]+/).filter(Boolean)) {
      const expand = files.find((n) => n.startsWith(`${num}_expand_`));
      if (!expand) fail(`${f}: в пометке contract-of указана несуществующая expand-миграция ${num}`);
      else if (expand >= f) fail(`${f}: contract должен идти после завершаемой expand-миграции ${expand}`);
      else if (base && !base.has(expand)) {
        fail(
          `${f}: expand-миграция ${expand} ещё не выпущена (нет в ${BASE}) — contract допустим только в следующем релизе`,
        );
      }
    }
    continue;
  }
  if (!/_expand_/.test(f)) continue;
  const rechecked = new Set(
    [...sql.matchAll(/\bADD\s+CONSTRAINT\s+(\w+)\s+CHECK\b/gi)].map((m) => m[1].toLowerCase()),
  );
  for (const stmt of sql.split(';')) {
    const widen = /\bDROP\s+CONSTRAINT\s+IF\s+EXISTS\s+(\w+)\s*$/i.exec(stmt.trim());
    if (widen && rechecked.has(widen[1].toLowerCase())) continue;
    // Удаление невалидного индекса перед повтором CREATE INDEX CONCURRENTLY выполняет раннер, не миграция.
    for (const [re, what] of RULES) {
      if (re.test(stmt)) fail(`${f}: запрещено в expand-миграции (${what}): ${stmt.trim().slice(0, 120)}`);
    }
  }
}

if (base) {
  const released = [...base.keys()].sort();
  for (const [name, content] of base) {
    if (!files.includes(name)) fail(`${name}: выпущенная миграция удалена (есть в ${BASE})`);
    else if (read(name) !== content) fail(`${name}: выпущенная миграция изменена (отличается от ${BASE})`);
  }
  const last = released.at(-1) ?? '';
  for (const f of files.filter((n) => !base.has(n))) {
    if (f < last) fail(`${f}: новая миграция должна идти после последней выпущенной (${last})`);
  }
  console.log(`миграции сверены с ${BASE}: выпущено ${released.length}, новых ${files.length - base.size}`);
}
if (errors) process.exit(1);
console.log('миграции: нарушений правила expand/contract нет');
