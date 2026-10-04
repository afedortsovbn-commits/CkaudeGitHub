/**
 * Модель сценария (02-архитектура 2.2, 6.3): граф из узлов и связей, общий для IVR (голос) и ботов (текст).
 * Сценарий хранится как данные (JSON) — изменение IVR не требует ни правки диалплана, ни перезапуска.
 * Набор допустимых узлов зависит от типа сценария (`kinds` в каталоге).
 */

export type FlowKind = 'voice' | 'text';

export type NodeType =
  | 'start'
  | 'play'
  | 'announcements'
  | 'menu'
  | 'schedule'
  | 'condition'
  | 'setVariable'
  | 'queue'
  | 'voicemail'
  | 'http'
  | 'sayNumber'
  | 'transfer'
  | 'csat'
  | 'hangup'
  // Текстовые узлы ботов (Ф7, M-AUTO-04).
  | 'message'
  | 'buttons'
  | 'ask'
  | 'handoff';

export interface FlowNode {
  id: string;
  type: NodeType;
  /** Подпись узла в редакторе и в журнале вызова. */
  name?: string;
  position?: { x: number; y: number };
  params: Record<string, unknown>;
}

/** Связь «выход узла → следующий узел». Выходы узла — `exitsOf(node)` (у меню — по одному на цифру). */
export interface FlowEdge {
  id: string;
  source: string;
  exit: string;
  target: string;
}

