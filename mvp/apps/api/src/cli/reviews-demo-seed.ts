import { newId } from '@cc/contracts';
import type { PoolClient } from 'pg';

/** GUID демо-АЗС AZS-1 … AZS-7 — как в выгрузке АСУ мока (mock-selfservice, `demoGuid`). */
export const demoObjectGuid = (n: number) => `DE${'0'.repeat(26)}${String(n).padStart(4, '0')}`;

/**
 * Демо Ф13 (01, разд. 5, сценарий 10): канал «Отзывы с карт» (ответы — в мок Rocket Data в mock-selfservice), очередь
 * «Отзывы» с операторами демо-стенда, GUID демо-АЗС (как в выгрузке АСУ мока), источник справочника объектов — мок
 * выгрузки АСУ НПО ЭК (ежедневная синхронизация выключена — запуск вручную на странице «Синхронизация объектов»).
 * Отзывы Rocket Data присылает сама — на демо-стенде их отправляет `ops/demo.sh review` или e2e.
 * Канал создаётся один раз; GUID объектов, адрес ответов и источник объектов прежнего демо (контракт-заглушка)
 * обновляются при каждом запуске (идемпотентно).
 */
export async function seedReviewsDemo(
  tx: PoolClient,
  o: { mockUrl: string; secretsKey?: string },
): Promise<boolean> {
  const base = o.mockUrl.replace(/\/$/, '');
  const answerUrl = `${base}/rocketdata/demo/answer`;
  const syncSettings = {
    enabled: false,
    url: `${base}/objects/asu`,
    format: 'asu',
    token: null,
    time: '03:00',
    maxDeactivateShare: 0.3,
    // Демо-предприятия: выгрузка «10» — E1 (по умолчанию), «20» — E2, «30» — E3.
    enterpriseCode: 'E1',
    enterpriseMap: { '20': 'E2', '30': 'E3' },
  };
  await tx.query(
    `UPDATE service_object SET external_ids = external_ids || jsonb_build_object('objguid',
            'DE' || repeat('0', 26) || lpad(substring(code from 5), 4, '0'))
      WHERE code ~ '^AZS-[0-9]$' AND NOT external_ids ? 'objguid'`,
  );
  // Прежнее демо (опрос по контракту-заглушке): адрес ответов и источник объектов — по описаниям заказчика.
  await tx.query(
    `UPDATE channel SET config = config || jsonb_build_object('answer_url', $1::text), updated_at = now()
      WHERE kind = 'review' AND config ->> 'api_url' LIKE $2 AND NOT config ? 'answer_url'`,
    [answerUrl, `${base}/rocketdata/%`],
  );
  await tx.query(
    `UPDATE system_setting SET value = $1, updated_at = now() WHERE key = 'objects.sync' AND value ->> 'url' = $2`,
    [JSON.stringify(syncSettings), `${base}/objects/feed.json`],
  );

  const exists = await tx.query(`SELECT 1 FROM channel WHERE kind = 'review' LIMIT 1`);
  if (exists.rowCount) return false;

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
    JSON.stringify({ answer_url: answerUrl, low_rating_max: 2 }),
  ]);
  await tx.query(
    `INSERT INTO system_setting (key, value) VALUES ('objects.sync', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(syncSettings)],
  );
  return true;
}
