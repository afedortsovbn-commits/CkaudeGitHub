/**
 * Д-085: раздел роли «только на чтение» (`<право>:read`) — просмотр (GET) разрешён, изменения — нет; полное право
 * перекрывает «только чтение»; неизвестное право «на чтение» роль не принимает.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Д-085: права «только чтение»', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local');
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it('роль с базой знаний на чтение: статьи видны, создать статью нельзя', async () => {
    const r = await t.call('POST', '/api/v1/roles', admin, {
      code: 'kb_reader',
      name: 'Читатель базы знаний',
      permissions: ['kb.manage:read'],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.permissions).toEqual(['kb.manage:read']);
    await t.pool.query(
      `DELETE FROM user_role WHERE user_id = (SELECT id FROM app_user WHERE email = 'curator1@demo.local')`,
    );
    await t.pool.query(
      `INSERT INTO user_role (user_id, role_code)
       SELECT id, 'kb_reader' FROM app_user WHERE email = 'curator1@demo.local'`,
    );
    t.ctx.principals.invalidate();
    const tok = await t.login('curator1@demo.local');

    expect((await t.call('GET', '/api/v1/kb/articles', tok)).status).toBe(200);
    const create = await t.call('POST', '/api/v1/kb/articles', tok, { title: 'Новая', body: 'Текст' });
    expect(create.status).toBe(403);
    expect(JSON.stringify(create.body)).toContain('только для чтения');
    // Раздел без права вовсе — отказ и на просмотр.
    expect((await t.call('GET', '/api/v1/roles', tok)).status).toBe(403);
  });

  it('полное право перекрывает «только чтение»; чтение для раздела без такого режима не принимается', async () => {
    const r = await t.call('POST', '/api/v1/roles', admin, {
      name: 'Полный и чтение',
      permissions: ['kb.manage', 'kb.manage:read'],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.permissions).toEqual(['kb.manage']);
    const bad = await t.call('POST', '/api/v1/roles', admin, {
      name: 'Неверное право',
      permissions: ['reports.view:read'],
    });
    expect(bad.status).toBe(400);
  });
});
