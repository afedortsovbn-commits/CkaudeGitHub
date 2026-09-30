import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Полнота журнала событий (Ф10, M-REP-01): отчёты восстанавливают историю по `event`, поэтому каждое изменение
 * статуса обращения, статуса оператора и статуса тикета в коде сервисов должно сопровождаться событием в той же
 * функции (outbox). Проверка статическая: после SQL, меняющего статус, в пределах функции должен быть вызов
 * публикации события. Новый путь смены статуса без события — падение этого теста.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const DIRS = ['apps', 'packages'];
const SKIP = new Set(['node_modules', 'dist', 'web', 'widget', 'it', 'e2e']);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const RULES: { what: string; sql: RegExp; emit: RegExp }[] = [
  {
    what: 'смена статуса обращения',
    sql: /UPDATE conversation SET[^`]*\bstatus\s*=|INSERT INTO conversation \(/,
    emit: /emitConversation\(|emitCallState\(/,
  },
  {
    what: 'смена статуса тикета',
    sql: /UPDATE ticket SET[^`]*\bstatus\s*=/,
    emit: /statusChanged\(|emitTicket\(/,
  },
  { what: 'статус оператора', sql: /INSERT INTO agent_status \(/, emit: /enqueueEvent\(/ },
];

/** Тело функции от позиции совпадения до следующего объявления функции/метода верхнего уровня. */
function functionTail(src: string, from: number): string {
  const rest = src.slice(from);
  const next = rest.slice(1).search(/\n(export )?(async )?function |\n {2}(@\w+|async \w+\(|private async )/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('полнота журнала событий для отчётов', () => {
  const sources = DIRS.flatMap((d) => files(join(ROOT, d)));

  it('исходники найдены', () => {
    expect(sources.some((f) => f.endsWith('conversations.controller.ts'))).toBe(true);
  });

  for (const rule of RULES) {
    it(`${rule.what} сопровождается событием`, () => {
      const missing: string[] = [];
      let found = 0;
      for (const f of sources) {
        const src = readFileSync(f, 'utf8');
        const re = new RegExp(rule.sql.source, 'g');
        for (let m = re.exec(src); m; m = re.exec(src)) {
          found++;
          if (!rule.emit.test(functionTail(src, m.index))) {
            const line = src.slice(0, m.index).split('\n').length;
            missing.push(`${relative(ROOT, f)}:${line}`);
          }
        }
      }
      expect(found).toBeGreaterThan(0);
      expect(missing, `нет события после изменения: ${missing.join(', ')}`).toEqual([]);
    });
  }
});
