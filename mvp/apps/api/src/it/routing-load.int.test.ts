/** Интеграционные тесты API режима «по загрузке» (Д-017): «Взять следующее», «+2 мин» к постобработке. */
import { newId } from '@cc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Режим «по загрузке» (Д-017, API)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let op: string;
  let opId: string;
  let queueId: string;
  let channelId: string;
  let contactId: string;
  beforeAll(async () => {
    t = await createTestApp();
    op = await t.login('operator1@demo.local');
    opId = (await t.pool.query(`SELECT id FROM app_user WHERE email = 'operator1@demo.local'`)).rows[0].id;
    queueId = (await t.pool.query(`SELECT queue_id FROM user_queue WHERE user_id = $1 LIMIT 1`, [opId]))
      .rows[0].queue_id;
    channelId = (await t.pool.query(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`))
      .rows[0].id;
    contactId = newId();
    await t.pool.query(`INSERT INTO contact (id, display_name) VALUES ($1, 'Автор отзыва')`, [contactId]);
    await t.pool.query(`UPDATE system_setting SET value = '{"mode":"load"}' WHERE key = 'routing.policy'`);
  }, 60_000);
  afterAll(async () => t?.cleanup());

  /** Обращение в очереди оператора: почта/отзыв (неспешное) или чат. */
  async function queued(kind: string, over: { urgent?: boolean; ageS?: number; dueInS?: number } = {}) {
    const id = newId();
    await t.pool.query(
      `INSERT INTO conversation (id, channel_id, channel_kind, contact_id, status, queue_id, is_urgent, queued_at, due_at)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, now() - make_interval(secs => $7),
               CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(secs => $8) END)`,
      [id, channelId, kind, contactId, queueId, over.urgent ?? false, over.ageS ?? 0, over.dueInS ?? null],
    );
    return id;
  }
  const status = async (id: string) =>
    (await t.pool.query(`SELECT status, assignee_id FROM conversation WHERE id = $1`, [id])).rows[0];

  it('«Взять следующее»: пустая очередь → id null; затем негативный отзыв раньше почты, почта — по порядку', async () => {
    const empty = await t.call('POST', '/api/v1/conversations/take-next', op);
    expect(empty.status).toBe(200);
    expect(empty.body.id).toBeNull();

    const mailOld = await queued('email', { ageS: 600 });
    const mailNew = await queued('email', { ageS: 60 });
    const negative = await queued('review', { urgent: true, ageS: 30 });
    const chat = await queued('webchat', { ageS: 900 }); // чат — не неспешная очередь, кнопкой не берётся

    const first = await t.call('POST', '/api/v1/conversations/take-next', op);
    expect(first.status).toBe(200);
    expect(first.body.id).toBe(negative);
    expect(await status(negative)).toMatchObject({ status: 'active', assignee_id: opId });
    const second = await t.call('POST', '/api/v1/conversations/take-next', op);
    expect(second.body.id).toBe(mailOld);
    const third = await t.call('POST', '/api/v1/conversations/take-next', op);
    expect(third.body.id).toBe(mailNew);
    expect((await status(chat)).status).toBe('queued');
    const none = await t.call('POST', '/api/v1/conversations/take-next', op);
    expect(none.body.id).toBeNull();
  });

  it('старение: письмо, у которого израсходовано 80 % срока, выдаётся раньше более старого письма без срока', async () => {
    const plain = await queued('email', { ageS: 3600 });
    const aging = await queued('email', { ageS: 3600, dueInS: 60 });
    const r = await t.call('POST', '/api/v1/conversations/take-next', op);
    expect(r.body.id).toBe(aging);
    expect((await status(plain)).status).toBe('queued');
    await t.call('POST', '/api/v1/conversations/take-next', op);
  });

  it('без свободной ёмкости (`pullMinFree`) кнопка не выдаёт обращение — ошибка с пояснением', async () => {
    // Взятое раньше закрыто (лимит одновременных чатов общий с ручным «Взять»).
    await t.pool.query(
      `UPDATE conversation SET status = 'closed', closed_at = now() WHERE assignee_id = $1`,
      [opId],
    );
    // Чат у оператора, клиент ждёт ответа: занято 40 из 100, свободно 60. Порог 70 — отказ; 40 — выдаёт.
    const mine = await queued('webchat');
    await t.pool.query(`UPDATE conversation SET status = 'active', assignee_id = $2 WHERE id = $1`, [
      mine,
      opId,
    ]);
    await t.pool.query(
      `INSERT INTO message (id, conversation_id, seq, direction, body, channel_kind, sent_at)
       VALUES ($1, $2, 1, 'in', 'вопрос', 'webchat', now())`,
      [newId(), mine],
    );
    const mail = await queued('email');
    await t.pool.query(
      `UPDATE system_setting SET value = '{"mode":"load","load":{"pullMinFree":70}}' WHERE key = 'routing.policy'`,
    );
    const busy = await t.call('POST', '/api/v1/conversations/take-next', op);
    expect(busy.status).toBe(409);
    expect(busy.body.message).toMatch(/свободно 60/);
    await t.pool.query(`UPDATE system_setting SET value = '{"mode":"load"}' WHERE key = 'routing.policy'`);
    const ok = await t.call('POST', '/api/v1/conversations/take-next', op);
    expect(ok.body.id).toBe(mail);
  });

  it('«+2 мин»: продлевает постобработку и считает продления; при запрете повтора — второе продление отклоняется', async () => {
    const notWrap = await t.call('POST', '/api/v1/agent-status/wrap-up/extend', op);
    expect(notWrap.status).toBe(409);
    await t.pool.query(
      `INSERT INTO agent_status (user_id, status, wrap_up_until, since, updated_at)
       VALUES ($1, 'wrap_up', now() + interval '30 seconds', now(), now())
       ON CONFLICT (user_id) DO UPDATE SET status = 'wrap_up', wrap_up_until = now() + interval '30 seconds', wrap_up_extends = 0`,
      [opId],
    );
    const me0 = await t.call('GET', '/api/v1/agent-status/me', op);
    expect(me0.body).toMatchObject({ status: 'wrap_up', routingMode: 'load', wrapUpExtends: 0 });
    const ext = await t.call('POST', '/api/v1/agent-status/wrap-up/extend', op);
    expect(ext.status).toBe(200);
    expect(ext.body.wrapUpExtends).toBe(1);
    const until = new Date(ext.body.wrapUpUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(120_000);
    expect(until - Date.now()).toBeLessThan(160_000);
    await t.pool.query(
      `UPDATE system_setting SET value = '{"mode":"load","wrapUp":{"extendRepeat":false}}' WHERE key = 'routing.policy'`,
    );
    const again = await t.call('POST', '/api/v1/agent-status/wrap-up/extend', op);
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/один раз/);
    // Смена статуса сбрасывает счётчик продлений.
    await t.call('POST', '/api/v1/agent-status', op, { status: 'ready' });
    const me1 = await t.call('GET', '/api/v1/agent-status/me', op);
    expect(me1.body).toMatchObject({ status: 'ready', wrapUpExtends: 0 });
  });
});
