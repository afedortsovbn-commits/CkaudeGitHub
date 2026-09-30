// Проверка-линтер строк интерфейса (M-NFR-08, Ф12b): в исходниках web и виджета нет кириллических литералов вне
// ресурсов локализации. Проверяются строки, шаблоны и текст JSX (по синтаксическому дереву TypeScript — комментарии
// не мешают); ресурсы — `src/lib/i18n.ts` и `src/lib/i18n/*.ts`; тесты (*.test.ts) не проверяются.
// Использование: node ops/test/i18n-lint.mjs   (код 1 и список мест — если нашлись строки вне ресурсов)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const MVP = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const ts = createRequire(join(MVP, 'package.json'))('typescript');
const ROOTS = ['apps/web/src', 'apps/widget/src'];
const CYR = /[А-Яа-яЁё]/;

const isResource = (rel) => /\/src\/lib\/i18n(\.ts|\/[^/]+\.ts)$/.test(`/${rel}`);
const isTest = (rel) => /\.test\.tsx?$/.test(rel);

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Места с кириллицей в строках, шаблонах и тексте JSX файла. */
export function findLiterals(fileName, text) {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = [];
  const visit = (node) => {
    const k = node.kind;
    const literal =
      k === ts.SyntaxKind.StringLiteral ||
      k === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      k === ts.SyntaxKind.TemplateHead ||
      k === ts.SyntaxKind.TemplateMiddle ||
      k === ts.SyntaxKind.TemplateTail ||
      k === ts.SyntaxKind.JsxText;
    if (literal && CYR.test(node.text ?? node.getText(sf))) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({ line: line + 1, col: character + 1, text: node.getText(sf).trim().slice(0, 60) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let total = 0;
  for (const root of ROOTS) {
    for (const f of files(join(MVP, root))) {
      const rel = relative(MVP, f);
      if (isResource(rel) || isTest(rel)) continue;
      for (const x of findLiterals(f, readFileSync(f, 'utf8'))) {
        total++;
        console.log(`${rel}:${x.line}:${x.col}  ${x.text}`);
      }
    }
  }
  if (total) {
    console.error(
      `\nСтрок интерфейса вне ресурсов: ${total}. Вынесите их в src/lib/i18n (M-NFR-08) и используйте t.<раздел>.<ключ>.`,
    );
    process.exit(1);
  }
  console.log('Строки интерфейса web и виджета — только в ресурсах локализации');
}
