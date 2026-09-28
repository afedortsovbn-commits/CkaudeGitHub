/* eslint-disable no-console */
/**
 * Одноразовая задача перед запуском сервисов (compose: сервис migrate):
 *  1) миграции БД;
 *  2) первый администратор, если в системе нет ни одного (BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD);
 *  3) демо-данные при SEED_DEMO=true.
 */
import { newId } from '@cc/contracts';
import { createPool, migrate } from '@cc/db';
import { hashPassword } from '../auth/passwords';
import { withTx } from '../lib/db';
import { seedDemo } from './demo-seed';

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', service: 'bootstrap', msg, ...extra }));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан');
  const pool = createPool(url, { max: 2 });
  try {
    const r = await migrate(pool, { log });
    log('миграции выполнены', { applied: r.applied });

    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    await withTx(pool, async (tx) => {
      const admins = await tx.query(`SELECT 1 FROM user_role WHERE role_code = 'admin' LIMIT 1`);
      if (admins.rowCount) return;
      if (!email || !password) {
        log('администраторов нет, BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD не заданы — пропуск');
        return;
      }
      if (password.length < 8) throw new Error('BOOTSTRAP_ADMIN_PASSWORD должен быть не короче 8 символов');
      const id = newId();
      await tx.query(
        `INSERT INTO app_user (id, full_name, email, password_hash) VALUES ($1, 'Администратор', $2, $3)`,
        [id, email, await hashPassword(password)],
      );
      await tx.query(`INSERT INTO user_role (user_id, role_code) VALUES ($1, 'admin')`, [id]);
      await tx.query('INSERT INTO access_scope (id, user_id) VALUES ($1, $2)', [newId(), id]);
      log('создан первый администратор', { email });
    });

    if (process.env.SEED_DEMO === 'true') {
      const demoPassword = process.env.DEMO_PASSWORD ?? 'Demo12345!';
      const created = await withTx(pool, (tx) => seedDemo(tx, demoPassword));
      log(created ? 'демо-данные загружены' : 'демо-данные уже есть — пропуск');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'bootstrap',
      msg: 'ошибка начальной настройки',
      err: String(e),
    }),
  );
  process.exit(1);
});
