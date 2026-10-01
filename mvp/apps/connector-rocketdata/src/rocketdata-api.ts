import { PermanentError } from '@cc/connector-kit';
import { z } from 'zod';

/**
 * Обмен с Rocket Data — адаптер по описанию заказчика (01.10, «Требования по интеграции с программным обеспечением
 * контакт-центра», В-32; `mvp/docs/интеграции-rocketdata-и-объекты.md`). Остальной коннектор работает с `RdReview`;
 * при изменении формата меняется только этот файл.
 *
 *   Отзыв:  Rocket Data → POST <адрес КЦ>/rd/<id канала>, JSON (TicketMapId, DateReceipt, StationGuid, StationType,
 *           StationNum, EmitentName, ClientName, Message, Link, Site) → HTTP 200 (принят) или 400 (ошибка формата).
 *   Ответ:  КЦ → POST <адрес сервиса ответов> JSON {Review_id, DateAnswer, Text} → HTTP 200.
 *
 * Время в описании — без часового пояса («2016-11-23T10:08:05»): это время Europe/Minsk (UTC+3, без перехода).
 */

const MINSK_OFFSET = '+03:00';

/** Строковое поле: число допускается (TicketMapId описан как «Число», в примере — строка). */
const text = (max: number) =>
  z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().trim().max(max));
const required = (max: number) => text(max).pipe(z.string().min(1, 'значение обязательно'));

/**
 * Отзыв. Ограничения длины из таблицы 1 описания соблюдает отправитель; приём — с запасом, чтобы отзыв не
 * терялся из-за длинной ссылки или текста (длиннее запаса — ошибка формата).
 */
const RdReviewSchema = z.object({
  TicketMapId: required(64),
  DateReceipt: required(40),
  StationGuid: required(64),
  StationType: required(64),
  StationNum: required(200),
  EmitentName: required(300),
  ClientName: text(300).nullish(),
  Message: required(20_000),
  Link: required(4000),
  Site: required(200),
  /** Оценки в описании нет; если Rocket Data начнёт её передавать — используется (срочность низкой оценки). */
  Rating: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.coerce.number().int().min(1).max(5).optional(),
  ),
});
export type RdReview = z.infer<typeof RdReviewSchema> & { receivedAt: string };

/** Поле «как в описании» по имени в любом регистре (в примере описания — и `Site`, и `SITE`). */
function canonical(raw: Record<string, unknown>): Record<string, unknown> {
  const keys = new Map(Object.keys(RdReviewSchema.shape).map((k) => [k.toLowerCase(), k]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[keys.get(k.trim().toLowerCase()) ?? k] = v;
  return out;
}

/**
 * Разбор JSON. Пример в описании — не строгий JSON («типографские» кавычки, пропущенные запятые между строками):
 * если строгий разбор не удался, пробуем исправить именно эти ошибки.
 */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (first) {
    const fixed = body
      .replace(/^\uFEFF/, '')
      .replace(/[“”]/g, '"')
      .replace(/"\s*\n(\s*")/g, '",\n$1');
    try {
      return JSON.parse(fixed);
    } catch {
      throw first;
    }
  }
}

/** «2016-11-23T10:08:05» (Минск), ISO с поясом или «23.11.2016 10:08[:05]» → ISO 8601 UTC; null — не дата. */
export function parseRdDate(v: string): string | null {
  const s = v.trim();
  let iso = s;
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (ru) iso = `${ru[3]}-${ru[2]}-${ru[1]}T${ru[4]}:${ru[5]}:${ru[6] ?? '00'}`;
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(iso))
    iso = `${iso.replace(' ', 'T')}${iso.length === 10 ? 'T00:00:00' : ''}${MINSK_OFFSET}`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export class RdFormatError extends Error {
  constructor(
    message: string,
    readonly details: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

/** Тело запроса Rocket Data → отзыв; ошибка формата — RdFormatError (ответ 400 с перечнем полей). */
export function parseRdReview(body: string, now = new Date()): RdReview {
  let data: unknown;
  try {
    data = parseJson(body);
  } catch {
    throw new RdFormatError('тело запроса — не JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new RdFormatError('ожидается один отзыв — объект JSON');
  const r = RdReviewSchema.safeParse(canonical(data as Record<string, unknown>));
  if (!r.success)
    throw new RdFormatError(
      'ошибка в данных отзыва',
      r.error.issues.map((i) => ({ field: i.path.join('.') || 'отзыв', message: i.message })),
    );
  if (!parseRdDate(r.data.DateReceipt))
    throw new RdFormatError('ошибка в данных отзыва', [
      { field: 'DateReceipt', message: 'ожидается дата, например 2016-11-23T10:08:05' },
    ]);
  return { ...r.data, receivedAt: now.toISOString() };
}

/** Время для Rocket Data — как в описании: «ГГГГ-ММ-ДДTчч:мм:сс» по Минску. */
export function rdDate(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Minsk',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export class RocketDataError extends Error {}

/** 4xx (кроме 408/429) — повтор не поможет: отзыв удалён, ответ запрещён, неверные данные. */
const permanent = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * Ответ на отзыв: POST {Review_id, DateAnswer, Text} на адрес сервиса ответов. Успех — любой 2xx. Повтор
 * исключает отметка «отправлено» коннектора; заголовок Idempotency-Key передаётся дополнительно (не мешает).
 */
export async function sendRdAnswer(
  url: string,
  a: { reviewId: string; text: string; at: Date; idempotencyKey: string },
  timeoutMs = 20_000,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
      'idempotency-key': a.idempotencyKey,
    },
    body: JSON.stringify({ Review_id: a.reviewId, DateAnswer: rdDate(a.at), Text: a.text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text().catch(() => '');
  if (res.ok) return;
  let detail = body.slice(0, 200);
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    detail = String(j.message ?? j.error ?? detail);
  } catch {
    /* не JSON — как есть */
  }
  const msg = `Rocket Data: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
  throw permanent(res.status) ? new PermanentError(msg) : new RocketDataError(msg);
}
