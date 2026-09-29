import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  daysWord,
  deadlinePhrase,
  formatDate,
  localDate,
  localTime,
  plural,
} from './ticket-time';

describe('даты в Europe/Minsk', () => {
  it('граница суток по Минску (UTC+3), в том числе в выходной', () => {
    expect(localDate(new Date('2026-10-03T20:59:00Z'), 'Europe/Minsk')).toBe('2026-10-03');
    expect(localDate(new Date('2026-10-03T21:00:00Z'), 'Europe/Minsk')).toBe('2026-10-04');
    expect(localTime(new Date('2026-10-03T05:00:00Z'), 'Europe/Minsk')).toBe('08:00');
    expect(localTime(new Date('2026-10-03T04:59:00Z'), 'Europe/Minsk')).toBe('07:59');
    expect(localTime(new Date('2026-10-03T21:05:00Z'), 'Europe/Minsk')).toBe('00:05');
  });
  it('календарные дни между датами и сдвиг', () => {
    expect(daysBetween('2026-10-03', '2026-10-05')).toBe(2);
    expect(daysBetween('2026-10-06', '2026-10-05')).toBe(-1);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(formatDate('2026-10-05')).toBe('05.10.2026');
  });
});

describe('склонения и фразы срока', () => {
  it('день / дня / дней', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 101, 111].map(daysWord)).toEqual([
      'день',
      'дня',
      'дней',
      'дней',
      'дней',
      'день',
      'дня',
      'дней',
      'день',
      'дней',
    ]);
    expect(plural(3, ['а', 'б', 'в'])).toBe('б');
  });
  it('«осталось N дней», «срок истекает сегодня», «просрочено на N дней»', () => {
    expect(deadlinePhrase(2)).toBe('осталось 2 дня');
    expect(deadlinePhrase(1)).toBe('осталось 1 день');
    expect(deadlinePhrase(15)).toBe('осталось 15 дней');
    expect(deadlinePhrase(0)).toBe('срок истекает сегодня');
    expect(deadlinePhrase(-1)).toBe('просрочено на 1 день');
    expect(deadlinePhrase(-5)).toBe('просрочено на 5 дней');
  });
});
