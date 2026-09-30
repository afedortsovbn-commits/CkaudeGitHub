/**
 * Маскирование персональных данных в журналах (M-NFR-07, FS-PD-02): номера телефонов, адреса email и тексты
 * клиентов не попадают в логи в открытом виде. Применяется ко всем записям логгера `createLogger`: к строке
 * сообщения и ко всем строковым полям объекта (в том числе к тексту ошибок, где PostgreSQL повторяет значения).
 */

/** Поля, значение которых скрывается целиком (тексты переписки, имена и адреса клиентов, секреты). */
const HIDE_KEYS = new Set([
  'body',
  'text',
  'caption',
  'displayname',
  'display_name',
  'fullname',
  'full_name',
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'address',
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
]);
/** Поля-идентификаторы клиента: маскируются, но оставляют хвост для поиска по журналу. */
const MASK_KEYS = new Set([
  'phone',
  'email',
  'from',
  'to',
  'caller',
  'callerid',
  'caller_id',
  'value',
  'username',
]);

const UUID = String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`;
const DATETIME = String.raw`\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?`;
const EMAIL = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`;
// Телефон: 9–15 цифр с разделителями, с «+» или без (белорусские +375…, 80…, внутренние длинные номера).
const PHONE = String.raw`\+?\d(?:[\s()-]*\d){8,14}`;
const RE = new RegExp(`(${UUID})|(${DATETIME})|(${EMAIL})|(?<![\\w.])(${PHONE})(?![\\w])`, 'g');

const maskEmail = (e: string) => {
  const [user, domain] = e.split('@');
  return `${user!.slice(0, 1)}***@${domain}`;
};
const maskPhone = (p: string) => {
  const digits = p.replace(/\D/g, '');
  return `${p.startsWith('+') ? '+' : ''}***${digits.slice(-2)}`;
};

/** Маскирует телефоны и email в произвольной строке; UUID и даты не трогает. */
export function maskPii(s: string): string {
  if (!/\d{3}|@/.test(s)) return s;
  return s.replace(RE, (m, uuid, dt, email, phone) =>
    uuid || dt ? m : email ? maskEmail(email) : phone ? maskPhone(phone) : m,
  );
}

/** Поле-идентификатор: адрес или номер маскируется целиком (даже короткий внутренний), прочее — как строка. */
function maskValue(v: string): string {
  if (/^\s*[^\s@]+@[^\s@]+\s*$/.test(v)) return maskEmail(v.trim());
  if (/^\s*\+?[\d\s()-]{5,}\s*$/.test(v)) return maskPhone(v.trim());
  return maskPii(v);
}

/** Маскирует объект записи журнала (глубина ограничена — логгер не должен зависать на больших структурах). */
export function maskPiiDeep(value: unknown, key = '', depth = 0): unknown {
  const k = key.toLowerCase();
  if (typeof value === 'string') {
    if (HIDE_KEYS.has(k)) return value ? `[скрыто: ${value.length} симв.]` : value;
    if (MASK_KEYS.has(k)) return maskValue(value);
    return maskPii(value);
  }
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (HIDE_KEYS.has(k) && k !== 'body') return '[скрыто]';
  if (Array.isArray(value)) return value.map((x) => maskPiiDeep(x, key, depth + 1));
  if (value instanceof Error) {
    return {
      type: value.name,
      message: maskPii(value.message),
      stack: value.stack ? maskPii(value.stack) : undefined,
    };
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [kk, vv] of Object.entries(value as Record<string, unknown>))
    out[kk] = maskPiiDeep(vv, kk, depth + 1);
  return out;
}
