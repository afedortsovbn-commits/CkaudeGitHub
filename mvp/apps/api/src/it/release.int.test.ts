/** Интеграционные тесты выпуска релиза Ф11: фиче-флаги, журнал выпусков, app.version, вывод coturn из ICE. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseOps } from '../cli/release-ops';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Выпуск релиза Ф11 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let op: string;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local');
    op = await t.login('operator1@demo.local');
  }, 60_000);
  afterAll(async () => t?.cleanup());

  it('фиче-флаги: по умолчанию, включение релизом, изменение администратором с аудитом', async () => {
    let f = await t.call('GET', '/api/v1/features', op);
    expect(f.status).toBe(200);
    expect(f.body['web.auto_reload']).toBe(true);
    expect(await releaseOps(t.pool, ['flags', 'enable', 'demo.new_feature'])).toMatchObject({
      enabled: true,
    });
    f = await t.call('GET', '/api/v1/features', op);
    expect(f.body['demo.new_feature']).toBe(true);
    // Оператору управление флагами недоступно.
    expect(
      (await t.call('PATCH', '/api/v1/admin/feature-flags/web.auto_reload', op, { enabled: false })).status,
    ).toBe(403);
    const r = await t.call('PATCH', '/api/v1/admin/feature-flags/web.auto_reload', admin, { enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: 'web.auto_reload', enabled: false });
    expect((await t.call('GET', '/api/v1/features', op)).body['web.auto_reload']).toBe(false);
    expect((await t.call('PATCH', '/api/v1/admin/feature-flags/nope', admin, { enabled: true })).status).toBe(
      404,
    );
    const { rows } = await t.pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE payload->>'type' = 'config.changed'
         AND payload->'data'->>'entity' = 'feature_flag'`,
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('журнал выпусков и событие app.version', async () => {
    const { id } = (await releaseOps(t.pool, ['release-start', 'v2', 'v1'])) as { id: string };
    await releaseOps(t.pool, ['announce-version', 'v2']);
    await releaseOps(t.pool, ['release-finish', id, 'succeeded', JSON.stringify({ steps: ['api'] })]);
    const list = await t.call('GET', '/api/v1/admin/releases', admin);
    expect(list.body[0]).toMatchObject({
      id,
      tag: 'v2',
      prevTag: 'v1',
      status: 'succeeded',
      report: { steps: ['api'] },
    });
    const ev = await t.pool.query(
      `SELECT data FROM event WHERE type = 'app.version' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(ev.rows[0].data).toEqual({ component: 'web', version: 'v2' });
    await expect(releaseOps(t.pool, ['release-finish', id, 'bad'])).rejects.toThrow(/итог/);
  });

  it('coturn выводится из выдачи ICE и возвращается', async () => {
    const prev = t.ctx.config.TURN_URLS;
    t.ctx.config.TURN_URLS = 'turn:turn.test:3478,turn:turn.test:3479';
    try {
      expect(await releaseOps(t.pool, ['turn', 'disable', 'coturn-1'])).toEqual({ disabled: ['coturn-1'] });
      let r = await t.call('GET', '/api/v1/telephony/ice', op);
      expect(r.body.iceServers[1].urls).toEqual(['turn:turn.test:3479']);
      expect(await releaseOps(t.pool, ['turn', 'enable', 'coturn-1'])).toEqual({ disabled: [] });
      r = await t.call('GET', '/api/v1/telephony/ice', op);
      expect(r.body.iceServers[1].urls).toHaveLength(2);
    } finally {
      t.ctx.config.TURN_URLS = prev;
    }
  });
});