export interface FlowGraph {
  version: 1;
  kind: FlowKind;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ---------------------------------------------------------------- параметры узлов

export interface PlayParams {
  /** Аудиофайлы библиотеки по порядку. */
  audio: string[];
}
export interface MenuParams {
  audio: string[];
  /** Цифры пунктов меню: 0–9, * и #. */
  digits: string[];
  timeoutSec: number;
  /** Сколько раз повторить меню при неверном вводе или тишине, прежде чем уйти по выходу «нет ввода». */
  retries: number;
  /** Фраза при неверном вводе (перед повтором меню). */
  invalidAudio?: string[];
  /** Цифра «вернуться в предыдущее меню» (M-IVR-02). */
  backDigit?: string;
}
export interface ScheduleParams {
  scheduleId: string;
}
export type ConditionOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'contains' | 'empty' | 'notEmpty';
export interface ConditionParams {
  variable: string;
  op: ConditionOp;
  value?: string;
}
export interface SetVariableParams {
  variable: string;
  /** Шаблон: {{переменная}}. */
  value: string;
}
export interface QueueParams {
  queueId: string;
  /** Тема обращения — по ней router учитывает навык (M-RT-02). */
  topicId?: string | null;
  /** Надбавка приоритета. */
  priority?: number;
  /** Периодическое сообщение в очереди (M-TEL-07, [УПР] — без точной позиции). */
  announceAudio?: string[];
  announceEverySec?: number;
  /** Максимальное ожидание — затем выход «таймаут» (например, на голосовое сообщение). */
  maxWaitSec?: number | null;
  /** Если в очереди нет операторов на смене (все не в сети или на перерыве) — выход «нет операторов». */
  checkAgents?: boolean;
  /**
   * «Все операторы заняты» (п.4 требований): фраза звучит один раз при постановке в очередь, если свободных
   * операторов нет (все разговаривают, на перерыве или не в сети); затем — музыка и периодическое сообщение.
   */
  busyAudio?: string[];
}
export interface VoicemailParams {
  /** voicemail — клиент оставляет сообщение; callback — только заказ обратного звонка. */
  mode: 'voicemail' | 'callback';
  audio: string[];
  maxSec: number;
  /** Очередь, в которую встанет обращение-задача «перезвонить». */
  queueId: string;
}
export interface HttpParams {
  operationId: string;
  /** Входные параметры операции — шаблоны {{переменная}}. */
  input: Record<string, string>;
}
export interface UnitAudio {
  one?: string;
  few?: string;
  many?: string;
}
export interface SayNumberParams {
  variable: string;
  /** Род единицы измерения (один рубль / одна копейка). */
  gender: 'm' | 'f';
  unit?: UnitAudio;
  /** Дробная часть (2 знака), например копейки. Не задано — дробная часть не озвучивается. */
  fraction?: UnitAudio & { gender: 'm' | 'f' };
  before?: string[];
  after?: string[];
}
export interface TransferParams {
  number: string;
}
export interface CsatParams {
  audio: string[];
  timeoutSec: number;
  retries: number;
  thanksAudio?: string[];
}
export interface HangupParams {
  audio?: string[];
  /** Текстовый сценарий: прощальное сообщение перед закрытием диалога. */
  text?: string;
}

// ---- текстовые узлы ботов (Ф7)

export interface MessageParams {
  /** Текст сообщения клиенту — шаблон {{переменная}}. */
  text: string;
}
export interface BotButton {
  /** Идентификатор кнопки — выход узла `btn:<id>`. */
  id: string;
  label: string;
}
export interface ButtonsParams extends WaitParams {
  text: string;
  buttons: BotButton[];
  /** Ответ клиента не совпал ни с одной кнопкой: текст перед повтором вопроса. */
  retryText?: string;
  /** Сколько раз повторить вопрос, прежде чем уйти по выходу «другое». */
  retries: number;
  /** Переменная, в которую сохраняется текст выбранной кнопки (необязательно). */
  variable?: string;
  /**
   * Навигация по меню (п.2 требований): подпись кнопки «Назад» (в предыдущее меню) и «В главное меню» (в первое
   * меню диалога). Пусто — кнопки нет. Кнопки показываются только во вложенных меню, у первого меню их нет.
   */
  backLabel?: string;
  homeLabel?: string;
}
/**
 * Ожидание ответа клиента у шагов «Меню кнопками» и «Сбор поля» (Ф14, M-AUTO-04 «клиент молчит»): клиент молчит
 * waitSec — напоминание (до reminders раз), затем выход «нет ответа». Не задано — бот ждёт без ограничения.
 */
export interface WaitParams {
  /** Ждать ответа, с; пусто или 0 — без ограничения (выхода «нет ответа» нет). */
  waitSec?: number | null;
  /** Сколько раз напомнить, прежде чем уйти по выходу «нет ответа». */
  reminders?: number;
  /** Текст напоминания; пусто — повторяется вопрос узла. */
  remindText?: string;
}
export type AskValidation = 'text' | 'phone' | 'email' | 'number';
export interface AskParams extends WaitParams {
  text: string;
  /** Переменная, в которую сохраняется ответ. */
  variable: string;
  validation: AskValidation;
  retryText?: string;
  retries: number;
  /** Сохранить ответ в карточку клиента (телефон/email — ещё и как идентификатор для узнавания). */
  saveTo?: 'phone' | 'email' | 'name' | null;
}
export interface HandoffParams {
  /** Очередь; пусто — очередь канала по умолчанию. */
  queueId?: string | null;
  topicId?: string | null;
  priority?: number;
  /** Сообщение клиенту при переводе («Соединяю с оператором…»). */
  text?: string;
}

// ---------------------------------------------------------------- каталог узлов

export interface NodeSpec {
  type: NodeType;
  label: string;
  description: string;
  kinds: FlowKind[];
  /** Узел выполняется мгновенно (без ввода-вывода) — важно для поиска бесконечных циклов. */
  instant: boolean;
  exits: { id: string; label: string }[];
  defaults: Record<string, unknown>;
}

const both: FlowKind[] = ['voice', 'text'];
const voice: FlowKind[] = ['voice'];
const text: FlowKind[] = ['text'];

export const NODE_SPECS: Record<NodeType, NodeSpec> = {
  start: {
    type: 'start',
    label: 'Начало',
    description: 'Точка входа сценария (звонок поступил / клиент написал)',
    kinds: both,
    instant: true,
    exits: [{ id: 'next', label: 'далее' }],
    defaults: {},
  },
  play: {
    type: 'play',
    label: 'Проиграть сообщение',
    description: 'Воспроизвести аудиофайлы из библиотеки',
    kinds: voice,
    instant: false,
    exits: [{ id: 'next', label: 'далее' }],
    defaults: { audio: [] },
  },
  announcements: {
    type: 'announcements',
    label: 'Объявления о сбоях',
    description: 'Проиграть действующие глобальные объявления (включаются менеджером без правки сценария)',
    kinds: voice,
    instant: false,
    exits: [{ id: 'next', label: 'далее' }],
    defaults: {},
  },
  menu: {
    type: 'menu',
    label: 'Меню (DTMF)',
    description: 'Выбор пункта нажатием цифры; повтор, таймаут, возврат в предыдущее меню',
    kinds: voice,
    instant: false,
    exits: [{ id: 'noinput', label: 'нет ввода' }],
    defaults: { audio: [], digits: ['1', '2', '0'], timeoutSec: 5, retries: 2 },
  },
  schedule: {
    type: 'schedule',
    label: 'Проверка расписания',
    description: 'Рабочее время по расписанию с праздниками',
    kinds: both,
    instant: true,
    exits: [
      { id: 'open', label: 'рабочее время' },
      { id: 'closed', label: 'нерабочее время' },
    ],
    defaults: { scheduleId: '' },
  },
  condition: {
    type: 'condition',
    label: 'Условие по переменной',
    description: 'Ветвление по значению переменной',
    kinds: both,
    instant: true,
    exits: [
      { id: 'true', label: 'да' },
      { id: 'false', label: 'нет' },
    ],
    defaults: { variable: '', op: 'eq', value: '' },
  },
  setVariable: {
    type: 'setVariable',
    label: 'Задать переменную',
    description: 'Присвоить переменной значение (шаблон {{переменная}})',
    kinds: both,
    instant: true,
    exits: [{ id: 'next', label: 'далее' }],
    defaults: { variable: '', value: '' },
  },
  queue: {
    type: 'queue',
    label: 'Поставить в очередь',
    description: 'Соединить с оператором очереди (тема, навык, приоритет); музыка и сообщения в ожидании',
    kinds: voice,
    instant: false,
    exits: [
      { id: 'after', label: 'после разговора' },
      { id: 'timeout', label: 'долгое ожидание' },
      { id: 'noAgents', label: 'нет операторов' },
    ],
    defaults: { queueId: '', announceEverySec: 30, checkAgents: true },
  },
  voicemail: {
    type: 'voicemail',
    label: 'Голосовое сообщение / перезвон',
    description: 'Запись сообщения клиента или заказ обратного звонка — обращение-задача «перезвонить»',
    kinds: voice,
    instant: false,
    exits: [{ id: 'next', label: 'далее' }],
    defaults: { mode: 'voicemail', audio: [], maxSec: 60, queueId: '' },
  },
  http: {
    type: 'http',
    label: 'Запрос во внешнюю систему',
    description: 'Интеграционная операция (самообслуживание); ответ сохраняется в переменные',
    kinds: both,
    instant: false,
    exits: [
      { id: 'ok', label: 'успех' },
      { id: 'error', label: 'ошибка' },
    ],
    defaults: { operationId: '', input: {} },
  },
  sayNumber: {
    type: 'sayNumber',
    label: 'Проиграть значение переменной',
    description: 'Число или сумма из записанных фрагментов («сто», «двадцать», «тысячи»…)',
    kinds: voice,
    instant: false,
    exits: [{ id: 'next', label: 'далее' }],
    defaults: { variable: '', gender: 'm' },
  },
  transfer: {
    type: 'transfer',
    label: 'Перевод на номер',
    description: 'Перевести звонок на внешний номер; если не ответили — выход «не удалось»',
    kinds: voice,
    instant: false,
    exits: [{ id: 'failed', label: 'не удалось' }],
    defaults: { number: '' },
  },
  csat: {
    type: 'csat',
    label: 'Оценка (CSAT)',
    description: 'Оценка обслуживания от 1 до 5 нажатием цифры',
    kinds: voice,
    instant: false,
    exits: [{ id: 'next', label: 'далее' }],
    defaults: { audio: [], timeoutSec: 7, retries: 1 },
  },
  hangup: {
    type: 'hangup',
    label: 'Завершить',
    description: 'Завершить звонок или диалог (можно с прощальной фразой/сообщением)',
    kinds: both,
    instant: false,
    exits: [],
    defaults: { audio: [] },
  },
  message: {
    type: 'message',
    label: 'Отправить сообщение',
    description: 'Сообщение клиенту (шаблон {{переменная}})',
    kinds: text,
    instant: false,
    exits: [{ id: 'next', label: 'далее' }],
    defaults: { text: '' },
  },
  buttons: {
    type: 'buttons',
    label: 'Меню кнопками',
    description: 'Вопрос с кнопками; клиент нажимает кнопку или пишет её текст/номер',
    kinds: text,
    instant: false,
    exits: [{ id: 'other', label: 'другое' }],
    defaults: {
      text: '',
      buttons: [
        { id: 'b1', label: 'Вариант 1' },
        { id: 'b2', label: 'Вариант 2' },
      ],
      retries: 1,
    },
  },
  ask: {
    type: 'ask',
    label: 'Сбор поля',
    description: 'Вопрос клиенту; ответ (с проверкой формата) сохраняется в переменную и карточку клиента',
    kinds: text,
    instant: false,
    exits: [
      { id: 'next', label: 'получено' },
      { id: 'invalid', label: 'не получено' },
    ],
    defaults: { text: '', variable: '', validation: 'text', retries: 2 },
  },
  handoff: {
    type: 'handoff',
    label: 'Перевод на оператора',
    description: 'Поставить диалог в очередь к оператору; вся переписка с ботом видна оператору',
    kinds: text,
    instant: false,
    exits: [],
    defaults: { queueId: '', text: 'Соединяю вас с оператором, пожалуйста, подождите.' },
  },
};

export const MENU_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];
export const digitExit = (d: string) => `digit:${d}`;
export const buttonExit = (id: string) => `btn:${id}`;
/** Выход «нет ответа» шагов, ждущих ответа клиента (Ф14). */
export const NO_ANSWER_EXIT = { id: 'noanswer', label: 'нет ответа' };

