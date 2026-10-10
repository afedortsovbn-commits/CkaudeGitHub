import { describe, expect, it } from 'vitest';
import { type Candidate, leastLoad, leastRecent, loadChat, loadVoice, pickCandidate } from './strategies';

const c = (over: Partial<Candidate>): Candidate => ({
  userId: 'u',
  activeCount: 0,
  lastAssignedAt: null,
  skillLevel: 0,
  ...over,
});

describe('leastRecent (M-RT-03)', () => {
  it('выбирает того, кому назначали давнее всего', () => {
    const a = c({ userId: 'a', lastAssignedAt: '2026-01-01T10:00:00Z' });
    const b = c({ userId: 'b', lastAssignedAt: '2026-01-01T09:00:00Z' });
    const cnd = c({ userId: 'c', lastAssignedAt: '2026-01-01T11:00:00Z' });
    expect(leastRecent([a, b, cnd])?.userId).toBe('b');
  });

  it('никогда не назначенный оператор выигрывает у всех', () => {
    const a = c({ userId: 'a', lastAssignedAt: '2026-01-01T10:00:00Z' });
    const never = c({ userId: 'never', lastAssignedAt: null });
    expect(leastRecent([a, never])?.userId).toBe('never');
  });

  it('при равенстве времени — выше уровень навыка', () => {
    const a = c({ userId: 'a', lastAssignedAt: '2026-01-01T10:00:00Z', skillLevel: 40 });
    const b = c({ userId: 'b', lastAssignedAt: '2026-01-01T10:00:00Z', skillLevel: 80 });
    expect(leastRecent([a, b])?.userId).toBe('b');
  });
});

describe('leastLoad (M-RT-03)', () => {
  it('выбирает наименее загруженного', () => {
    const a = c({ userId: 'a', activeCount: 3 });
    const b = c({ userId: 'b', activeCount: 1 });
    expect(leastLoad([a, b])?.userId).toBe('b');
  });

  it('при равной загрузке — кто дольше свободен', () => {
    const a = c({ userId: 'a', activeCount: 1, lastAssignedAt: '2026-01-01T10:00:00Z' });
    const b = c({ userId: 'b', activeCount: 1, lastAssignedAt: '2026-01-01T09:00:00Z' });
    expect(leastLoad([a, b])?.userId).toBe('b');
  });
});

describe('pickCandidate', () => {
  it('пустой список кандидатов — нет назначения', () => {
    expect(pickCandidate('least_recent', [])).toBeUndefined();
  });

  it('неизвестная стратегия — фолбэк на least_recent', () => {
    const a = c({ userId: 'a', lastAssignedAt: '2026-01-01T10:00:00Z' });
    const b = c({ userId: 'b', lastAssignedAt: '2026-01-01T09:00:00Z' });
    expect(pickCandidate('unknown', [a, b])?.userId).toBe('b');
  });
});

describe('режим «по загрузке» (Д-017, п.5)', () => {
  it('звонок — тому, у кого меньше чатов; при равенстве — кто дольше без звонка', () => {
    const a = c({ userId: 'a', activeCount: 2, lastAssignedAt: '2026-01-01T08:00:00Z' });
    const b = c({ userId: 'b', activeCount: 1, lastAssignedAt: '2026-01-01T11:00:00Z' });
    const d = c({ userId: 'd', activeCount: 1, lastAssignedAt: '2026-01-01T09:00:00Z' });
    expect(loadVoice([a, b, d])?.userId).toBe('d');
  });

  it('чат — тому, у кого больше свободной ёмкости; при равенстве — кто дольше без текстовых', () => {
    const a = c({ userId: 'a', freeCapacity: 60, lastAssignedAt: '2026-01-01T08:00:00Z' });
    const b = c({ userId: 'b', freeCapacity: 90, lastAssignedAt: '2026-01-01T11:00:00Z' });
    const d = c({ userId: 'd', freeCapacity: 90, lastAssignedAt: null });
    expect(loadChat([a, b, d])?.userId).toBe('d');
    expect(loadChat([a, b])?.userId).toBe('b');
  });
});
