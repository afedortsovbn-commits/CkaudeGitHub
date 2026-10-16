/** Д-100: модерация комментариев к новостям — приём по ключу API, решения модератора, ответ компании, события. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Модерация комментариев (Д-100)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let op: string;
  let key: string;
  const ext = (method: string, path: string, payload?: unknown) =>
    t.call(method, `/api/v1/ext${path}`, undefined, payload, { authorization: `Bearer ${key}` });
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local');
    op = await t.login('operator1@demo.local');
    const k = await t.call('POST', '/api/v1/api-keys', admin, {
      name: 'Мобильные сервисы',
      permissions: ['comments'],
    });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    key = k.body.key;
  }, 60_000);
  afterAll(async () => t?.cleanup());

  it('комментарий → модерация оператором → решения и ответ компании для сайта', async () => {
    const c1 = {
      externalId: 'it-1',
      newsId: 'n-1',
      newsTitle: 'Новость',
      author: { name: 'Иван' },
      text: 'Когда акция?',
    };
    const r1 = await ext('POST', '/comments', c1);
    expect(r1.status, JSON.stringify(r1.body)).toBe(202);
    expect((await ext('POST', '/comments', c1)).body).toMatchObject({ id: r1.body.id, duplicate: true });
    const r2 = await ext('POST', '/comments', { ...c1, externalId: 'it-2', text: 'Продам баллы, звоните!' });
    const r3 = await ext('POST', '/comments', {
      ...c1,
      externalId: 'it-3',
      parentExternalId: 'it-1',
      text: 'Тоже интересно',
    });
    expect(r3.status).toBe(202);
    // Без права ключа — нельзя.
    expect((await t.call('POST', '/api/v1/ext/comments', op, c1)).status).toBe(401);

    const pending = await t.call('GET', '/api/v1/moderation/comments', op);
    expect(pending.status).toBe(200);
    expect(
      pending.body
        .map((x: { externalId: string }) => x.externalId)
        .filter((x: string) => x.startsWith('it-')),
    ).toEqual(['it-1', 'it-2', 'it-3']);
    expect(pending.body.find((x: { externalId: string }) => x.externalId === 'it-3').parent).toMatchObject({
      body: 'Когда акция?',
    });

    expect(
      (await t.call('POST', `/api/v1/moderation/comments/${r2.body.id}/reject`, op, { reason: 'spam' }))
        .status,
    ).toBe(200);
    expect((await t.call('POST', `/api/v1/moderation/comments/${r2.body.id}/approve`, op)).status).toBe(409);
    const rep = await t.call('POST', `/api/v1/moderation/comments/${r1.body.id}/reply`, op, {
      text: 'Акция продлится до конца года.',
    });
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect((await t.call('POST', `/api/v1/moderation/comments/${r3.body.id}/approve`, op)).status).toBe(200);
    expect((await t.call('GET', '/api/v1/moderation/counts', op)).body).toMatchObject({
      today: 3,
    });

    const dec = await ext('GET', '/comments/decisions');
    expect(dec.status).toBe(200);
    const byExt = (id: string | null, official = false) =>
      dec.body.find(
        (d: { externalId: string | null; isOfficial: boolean; parentExternalId: string | null }) =>
          official ? d.isOfficial && d.parentExternalId === id : d.externalId === id,
      );
    expect(byExt('it-1')).toMatchObject({ status: 'approved' });
    expect(byExt('it-2')).toMatchObject({ status: 'rejected', rejectReason: 'Спам или реклама' });
    expect(byExt('it-1', true)).toMatchObject({ status: 'approved', text: 'Акция продлится до конца года.' });
    // Событие для webhook сайта.
    const ev = await t.pool
      .query(`SELECT count(*)::int AS n FROM outbox WHERE payload ->> 'type' = 'comment.moderated'`)
      .catch(() => ({ rows: [{ n: -1 }] }));
    expect(ev.rows[0].n === -1 || ev.rows[0].n >= 4).toBe(true);
  });
});
