/** Интеграционные тесты контроля ресурсов и чистки outbox на реальной PostgreSQL. */
import { newId } from '@cc/contracts';
import { pruneOutbox, runResourceCheck } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp, DEMO_PW } from './setup';

describe.skipIf(!ADMIN_URL)('Контроль ресурсов (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    t = await createTestApp();
  }, 60_000);
  afterAll(async () => {
    await t?.cleanup();
  });

  const GB = 1024 ** 3;
  const full = { disk: { totalBytes: 100 * GB, freeBytes: 5 * GB } };
  const fine = { disk: { totalBytes: 100 * GB, freeBytes: 60 * GB } };
  const resourceMail = async () =>
    (
      await t.pool.query<{ email: string; channel: string; subject: string; status: string }>(
        `SELECT u.email, n.channel, n.subject, n.status FROM notification n JOIN app_user u ON u.id = n.user_id
          WHERE n.kind = 'resource' ORDER BY n.created_at`,
      )
    ).rows;

  it('диск на пределе: администратору и супервизору — колокольчик и письмо; повтор не дублирует; «снова в норме»', async () => {
    const t0 = new Date();
    const r = await runResourceCheck(t.pool, full, t0);
    expect(r.samples.find((s) => s.key === 'disk')).toMatchObject({ level: 'crit', usedPct: 95 });
    const first = await resourceMail();
    const to = new Set(first.map((m) => m.email));
    expect(to).toContain('admin@test.local');
    expect(to).toContain('supervisor@demo.local');
    expect(to).not.toContain('operator1@demo.local');
    expect(first.filter((m) => m.channel === 'email').every((m) => m.status === 'pending')).toBe(true);
    expect(first.find((m) => m.channel === 'email')!.subject).toMatch(
      /^Важно! Ресурсы сервера: Место на диске/,
    );
    // через 5 минут — без новых уведомлений
    await runResourceCheck(t.pool, full, new Date(t0.getTime() + 300_000));
    expect((await resourceMail()).length).toBe(first.length);
    // место освободили — «снова в норме»
    await runResourceCheck(t.pool, fine, new Date(t0.getTime() + 600_000));
    const after = await resourceMail();
    expect(after.length).toBe(first.length * 2);
    expect(after.at(-1)!.subject).toContain('снова в норме');
  });

  it('страница «Ресурсы сервера»: последний замер — администратору и супервизору, оператору — нет', async () => {
    const admin = await t.login('admin@test.local', DEMO_PW);
    const res = await t.call('GET', '/api/v1/resources', admin);
    expect(res.status).toBe(200);
    expect(res.body.samples.map((s: { key: string }) => s.key)).toContain('disk');
    expect(res.body.thresholds).toEqual({ warnPct: 80, critPct: 90 });
    const sup = await t.login('supervisor@demo.local');
    expect((await t.call('GET', '/api/v1/resources', sup)).status).toBe(200);
    const op = await t.login('operator1@demo.local');
    expect((await t.call('GET', '/api/v1/resources', op)).status).toBe(403);
    // пороги меняются в настройках
    expect(
      (await t.call('PATCH', '/api/v1/settings', admin, { 'resource.warn_pct': 70, 'resource.crit_pct': 85 }))
        .status,
    ).toBe(200);
  });

  it('чистка outbox: удаляются только отправленные старше 30 дней', async () => {
    const ins = (published: string | null, created: string) =>
      t.pool.query(
        `INSERT INTO outbox (id, subject, payload, created_at, published_at)
         VALUES ($1, 'cc.test', '{}', now() - $2::interval, now() - $3::interval)`,
        [newId(), created, published],
      );
    await ins('40 days', '40 days');
    await ins('1 day', '1 day');
    await ins(null, '40 days');
    const before = Number((await t.pool.query('SELECT count(*) FROM outbox')).rows[0].count);
    expect(await pruneOutbox(t.pool, 30)).toBeGreaterThanOrEqual(1);
    const left = await t.pool.query(
      `SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS unpublished,
              count(*) FILTER (WHERE published_at < now() - interval '30 days')::int AS old
         FROM outbox`,
    );
    expect(left.rows[0]).toMatchObject({ old: 0 });
    expect(left.rows[0].unpublished).toBeGreaterThanOrEqual(1);
    expect(Number((await t.pool.query('SELECT count(*) FROM outbox')).rows[0].count)).toBeLessThan(before);
  });
});
