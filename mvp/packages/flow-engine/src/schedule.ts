/**
 * Расписание работы (M-IVR-05): интервалы по дням недели в часовом поясе расписания и праздничные дни
 * (нерабочие целиком). Формат — как в справочнике «Расписания» (Ф1).
 */
export interface Schedule {
  timezone: string;
  week: Partial<Record<Weekday, [string, string][]>>;
  holidays: string[];
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
const DAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Дата, день недели и минуты от полуночи в часовом поясе. */
export function localParts(at: Date, timezone: string): { date: string; day: Weekday; minutes: number } {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const day = DAYS.find((d) => d === String(p.weekday).toLowerCase().slice(0, 3)) ?? 'mon';
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    day,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function isOpen(s: Schedule, at: Date): boolean {
  const { date, day, minutes } = localParts(at, s.timezone);
  if ((s.holidays ?? []).includes(date)) return false;
  return (s.week?.[day] ?? []).some(([from, to]) => {
    const a = toMin(from);
    const b = toMin(to);
    return b > a ? minutes >= a && minutes < b : minutes >= a || minutes < b; // интервал через полночь
  });
}
