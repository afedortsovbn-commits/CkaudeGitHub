import {
  type AskParams,
  type AskValidation,
  type BotButton,
  buttonExit,
  buttonsOf,
  type ButtonsParams,
  type ConditionParams,
  type CsatParams,
  digitExit,
  type FlowGraph,
  type FlowNode,
  type HandoffParams,
  type HangupParams,
  type HttpParams,
  type MessageParams,
  type MenuParams,
  nextNode,
  nodeById,
  type QueueParams,
  type SayNumberParams,
  type ScheduleParams,
  type SetVariableParams,
  type TransferParams,
  type VoicemailParams,
} from './graph';
import { numberKeys, parseAmount, plural } from './numbers';
import { isOpen, type Schedule } from './schedule';
import { render } from './template';

/**
 * Пошаговый исполнитель сценария (02-архитектура 6.3). Чистые функции без ввода-вывода: на вход — граф,
 * сериализуемое состояние и событие (цифра, конец фразы, ответ внешней системы…), на выход — новое
 * состояние и действие, которое должен выполнить исполнитель канала (call-control для голоса, тестовый
 * прогон в редакторе). Состояние сохраняется после каждого шага, поэтому сценарий продолжается на другом
 * экземпляре call-control: `replayFlow` повторяет текущий шаг с начала.
 */

export type Media =
  | { kind: 'audio'; id: string }
  | { kind: 'announcements' }
  | { kind: 'fragment'; key: string };

export type Action =
  | { type: 'play'; media: Media[] }
  /** Проиграть и ждать одну цифру из `digits` не дольше `timeoutSec` после окончания фразы. */
  | { type: 'collect'; media: Media[]; digits: string[]; timeoutSec: number }
  | { type: 'http'; operationId: string; input: Record<string, string> }
  | {
      type: 'queue';
      queueId: string;
      topicId: string | null;
      priority: number;
      announceAudio: string[];
      announceEverySec: number | null;
      /** null — выход «долгое ожидание» не подключён: ждать без ограничения. */
      maxWaitSec: number | null;
      /** Проверять наличие операторов на смене (подключён выход «нет операторов»). */
      checkAgents: boolean;
    }
  | { type: 'voicemail'; mode: 'voicemail' | 'callback'; media: Media[]; maxSec: number; queueId: string }
  | { type: 'transfer'; number: string }
  /** Завершить звонок / диалог; text — прощальное сообщение текстового сценария. */
  | { type: 'hangup'; media: Media[]; text?: string }
  // ---- текстовые сценарии (боты, Ф7)
  /** Отправить сообщение клиенту и сразу продолжить (событие done). */
  | { type: 'say'; text: string }
  /** Отправить вопрос (с кнопками или без) и ждать ответа клиента (событие text). */
  | { type: 'prompt'; text: string; buttons: BotButton[] }
  /** Перевести диалог на оператора: очередь (null — очередь канала), тема, надбавка приоритета. */
  | { type: 'handoff'; queueId: string | null; topicId: string | null; priority: number; text: string };

export type FlowEvent =
  | { type: 'done' }
  | { type: 'digit'; digit: string }
  | { type: 'timeout' }
  | { type: 'http'; ok: boolean; outputs: Record<string, string> }
  | { type: 'queue'; result: 'after' | 'timeout' | 'noAgents' }
  | { type: 'transfer'; ok: false }
  /** Ответ клиента в текстовом канале. */
  | { type: 'text'; text: string };

export type Effect =
  | { type: 'csat'; score: number }
  /** Бот собрал поле клиента — записать в карточку (телефон/email — ещё и идентификатор). */
  | { type: 'contact'; field: 'phone' | 'email' | 'name'; value: string };

export interface FlowState {
  /** Текущий узел. */
  node: string;
  vars: Record<string, string>;
  /** Пройденные меню — для «вернуться в предыдущее меню». */
  menuStack: string[];
  /** Номер попытки ввода в текущем узле (меню, оценка). */
  attempt: number;
  /** Подшаг узла: 'invalid' — у меню перед повтором звучит фраза о неверном вводе; 'thanks' — благодарность CSAT. */
  sub?: string;
}

