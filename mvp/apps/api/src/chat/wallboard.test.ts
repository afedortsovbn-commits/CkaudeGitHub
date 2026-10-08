import { SupervisorThresholdsSchema } from '@cc/contracts';
import { describe, expect, it } from 'vitest';
import { evaluateWallboard, spikeLevel, type WallboardInput } from './wallboard';

const th = SupervisorThresholdsSchema.parse({});
const bucket = (received: number, usual: number, maxWaitS = 0, lost = 0) => ({
  at: '2026-10-08T10:00:00Z',
  received,
  usual,
  maxWaitS,
  lost,
});
const base: WallboardInput = {
  operators: [
    { status: 'ready', onCall: false, inChat: false },
    { status: 'ready', onCall: true, inChat: false },
    { status: 'break', onCall: false, inChat: false },
    { status: 'offline', onCall: false, inChat: false },
  ],
  now: { talking: 1, ivr: 0, qVoice: 0, qText: 0, oldestWaitS: 0, chats: 0, bot: 0 },
  buckets: Array.from({ length: 12 }, () => bucket(4, 4)),
  today: { received: 50, answered: 45, abandoned: 1, slPct: 90, asaS: 12 },
  resources: [],
  th,
};

describe('экран мониторинга', () => {
  it('всё в норме: операторы по состояниям, проблем нет', () => {
    const r = evaluateWallboard(base);
    expect(r.level).toBe('ok');
    expect(r.problems).toEqual([]);
    expect(r.operators).toEqual({ online: 3, free: 1, busy: 1, wrapUp: 0, onBreak: 1 });
  });

  it('очередь без свободных операторов, долгое ожидание, резкий рост и потерянные', () => {
    const r = evaluateWallboard({
      ...base,
      operators: [{ status: 'ready', onCall: true, inChat: false }],
      now: { ...base.now, qVoice: 3, oldestWaitS: 240 },
      buckets: [
        ...Array.from({ length: 9 }, () => bucket(4, 4)),
        bucket(10, 4, 200, 1),
        bucket(9, 4),
        bucket(8, 4),
      ],
    });
    expect(r.level).toBe('crit');
    expect(r.problems.map((p) => p.key)).toEqual(['wait', 'no_free', 'spike', 'lost']);
    expect(r.problems.find((p) => p.key === 'spike')!.text).toContain('в 2,3 раза больше обычного');
    expect(r.buckets[9]!.flags).toEqual(['spike', 'slow', 'lost']);
    expect(r.recentProblemBuckets).toBe(3);
  });

  it('рост считается от обычного потока и не срабатывает на единицах', () => {
    expect(spikeLevel(3, 1, 10)).toBe('ok');
    expect(spikeLevel(15, 10, 10)).toBe('warn');
    expect(spikeLevel(20, 10, 10)).toBe('crit');
    expect(spikeLevel(12, 0, 10)).toBe('crit');
  });
});
