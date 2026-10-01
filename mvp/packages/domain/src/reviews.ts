import {
  type InboundMessage,
  normalizeGuid,
  OBJECT_GUID_KEY,
  ROCKETDATA_OBJECT_KEY,
  type ReviewMeta,
  ReviewMetaSchema,
} from '@cc/contracts';
import type { PoolClient } from 'pg';

/**
 * Отзывы с карт (Ф13, M-CH-10): отзыв из Rocket Data — обращение канала «Отзыв». Клиент обращения — автор
 * отзыва (идентификатор — id отзыва: у площадок нет устойчивого идентификатора автора), поэтому у каждого отзыва
 * своё обращение; изменённый автором отзыв — новое сообщение в том же открытом обращении (или новое обращение,
 * если прежнее закрыто). АЗС отзыва сопоставляется объекту справочника (M-ORG-06) → предприятие.
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
 * Объект справочника АЗС отзыва: по GUID объекта (`StationGuid` = `external_ids.objguid`, сравнение без дефисов и
 * регистра), иначе по прежнему идентификатору точки `external_ids.rocketdata` или по коду объекта. Деактивированный
 * объект тоже подходит (отзывы о закрытой АЗС приходят).
 */
export async function reviewObject(
  tx: PoolClient,
  r: Pick<ReviewMeta, 'locationId' | 'locationCode'>,
): Promise<{ id: string; enterprise_id: string; name: string } | null> {
  if (!r.locationId) return null;
  const { rows } = await tx.query<{ id: string; enterprise_id: string; name: string }>(
    `SELECT id, enterprise_id, name FROM service_object
      WHERE upper(replace(external_ids ->> '${OBJECT_GUID_KEY}', '-', '')) = $1
         OR external_ids ->> '${ROCKETDATA_OBJECT_KEY}' = $2
         OR code IN ($1, $2)
      ORDER BY (upper(replace(external_ids ->> '${OBJECT_GUID_KEY}', '-', '')) IS NOT DISTINCT FROM $1) DESC,
               is_active DESC
      LIMIT 1`,
    [normalizeGuid(r.locationId), r.locationId],
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
  const station = [r.stationType, r.locationCode && `№${r.locationCode}`].filter(Boolean).join(' ');
  const where = [station, r.emitent, r.locationId && `GUID ${r.locationId}`].filter(Boolean).join(', ');
  return where
    ? `АЗС из отзыва (${where}) не найдена в справочнике объектов — укажите предприятие и объект вручную.`
    : 'У отзыва не указана АЗС — укажите предприятие и объект вручную.';
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
    stationType: r.stationType ?? null,
    emitent: r.emitent ?? null,
  };
}
