import { newId } from '@cc/contracts';
import type { PoolClient } from 'pg';
import { hashKey } from '../ext/api-key';

/** Тема «Акция по газу» — миграция 0035 (фиксированный id). */
export const GAS_TOPIC_ID = '0f0a5000-0000-4000-8000-000000000001';
/** Ключ демо-стенда для личного кабинета сайта (заявления на скидку по газу); на рабочем стенде не создаётся. */
export const DEMO_GAS_KEY = 'cck_demo_gas_key_change_me_0123456789abcdef';

/**
 * Демо Д-019: канал «Внешняя система (API)» для заявлений на скидку по газу с темой по умолчанию «Акция по газу»,
 * ключ API с правом «Внешний канал» и срок ответа 2 рабочих дня (Д-020, `routing.policy.dueByChannel`).
 * Идемпотентно: канал с этой темой уже есть — пропуск.
 */
export async function seedGasDemo(tx: PoolClient, o: { key?: string } = {}): Promise<boolean> {
  const exists = await tx.query(`SELECT 1 FROM channel WHERE kind = 'api' AND config ->> 'topic_id' = $1`, [
    GAS_TOPIC_ID,
  ]);
  if (exists.rowCount) return false;
  const topic = await tx.query(`SELECT 1 FROM topic WHERE id = $1`, [GAS_TOPIC_ID]);
  if (!topic.rowCount) return false;
  const q = await tx.query<{ id: string }>(`SELECT id FROM queue WHERE name = 'Общая' LIMIT 1`);
  const queue = q.rows[0]?.id;
  if (!queue) return false;
  const channel = newId();
  await tx.query(`INSERT INTO channel (id, kind, name, queue_id, config) VALUES ($1, 'api', $2, $3, $4)`, [
    channel,
    'Акция по газу (личный кабинет сайта)',
    queue,
    JSON.stringify({ topic_id: GAS_TOPIC_ID }),
  ]);
  const key = o.key ?? DEMO_GAS_KEY;
  await tx.query(
    `INSERT INTO api_key (id, name, prefix, key_hash, permissions, channel_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      newId(),
      'Демо: заявления на скидку по газу',
      key.slice(0, 12),
      hashKey(key),
      ['inbound', 'conversations.read'],
      channel,
    ],
  );
  // Срок ответа по каналу — 2 рабочих дня (настраивается в «Настройках» и у супервизора).
  await tx.query(
    `INSERT INTO system_setting (key, value) VALUES ('routing.policy', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = jsonb_set(
       COALESCE(system_setting.value, '{}'::jsonb) || jsonb_build_object('dueByChannel', COALESCE(system_setting.value -> 'dueByChannel', '{}'::jsonb)),
       ARRAY['dueByChannel', $2], '{"businessDays": 2}'::jsonb, true), updated_at = now()`,
    [JSON.stringify({ dueByChannel: { [channel]: { businessDays: 2 } } }), channel],
  );
  return true;
}
