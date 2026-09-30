import { type InboundMessage, ROCKETDATA_OBJECT_KEY, type ReviewMeta, ReviewMetaSchema } from '@cc/contracts';
import type { PoolClient } from 'pg';

/**
 * Отзывы с карт (Ф13, M-CH-10): отзыв из Rocket Data — обращение канала «Отзыв». Клиент обращения — автор
 * отзыва (идентификатор — id отзыва: у площадок нет устойчивого идентификатора автора), поэтому у каждого отзыва
 * своё обращение; изменённый автором отзыв — новое сообщение в том же открытом обращении (или новое обращение,
 * если прежнее закрыто). Точка Rocket Data сопоставляется объекту справочника (M-ORG-06) → предприятие.
 */

/** Сведения об отзыве из входящего сообщения канала «Отзыв»; null — не отзыв или некорректные данные. */
export function reviewOf(m: InboundMessage): ReviewMeta | null {
  if (m.channelKind !== 'review') return null;
  const r = ReviewMetaSchema.safeParse(m.meta?.review);
  return r.success ? r.data : null;
}

/** Есть ли в системе обращение по этому отзыву (любое, в т.ч. закрытое). */
export async function reviewKnown(tx: PoolClient, channelId: string, reviewId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM conversation WHERE channel_kind = 'review' AND channel_id = $1
        AND channel_meta #>> '{review,id}' = $2 LIMIT 1`,
    [channelId, reviewId],
  );
  return rows.length > 0;
}

/**
 * Объект справочника точки Rocket Data: по внешнему идентификатору `external_ids.rocketdata`, иначе по коду
 * объекта (= код точки в Rocket Data). Деактивированный объект тоже подходит (отзывы о закрытой точке приходят).
 */
export async function reviewObject(
  tx: PoolClient,
  r: Pick<ReviewMeta, 'locationId' | 'locationCode'>,
): Promise<{ id: string; enterprise_id: string; name: string } | null> {
  if (!r.locationId && !r.locationCode) return null;
  const { rows } = await tx.query<{ id: string; enterprise_id: string; name: string }>(
    `SELECT id, enterprise_id, name FROM service_object
      WHERE ($1::text IS NOT NULL AND external_ids ->> '${ROCKETDATA_OBJECT_KEY}' = $1)
         OR ($2::text IS NOT NULL AND code = $2)
      ORDER BY (external_ids ->> '${ROCKETDATA_OBJECT_KEY}' IS NOT DISTINCT FROM $1) DESC, is_active DESC
      LIMIT 1`,
    [r.locationId, r.locationCode],
  );
  return rows[0] ?? null;
}

/**
 * Новое обращение по отзыву: сведения об отзыве, объект и предприятие, срочность низкой оценки. Возвращает текст
 * служебного сообщения оператору, если точку не удалось сопоставить объекту.
 */
export async function attachReview(
  tx: PoolClient,
  conversationId: string,
  r: ReviewMeta,
): Promise<string | null> {
  const obj = await reviewObject(tx, r);
  await tx.query(
    `UPDATE conversation SET channel_meta = channel_meta || jsonb_build_object('review', $2::jsonb),
        object_id = COALESCE($3::uuid, object_id), enterprise_id = COALESCE($4::uuid, enterprise_id),
        is_urgent = is_urgent OR $5
      WHERE id = $1`,
    [conversationId, JSON.stringify(stored(r)), obj?.id ?? null, obj?.enterprise_id ?? null, r.urgent],
  );
  if (obj) return null;
  const where = [r.locationCode && `код «${r.locationCode}»`, r.locationId && `id «${r.locationId}»`]
    .filter(Boolean)
    .join(', ');
  return where
    ? `Точка Rocket Data (${where}) не найдена в справочнике объектов — укажите предприятие и объект вручную.`
    : 'У отзыва не указана точка — укажите предприятие и объект вручную.';
}

/** Отзыв изменён автором: в открытом обращении — актуальные оценка и текст. */
export async function refreshReview(tx: PoolClient, conversationId: string, r: ReviewMeta): Promise<void> {
  await tx.query(
    `UPDATE conversation SET channel_meta = channel_meta || jsonb_build_object('review', $2::jsonb) WHERE id = $1`,
    [conversationId, JSON.stringify(stored(r))],
  );
}

/** В обращении хранится только то, что нужно карточке, ответу и отчёту (служебные флаги разбора — нет). */
function stored(r: ReviewMeta) {
  return {
    id: r.id,
    platform: r.platform,
    rating: r.rating,
    author: r.author,
    url: r.url,
    publishedAt: r.publishedAt,
    locationId: r.locationId,
    locationCode: r.locationCode,
  };
}
