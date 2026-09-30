// Проверка-линтер строк интерфейса (M-NFR-08): находит кириллицу в строках, шаблонах и тексте JSX, но не в комментариях.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLiterals } from './i18n-lint.mjs';

test('строки, шаблоны, текст JSX и атрибуты с кириллицей — нарушения', () => {
  const src = `
    const a = 'Сохранить';
    const b = \`Звонок \${n}\`;
    const c = <Button title="Подсказка">Отправить {x} шт.</Button>;
  `;
  const found = findLiterals('x.tsx', src).map((f) => f.text);
  assert.deepEqual(found, ["'Сохранить'", '`Звонок ${', '"Подсказка"', 'Отправить', 'шт.']);
});

test('комментарии, латиница и ресурсы через t — не нарушения', () => {
  const src = `
    // Комментарий по-русски
    /** Документация по-русски */
    const a = t.workspace.sokhranit;
    const b = <Text data-testid="close">{t.save}</Text>;
    const c = 'Telegram';
  `;
  assert.deepEqual(findLiterals('x.tsx', src), []);
});
