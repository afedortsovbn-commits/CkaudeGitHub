/** Д-098, Д-099: робот предложений по улучшению и кандидатов в шаблоны. */
import { newId } from '@cc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Предложения по улучшению (Д-098, Д-099)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let op: string;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local');
    op = await t.login('operator1@demo.local');
  }, 60_000);
  afterAll(async () => t?.cleanup());

  it('одинаковые ответы операторов → кандидат в шаблон → общий шаблон; статус предложения ставит человек', async () => {
    expect((await t.call('GET', '/api/v1/improvements', op)).status).toBe(403);
    const opId = (await t.pool.query(`SELECT id FROM app_user WHERE email = 'operator1@demo.local'`)).rows[0]
      .id;
    const conv = (await t.pool.query(`SELECT id FROM conversation LIMIT 1`)).rows[0]?.id as
      | string
      | undefined;
    if (conv) {
      const seq0 = Number(
        (
          await t.pool.query(`SELECT COALESCE(max(seq), 0) AS s FROM message WHERE conversation_id = $1`, [
            conv,
          ])
        ).rows[0].s,
      );
      for (let i = 1; i <= 3; i++)
        await t.pool.query(
          `INSERT INTO message (id, conversation_id, seq, direction, body, author_user_id, sent_at)
           VALUES ($1, $2, $3, 'out', $4, $5, now())`,
          [
            newId(),
            conv,
            seq0 + i,
            `Номер заказа ${100 + i}: бонусы начисляются в течение 3 суток после заправки.`,
            opId,
          ],
        );
    }
    const run = await t.call('POST', '/api/v1/improvements/analyze', admin);
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const list = await t.call('GET', '/api/v1/improvements', admin);
    expect(list.status).toBe(200);
    expect(list.body.lastRun).toBeTruthy();
    if (conv) {
      const cands = await t.call('GET', '/api/v1/improvements/templates', admin);
      const c = cands.body.find((x: { body: string }) => x.body.includes('бонусы начисляются'));
      expect(c, JSON.stringify(cands.body)).toBeTruthy();
      expect(c.uses).toBe(3);
      const acc = await t.call('POST', `/api/v1/improvements/templates/${c.id}/accept`, admin, {
        title: 'Срок начисления бонусов',
        body: 'Бонусы начисляются в течение 3 суток после заправки.',
      });
      expect(acc.status, JSON.stringify(acc.body)).toBe(200);
      expect((await t.call('POST', `/api/v1/improvements/templates/${c.id}/reject`, admin)).status).toBe(404);
    }
    const manual = await t.call('POST', '/api/v1/improvements', admin, {
      title: 'Добавить кнопку «Перезвонить» в чат',
      category: 'software',
      rating: 70,
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    const st = await t.call('PATCH', `/api/v1/improvements/${manual.body.id}`, admin, {
      status: 'rejected',
      note: 'Не сейчас',
    });
    expect(st.body).toMatchObject({ status: 'rejected', note: 'Не сейчас' });
    // Повторный анализ не трогает ручные предложения и статусы.
    await t.call('POST', '/api/v1/improvements/analyze', admin);
    const again = await t.call('GET', '/api/v1/improvements', admin);
    expect(again.body.items.find((x: { id: string }) => x.id === manual.body.id)).toMatchObject({
      status: 'rejected',
    });
  });
});
