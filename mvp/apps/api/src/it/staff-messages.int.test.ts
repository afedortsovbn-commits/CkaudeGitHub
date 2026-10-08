/** Интеграционные тесты рассылки сотрудникам: права, получатели, прочтение, напоминание, событие realtime. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Рассылка сотрудникам (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const tok: Record<string, string> = {};
  beforeAll(async () => {
    t = await createTestApp();
    tok.admin = await t.login('admin@test.local');
    tok.sup = await t.login('supervisor@demo.local');
    tok.op1 = await t.login('operator1@demo.local');
    tok.op2 = await t.login('operator2@demo.local');
  }, 120_000);
  afterAll(async () => t?.cleanup());

  const call = (m: string, path: string, who: string, body?: unknown) =>
    t.call(m, `/api/v1${path}`, tok[who], body);

  it('отправка ролям, окно у получателя, «прочитал», кто прочитал — у автора, напоминание', async () => {
    // Оператор рассылать не может.
    expect((await call('POST', '/staff-messages', 'op1', { subject: 'x' })).status).toBe(403);
    expect((await call('POST', '/staff-messages', 'sup', { subject: '  ' })).status).toBe(400);

    const sent = await call('POST', '/staff-messages', 'sup', {
      importance: 'urgent',
      subject: 'Сбой оплаты картами на АЗС',
      body: 'Сообщайте клиентам: оплата наличными доступна.',
      roles: ['operator'],
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const id = sent.body.id as string;
    const total = sent.body.recipients as number;
    expect(total).toBeGreaterThanOrEqual(2);
    const ev = await t.pool.query(
      `SELECT data FROM event WHERE type = 'app.staff_message' AND data ->> 'messageId' = $1`,
      [id],
    );
    expect(ev.rows[0].data.notifyUserIds).toHaveLength(total);

    // Получатель видит непрочитанное; автор — нет (не себе).
    const inbox = (await call('GET', '/staff-messages/inbox', 'op1')).body as {
      id: string;
      importance: string;
    }[];
    expect(inbox.find((m) => m.id === id)).toMatchObject({ importance: 'urgent' });
    expect(
      ((await call('GET', '/staff-messages/inbox', 'sup')).body as { id: string }[]).some((m) => m.id === id),
    ).toBe(false);
    expect((await call('POST', `/staff-messages/${id}/read`, 'op1')).body.updated).toBe(1);
    expect(
      ((await call('GET', '/staff-messages/inbox', 'op1')).body as { id: string }[]).some((m) => m.id === id),
    ).toBe(false);

    const list = (await call('GET', '/staff-messages', 'sup')).body as {
      id: string;
      read: number;
      total: number;
    }[];
    expect(list.find((m) => m.id === id)).toMatchObject({ read: 1, total });
    const rec = (await call('GET', `/staff-messages/${id}`, 'sup')).body as {
      fullName: string;
      readAt: string | null;
    }[];
    expect(rec.filter((r) => r.readAt)).toHaveLength(1);
    expect(rec[0]!.readAt).toBeNull(); // непрочитавшие — сверху

    const remind = await call('POST', `/staff-messages/${id}/remind`, 'sup');
    expect(remind.body.reminded).toBe(total - 1);
  });

  it('«только тем, кто на линии»: нет таких — понятный отказ', async () => {
    await t.pool.query(`UPDATE agent_status SET status = 'offline'`);
    const r = await call('POST', '/staff-messages', 'admin', {
      subject: 'Тест',
      roles: ['operator'],
      onlineOnly: true,
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('Получателей нет');
  });
});
