import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BREAK_RULES,
  DEFAULT_SCHEDULE_RULES,
  generateMonth,
  monthDays,
  monthMinuteToDate,
  planBreaks,
  type StaffIn,
} from './schedule';

const DAY = { id: 'D', code: 'Д12', startMin: 480, durationMin: 720, isNight: false };
const NIGHT = { id: 'N', code: 'Н12', startMin: 1200, durationMin: 720, isNight: true };
const staff = (n: number, patch: Partial<StaffIn> = {}): StaffIn[] =>
  Array.from({ length: n }, (_, k) => ({
    userId: `u${k}`,
    name: `Оператор ${k}`,
    shiftLengths: [8, 12],
    night: 'ok',
    weekdays: {},
    ...patch,
  }));

describe('график работы', () => {
  it('дни месяца и время по Минску', () => {
    const d = monthDays('2026-10');
    expect(d).toHaveLength(31);
    expect(d[0]).toEqual({ date: '2026-10-01', index: 0, weekday: 4 });
    expect(monthMinuteToDate('2026-10', 480).toISOString()).toBe('2026-10-01T05:00:00.000Z');
  });

  it('покрытие потребности, отдых не меньше двойной смены, не больше 5 дней подряд, равномерно', () => {
    const r = generateMonth({
      month: '2026-10',
      templates: [DAY, NIGHT],
      demand: (_d, _w, t) => (t === 'D' ? 2 : 1),
      staff: staff(10),
      rules: [],
      scheduleRules: DEFAULT_SCHEDULE_RULES,
      breakRules: DEFAULT_BREAK_RULES,
      fixed: [],
    });
    expect(r.warnings.filter((w) => w.includes('не хватает'))).toEqual([]);
    for (const date of monthDays('2026-10').map((d) => d.date)) {
      expect(r.shifts.filter((s) => s.date === date && s.templateId === 'D')).toHaveLength(2);
      expect(r.shifts.filter((s) => s.date === date && s.templateId === 'N')).toHaveLength(1);
    }
    const byUser = new Map<string, typeof r.shifts>();
    for (const s of r.shifts) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
    for (const list of byUser.values()) {
      for (let k = 1; k < list.length; k++) {
        const prev = list[k - 1]!;
        expect(list[k]!.start - prev.end).toBeGreaterThanOrEqual(2 * (prev.end - prev.start));
      }
    }
    const h = Object.values(r.hours);
    expect(Math.max(...h) - Math.min(...h)).toBeLessThanOrEqual(25);
  });

  it('пожелания: «не может» в даты и время, ночные — нет, выходной день недели', () => {
    const s = staff(4);
    s[0]!.night = 'no';
    s[1]!.weekdays = { '6': 'off', '7': 'off' };
    const r = generateMonth({
      month: '2026-10',
      templates: [DAY, NIGHT],
      demand: () => 1,
      staff: s,
      rules: [
        { userId: 'u2', kind: 'unavailable', dateFrom: '2026-10-10', dateTo: '2026-10-20' },
        { userId: 'u3', kind: 'unavailable', weekdays: [2], timeFrom: 1080, timeTo: 1440 },
      ],
      scheduleRules: DEFAULT_SCHEDULE_RULES,
      breakRules: DEFAULT_BREAK_RULES,
      fixed: [],
    });
    const days = new Map(monthDays('2026-10').map((d) => [d.date, d.weekday]));
    expect(r.shifts.some((x) => x.userId === 'u0' && x.isNight)).toBe(false);
    expect(r.shifts.some((x) => x.userId === 'u1' && (days.get(x.date) ?? 0) >= 6)).toBe(false);
    expect(r.shifts.some((x) => x.userId === 'u2' && x.date >= '2026-10-10' && x.date <= '2026-10-20')).toBe(
      false,
    );
    // по вторникам после 18:00 — ни дневная до 20:00, ни ночная
    expect(r.shifts.some((x) => x.userId === 'u3' && days.get(x.date) === 2)).toBe(false);
  });

  it('перерывы: дневная 45 + 3×15, ночная 120 + 3×15, одновременно на перерыве — не больше одного', () => {
    const r = generateMonth({
      month: '2026-10',
      templates: [DAY, NIGHT],
      demand: (_d, _w, t) => (t === 'D' ? 3 : 2),
      staff: staff(14),
      rules: [],
      scheduleRules: DEFAULT_SCHEDULE_RULES,
      breakRules: DEFAULT_BREAK_RULES,
      fixed: [],
    });
    const { breaks, warnings } = planBreaks(r.shifts, DEFAULT_BREAK_RULES);
    expect(warnings).toEqual([]);
    const first = r.shifts.find((s) => !s.isNight)!;
    const mine = breaks.filter(
      (b) => b.userId === first.userId && b.start >= first.start && b.end <= first.end,
    );
    expect(mine.map((b) => b.end - b.start).sort((a, b) => a - b)).toEqual([15, 15, 15, 45]);
    const night = r.shifts.find((s) => s.isNight)!;
    const nb = breaks.filter(
      (b) => b.userId === night.userId && b.start >= night.start && b.end <= night.end,
    );
    expect(nb.map((b) => b.end - b.start).sort((a, b) => a - b)).toEqual([15, 15, 15, 120]);
    const sorted = [...breaks].sort((a, b) => a.start - b.start);
    for (let k = 1; k < sorted.length; k++)
      expect(sorted[k]!.start).toBeGreaterThanOrEqual(sorted[k - 1]!.end);
  });
});
