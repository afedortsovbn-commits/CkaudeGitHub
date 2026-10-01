import { PermanentError } from '@cc/connector-kit';
import { z } from 'zod';

/**
 * Клиент API Rocket Data — адаптер по контракту-заглушке (описание API от заказчика не получено, В-32):
 * `mvp/docs/интеграции-rocketdata-и-объекты.md`. При получении описания меняется только этот файл (запросы и разбор
 * ответа) — остальной коннектор работает с `RdReview` и `RdAnswerResult`.
 *
 *   GET  {api_url}/v1/reviews?updated_since=<ISO>&cursor=<…>&limit=100   → {items: RdReview[], next_cursor}
 *   POST {api_url}/v1/reviews/{id}/answer   {text}   Idempotency-Key: <id сообщения>  → {id, status, error?}
 *   Авторизация — заголовок Authorization: Bearer <api_token>.
 */

const RdReviewSchema = z.object({
  id: z.coerce.string().min(1).max(200),
  location_id: z.coerce.string().max(200).nullish(),
  location_code: z.coerce.string().max(200).nullish(),
  platform: z.string().max(40).default('unknown'),
  rating: z.coerce.number().int().min(1).max(5).nullish(),
  text: z.string().max(20000).nullish(),
  author_name: z.string().max(300).nullish(),
  published_at: z.string().datetime({ offset: true }).nullish(),
  updated_at: z.string().datetime({ offset: true }),
  url: z.string().max(2000).nullish(),
  /** Ответ на площадке (из системы или вне её). */
  answer: z
    .object({
      text: z.string().nullish(),
      status: z.string().nullish(),
      published_at: z.string().nullish(),
    })
    .nullish(),
});
export type RdReview = z.infer<typeof RdReviewSchema>;

const PageSchema = z.object({
  items: z.array(z.unknown()),
  next_cursor: z.string().nullish(),
});

const AnswerSchema = z.object({
  id: z.coerce.string().nullish(),
  /** published — опубликован на площадке, pending — принят и ждёт публикации (модерация), rejected — отклонён. */
  status: z.enum(['published', 'pending', 'rejected']).default('pending'),
  error: z.string().nullish(),
});
export type RdAnswerResult = z.infer<typeof AnswerSchema>;

export class RocketDataError extends Error {}

/** 4xx (кроме 408/429) — повтор не поможет: отзыв удалён, ответ запрещён площадкой, неверные данные. */
const permanent = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

export class RocketDataApi {
  private readonly base: string;

  constructor(
    apiUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 20_000,
  ) {
    this.base = apiUrl.replace(/\/+$/, '');
  }

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text) as { error?: unknown; message?: unknown };
        detail = String(j.error ?? j.message ?? detail);
      } catch {
        /* не JSON — как есть */
      }
      const msg = `Rocket Data: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
      throw permanent(res.status) ? new PermanentError(msg) : new RocketDataError(msg);
    }
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new RocketDataError('Rocket Data: ответ — не JSON');
    }
  }

  /**
   * Одна страница отзывов, созданных или изменённых начиная с `since`. Некорректные записи не останавливают
   * загрузку — возвращаются в `invalid` (пишутся в журнал канала).
   */
  async reviews(
    since: string,
    cursor: string | null,
  ): Promise<{ items: RdReview[]; invalid: string[]; nextCursor: string | null }> {
    const q = new URLSearchParams({ updated_since: since, limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const page = PageSchema.parse(await this.call('GET', `/v1/reviews?${q.toString()}`));
    const items: RdReview[] = [];
    const invalid: string[] = [];
    for (const raw of page.items) {
      const r = RdReviewSchema.safeParse(raw);
      if (r.success) items.push(r.data);
      else
        invalid.push(
          `${String((raw as { id?: unknown })?.id ?? '?')}: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`,
        );
    }
    return { items, invalid, nextCursor: page.next_cursor ?? null };
  }

  /** Ответ на отзыв; повтор с тем же ключом идемпотентности не создаёт второй ответ. */
  async answer(reviewId: string, text: string, idempotencyKey: string): Promise<RdAnswerResult> {
    const r = AnswerSchema.parse(
      await this.call(
        'POST',
        `/v1/reviews/${encodeURIComponent(reviewId)}/answer`,
        { text },
        {
          'idempotency-key': idempotencyKey,
        },
      ),
    );
    if (r.status === 'rejected')
      throw new PermanentError(`площадка отклонила ответ${r.error ? `: ${r.error}` : ''}`);
    return r;
  }
}
