import { describe, expect, it } from 'vitest';
import {
  type EngineContext,
  type FlowState,
  replayFlow,
  resumeFlow,
  startFlow,
  type StepResult,
} from './engine';
import type { FlowEdge, FlowGraph, FlowNode } from './graph';
import { validateGraph } from './validate';

const node = (id: string, type: FlowNode['type'], params: Record<string, unknown> = {}): FlowNode => ({
  id,
  type,
  params,
});
const edge = (source: string, exit: string, target: string): FlowEdge => ({
  id: `${source}-${exit}`,
  source,
  exit,
  target,
});

/** Демо-сценарий 1 (01, разд. 5): приветствие + объявление → меню → бонусы → баланс → «0» — оператор → CSAT. */
const demo: FlowGraph = {
  version: 1,
  kind: 'voice',
  nodes: [
    node('start', 'start'),
    node('hours', 'schedule', { scheduleId: 'sch' }),
    node('ann', 'announcements'),
    node('hello', 'play', { audio: ['a-hello'] }),
    node('main', 'menu', {
      audio: ['a-main'],
      digits: ['1', '0'],
      timeoutSec: 5,
      retries: 1,
      invalidAudio: ['a-bad'],
    }),
    node('bonus', 'menu', {
      audio: ['a-bonus'],
      digits: ['1', '0'],
      timeoutSec: 5,
      retries: 2,
      backDigit: '*',
    }),
    node('balance', 'http', { operationId: 'op-balance', input: { phone: '{{caller}}' } }),
    node('say', 'sayNumber', {
      variable: 'balance',
      gender: 'm',
      unit: { one: 'u1', few: 'u2', many: 'u5' },
      before: ['a-your-balance'],
    }),
    node('sorry', 'play', { audio: ['a-sorry'] }),
    node('queue', 'queue', { queueId: 'q1', topicId: 't1', checkAgents: true }),
    node('csat', 'csat', { audio: ['a-rate'], timeoutSec: 5, retries: 1, thanksAudio: ['a-thanks'] }),
    node('vm', 'voicemail', { mode: 'voicemail', audio: ['a-vm'], maxSec: 60, queueId: 'q-cb' }),
    node('closed', 'play', { audio: ['a-closed'] }),
    node('bye', 'hangup', { audio: ['a-bye'] }),
  ],
  edges: [
    edge('start', 'next', 'hours'),
    edge('hours', 'open', 'ann'),
    edge('hours', 'closed', 'closed'),
    edge('closed', 'next', 'vm'),
    edge('ann', 'next', 'hello'),
    edge('hello', 'next', 'main'),
    edge('main', 'digit:1', 'bonus'),
    edge('main', 'digit:0', 'queue'),
    edge('main', 'noinput', 'queue'),
    edge('bonus', 'digit:1', 'balance'),
    edge('bonus', 'digit:0', 'queue'),
    edge('balance', 'ok', 'say'),
    edge('balance', 'error', 'sorry'),
    edge('say', 'next', 'bonus'),
    edge('sorry', 'next', 'bonus'),
    edge('queue', 'after', 'csat'),
    edge('queue', 'noAgents', 'vm'),
    edge('csat', 'next', 'bye'),
    edge('vm', 'next', 'bye'),
  ],
};

// Пн–пт 09:00–18:00 по Минску, 2026-10-01 — выходной (праздник для теста).
const ctx = (iso: string): EngineContext => ({
  now: new Date(iso),
  schedules: {
    sch: {
      timezone: 'Europe/Minsk',
      week: {
        mon: [['09:00', '18:00']],
        tue: [['09:00', '18:00']],
        wed: [['09:00', '18:00']],
        thu: [['09:00', '18:00']],
        fri: [['09:00', '18:00']],
      },
      holidays: ['2026-10-01'],
    },
  },
});
const work = ctx('2026-09-29T08:00:00Z'); // вторник 11:00 по Минску

function step(r: StepResult | null): StepResult {
  expect(r).not.toBeNull();
  return r!;
}

