// Линтер миграций: expand-миграции не должны ломать работающую предыдущую версию (02-архитектура, 6.2 п.7).
// Запрещено в *_expand_*.sql: DROP, RENAME, смена типа столбца, SET NOT NULL,
// добавление NOT NULL-столбца без DEFAULT. Такие изменения — только в *_contract_*.sql следующего релиза.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../../packages/db/migrations/', import.meta.url).pathname;
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
for (const f of readdirSync(dir)
  .filter((n) => n.endsWith('.sql'))
  .sort()) {
  if (!/_expand_/.test(f)) continue;
  const sql = readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '');
  for (const stmt of sql.split(';')) {
    for (const [re, what] of RULES) {
      if (re.test(stmt)) {
        errors++;
        console.error(`${f}: запрещено в expand-миграции (${what}): ${stmt.trim().slice(0, 120)}`);
      }
    }
  }
}
if (errors) process.exit(1);
console.log('миграции: нарушений правила expand/contract нет');
