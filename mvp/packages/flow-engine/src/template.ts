/**
 * Шаблоны {{переменная}} и извлечение значений из JSON-ответа по пути вида `$.data.items[0].amount`
 * (M-INT-03: маппинг входа и выхода интеграционной операции). Без внешних зависимостей — пакет работает
 * и в браузере (тестовый прогон сценария в редакторе).
 */

const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function render(
  template: string,
  vars: Record<string, string>,
  encode: (v: string) => string = (v) => v,
): string {
  return template.replace(VAR, (_, name: string) => encode(vars[name] ?? ''));
}

/** Имена переменных, упомянутых в шаблоне. */
export function templateVars(template: string): string[] {
  return [...template.matchAll(VAR)].map((m) => m[1]!);
}

/** Значение по пути `$.a.b[0].c` (или `a.b.0.c`); undefined — пути нет. */
export function getPath(obj: unknown, path: string): unknown {
  const parts = path
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Значение для переменной сценария: строки как есть, числа/булевы — строкой, объекты и массивы — JSON. */
export function toVar(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