export interface PathStep {
  nodeId: string;
  type: string;
  name?: string;
  /** Выход, по которому ушли из узла. */
  exit?: string;
}

export interface StepResult {
  state: FlowState;
  action: Action;
  effects: Effect[];
  /** Узлы, пройденные за шаг, — журнал пути по IVR. */
  path: PathStep[];
}

export interface EngineContext {
  now: Date;
  schedules: Record<string, Schedule>;
}

const MAX_INSTANT_STEPS = 200;
const END: Action = { type: 'hangup', media: [] };
const audio = (ids: unknown): Media[] =>
  Array.isArray(ids)
    ? ids.filter((x): x is string => typeof x === 'string' && !!x).map((id) => ({ kind: 'audio', id }))
    : [];

class Run {
  readonly effects: Effect[] = [];
  readonly path: PathStep[] = [];
  constructor(
    readonly graph: FlowGraph,
    public state: FlowState,
    readonly ctx: EngineContext,
  ) {}

  result(action: Action): StepResult {
    return { state: this.state, action, effects: this.effects, path: this.path };
  }

  node(): FlowNode | undefined {
    return nodeById(this.graph, this.state.node);
  }

  /** Уйти из текущего узла по выходу и выполнять узлы до первого, требующего ввода-вывода. */
  exit(exit: string): StepResult {
    const last = this.path[this.path.length - 1];
    if (last && last.nodeId === this.state.node && !last.exit) last.exit = exit;
    else this.path.push({ nodeId: this.state.node, type: this.node()?.type ?? '', exit });
    const target = nextNode(this.graph, this.state.node, exit);
    if (!target) return this.result(this.end());
    return this.enter(target);
  }

  /**
   * Сценарий закончился неподключённым выходом. Звонок завершается; текстовый диалог не обрывается —
   * бот передаёт его оператору очереди канала (клиент не остаётся без ответа).
   */
  end(): Action {
    return this.graph.kind === 'text'
      ? { type: 'handoff', queueId: null, topicId: null, priority: 0, text: '' }
      : END;
  }

  enter(id: string): StepResult {
    let target: string | null = id;
    for (let i = 0; i < MAX_INSTANT_STEPS && target; i++) {
      const node = nodeById(this.graph, target);
      if (!node) return this.result(this.end());
      const stackAt = this.state.menuStack.indexOf(node.id);
      this.state = {
        ...this.state,
        node: node.id,
        attempt: 0,
        sub: undefined,
        menuStack: stackAt >= 0 ? this.state.menuStack.slice(0, stackAt) : this.state.menuStack,
      };
      this.path.push({ nodeId: node.id, type: node.type, ...(node.name ? { name: node.name } : {}) });
      const exit = this.instantExit(node);
      if (exit === null) {
        const action = this.actionFor(node);
        // Пустая фраза (например, не задана единица и значение не число) или пустое сообщение — сразу дальше.
        if ((action.type === 'play' && !action.media.length) || (action.type === 'say' && !action.text)) {
          target = this.follow(node, 'next');
          continue;
        }
        return this.result(action);
      }
      target = this.follow(node, exit);
    }
    return this.result(this.end());
  }

  private follow(node: FlowNode, exit: string): string | null {
    const step = this.path[this.path.length - 1];
    if (step && step.nodeId === node.id) step.exit = exit;
    return nextNode(this.graph, node.id, exit);
  }

  /** Выход мгновенного узла или null, если узлу нужен ввод-вывод. */
  private instantExit(node: FlowNode): string | null {
    const p = node.params;
    switch (node.type) {
      case 'start':
        return 'next';
      case 'schedule': {
        const s = this.ctx.schedules[(p as unknown as ScheduleParams).scheduleId];
        // Расписание удалено или отключено — считаем время рабочим, чтобы не отказать клиенту.
        return !s || isOpen(s, this.ctx.now) ? 'open' : 'closed';
      }
      case 'condition':
        return compare(this.state.vars, p as unknown as ConditionParams) ? 'true' : 'false';
      case 'setVariable': {
        const sp = p as unknown as SetVariableParams;
        this.state = {
          ...this.state,
          vars: { ...this.state.vars, [sp.variable]: render(sp.value ?? '', this.state.vars) },
        };
        return 'next';
      }
      default:
        return null;
    }
  }

