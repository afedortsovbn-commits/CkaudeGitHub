import { newId } from '@cc/contracts';
import { createPool, migrate } from '@cc/db';
import { Pool } from 'pg';

export const ADMIN_URL = process.env.TEST_DATABASE_URL;

/** Изолированная временная БД с прогнанными миграциями — для интеграционных тестов router (Ф3). */
export async function createTestDb() {
  const dbName = `cc_it_router_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: ADMIN_URL });
  admin.on('error', () => undefined);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${dbName}`;
  const pool = createPool(url.toString());
  // Без обработчика 'error' Node аварийно завершает процесс на ошибке простаивающего соединения —
  // это происходит в cleanup(), когда DROP DATABASE ... WITH (FORCE) обрывает ещё закрывающиеся сокеты.
  pool.on('error', () => undefined);
  await migrate(pool);

  async function queue(over: Partial<Record<string, unknown>> = {}): Promise<string> {
    const id = newId();
    await pool.query(
      `INSERT INTO queue (id, name, channels, priority, strategy, overflow_queue_id, overflow_after_s,
          offer_timeout_s, wrap_up_s, max_wait_s)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        (over.name as string) ?? `Q-${id.slice(0, 8)}`,
        (over.channels as string[]) ?? ['webchat'],
        (over.priority as number) ?? 0,
        (over.strategy as string) ?? 'least_recent',
        (over.overflowQueueId as string) ?? null,
        (over.overflowAfterS as number) ?? null,
        (over.offerTimeoutS as number) ?? 20,
        (over.wrapUpS as number) ?? 15,
        (over.maxWaitS as number) ?? null,
      ],
    );
    return id;
  }

  async function operator(queueId: string, status: 'ready' | 'offline' = 'ready'): Promise<string> {
    const id = newId();
    await pool.query(
      `INSERT INTO app_user (id, full_name, email, can_login, is_active) VALUES ($1, $2, $3, true, true)`,
      [id, `Оператор ${id.slice(0, 8)}`, `${id}@test.local`],
    );
    await pool.query(`INSERT INTO user_role (user_id, role_code) VALUES ($1, 'operator')`, [id]);
    await pool.query(`INSERT INTO user_queue (user_id, queue_id) VALUES ($1, $2)`, [id, queueId]);
    await pool.query(
      `INSERT INTO agent_status (user_id, status, since, updated_at) VALUES ($1, $2, now(), now())`,
      [id, status],
    );
    return id;
  }

  async function channel(queueId: string): Promise<string> {
    const id = newId();
    await pool.query(`INSERT INTO channel (id, kind, name, queue_id) VALUES ($1, 'webchat', 'тест', $2)`, [
      id,
      queueId,
    ]);
    return id;
  }

  async function contact(): Promise<string> {
    const id = newId();
    await pool.query(`INSERT INTO contact (id, display_name) VALUES ($1, 'Клиент')`, [id]);
    return id;
  }

  async function queuedConversation(
    queueId: string,
    channelId: string,
    contactId: string,
    over: Partial<Record<string, unknown>> = {},
  ): Promise<string> {
    const id = newId();
    await pool.query(
      `INSERT INTO conversation (id, channel_id, channel_kind, contact_id, status, queue_id, priority, queued_at)
       VALUES ($1, $2, 'webchat', $3, 'queued', $4, $5, now() - ($6 || ' seconds')::interval)`,
      [id, channelId, contactId, queueId, (over.priority as number) ?? 0, (over.ageS as number) ?? 0],
    );
    return id;
  }

  async function cleanup() {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  return { pool, url: url.toString(), queue, operator, channel, contact, queuedConversation, cleanup };
}
