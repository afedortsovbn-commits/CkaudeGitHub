/** Даты и склонения для сроков тикетов (M-TKT-03, M-TKT-04). Чистые функции. */

/** Календарная дата YYYY-MM-DD в часовом поясе системы. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Время HH:MM в часовом поясе системы. */
export function localTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/** Разница в календарных днях: to − from (обе даты вида YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export const daysWord = (n: number) => plural(n, ['день', 'дня', 'дней']);

/** «осталось 2 дня» / «срок истекает сегодня» / «просрочено на 1 день». daysLeft = срок − сегодня. */
export function deadlinePhrase(daysLeft: number): string {
  if (daysLeft > 0) return `осталось ${daysLeft} ${daysWord(daysLeft)}`;
  if (daysLeft === 0) return 'срок истекает сегодня';
  const n = -daysLeft;
  return `просрочено на ${n} ${daysWord(n)}`;
}

/** 2026-10-05 → 05.10.2026 */
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}