/** Сколько ждать ответа клиента в узле (с); 0 — без ограничения. */
export function waitSecOf(node: Pick<FlowNode, 'type' | 'params'>): number {
  if (node.type !== 'buttons' && node.type !== 'ask') return 0;
  const v = Number(node.params.waitSec ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Кнопки узла «Меню кнопками» (некорректные записи отбрасываются). */
export function buttonsOf(node: Pick<FlowNode, 'params'>): BotButton[] {
  const b = node.params.buttons;
  return Array.isArray(b)
    ? b.filter(
        (x): x is BotButton =>
          !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.label === 'string',
      )
    : [];
}

/**
 * Выходы узла (у меню — по цифре на пункт + «нет ввода», у кнопок — по кнопке + «другое»; у шагов бота с
 * ожиданием ответа — ещё «нет ответа»).
 */
export function exitsOf(node: FlowNode): { id: string; label: string }[] {
  const spec = NODE_SPECS[node.type];
  if (!spec) return [];
  if (node.type === 'menu') {
    const digits = Array.isArray(node.params.digits) ? (node.params.digits as string[]) : [];
    return [...digits.map((d) => ({ id: digitExit(d), label: d })), ...spec.exits];
  }
  const wait = waitSecOf(node) ? [NO_ANSWER_EXIT] : [];
  if (node.type === 'buttons')
    return [
      ...buttonsOf(node).map((b) => ({ id: buttonExit(b.id), label: b.label })),
      ...spec.exits,
      ...wait,
    ];
  return [...spec.exits, ...wait];
}

export function nodeById(graph: FlowGraph, id: string): FlowNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function nextNode(graph: FlowGraph, from: string, exit: string): string | null {
  return graph.edges.find((e) => e.source === from && e.exit === exit)?.target ?? null;
}

/** Ссылки сценария на справочники — для проверки перед публикацией (файлы, очереди, темы, операции…). */
export interface FlowRefs {
  audio: string[];
  queues: string[];
  topics: string[];
  schedules: string[];
  operations: string[];
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
const str = (v: unknown): string[] => (typeof v === 'string' && v ? [v] : []);

export function collectRefs(graph: FlowGraph): FlowRefs {
  const r: FlowRefs = { audio: [], queues: [], topics: [], schedules: [], operations: [] };
  for (const n of graph.nodes) {
    const p = n.params ?? {};
    r.audio.push(...strs(p.audio), ...strs(p.invalidAudio), ...strs(p.announceAudio));
    r.audio.push(...strs(p.thanksAudio), ...strs(p.before), ...strs(p.after));
    for (const u of [p.unit, p.fraction] as (UnitAudio | undefined)[])
      if (u && typeof u === 'object') r.audio.push(...str(u.one), ...str(u.few), ...str(u.many));
    if (n.type === 'queue' || n.type === 'voicemail' || n.type === 'handoff')
      r.queues.push(...str(p.queueId));
    if (n.type === 'queue' || n.type === 'handoff') r.topics.push(...str(p.topicId));
    if (n.type === 'schedule') r.schedules.push(...str(p.scheduleId));
    if (n.type === 'http') r.operations.push(...str(p.operationId));
  }
  const uniq = (a: string[]) => [...new Set(a)];
  return {
    audio: uniq(r.audio),
    queues: uniq(r.queues),
    topics: uniq(r.topics),
    schedules: uniq(r.schedules),
    operations: uniq(r.operations),
  };
}
