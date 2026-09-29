import { describe, expect, it } from 'vitest';
import {
  type EngineContext,
  matchButton,
  resumeFlow,
  startFlow,
  type StepResult,
  validateAnswer,
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
const ctx: EngineContext = { now: new Date('2026-09-29T09:00:00Z'), schedules: {} };

/** Бот демо-сценария 2 (01, разд. 5): приветствие → кнопки → сбор телефона → баланс → перевод на оператора. */
const bot: FlowGraph = {
  version: 1,
  kind: 'text',
  nodes: [
    node('start', 'start'),
    node('hello', 'message', { text: 'Здравствуйте, {{name}}! Я бот.' }),
    node('menu', 'buttons', {
      text: 'Выберите тему',
      buttons: [
        { id: 'bonus', label: 'Бонусная программа' },
        { id: 'cards', label: 'Топливные карты' },
      ],
      retries: 1,
      retryText: 'Пожалуйста, нажмите кнопку.',
      variable: 'choice',
    }),
    node('phone', 'ask', {
      text: 'Напишите номер телефона',
      variable: 'phone',
      validation: 'phone',
      retries: 1,
      retryText: 'Не похоже на номер телефона.',
      saveTo: 'phone',
    }),
    node('balance', 'http', { operationId: 'op', input: { phone: '{{phone}}' } }),
    node('say', 'message', { text: 'Ваш баланс: {{balance}} бонусов.' }),
    node('op', 'handoff', { queueId: 'q1', topicId: 't1', priority: 5, text: 'Соединяю с оператором.' }),
    node('bye', 'hangup', { text: 'До свидания!' }),
  ],
  edges: [
    edge('start', 'next', 'hello'),
    edge('hello', 'next', 'menu'),
    edge('menu', 'btn:bonus', 'phone'),
    edge('menu', 'btn:cards', 'bye'),
    edge('menu', 'other', 'op'),
    edge('phone', 'next', 'balance'),
    edge('phone', 'invalid', 'op'),
    edge('balance', 'ok', 'say'),
    edge('balance', 'error', 'op'),
    edge('say', 'next', 'op'),
  ],
};

const step = (r: StepResult | null): StepResult => {
  expect(r).not.toBeNull();
  return r!;
};

describe('текстовый бот (flow-engine, Ф7)', () => {
  it('демо-сценарий 2: сообщение → кнопки → телефон → HTTP → перевод на оператора', () => {
    let r = startFlow(bot, { name: 'Анна' }, ctx);
    expect(r.action).toEqual({ type: 'say', text: 'Здравствуйте, Анна! Я бот.' });
    r = step(resumeFlow(bot, r.state, { type: 'done' }, ctx));
    expect(r.action).toEqual({
      type: 'prompt',
      text: 'Выберите тему',
      buttons: [
        { id: 'bonus', label: 'Бонусная программа' },
        { id: 'cards', label: 'Топливные карты' },
      ],
    });
    // Клиент пишет текст кнопки в другом регистре.
    r = step(resumeFlow(bot, r.state, { type: 'text', text: 'бонусная ПРОГРАММА!' }, ctx));
    expect(r.state.vars.choice).toBe('Бонусная программа');
    expect(r.action).toMatchObject({ type: 'prompt', text: 'Напишите номер телефона', buttons: [] });
    r = step(resumeFlow(bot, r.state, { type: 'text', text: 'не скажу' }, ctx));
    expect(r.action).toMatchObject({
      type: 'prompt',
      text: 'Не похоже на номер телефона.\n\nНапишите номер телефона',
    });
    r = step(resumeFlow(bot, r.state, { type: 'text', text: '8 (029) 123-45-67' }, ctx));
    expect(r.state.vars.phone).toBe('+375291234567');
    expect(r.effects).toEqual([{ type: 'contact', field: 'phone', value: '+375291234567' }]);
    expect(r.action).toEqual({ type: 'http', operationId: 'op', input: { phone: '+375291234567' } });
    r = step(resumeFlow(bot, r.state, { type: 'http', ok: true, outputs: { balance: '1234' } }, ctx));
    expect(r.action).toEqual({ type: 'say', text: 'Ваш баланс: 1234 бонусов.' });
    r = step(resumeFlow(bot, r.state, { type: 'done' }, ctx));
    expect(r.action).toEqual({
      type: 'handoff',
      queueId: 'q1',
      topicId: 't1',
      priority: 5,
      text: 'Соединяю с оператором.',
    });
    // Перевод — конец сценария: дальнейшие события бота не касаются.
    expect(resumeFlow(bot, r.state, { type: 'text', text: 'алло' }, ctx)).toBeNull();
  });

  it('кнопка по номеру; нераспознанный ответ после повторов — выход «другое»', () => {
    let r = startFlow(bot, {}, ctx);
    r = step(resumeFlow(bot, r.state, { type: 'done' }, ctx));
    const atMenu = r.state;
    r = step(resumeFlow(bot, atMenu, { type: 'text', text: '2' }, ctx));
    expect(r.action).toEqual({ type: 'hangup', media: [], text: 'До свидания!' });
    r = step(resumeFlow(bot, atMenu, { type: 'text', text: 'что?' }, ctx));
    expect(r.action).toMatchObject({ type: 'prompt', text: 'Пожалуйста, нажмите кнопку.\n\nВыберите тему' });
    r = step(resumeFlow(bot, r.state, { type: 'text', text: 'опять не то' }, ctx));
    expect(r.action).toMatchObject({ type: 'handoff', queueId: 'q1' });
  });

  it('ошибка внешней системы ведёт по ветке «ошибка»; события не своего шага игнорируются', () => {
    let r = startFlow(bot, {}, ctx);
    r = step(resumeFlow(bot, r.state, { type: 'done' }, ctx));
    r = step(resumeFlow(bot, r.state, { type: 'text', text: '1' }, ctx));
    expect(resumeFlow(bot, r.state, { type: 'done' }, ctx)).toBeNull();
    r = step(resumeFlow(bot, r.state, { type: 'text', text: '+375 29 000-00-00' }, ctx));
    expect(resumeFlow(bot, r.state, { type: 'text', text: 'ну что там?' }, ctx)).toBeNull();
    r = step(resumeFlow(bot, r.state, { type: 'http', ok: false, outputs: {} }, ctx));
    expect(r.action.type).toBe('handoff');
  });

  it('неподключённый выход текстового сценария — перевод на оператора очереди канала, а не обрыв', () => {
    const g: FlowGraph = {
      version: 1,
      kind: 'text',
      nodes: [node('start', 'start'), node('hi', 'message', { text: 'Привет' })],
      edges: [edge('start', 'next', 'hi')],
    };
    const r = step(resumeFlow(g, startFlow(g, {}, ctx).state, { type: 'done' }, ctx));
    expect(r.action).toEqual({ type: 'handoff', queueId: null, topicId: null, priority: 0, text: '' });
    expect(validateGraph(g).warnings[0]?.message).toContain('бот передаст диалог оператору');
  });

  it('проверка графа бота: кнопки обязаны быть подключены, голосовые узлы недоступны', () => {
    expect(validateGraph(bot)).toEqual({ errors: [], warnings: [] });
    const broken: FlowGraph = {
      ...bot,
      nodes: [...bot.nodes, node('m', 'menu', { audio: ['a'], digits: ['1'], timeoutSec: 5, retries: 1 })],
      edges: bot.edges.filter((e) => e.exit !== 'btn:cards'),
    };
    const msgs = validateGraph(broken).errors.map((e) => e.message);
    expect(msgs).toContain('«Меню кнопками»: не подключён выход «Топливные карты»');
    expect(msgs).toContain('«Меню (DTMF)»: узел недоступен в сценарии этого типа');
    const empty: FlowGraph = {
      ...bot,
      nodes: bot.nodes.map((n) =>
        n.id === 'menu' ? { ...n, params: { ...n.params, buttons: [{ id: 'x', label: '' }] } } : n,
      ),
    };
    expect(validateGraph(empty).errors.map((e) => e.message)).toContain(
      '«Меню кнопками»: У кнопки нет текста',
    );
  });

  it('нормализация ответов и выбор кнопки', () => {
    expect(validateAnswer('phone', '+375 (29) 123-45-67')).toBe('+375291234567');
    expect(validateAnswer('phone', '80291234567')).toBe('+375291234567');
    expect(validateAnswer('phone', '12')).toBeNull();
    expect(validateAnswer('email', ' Ivan@Example.BY ')).toBe('ivan@example.by');
    expect(validateAnswer('email', 'ivan@')).toBeNull();
    expect(validateAnswer('number', '12,5')).toBe('12.5');
    expect(validateAnswer('text', '   ')).toBeNull();
    const b = [
      { id: 'a', label: 'Ёлка' },
      { id: 'b', label: 'Другое' },
    ];
    expect(matchButton(b, 'елка')?.id).toBe('a');
    expect(matchButton(b, '2')?.id).toBe('b');
    expect(matchButton(b, '3')).toBeUndefined();
  });
});