  actionFor(node: FlowNode): Action {
    const p = node.params;
    switch (node.type) {
      case 'play':
        return { type: 'play', media: audio(p.audio) };
      case 'announcements':
        return { type: 'play', media: [{ kind: 'announcements' }] };
      case 'menu': {
        const mp = p as unknown as MenuParams;
        const digits = [...mp.digits];
        if (mp.backDigit && this.state.menuStack.length) digits.push(mp.backDigit);
        const invalid = this.state.sub === 'invalid' ? audio(mp.invalidAudio) : [];
        return {
          type: 'collect',
          media: [...invalid, ...audio(mp.audio)],
          digits,
          timeoutSec: mp.timeoutSec,
        };
      }
      case 'csat': {
        const cp = p as unknown as CsatParams;
        if (this.state.sub === 'thanks') return { type: 'play', media: audio(cp.thanksAudio) };
        return {
          type: 'collect',
          media: audio(cp.audio),
          digits: ['1', '2', '3', '4', '5'],
          timeoutSec: cp.timeoutSec,
        };
      }
      case 'sayNumber':
        return { type: 'play', media: sayNumber(p as unknown as SayNumberParams, this.state.vars) };
      case 'http': {
        const hp = p as unknown as HttpParams;
        const input: Record<string, string> = {};
        for (const [k, v] of Object.entries(hp.input ?? {})) input[k] = render(String(v), this.state.vars);
        return { type: 'http', operationId: hp.operationId, input };
      }
      case 'queue': {
        const qp = p as unknown as QueueParams;
        const has = (x: string) => !!nextNode(this.graph, node.id, x);
        return {
          type: 'queue',
          queueId: qp.queueId,
          topicId: qp.topicId || null,
          priority: Number(qp.priority ?? 0) || 0,
          announceAudio: (qp.announceAudio ?? []).filter(Boolean),
          announceEverySec: qp.announceAudio?.length ? Number(qp.announceEverySec ?? 30) : null,
          maxWaitSec: qp.maxWaitSec && has('timeout') ? Number(qp.maxWaitSec) : null,
          checkAgents: !!qp.checkAgents && has('noAgents'),
        };
      }
      case 'voicemail': {
        const vp = p as unknown as VoicemailParams;
        return {
          type: 'voicemail',
          mode: vp.mode,
          media: audio(vp.audio),
          maxSec: Number(vp.maxSec ?? 60),
          queueId: vp.queueId,
        };
      }
      case 'transfer':
        return {
          type: 'transfer',
          number: String((p as unknown as TransferParams).number).replace(/[\s()-]/g, ''),
        };
      case 'hangup': {
        const hp = p as unknown as HangupParams;
        return this.graph.kind === 'text'
          ? { type: 'hangup', media: [], text: render(hp.text ?? '', this.state.vars) }
          : { type: 'hangup', media: audio(hp.audio) };
      }
      case 'message':
        return { type: 'say', text: render((p as unknown as MessageParams).text ?? '', this.state.vars) };
      case 'buttons':
      case 'ask': {
        const bp = p as unknown as ButtonsParams | AskParams;
        const question = render(bp.text ?? '', this.state.vars);
        const retry = this.state.sub === 'invalid' ? render(bp.retryText ?? '', this.state.vars) : '';
        return {
          type: 'prompt',
          text: [retry, question].filter(Boolean).join('\n\n'),
          buttons: node.type === 'buttons' ? buttonsOf(node) : [],
        };
      }
      case 'handoff': {
        const hp = p as unknown as HandoffParams;
        return {
          type: 'handoff',
          queueId: hp.queueId || null,
          topicId: hp.topicId || null,
          priority: Number(hp.priority ?? 0) || 0,
          text: render(hp.text ?? '', this.state.vars),
        };
      }
      default:
        return END;
    }
  }

