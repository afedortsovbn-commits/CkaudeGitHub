import {
  exitsOf,
  type FlowGraph,
  type FlowKind,
  type FlowNode,
  MENU_DIGITS,
  NODE_SPECS,
  type NodeType,
} from './graph';

export interface Issue {
  nodeId?: string;
  message: string;
}
export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNum = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Структурная проверка JSON сценария (api — перед сохранением черновика). */
export function parseGraph(input: unknown): FlowGraph | string {
  if (!input || typeof input !== 'object') return 'Сценарий должен быть объектом';
  const g = input as Record<string, unknown>;
  if (g.kind !== 'voice' && g.kind !== 'text') return 'Неизвестный тип сценария';
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return 'Нет списка узлов или связей';
  if (g.nodes.length > 500 || g.edges.length > 2000) return 'Слишком большой сценарий';
  const nodes: FlowNode[] = [];
  const ids = new Set<string>();
  for (const n of g.nodes as Record<string, unknown>[]) {
    if (!n || !isStr(n.id) || n.id.length > 64) return 'Узел без идентификатора';
    if (ids.has(n.id)) return `Повторяющийся идентификатор узла ${n.id}`;
    ids.add(n.id);
    if (typeof n.type !== 'string' || !(n.type in NODE_SPECS))
      return `Неизвестный тип узла ${String(n.type)}`;
    const params = n.params && typeof n.params === 'object' ? (n.params as Record<string, unknown>) : {};
    const pos = n.position as { x?: unknown; y?: unknown } | undefined;
    nodes.push({
      id: n.id,
      type: n.type as NodeType,
      ...(isStr(n.name) ? { name: n.name.slice(0, 200) } : {}),
      ...(pos && typeof pos.x === 'number' && typeof pos.y === 'number'
        ? { position: { x: pos.x, y: pos.y } }
        : {}),
      params,
    });
  }
  const edges = [];
  for (const e of g.edges as Record<string, unknown>[]) {
    if (!e || !isStr(e.id) || !isStr(e.source) || !isStr(e.exit) || !isStr(e.target))
      return 'Некорректная связь';
    edges.push({ id: e.id, source: e.source, exit: e.exit, target: e.target });
  }
  return { version: 1, kind: g.kind, nodes, edges };
}

function checkWait(p: Record<string, unknown>, err: (m: string) => void) {
  if (p.waitSec !== undefined && p.waitSec !== null && p.waitSec !== 0 && !isNum(p.waitSec, 10, 86_400))
    err('ждать ответа — от 10 с до 24 ч');
  if (p.reminders !== undefined && p.reminders !== null && !isNum(p.reminders, 0, 5))
    err('напоминаний — от 0 до 5');
  if (p.remindText !== undefined && typeof p.remindText !== 'string') err('некорректный текст напоминания');
  else if (typeof p.remindText === 'string' && p.remindText.length > 4000)
    err('Напоминание длиннее 4000 символов');
}

