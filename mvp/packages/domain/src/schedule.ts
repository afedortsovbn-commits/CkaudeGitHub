/**
 * График работы персонала (доработки 07.10.2026): автосоставление графика на месяц и расстановка перерывов.
 * Чистые функции без БД — проверяются unit-тестами. Время — минуты от начала месяца по местному времени
 * (Europe/Minsk, UTC+3 без перехода на летнее время).
 */

export interface ShiftTemplateIn {
  id: string;
  code: string;
  startMin: number;
  durationMin: number;
  isNight: boolean;
}

export interface StaffIn {
  userId: string;
  name: string;
  /** Допустимые длительности смен, часы (8 — короткая, 12 — длинная). */
  shiftLengths: number[];
  night: 'prefer' | 'ok' | 'no';
  /** День недели (1 — пн … 7 — вс) → предпочтение. */
  weekdays: Record<string, 'prefer' | 'avoid' | 'off'>;
  maxHours?: number | null;
}

export interface StaffRuleIn {
  userId: string;
  kind: 'unavailable' | 'preferred';
  dateFrom?: string | null;
  dateTo?: string | null;
  weekdays?: number[] | null;
  timeFrom?: number | null;
  timeTo?: number | null;
}

export interface ScheduleRules {
  /** Отдых между сменами — не меньше restFactor × длительность предыдущей смены. */
  restFactor: number;
  maxConsecutiveDays: number;
  maxShiftHours: number;
  monthNormHours: number;
  normTolerancePct: number;
}

export interface BreakRules {
  day: { long: number; short: number[] };
  night: { long: number; short: number[] };
}

export interface PlannedShift {
  userId: string;
  date: string;
  templateId: string;
  /** Минуты от начала месяца (местное время). */
  start: number;
  end: number;
  isNight: boolean;
  manual?: boolean;
}

export interface PlannedBreak {
  userId: string;
  date: string;
  kind: 'long' | 'short';
  start: number;
  end: number;
  manual?: boolean;
}

export const DEFAULT_SCHEDULE_RULES: ScheduleRules = {
  restFactor: 2,
  maxConsecutiveDays: 5,
  maxShiftHours: 12,
  monthNormHours: 168,
  normTolerancePct: 10,
};

export const DEFAULT_BREAK_RULES: BreakRules = {
  day: { long: 45, short: [15, 15, 15] },
  night: { long: 120, short: [15, 15, 15] },
};

/** Дни месяца «ГГГГ-ММ»: дата, индекс, день недели (1 — пн … 7 — вс). */
export function monthDays(month: string): { date: string; index: number; weekday: number }[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1, i + 1));
    return { date: d.toISOString().slice(0, 10), index: i, weekday: ((d.getUTCDay() + 6) % 7) + 1 };
  });
}

/** Минуты от начала месяца → момент времени (Минск, UTC+3). */
export function monthMinuteToDate(month: string, min: number): Date {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1) + (min - 180) * 60_000);
}

/** Момент времени → минуты от начала месяца (Минск, UTC+3). */
export function dateToMonthMinute(month: string, at: Date): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return Math.round((at.getTime() - Date.UTC(y, m - 1, 1)) / 60_000) + 180;
}

/** Класс длительности смены для пожеланий: 8 (короткая) или 12 (длинная). */
export const lengthClass = (durationMin: number) => (durationMin >= 600 ? 12 : 8);

/** Рабочие часы смены: присутствие минус длинный (неоплачиваемый) перерыв. */
export const workHours = (t: { durationMin: number; isNight: boolean }, br: BreakRules) =>
  (t.durationMin - (t.isNight ? br.night.long : br.day.long)) / 60;

type Interval = [number, number];
const overlaps = (a: Interval, b: Interval) => a[0] < b[1] && b[0] < a[1];

/** Интервалы правила сотрудника в месяце: полные дни или окна времени (окно через полночь — до утра). */
export function ruleIntervals(rule: StaffRuleIn, days: ReturnType<typeof monthDays>): Interval[] {
  const out: Interval[] = [];
  for (const d of days) {
    if (rule.dateFrom && d.date < rule.dateFrom) continue;
    if (rule.dateTo && d.date > rule.dateTo) continue;
    if (rule.weekdays?.length && !rule.weekdays.includes(d.weekday)) continue;
    const base = d.index * 1440;
    if (rule.timeFrom == null || rule.timeTo == null) out.push([base, base + 1440]);
    else {
      const to = rule.timeTo <= rule.timeFrom ? rule.timeTo + 1440 : rule.timeTo;
      out.push([base + rule.timeFrom, base + to]);
    }
  }
  return out;
}