  /** Неверный ввод или тишина в меню/оценке: повтор или выход «нет ввода». */
  retry(node: FlowNode, invalid: boolean): StepResult {
    const retries = Number((node.params as { retries?: number }).retries ?? 0);
    const attempt = this.state.attempt + 1;
    if (attempt > retries) return this.exit(RETRY_EXIT[node.type] ?? 'next');
    const withInvalidPhrase =
      invalid && (node.type === 'menu' || node.type === 'buttons' || node.type === 'ask');
    this.state = { ...this.state, attempt, sub: withInvalidPhrase ? 'invalid' : undefined };
    this.path.push({ nodeId: node.id, type: node.type, ...(node.name ? { name: node.name } : {}) });
    return this.result(this.actionFor(node));
  }
}

const RETRY_EXIT: Partial<Record<string, string>> = { menu: 'noinput', buttons: 'other', ask: 'invalid' };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Кнопка по ответу клиента: текст кнопки (без учёта регистра и знаков) или её номер. */
export function matchButton(buttons: BotButton[], answer: string): BotButton | undefined {
  const a = norm(answer);
  if (!a) return undefined;
  const byLabel = buttons.find((b) => norm(b.label) === a);
  if (byLabel) return byLabel;
  const n = Number(a);
  return Number.isInteger(n) && n >= 1 && n <= buttons.length ? buttons[n - 1] : undefined;
}

/** Проверка и нормализация ответа «Сбор поля»; null — формат не подходит. */
export function validateAnswer(kind: AskValidation, answer: string): string | null {
  const v = answer.trim();
  if (!v) return null;
  switch (kind) {
    case 'phone': {
      if (!/^[+\d\s()-]{5,25}$/.test(v)) return null;
      const digits = v.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return null;
      if (v.startsWith('+')) return `+${digits}`;
      // Белорусский номер в местном формате: 80 29 123-45-67 → +375291234567.
      if (digits.length === 11 && digits.startsWith('80')) return `+375${digits.slice(2)}`;
      return digits.length >= 11 ? `+${digits}` : digits;
    }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200 ? v.toLowerCase() : null;
    case 'number': {
      const n = Number(v.replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(n) ? String(n) : null;
    }
    default:
      return v.slice(0, 2000);
  }
}

function compare(vars: Record<string, string>, c: ConditionParams): boolean {
  const a = vars[c.variable] ?? '';
  const b = c.value ?? '';
  const na = Number(a.replace(',', '.'));
  const nb = Number(b.replace(',', '.'));
  const numeric = a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb);
  switch (c.op) {
    case 'eq':
      return numeric ? na === nb : a === b;
    case 'ne':
      return numeric ? na !== nb : a !== b;
    case 'gt':
      return numeric && na > nb;
    case 'ge':
      return numeric && na >= nb;
    case 'lt':
      return numeric && na < nb;
    case 'le':
      return numeric && na <= nb;
    case 'contains':
      return a.toLowerCase().includes(b.toLowerCase());
    case 'empty':
      return a.trim() === '';
    case 'notEmpty':
      return a.trim() !== '';
    default:
      return false;
  }
}

/** Фраза «баланс … сто двадцать три бонуса …» из фрагментов. */
export function sayNumber(p: SayNumberParams, vars: Record<string, string>): Media[] {
  const out: Media[] = [...audio(p.before)];
  const amount = parseAmount(vars[p.variable] ?? '');
  if (amount) {
    const frag = (keys: string[]): Media[] => keys.map((key) => ({ kind: 'fragment', key }));
    const unit = (u: SayNumberParams['unit'], n: number): Media[] => {
      const id = u?.[plural(n)];
      return id ? [{ kind: 'audio', id }] : [];
    };
    const withFraction = !!p.fraction && amount.frac > 0;
    const whole = numberKeys(amount.int, p.gender ?? 'm');
    out.push(...(amount.negative && (amount.int || amount.frac) ? frag(['minus']) : []));
    out.push(...frag(whole), ...unit(p.unit, amount.int));
    if (withFraction)
      out.push(...frag(numberKeys(amount.frac, p.fraction!.gender ?? 'f')), ...unit(p.fraction, amount.frac));
  }
  out.push(...audio(p.after));
  return out;
}