function checkParams(n: FlowNode, err: (m: string) => void) {
  const p = n.params;
  const audioList = (key: string, required: boolean, what: string) => {
    if (p[key] === undefined && !required) return;
    if (!isStrArr(p[key])) return err(`некорректный список файлов («${what}»)`);
    if (required && !(p[key] as string[]).length) err(`выберите аудиофайл («${what}»)`);
  };
  switch (n.type) {
    case 'play':
      return audioList('audio', true, 'Сообщение');
    case 'menu': {
      audioList('audio', true, 'Меню');
      audioList('invalidAudio', false, 'Фраза о неверном вводе');
      const d = p.digits;
      if (!isStrArr(d) || !d.length) return err('нет пунктов');
      if (d.some((x) => !MENU_DIGITS.includes(x))) err('пункт — одна цифра 0–9, * или #');
      if (new Set(d).size !== d.length) err('повторяющиеся цифры');
      if (p.backDigit !== undefined && p.backDigit !== '' && p.backDigit !== null) {
        if (!MENU_DIGITS.includes(String(p.backDigit))) err('цифра возврата — 0–9, * или #');
        if (d.includes(String(p.backDigit))) err('цифра возврата совпадает с пунктом меню');
      }
      if (!isNum(p.timeoutSec, 1, 60)) err('таймаут — от 1 до 60 с');
      if (!isNum(p.retries, 0, 10)) err('повторов — от 0 до 10');
      return;
    }
    case 'schedule':
      if (!isStr(p.scheduleId)) err('Выберите расписание');
      return;
    case 'condition':
      if (!isStr(p.variable)) err('укажите переменную');
      if (!['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'empty', 'notEmpty'].includes(String(p.op)))
        err('неизвестная операция');
      return;
    case 'setVariable':
      if (!isStr(p.variable) || !/^[\p{L}\p{N}_.-]+$/u.test(p.variable))
        err('Укажите имя переменной (буквы, цифры, _ . -)');
      if (typeof p.value !== 'string') err('Укажите значение');
      return;
    case 'queue':
      if (!isStr(p.queueId)) err('Выберите очередь');
      audioList('announceAudio', false, 'Сообщение в очереди');
      if (
        p.announceEverySec !== undefined &&
        p.announceEverySec !== null &&
        !isNum(p.announceEverySec, 10, 600)
      )
        err('Периодичность сообщения — от 10 до 600 с');
      if (p.maxWaitSec !== undefined && p.maxWaitSec !== null && !isNum(p.maxWaitSec, 10, 7200))
        err('Максимальное ожидание — от 10 до 7200 с');
      return;
    case 'voicemail':
      if (p.mode !== 'voicemail' && p.mode !== 'callback') err('Выберите режим');
      if (!isStr(p.queueId)) err('Выберите очередь для задачи «перезвонить»');
      audioList('audio', p.mode === 'voicemail', 'Приглашение');
      if (p.mode === 'voicemail' && !isNum(p.maxSec, 5, 600)) err('Длительность сообщения — от 5 до 600 с');
      return;
    case 'http':
      if (!isStr(p.operationId)) err('Выберите интеграционную операцию');
      if (p.input !== undefined && (typeof p.input !== 'object' || p.input === null))
        err('Некорректные входные данные');
      return;
    case 'sayNumber':
      if (!isStr(p.variable)) err('Укажите переменную с числом');
      if (p.gender !== 'm' && p.gender !== 'f') err('Укажите род единицы измерения');
      audioList('before', false, 'Фраза перед числом');
      audioList('after', false, 'Фраза после числа');
      return;
    case 'transfer':
      if (!isStr(p.number) || !/^\+?[\d*#]{2,20}$/.test(p.number.replace(/[\s()-]/g, '')))
        err('Укажите номер для перевода');
      return;
    case 'csat':
      audioList('audio', true, 'Вопрос об оценке');
      audioList('thanksAudio', false, 'Благодарность');
      if (!isNum(p.timeoutSec, 1, 60)) err('таймаут — от 1 до 60 с');
      if (!isNum(p.retries, 0, 5)) err('повторов — от 0 до 5');
      return;
    case 'hangup':
      if (p.text !== undefined && typeof p.text !== 'string') err('некорректный текст сообщения');
      return audioList('audio', false, 'Прощальная фраза');
    case 'message':
      if (!isStr(p.text)) err('Введите текст сообщения');
      else if (p.text.length > 4000) err('Сообщение длиннее 4000 символов');
      return;
    case 'buttons': {
      if (!isStr(p.text)) err('Введите вопрос');
      const b = p.buttons;
      if (!Array.isArray(b) || !b.length) return err('Добавьте кнопки');
      if (b.length > 10) err('Не больше 10 кнопок');
      const ids = new Set<string>();
      const labels = new Set<string>();
      for (const x of b as { id?: unknown; label?: unknown }[]) {
        if (!x || !isStr(x.id) || !isStr(x.label)) {
          err('У кнопки нет текста');
          continue;
        }
        if (x.label.length > 64) err(`Текст кнопки «${x.label.slice(0, 20)}…» длиннее 64 символов`);
        if (ids.has(x.id) || labels.has(x.label.toLowerCase())) err('Повторяющиеся кнопки');
        ids.add(x.id);
        labels.add(x.label.toLowerCase());
      }
      if (!isNum(p.retries, 0, 10)) err('повторов — от 0 до 10');
      if (p.variable !== undefined && p.variable !== '' && !/^[\p{L}\p{N}_.-]+$/u.test(String(p.variable)))
        err('Имя переменной — буквы, цифры, _ . -');
      checkWait(p, err);
      return;
    }
    case 'ask':
      if (!isStr(p.text)) err('Введите вопрос');
      if (!isStr(p.variable) || !/^[\p{L}\p{N}_.-]+$/u.test(p.variable))
        err('Укажите переменную для ответа (буквы, цифры, _ . -)');
      if (!['text', 'phone', 'email', 'number'].includes(String(p.validation))) err('Выберите формат ответа');
      if (!isNum(p.retries, 0, 10)) err('повторов — от 0 до 10');
      if (
        p.saveTo !== undefined &&
        p.saveTo !== null &&
        !['phone', 'email', 'name'].includes(String(p.saveTo))
      )
        err('Неизвестное поле карточки');
      checkWait(p, err);
      return;
    case 'handoff':
      if (p.text !== undefined && typeof p.text !== 'string') err('некорректный текст сообщения');
      if (p.priority !== undefined && p.priority !== null && !isNum(p.priority, 0, 10000))
        err('Надбавка приоритета — от 0 до 10000');
      return;
    default:
      return;
  }
}

/**
 * Проверка сценария перед публикацией (M-IVR-06): ошибки блокируют публикацию, предупреждения — нет.
 */
export function validateGraph(graph: FlowGraph, kind: FlowKind = graph.kind): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const starts = graph.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) errors.push({ message: 'В сценарии должен быть ровно один узел «Начало»' });

  for (const n of graph.nodes) {
    const spec = NODE_SPECS[n.type];
    const label = n.name || spec.label;
    if (!spec.kinds.includes(kind))
      errors.push({ nodeId: n.id, message: `«${label}»: узел недоступен в сценарии этого типа` });
    checkParams(n, (m) => errors.push({ nodeId: n.id, message: `«${label}»: ${m}` }));
  }

  const used = new Set<string>();
  for (const e of graph.edges) {
    const src = byId.get(e.source);
    if (!src || !byId.has(e.target)) {
      errors.push({ message: 'Связь ведёт к несуществующему узлу' });
      continue;
    }
    if (!exitsOf(src).some((x) => x.id === e.exit)) {
      errors.push({
        nodeId: src.id,
        message: `«${src.name || NODE_SPECS[src.type].label}»: связь от несуществующего выхода`,
      });
      continue;
    }
    const key = `${e.source}|${e.exit}`;
    if (used.has(key))
      errors.push({
        nodeId: src.id,
        message: `«${src.name || NODE_SPECS[src.type].label}»: у выхода несколько связей`,
      });
    used.add(key);
    if (byId.get(e.target)?.type === 'start')
      errors.push({ nodeId: src.id, message: 'Связь не может вести в «Начало»' });
  }

  for (const n of graph.nodes) {
    const label = n.name || NODE_SPECS[n.type].label;
    for (const x of exitsOf(n).filter((v, i, a) => a.findIndex((y) => y.id === v.id) === i)) {
      if (used.has(`${n.id}|${x.id}`)) continue;
      if (
        n.type === 'start' ||
        (n.type === 'menu' && x.id.startsWith('digit:')) ||
        (n.type === 'buttons' && x.id.startsWith('btn:'))
      )
        errors.push({ nodeId: n.id, message: `«${label}»: не подключён выход «${x.label}»` });
      // У очереди выходы необязательны: без них клиент просто ждёт оператора, а после разговора — отбой.
      else if (n.type !== 'queue')
        warnings.push({
          nodeId: n.id,
          message: `«${label}»: выход «${x.label}» не подключён — ${
            graph.kind === 'text' ? 'бот передаст диалог оператору' : 'звонок завершится'
          }`,
        });
    }
  }

  // Достижимость от начала.
  const start = starts[0];
  if (start) {
    const seen = new Set([start.id]);
    const stack = [start.id];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of graph.edges)
        if (e.source === id && !seen.has(e.target)) {
          seen.add(e.target);
          stack.push(e.target);
        }
    }
    for (const n of graph.nodes)
      if (!seen.has(n.id))
        warnings.push({ nodeId: n.id, message: `«${n.name || NODE_SPECS[n.type].label}»: узел недостижим` });
  }

  // Цикл только из мгновенных узлов (условие, расписание, переменная) — сценарий зациклится без ввода.
  const instant = new Set(graph.nodes.filter((n) => NODE_SPECS[n.type].instant).map((n) => n.id));
  const state = new Map<string, 1 | 2>();
  const dfs = (id: string): boolean => {
    state.set(id, 1);
    for (const e of graph.edges) {
      if (e.source !== id || !instant.has(e.target)) continue;
      const s = state.get(e.target);
      if (s === 1) return true;
      if (!s && dfs(e.target)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of instant)
    if (!state.has(id) && dfs(id)) {
      errors.push({ nodeId: id, message: 'Цикл из условий без ввода клиента — сценарий зациклится' });
      break;
    }

  return { errors, warnings };
}
