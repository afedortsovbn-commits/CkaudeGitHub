/**
 * Производственный календарь (доработки 08.10.2026): рабочие, сокращённые предпраздничные, выходные и праздничные
 * дни, норма рабочих часов месяца. По умолчанию — по законодательству Республики Беларусь (пятидневка, 40 ч в
 * неделю: рабочий день 8 ч, накануне праздника — на 1 ч короче; праздник, выпавший на выходной, не переносится).
 * Переносы рабочих дней (постановления Совмина) и любые другие изменения задаются вручную — корректировками дня.
 */

export type DayKind = 'work' | 'short' | 'off' | 'holiday';

export interface CalendarOverride {
  date: string;
  kind: DayKind;
  note?: string | null;
}

export interface CalendarDay {
  date: string;
  /** 1 — понедельник … 7 — воскресенье. */
  weekday: number;
  kind: DayKind;
  /** Как было бы без корректировки. */
  defaultKind: DayKind;
  /** Название праздника (по закону). */
  holiday: string | null;
  /** Комментарий к корректировке (например, «перенос с 20 апреля»). */
  note: string | null;
  overridden: boolean;
  /** Рабочие часы дня по календарю. */
  hours: number;
}

/** Часы рабочего дня при 40-часовой пятидневке; сокращённый предпраздничный — на час меньше. */
export const DAY_HOURS: Record<DayKind, number> = { work: 8, short: 7, off: 0, holiday: 0 };

/** Государственные праздники и праздничные дни Республики Беларусь, нерабочие (ММ-ДД). */
const FIXED_HOLIDAYS: Record<string, string> = {
  '01-01': 'Новый год',
  '01-02': 'Новый год',
  '01-07': 'Рождество Христово (православное)',
  '03-08': 'День женщин',
  '05-01': 'Праздник труда',
  '05-09': 'День Победы',
  '07-03': 'День Независимости',
  '11-07': 'День Октябрьской революции',
  '12-25': 'Рождество Христово (католическое)',
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};
const addDays = (date: string, k: number) => iso(new Date(utc(date).getTime() + k * 86_400_000));
export const weekdayOf = (date: string) => ((utc(date).getUTCDay() + 6) % 7) + 1;

/** Православная Пасха (по юлианскому алгоритму, переведённая в григорианский календарь; 1900–2099). */
export function orthodoxEaster(year: number): string {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return iso(new Date(Date.UTC(year, month - 1, day + 13)));
}

/** Праздники года: дата → название (фиксированные и Радуница — 9-й день после православной Пасхи). */
export function holidaysOf(year: number): Map<string, string> {
  const m = new Map(Object.entries(FIXED_HOLIDAYS).map(([md, name]) => [`${year}-${md}`, name]));
  m.set(addDays(orthodoxEaster(year), 9), 'Радуница');
  return m;
}

/**
 * Вид дня по закону: праздник; суббота и воскресенье — выходные; будний день накануне праздника — сокращённый;
 * иначе — рабочий.
 */
export function defaultDayKind(date: string): DayKind {
  const year = Number(date.slice(0, 4));
  if (holidaysOf(year).has(date)) return 'holiday';
  if (weekdayOf(date) >= 6) return 'off';
  const next = addDays(date, 1);
  return holidaysOf(Number(next.slice(0, 4))).has(next) ? 'short' : 'work';
}

/** Дни с ... по ... включительно (ГГГГ-ММ-ДД) с учётом корректировок. */
export function calendarDays(from: string, to: string, overrides: CalendarOverride[]): CalendarDay[] {
  const byDate = new Map(overrides.map((o) => [o.date, o]));
  const out: CalendarDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const defaultKind = defaultDayKind(d);
    const o = byDate.get(d);
    const kind = o?.kind ?? defaultKind;
    out.push({
      date: d,
      weekday: weekdayOf(d),
      kind,
      defaultKind,
      holiday: holidaysOf(Number(d.slice(0, 4))).get(d) ?? null,
      note: o?.note ?? null,
      overridden: !!o && (o.kind !== defaultKind || !!o.note),
      hours: DAY_HOURS[kind],
    });
  }
  return out;
}

/** Дни месяца «ГГГГ-ММ» по календарю. */
export function calendarMonth(month: string, overrides: CalendarOverride[]): CalendarDay[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return calendarDays(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`, overrides);
}

/** Итоги месяца: рабочих дней (включая сокращённые) и норма часов. */
export function monthTotals(days: CalendarDay[]): { workDays: number; hours: number; offDays: number } {
  return {
    workDays: days.filter((d) => d.kind === 'work' || d.kind === 'short').length,
    hours: days.reduce((a, d) => a + d.hours, 0),
    offDays: days.filter((d) => d.kind === 'off' || d.kind === 'holiday').length,
  };
}

/**
 * День недели для потребности графика: праздник или перенесённый выходной в будний день — как воскресенье;
 * перенесённый рабочий день в субботу или воскресенье — как понедельник; иначе — свой день недели.
 */
export function demandWeekday(day: Pick<CalendarDay, 'kind' | 'weekday'>): number {
  const working = day.kind === 'work' || day.kind === 'short';
  if (!working && day.weekday <= 5) return 7;
  if (working && day.weekday >= 6) return 1;
  return day.weekday;
}
