import { newId } from '@cc/contracts';
import { sealSecret } from '@cc/service-kit';
import type { PoolClient } from 'pg';

/** Токены демо-стенда — известны моку (mock-selfservice: ROCKETDATA_TOKEN, OBJECTS_TOKEN). */
export const REVIEWS_DEMO_DEFAULTS = {
  rocketdataToken: 'demo-rocketdata-token',
  objectsToken: 'demo-objects-token',
};

/**
 * Демо Ф13 (01, разд. 5, сценарий 10): канал «Отзывы с карт» к моку Rocket Data (mock-selfservice), очередь
 * «Отзывы» с операторами демо-стенда, идентификаторы точек Rocket Data у демо-объектов, источник справочника
 * объектов (мок; ежедневная синхронизация выключена — запуск вручную на странице «Синхронизация объектов»).
 * Отзывы в моке появляются по команде (`ops/demo.sh up` или e2e) — пустой мок не влияет на другие проверки.
 * Идемпотентно: канал «Отзыв» уже есть — пропуск.
 */
export async function seedReviewsDemo(
  tx: PoolClient,
  o: { mockUrl: string; secretsKey?: string },
): Promise<boolean> {
  const exists = await tx.query(`SELECT 1 FROM channel WHERE kind = 'review' LIMIT 1`);
  if (exists.rowCount) return false;
  const seal = (s: string) => (o.secretsKey ? sealSecret(s, o.secretsKey) : s);
  const base = o.mockUrl.replace(/\/$/, '');

  const q = await tx.query<{ id: string }>(
    `INSERT INTO queue (id, name, channels, priority) VALUES ($1, 'Отзывы', ARRAY['review'], 0)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [newId()],
  );
  const queueId = q.rows[0]!.id;
  const ops = await tx.query<{ id: string }>(
    `SELECT id FROM app_user WHERE email IN ('operator1@demo.local', 'operator2@demo.local', 'operator3@demo.local')`,
  );
  for (const op of ops.rows)
    await tx.query(`INSERT INTO user_queue (user_id, queue_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      op.id,
      queueId,
    ]);
  await tx.query(`INSERT INTO channel (id, kind, name, queue_id, config) VALUES ($1, 'review', $2, $3, $4)`, [
    newId(),
    'Отзывы с карт (Rocket Data, демо)',
    queueId,
    JSON.stringify({
      api_url: `${base}/rocketdata/demo`,
      api_token: seal(REVIEWS_DEMO_DEFAULTS.rocketdataToken),
      poll_interval_s: 10,
      initial_days: 30,
      low_rating_max: 2,
      skip_answered: true,
    }),
  ]);
  // Точки Rocket Data демо-объектов (как в выгрузке мока): rd-azs-1 … rd-azs-6, rd-ev-1.
  await tx.query(
    `UPDATE service_object SET external_ids = external_ids || jsonb_build_object('rocketdata', 'rd-' || lower(code))
      WHERE code ~ '^(AZS|EV)-[0-9]+$' AND NOT external_ids ? 'rocketdata'`,
  );
  await tx.query(
    `INSERT INTO system_setting (key, value) VALUES ('objects.sync', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [
      JSON.stringify({
        enabled: false,
        url: `${base}/objects/feed.json`,
        format: 'json',
        token: seal(REVIEWS_DEMO_DEFAULTS.objectsToken),
        time: '03:00',
        maxDeactivateShare: 0.3,
      }),
    ],
  );
  return true;
}