/** Детерминированная «случайность» для равных кандидатов (один и тот же вход — один и тот же график). */
function tie(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

export interface GenerateInput {
  month: string;
  templates: ShiftTemplateIn[];
  /** Сколько операторов нужно на смене в дату. */
  demand(date: string, weekday: number, templateId: string): number;
  staff: StaffIn[];
  rules: StaffRuleIn[];
  scheduleRules: ScheduleRules;
  breakRules: BreakRules;
  /** Смены, поставленные вручную: сохраняются и учитываются. */
  fixed: PlannedShift[];
}

export interface GenerateResult {
  shifts: PlannedShift[];
  warnings: string[];
  hours: Record<string, number>;
}

/**
 * Автосоставление графика: по дням и сменам подбираются сотрудники, которым смена разрешена (длительность,
 * ночные, «не может», выходной день недели), у которых соблюдён отдых после предыдущей смены (не меньше
 * restFactor × её длительность) и не превышены рабочие дни подряд и норма часов. Среди подходящих — сначала
 * те, у кого меньше часов (равномерная нагрузка), затем по пожеланиям.
 */
export function generateMonth(i: GenerateInput): GenerateResult {
  const days = monthDays(i.month);
  const tById = new Map(i.templates.map((t) => [t.id, t]));
  const byUser = new Map<string, PlannedShift[]>(i.staff.map((s) => [s.userId, []]));
  const hours: Record<string, number> = Object.fromEntries(i.staff.map((s) => [s.userId, 0]));
  const shifts: PlannedShift[] = [];
  const warnings: string[] = [];
  const add = (s: PlannedShift) => {
    shifts.push(s);
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    list.sort((a, b) => a.start - b.start);
    byUser.set(s.userId, list);
    const t = tById.get(s.templateId);
    if (t) hours[s.userId] = (hours[s.userId] ?? 0) + workHours(t, i.breakRules);
  };
  for (const f of i.fixed) add({ ...f, manual: true });

  const unavailable = new Map<string, Interval[]>();
  const preferred = new Map<string, Interval[]>();
  for (const r of i.rules) {
    const m = r.kind === 'unavailable' ? unavailable : preferred;
    m.set(r.userId, [...(m.get(r.userId) ?? []), ...ruleIntervals(r, days)]);
  }
  const norm = i.scheduleRules.monthNormHours;
  const maxFor = (s: StaffIn) => s.maxHours ?? norm * (1 + i.scheduleRules.normTolerancePct / 100);
  const templates = [...i.templates].sort((a, b) => a.startMin - b.startMin);

  for (const d of days) {
    for (const t of templates) {
      const need = i.demand(d.date, d.weekday, t.id);
      const have = shifts.filter((s) => s.date === d.date && s.templateId === t.id).length;
      if (need <= have) continue;
      const start = d.index * 1440 + t.startMin;
      const end = start + t.durationMin;
      const wh = workHours(t, i.breakRules);
      const ok = i.staff.filter((s) => {
        const mine = byUser.get(s.userId) ?? [];
        if (mine.some((x) => x.date === d.date || overlaps([x.start, x.end], [start, end]))) return false;
        if (!s.shiftLengths.includes(lengthClass(t.durationMin))) return false;
        if (t.isNight && s.night === 'no') return false;
        if (s.weekdays[String(d.weekday)] === 'off') return false;
        if (t.durationMin / 60 > i.scheduleRules.maxShiftHours) return false;
        if ((unavailable.get(s.userId) ?? []).some((iv) => overlaps(iv, [start, end]))) return false;
        // Отдых: после предыдущей смены и перед следующей (в т. ч. поставленной вручную).
        const prev = [...mine].reverse().find((x) => x.end <= start);
        if (prev && start - prev.end < i.scheduleRules.restFactor * (prev.end - prev.start)) return false;
        const next = mine.find((x) => x.start >= end);
        if (next && next.start - end < i.scheduleRules.restFactor * t.durationMin) return false;
        // Рабочих дней подряд — не больше допустимого.
        let run = 0;
        for (let k = d.index - 1; k >= 0 && mine.some((x) => x.date === days[k]!.date); k--) run++;
        if (run >= i.scheduleRules.maxConsecutiveDays) return false;
        return (hours[s.userId] ?? 0) + wh <= maxFor(s);
      });
      const score = (s: StaffIn) => {
        let v = -((hours[s.userId] ?? 0) / Math.max(1, maxFor(s))) * 100;
        if ((preferred.get(s.userId) ?? []).some((iv) => overlaps(iv, [start, end]))) v += 40;
        const wd = s.weekdays[String(d.weekday)];
        if (wd === 'prefer') v += 15;
        if (wd === 'avoid') v -= 30;
        if (t.isNight && s.night === 'prefer') v += 20;
        if (!t.isNight && s.night === 'prefer') v -= 5;
        return v + tie(`${s.userId}:${d.date}:${t.id}`);
      };
      const picked = ok.sort((a, b) => score(b) - score(a)).slice(0, need - have);
      for (const s of picked)
        add({ userId: s.userId, date: d.date, templateId: t.id, start, end, isNight: t.isNight });
      if (picked.length < need - have)
        warnings.push(`${d.date} · ${t.code}: не хватает ${need - have - picked.length} из ${need}`);
    }
  }
  for (const s of i.staff) {
    const h = Math.round(hours[s.userId] ?? 0);
    if (h < norm * 0.85) warnings.push(`${s.name}: ${h} ч из нормы ${norm} ч`);
  }
  return {
    shifts: shifts.sort((a, b) => a.start - b.start || a.userId.localeCompare(b.userId)),
    warnings,
    hours,
  };
}

/**
 * Перерывы: длинный — около середины смены, короткие — равномерно (≈ 20 %, 70 %, 88 % смены); не ближе часа к
 * началу и получаса к концу смены. Перерывы разных операторов не пересекаются (одновременно на перерыве —
 * не больше одного): время сдвигается шагом 5 минут. Поставленные вручную — не трогаются.
 */
export function planBreaks(
  shifts: PlannedShift[],
  rules: BreakRules,
  fixed: PlannedBreak[] = [],
): { breaks: PlannedBreak[]; warnings: string[] } {
  const occupied: Interval[] = fixed.map((b) => [b.start, b.end]);
  const breaks: PlannedBreak[] = [...fixed];
  const warnings: string[] = [];
  const own = new Map<PlannedShift, Interval[]>();
  for (const s of shifts)
    own.set(
      s,
      fixed
        .filter((b) => b.userId === s.userId && b.start >= s.start && b.end <= s.end)
        .map((b) => [b.start, b.end]),
    );
  const place = (s: PlannedShift, kind: 'long' | 'short', len: number, desired: number) => {
    const mine = own.get(s)!;
    if (
      kind === 'long' &&
      fixed.some((b) => b.userId === s.userId && b.kind === 'long' && b.start >= s.start && b.end <= s.end)
    )
      return;
    const lo = s.start + 60;
    const hi = s.end - 30 - len;
    for (let k = 0; k <= 48; k++) {
      for (const sign of k ? [1, -1] : [1]) {
        const st = Math.round((desired + sign * k * 5) / 5) * 5;
        if (st < lo || st > hi) continue;
        const iv: Interval = [st, st + len];
        if (occupied.some((o) => overlaps(o, iv))) continue;
        if (mine.some((o) => overlaps([o[0] - 30, o[1] + 30], iv))) continue;
        occupied.push(iv);
        mine.push(iv);
        breaks.push({ userId: s.userId, date: s.date, kind, start: st, end: st + len });
        return;
      }
    }
    const st = Math.max(lo, Math.min(hi, Math.round(desired / 5) * 5));
    occupied.push([st, st + len]);
    mine.push([st, st + len]);
    breaks.push({ userId: s.userId, date: s.date, kind, start: st, end: st + len });
    warnings.push(
      `${s.date}: перерыв совпадает с перерывом другого оператора (слишком много людей на смене)`,
    );
  };
  const ordered = [...shifts].sort((a, b) => a.start - b.start);
  for (const s of ordered) {
    const r = s.isNight ? rules.night : rules.day;
    if (r.long > 0) place(s, 'long', r.long, s.start + (s.end - s.start) * 0.45 - r.long / 2);
  }
  for (const s of ordered) {
    const r = s.isNight ? rules.night : rules.day;
    const fr =
      r.short.length === 3 ? [0.2, 0.7, 0.88] : r.short.map((_, k) => (k + 1) / (r.short.length + 1));
    // Короткие, поставленные вручную, засчитываются — недостающие добавляются.
    const manualShorts = fixed.filter(
      (b) => b.userId === s.userId && b.kind === 'short' && b.start >= s.start && b.end <= s.end,
    ).length;
    r.short.forEach((len, k) => {
      if (k >= manualShorts) place(s, 'short', len, s.start + (s.end - s.start) * fr[k]!);
    });
  }
  return { breaks: breaks.sort((a, b) => a.start - b.start), warnings };
}