describe('flow-engine: исполнение', () => {
  it('демо-сценарий 1: объявления → меню → баланс → «0» → очередь → CSAT', () => {
    let r = startFlow(demo, { caller: '+375291234567' }, work);
    expect(r.path.map((p) => p.nodeId)).toEqual(['start', 'hours', 'ann']);
    expect(r.action).toEqual({ type: 'play', media: [{ kind: 'announcements' }] });
    r = step(resumeFlow(demo, r.state, { type: 'done' }, work));
    expect(r.action).toEqual({ type: 'play', media: [{ kind: 'audio', id: 'a-hello' }] });
    r = step(resumeFlow(demo, r.state, { type: 'done' }, work));
    expect(r.action).toMatchObject({ type: 'collect', digits: ['1', '0'], timeoutSec: 5 });
    r = step(resumeFlow(demo, r.state, { type: 'digit', digit: '1' }, work));
    // Во вложенном меню доступна цифра возврата.
    expect(r.action).toMatchObject({ type: 'collect', digits: ['1', '0', '*'] });
    r = step(resumeFlow(demo, r.state, { type: 'digit', digit: '1' }, work));
    expect(r.action).toEqual({ type: 'http', operationId: 'op-balance', input: { phone: '+375291234567' } });
    r = step(resumeFlow(demo, r.state, { type: 'http', ok: true, outputs: { balance: '1234' } }, work));
    expect(r.state.vars.balance).toBe('1234');
    expect(r.action).toEqual({
      type: 'play',
      media: [
        { kind: 'audio', id: 'a-your-balance' },
        ...['1f', 'thousand_one', '200', '30', '4'].map((key) => ({ kind: 'fragment', key })),
        { kind: 'audio', id: 'u2' },
      ],
    });
    r = step(resumeFlow(demo, r.state, { type: 'done' }, work));
    expect(r.state.node).toBe('bonus');
    r = step(resumeFlow(demo, r.state, { type: 'digit', digit: '0' }, work));
    expect(r.action).toEqual({
      type: 'queue',
      queueId: 'q1',
      topicId: 't1',
      priority: 0,
      announceAudio: [],
      announceEverySec: null,
      maxWaitSec: null, // выход «долгое ожидание» не подключён
      checkAgents: true,
    });
    r = step(resumeFlow(demo, r.state, { type: 'queue', result: 'after' }, work));
    expect(r.action).toMatchObject({ type: 'collect', digits: ['1', '2', '3', '4', '5'] });
    r = step(resumeFlow(demo, r.state, { type: 'digit', digit: '4' }, work));
    expect(r.effects).toEqual([{ type: 'csat', score: 4 }]);
    expect(r.action).toEqual({ type: 'play', media: [{ kind: 'audio', id: 'a-thanks' }] });
    r = step(resumeFlow(demo, r.state, { type: 'done' }, work));
    expect(r.action).toEqual({ type: 'hangup', media: [{ kind: 'audio', id: 'a-bye' }] });
  });

  it('ошибка внешней системы ведёт по ветке «ошибка»', () => {
    const s: FlowState = { node: 'balance', vars: {}, menuStack: ['main', 'bonus'], attempt: 0 };
    const r = step(resumeFlow(demo, s, { type: 'http', ok: false, outputs: {} }, work));
    expect(r.state.node).toBe('sorry');
    expect(r.path[0]).toMatchObject({ nodeId: 'balance', exit: 'error' });
  });

  it('меню: неверная цифра — фраза и повтор, тишина сверх повторов — выход «нет ввода»', () => {
    const s: FlowState = { node: 'main', vars: {}, menuStack: [], attempt: 0 };
    let r = step(resumeFlow(demo, s, { type: 'digit', digit: '7' }, work));
    expect(r.state).toMatchObject({ node: 'main', attempt: 1, sub: 'invalid' });
    expect(r.action).toMatchObject({
      media: [
        { kind: 'audio', id: 'a-bad' },
        { kind: 'audio', id: 'a-main' },
      ],
    });
    r = step(resumeFlow(demo, r.state, { type: 'timeout' }, work));
    expect(r.state.node).toBe('queue');
  });

  it('меню: «*» возвращает в предыдущее меню', () => {
    const s: FlowState = { node: 'bonus', vars: {}, menuStack: ['main'], attempt: 0 };
    const r = step(resumeFlow(demo, s, { type: 'digit', digit: '*' }, work));
    expect(r.state.node).toBe('main');
    expect(r.state.menuStack).toEqual([]);
    expect(r.action).toMatchObject({ digits: ['1', '0'] });
  });

  it('нерабочее время и праздник — ветка «нерабочее время»', () => {
    expect(startFlow(demo, {}, ctx('2026-09-29T16:00:00Z')).state.node).toBe('closed'); // 19:00 Минск
    expect(startFlow(demo, {}, ctx('2026-10-01T08:00:00Z')).state.node).toBe('closed'); // праздник
    expect(startFlow(demo, {}, ctx('2026-10-03T08:00:00Z')).state.node).toBe('closed'); // суббота
  });

  it('replayFlow повторяет текущий шаг, запоздалое событие игнорируется', () => {
    const s: FlowState = { node: 'bonus', vars: {}, menuStack: ['main'], attempt: 1 };
    expect(replayFlow(demo, s, work).action).toMatchObject({ type: 'collect', digits: ['1', '0', '*'] });
    expect(resumeFlow(demo, s, { type: 'done' }, work)).toBeNull();
    expect(resumeFlow(demo, s, { type: 'http', ok: true, outputs: {} }, work)).toBeNull();
  });

  it('CSAT без ответа — дальше без оценки; выход без связи — завершение', () => {
    const s: FlowState = { node: 'csat', vars: {}, menuStack: [], attempt: 1 };
    const r = step(resumeFlow(demo, s, { type: 'timeout' }, work));
    expect(r.effects).toEqual([]);
    expect(r.state.node).toBe('bye');
    const q: FlowState = { node: 'queue', vars: {}, menuStack: [], attempt: 0 };
    expect(step(resumeFlow(demo, q, { type: 'queue', result: 'timeout' }, work)).action).toEqual({
      type: 'hangup',
      media: [],
    });
  });

  it('условие и переменные; цикл из условий не зацикливает исполнитель', () => {
    const g: FlowGraph = {
      version: 1,
      kind: 'voice',
      nodes: [
        node('s', 'start'),
        node('set', 'setVariable', { variable: 'x', value: '{{caller}}-1' }),
        node('c', 'condition', { variable: 'balance', op: 'gt', value: '100' }),
        node('rich', 'play', { audio: ['r'] }),
        node('poor', 'play', { audio: ['p'] }),
      ],
      edges: [
        edge('s', 'next', 'set'),
        edge('set', 'next', 'c'),
        edge('c', 'true', 'rich'),
        edge('c', 'false', 'poor'),
      ],
    };
    const r = startFlow(g, { caller: '5', balance: '150,5' }, work);
    expect(r.state.vars.x).toBe('5-1');
    expect(r.state.node).toBe('rich');
    expect(startFlow(g, { balance: 'нет' }, work).state.node).toBe('poor');
    const loop: FlowGraph = {
      ...g,
      edges: [edge('s', 'next', 'c'), edge('c', 'true', 'c'), edge('c', 'false', 'c')],
    };
    expect(startFlow(loop, {}, work).action).toEqual({ type: 'hangup', media: [] });
    expect(validateGraph(loop).errors.some((e) => e.message.includes('Цикл'))).toBe(true);
  });
});

describe('flow-engine: валидация', () => {
  it('демо-сценарий корректен', () => {
    expect(validateGraph(demo).errors).toEqual([]);
  });

  it('ошибки: нет начала, пункт меню без связи, узел без параметров, текстовый узел в голосе', () => {
    const g: FlowGraph = {
      version: 1,
      kind: 'text',
      nodes: [
        node('m', 'menu', { audio: ['a'], digits: ['1', '1'], timeoutSec: 5, retries: 1 }),
        node('p', 'play', { audio: [] }),
      ],
      edges: [edge('m', 'digit:5', 'p')],
    };
    const msgs = validateGraph(g).errors.map((e) => e.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        'В сценарии должен быть ровно один узел «Начало»',
        '«Меню (DTMF)»: повторяющиеся цифры',
        '«Меню (DTMF)»: связь от несуществующего выхода',
        '«Меню (DTMF)»: не подключён выход «1»',
        '«Проиграть сообщение»: выберите аудиофайл («Сообщение»)',
        '«Проиграть сообщение»: узел недоступен в сценарии этого типа',
      ]),
    );
  });
});
