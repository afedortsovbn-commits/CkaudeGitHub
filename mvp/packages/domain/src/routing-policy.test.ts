import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_POLICY,
  effectiveRank,
  isPullItem,
  isPushItem,
  parseRoutingPolicy,
  type QueuedItem,
  sortByUrgency,
} from './routing-policy';

const load = parseRoutingPolicy({ mode: 'load' });
const now = new Date('2026-10-10T12:00:00Z');
const item = (over: Partial<QueuedItem>): QueuedItem => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  queueId: 'q',
  baseRank: 3,
  priority: 0,
  queuedAt: '2026-10-10T10:00:00Z',
  dueAt: null,
  ...over,
});

describe('политика распределения: разбор настройки (Д-017)', () => {
  it('пустая или старая запись — умолчания; режим «по загрузке» только при mode=load', () => {
    expect(parseRoutingPolicy(undefined)).toEqual(DEFAULT_ROUTING_POLICY);
    expect(parseRoutingPolicy({ text: 'pull', idleScope: 'split' })).toMatchObject({
      mode: 'standard',
      text: 'pull',
      idleScope: 'split',
      load: DEFAULT_ROUTING_POLICY.load,
    });
    expect(load.mode).toBe('load');
  });

  it('границы: стоимость в пределах ёмкости, доля старения 0…1, пустой текст — умолчание', () => {
    const p = parseRoutingPolicy({
      load: { cost: { voice: 500, chatWaitingAgent: 0 }, agingThreshold: 7, pullMinFree: -3 },
      chat: { silenceCloseMin: 'x', silenceCloseText: '   ' },
      wrapUp: { seconds: -1, extendSeconds: 5, extendRepeat: false },
    });
    expect(p.load.cost).toMatchObject({ voice: 100, chatWaitingAgent: 1 });
    expect(p.load.agingThreshold).toBe(0.8);
    expect(p.load.pullMinFree).toBe(0);
    expect(p.chat.silenceCloseMin).toBe(15);
    expect(p.chat.silenceCloseText).toBe(DEFAULT_ROUTING_POLICY.chat.silenceCloseText);
    expect(p.wrapUp).toEqual({ seconds: 0, extendSeconds: 10, extendRepeat: false });
  });
});

describe('ранги и старение (Д-017, п.2–3)', () => {
  it('звонок и чат — без старения; у неспешных без срока ранг не меняется', () => {
    expect(effectiveRank(item({ baseRank: 1 }), load, now)).toBe(1);
    expect(effectiveRank(item({ baseRank: 3, dueAt: '2026-10-10T10:30:00Z' }), load, now)).toBe(3);
    expect(effectiveRank(item({ baseRank: 5 }), load, now)).toBe(5);
  });

  it('израсходовано 80 % срока — на ранг выше, но не выше 3', () => {
    // В очереди с 10:00, срок до 12:30: к 12:00 израсходовано 80 % — ранг 5 → 4, ранг 4 → 3.
    const due = '2026-10-10T12:30:00Z';
    expect(effectiveRank(item({ baseRank: 5, dueAt: due }), load, now)).toBe(4);
    expect(effectiveRank(item({ baseRank: 4, dueAt: due }), load, now)).toBe(3);
    // Срока хватает — ранг прежний.
    expect(effectiveRank(item({ baseRank: 5, dueAt: '2026-10-11T10:00:00Z' }), load, now)).toBe(5);
    // Срок уже истёк — тоже поднимается (не выше 3).
    expect(effectiveRank(item({ baseRank: 5, dueAt: '2026-10-10T11:00:00Z' }), load, now)).toBe(4);
  });

  it('система назначает звонки и чаты; негативный отзыв после старения — только при pushUrgent', () => {
    const aged = item({ baseRank: 4, dueAt: '2026-10-10T12:30:00Z' });
    expect(isPushItem(item({ baseRank: 1 }), load, now)).toBe(true);
    expect(isPushItem(item({ baseRank: 3 }), load, now)).toBe(true);
    expect(isPushItem(item({ baseRank: 5 }), load, now)).toBe(false);
    expect(isPushItem(aged, load, now)).toBe(false);
    expect(isPushItem(aged, parseRoutingPolicy({ mode: 'load', load: { pushUrgent: true } }), now)).toBe(
      true,
    );
    expect(isPullItem(item({ baseRank: 4 }))).toBe(true);
    expect(isPullItem(item({ baseRank: 3 }))).toBe(false);
  });

  it('порядок выдачи: эффективный ранг → приоритет → кто дольше ждёт', () => {
    const a = item({ id: 'mail-old', baseRank: 5, queuedAt: '2026-10-10T08:00:00Z' });
    const b = item({
      id: 'mail-aged',
      baseRank: 5,
      queuedAt: '2026-10-10T10:00:00Z',
      dueAt: '2026-10-10T12:30:00Z',
    });
    const c = item({ id: 'negative', baseRank: 4, queuedAt: '2026-10-10T11:00:00Z' });
    const d = item({ id: 'negative-prio', baseRank: 4, queuedAt: '2026-10-10T11:30:00Z', priority: 10 });
    expect(sortByUrgency([a, b, c, d], load, now).map((i) => i.id)).toEqual([
      'negative-prio',
      'mail-aged',
      'negative',
      'mail-old',
    ]);
  });
});