/** Начать сценарий с узла «Начало». */
export function startFlow(graph: FlowGraph, vars: Record<string, string>, ctx: EngineContext): StepResult {
  const start = graph.nodes.find((n) => n.type === 'start');
  const run = new Run(graph, { node: start?.id ?? '', vars: { ...vars }, menuStack: [], attempt: 0 }, ctx);
  if (!start) return run.result(END);
  return run.enter(start.id);
}

/** Повторить текущий шаг с начала (после переключения call-control): фраза переигрывается. */
export function replayFlow(graph: FlowGraph, state: FlowState, ctx: EngineContext): StepResult {
  const run = new Run(graph, state, ctx);
  const node = run.node();
  if (!node) return run.result(END);
  return run.result(run.actionFor(node));
}

/**
 * Обработать событие текущего шага. null — событие к текущему шагу не относится (запоздало) — игнорировать.
 */
export function resumeFlow(
  graph: FlowGraph,
  state: FlowState,
  event: FlowEvent,
  ctx: EngineContext,
): StepResult | null {
  const run = new Run(graph, { ...state, vars: { ...state.vars }, menuStack: [...state.menuStack] }, ctx);
  const node = run.node();
  if (!node) return run.result(END);
  switch (node.type) {
    case 'play':
    case 'announcements':
    case 'sayNumber':
    case 'voicemail':
      return event.type === 'done' ? run.exit('next') : null;
    case 'menu': {
      const mp = node.params as unknown as MenuParams;
      if (event.type === 'timeout') return run.retry(node, false);
      if (event.type !== 'digit') return null;
      if (mp.digits.includes(event.digit)) {
        run.state = { ...run.state, menuStack: [...run.state.menuStack, node.id] };
        return run.exit(digitExit(event.digit));
      }
      if (mp.backDigit && event.digit === mp.backDigit && run.state.menuStack.length) {
        const prev = run.state.menuStack[run.state.menuStack.length - 1]!;
        run.path.push({ nodeId: node.id, type: node.type, exit: 'back' });
        return run.enter(prev);
      }
      return run.retry(node, true);
    }
    case 'csat': {
      if (run.state.sub === 'thanks') return event.type === 'done' ? run.exit('next') : null;
      if (event.type === 'timeout') return run.retry(node, false);
      if (event.type !== 'digit') return null;
      const score = Number(event.digit);
      if (!(score >= 1 && score <= 5)) return run.retry(node, true);
      run.effects.push({ type: 'csat', score });
      run.state = { ...run.state, vars: { ...run.state.vars, csat: String(score) } };
      if (audio((node.params as unknown as CsatParams).thanksAudio).length) {
        run.state = { ...run.state, sub: 'thanks' };
        return run.result(run.actionFor(node));
      }
      return run.exit('next');
    }
    case 'http':
      if (event.type !== 'http') return null;
      run.state = { ...run.state, vars: { ...run.state.vars, ...event.outputs } };
      return run.exit(event.ok ? 'ok' : 'error');
    case 'queue':
      return event.type === 'queue' ? run.exit(event.result) : null;
    case 'transfer':
      return event.type === 'transfer' ? run.exit('failed') : null;
    case 'message':
      return event.type === 'done' ? run.exit('next') : null;
    case 'buttons': {
      if (event.type !== 'text') return null;
      const b = matchButton(buttonsOf(node), event.text);
      if (!b) return run.retry(node, true);
      const variable = (node.params as unknown as ButtonsParams).variable;
      if (variable) run.state = { ...run.state, vars: { ...run.state.vars, [variable]: b.label } };
      return run.exit(buttonExit(b.id));
    }
    case 'ask': {
      if (event.type !== 'text') return null;
      const ap = node.params as unknown as AskParams;
      const value = validateAnswer(ap.validation ?? 'text', event.text);
      if (value === null) return run.retry(node, true);
      run.state = { ...run.state, vars: { ...run.state.vars, [ap.variable]: value } };
      if (ap.saveTo) run.effects.push({ type: 'contact', field: ap.saveTo, value });
      return run.exit('next');
    }
    case 'hangup':
    case 'handoff':
      return null;
    default:
      return run.enter(node.id);
  }
}
