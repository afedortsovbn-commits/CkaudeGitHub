import { describe, expect, it } from 'vitest';
import {
  calendarMonth,
  defaultDayKind,
  demandWeekday,
  holidaysOf,
  monthTotals,
  orthodoxEaster,
} from './work-calendar';

describe('производственный календарь (Республика Беларусь)', () => {
  it('православная Пасха и Радуница', () => {
    expect(orthodoxEaster(2025)).toBe('2025-04-20');
    expect(orthodoxEaster(2026)).toBe('2026-04-12');
    expect(orthodoxEaster(2027)).toBe('2027-05-02');
    expect(holidaysOf(2026).get('2026-04-21')).toBe('Радуница');
    expect(holidaysOf(2027).get('2027-05-11')).toBe('Радуница');
  });

  it('виды дней по закону', () => {
    expect(defaultDayKind('2026-07-03')).toBe('holiday');
    expect(defaultDayKind('2026-07-02')).toBe('short'); // накануне Дня Независимости
    expect(defaultDayKind('2026-07-04')).toBe('off');
    expect(defaultDayKind('2026-11-06')).toBe('short'); // праздник в субботу — пятница всё равно короче
    expect(defaultDayKind('2026-12-31')).toBe('short'); // накануне Нового года следующего года
    expect(defaultDayKind('2026-10-08')).toBe('work');
  });

  it('норма часов месяца', () => {
    // Ноябрь 2026: 21 рабочий день, 6 ноября — сокращённый.
    expect(monthTotals(calendarMonth('2026-11', []))).toEqual({ workDays: 21, hours: 167, offDays: 9 });
  });

  it('корректировки: перенос рабочего дня меняет норму и потребность', () => {
    const days = calendarMonth('2026-04', [
      { date: '2026-04-20', kind: 'off', note: 'перенос на 25 апреля' },
      { date: '2026-04-25', kind: 'work', note: 'перенос с 20 апреля' },
    ]);
    const base = monthTotals(calendarMonth('2026-04', []));
    // 20 апреля — канун Радуницы (7 ч), перенесённая суббота — полный день (8 ч).
    expect(monthTotals(days).hours).toBe(base.hours + 1);
    const mon = days.find((d) => d.date === '2026-04-20')!;
    const sat = days.find((d) => d.date === '2026-04-25')!;
    expect(mon.overridden && sat.overridden).toBe(true);
    expect(demandWeekday(mon)).toBe(7);
    expect(demandWeekday(sat)).toBe(1);
    expect(demandWeekday(days.find((d) => d.date === '2026-04-21')!)).toBe(7); // Радуница
  });
});
