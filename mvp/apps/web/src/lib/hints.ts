/**
 * Структурированная подсказка оператору — статья базы знаний, текст которой разбит на разделы с заголовками
 * отдельными строками (как их пишет администратор или загрузчик справочников):
 *
 *   ОТВЕТ КЛИЕНТУ            — готовый текст клиенту (его можно вставить в чат одной кнопкой);
 *   УТОЧНИТЕ У КЛИЕНТА       — что спросить (пункты «• …»);
 *   ДЕЙСТВИЯ ОПЕРАТОРА       — порядок действий («1. …»);
 *   ВАЖНО                    — оговорки, которые легко упустить;
 *   КОНТАКТЫ                 — телефоны и ссылки;
 *   ЕСЛИ НЕ РЕШЕНО — ОБРАЩЕНИЕ НА 2-Ю ЛИНИЮ — «Когда: …», «Тема: …», «Подтема: …».
 *
 * Статья без этих заголовков — обычная справка: показывается текстом целиком.
 */
export interface Hint {
  structured: boolean;
  intro: string;
  answer: string;
  ask: string[];
  steps: string[];
  warn: string[];
  contacts: string[];
  escalate: { when: string; topic: string; sub: string } | null;
  /** Полный текст исходной инструкции (раздел «ИСХОДНАЯ ИНСТРУКЦИЯ») — показывается свёрнутым. */
  source: string;
}

const HEADS: [RegExp, keyof Omit<Hint, 'structured'>][] = [
  [/^ОТВЕТ КЛИЕНТУ:?$/i, 'answer'],
  [/^УТОЧНИТЕ( У КЛИЕНТА)?:?$/i, 'ask'],
  [/^ДЕЙСТВИЯ( ОПЕРАТОРА)?:?$/i, 'steps'],
  [/^ВАЖНО:?$/i, 'warn'],
  [/^КОНТАКТЫ:?$/i, 'contacts'],
  [/^ЕСЛИ НЕ РЕШЕНО.*$/i, 'escalate'],
  [/^ИСХОДНАЯ ИНСТРУКЦИЯ:?$/i, 'source'],
];

const bullet = (s: string) => s.replace(/^\s*(?:[•\-–—*]|\d+[.)])\s*/, '').trim();

export function parseHint(body: string): Hint {
  const h: Hint = {
    structured: false,
    intro: '',
    answer: '',
    ask: [],
    steps: [],
    warn: [],
    contacts: [],
    escalate: null,
    source: '',
  };
  let cur: string = 'intro';
  const buf: Record<string, string[]> = { intro: [] };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const head = HEADS.find(([re]) => re.test(line));
    if (head) {
      h.structured = true;
      cur = head[1];
      buf[cur] = buf[cur] ?? [];
      continue;
    }
    (buf[cur] = buf[cur] ?? []).push(raw);
  }
  const lines = (k: string) => (buf[k] ?? []).map((l) => l.trim()).filter(Boolean);
  h.intro = (buf.intro ?? []).join('\n').trim();
  h.answer = (buf.answer ?? []).join('\n').trim();
  h.source = (buf.source ?? []).join('\n').trim();
  h.ask = lines('ask').map(bullet);
  h.steps = lines('steps').map(bullet);
  h.warn = lines('warn').map(bullet);
  h.contacts = lines('contacts').map(bullet);
  const esc = lines('escalate');
  if (esc.length) {
    const val = (p: RegExp) => bullet(esc.find((l) => p.test(l))?.replace(p, '') ?? '');
    h.escalate = { when: val(/^Когда:\s*/i), topic: val(/^Тема:\s*/i), sub: val(/^Подтема:\s*/i) };
  }
  return h;
}

/** Текст, который вставляется в ответ клиенту: для структурированной подсказки — только «Ответ клиенту». */
export function hintInsertText(body: string): string {
  const h = parseHint(body);
  return h.structured ? h.answer : body;
}
