/** Д-012 уведомления, Д-011 минимум операторов, Д-013 отписка: правила, настройки сотрудника, Telegram-очередь, проверки событий. */
import { newId } from '@cc/contracts';
import { checkAlerts, emitNotice, processTelegramQueue } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Уведомления о событиях (Д-012, Д-011, Д-013)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let sup: string;
  let op: string;
  let supId: string;
  let opId: string;
  const cells = (required: number) =>
    Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 24 }, (_, h) => ({ weekday: d + 1, hour: h, required })),
    ).flat();
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local');
    sup = await t.login('supervisor@demo.local');
    op = await t.login('operator1@demo.local');
    supId = (await t.pool.query(`SELECT id FROM app_user WHERE email = 'supervisor@demo.local'`)).rows[0].id;
    opId = (await t.pool.query(`SELECT id FROM app_user WHERE email = 'operator1@demo.local'`)).rows[0].id;
  }, 60_000);
  afterAll(async () => t?.cleanup());

  it('каталог событий и правила по умолчанию; правило создаётся, меняется и удаляется', async () => {
    const ev = await t.call('GET', '/api/v1/notify/events', sup);
    expect(ev.status).toBe(200);
    expect(ev.body.map((e: { code: string }) => e.code)).toContain('operators.below_min');
    const rules = await t.call('GET', '/api/v1/notify/rules', sup);
    expect(rules.body.length).toBeGreaterThanOrEqual(8);
    expect(rules.body.find((r: { event: string }) => r.event === 'operators.below_min')).toMatchObject({
      channels: ['ui', 'email'],
      roleCodes: ['supervisor', 'admin'],
    });
    expect((await t.call('GET', '/api/v1/notify/rules', op)).status).toBe(403);
    const created = await t.call('POST', '/api/v1/notify/rules', sup, {
      event: 'queue.long_wait',
      channels: ['ui', 'telegram'],
      roleCodes: [],
      userIds: [supId],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bad = await t.call('POST', '/api/v1/notify/rules', sup, {
      event: 'my.ticket',
      channels: ['ui'],
      roleCodes: ['admin'],
    });
    expect(bad.status).toBe(400);
    expect(
      (await t.call('PATCH', `/api/v1/notify/rules/${created.body.id}`, sup, { isActive: false })).body
        .isActive,
    ).toBe(false);
    expect((await t.call('DELETE', `/api/v1/notify/rules/${created.body.id}`, admin)).status).toBe(200);
  });

  it('сотрудник выбирает свои каналы; Telegram привязывается по коду; настройки бота — администратор', async () => {
    expect((await t.call('POST', '/api/v1/me/telegram/link', sup)).status).toBe(409);
    const tg = await t.call('PATCH', '/api/v1/notify/telegram', admin, {
      botToken: '123456:test-token',
      apiRoot: 'http://127.0.0.1:9',
    });
    expect(tg.status, JSON.stringify(tg.body)).toBe(200);
    expect(tg.body).toMatchObject({ configured: true, botTokenMasked: '123456…' });
    expect((await t.call('PATCH', '/api/v1/notify/telegram', sup, { botToken: 'x' })).status).toBe(403);
    const link = await t.call('POST', '/api/v1/me/telegram/link', sup);
    expect(link.status).toBe(200);
    expect(link.body.code).toMatch(/^\d{6}$/);
    // Бот получил «/start КОД» (здесь — та же запись, что делает бот).
    const linked = await t.pool.query(
      `UPDATE app_user SET telegram_chat_id = '555', telegram_linked_at = now(), telegram_link_code = NULL
        WHERE telegram_link_code = $1 RETURNING id`,
      [link.body.code],
    );
    expect(linked.rows[0].id).toBe(supId);
    const prefs = await t.call('PUT', '/api/v1/me/notify', sup, {
      prefs: { 'my.conversation': ['telegram', 'email'], 'my.ticket': ['telegram'] },
    });
    expect(prefs.status, JSON.stringify(prefs.body)).toBe(200);
    expect(prefs.body.prefs).toEqual({ 'my.conversation': ['telegram', 'email'], 'my.ticket': ['telegram'] });
    expect(prefs.body.telegram).toMatchObject({ available: true, linked: true });
    expect(
      (await t.call('PUT', '/api/v1/me/notify', sup, { prefs: { 'queue.long_wait': ['ui'] } })).status,
    ).toBe(400);
  });

  it('минимум операторов: уйти с линии ниже минимума нельзя, супервизор получает уведомление (интерфейс, почта, Telegram)', async () => {
    expect((await t.call('PUT', '/api/v1/staffing/minimum', op, { cells: cells(1) })).status).toBe(403);
    expect((await t.call('PUT', '/api/v1/staffing/minimum', sup, { cells: cells(1) })).status).toBe(200);
    expect((await t.call('GET', '/api/v1/staffing/minimum', sup)).body.cells).toHaveLength(168);
    // Правило «меньше минимума» — ещё и в Telegram.
    const rule = (await t.call('GET', '/api/v1/notify/rules', sup)).body.find(
      (r: { event: string }) => r.event === 'operators.below_min',
    );
    await t.call('PATCH', `/api/v1/notify/rules/${rule.id}`, sup, { channels: ['ui', 'email', 'telegram'] });
    expect((await t.call('POST', '/api/v1/agent-status', op, { status: 'ready' })).status).toBe(200);
    const leave = await t.call('POST', '/api/v1/agent-status', op, { status: 'offline' });
    expect(leave.status).toBe(409);
    expect(leave.body.message).toMatch(/Невозможно/);
    expect((await t.call('GET', '/api/v1/agent-status/me', op)).body.status).toBe('ready');
    const notes = await t.pool.query<{ channel: string; status: string; subject: string }>(
      `SELECT channel, status, subject FROM notification WHERE user_id = $1 AND kind = 'operators.below_min' ORDER BY channel`,
      [supId],
    );
    expect(notes.rows.map((n) => `${n.channel}:${n.status}`)).toEqual([
      'email:pending',
      'telegram:pending',
      'ui:sent',
    ]);
    expect(notes.rows[0]!.subject).toMatch(/хочет уйти с линии/);
    const sent: { chat: string; text: string }[] = [];
    const n = await processTelegramQueue(t.pool, {
      send: async (chat, text) => {
        sent.push({ chat, text });
      },
    });
    expect(n).toBe(1);
    expect(sent[0]).toMatchObject({ chat: '555' });
    expect(sent[0]!.text).toMatch(/останется 0 при минимуме 1/);
    // Минимум снят — уйти можно.
    await t.call('PUT', '/api/v1/staffing/minimum', sup, { cells: [] });
    expect((await t.call('POST', '/api/v1/agent-status', op, { status: 'offline' })).status).toBe(200);
  });

  it('проверки событий: на линии меньше минимума, долгое ожидание в очереди', async () => {
    await t.call('PUT', '/api/v1/staffing/minimum', sup, { cells: cells(2) });
    const channelId = (
      await t.pool.query(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`)
    ).rows[0].id;
    const contact = newId();
    await t.pool.query(`INSERT INTO contact (id, display_name) VALUES ($1, 'Ждущий')`, [contact]);
    await t.pool.query(
      `INSERT INTO conversation (id, channel_id, channel_kind, contact_id, status, queued_at)
       VALUES ($1, $2, 'webchat', $3, 'queued', now() - interval '1 hour')`,
      [newId(), channelId, contact],
    );
    const r = await checkAlerts(t.pool);
    expect(r.belowMin).toBeGreaterThanOrEqual(1);
    expect(r.longWait).toBeGreaterThanOrEqual(1);
    const again = await checkAlerts(t.pool);
    expect(again.longWait).toBe(0); // один раз на обращение
    const ui = await t.pool.query(
      `SELECT subject FROM notification WHERE user_id = $1 AND channel = 'ui' AND kind IN ('operators.below_min', 'queue.long_wait') ORDER BY kind`,
      [supId],
    );
    expect(ui.rows.map((x) => x.subject).join(' | ')).toMatch(/На линии \d+ операторов при минимуме 2/);
    expect(ui.rows.map((x) => x.subject).join(' | ')).toMatch(/Клиент ждёт в очереди/);
    await t.call('PUT', '/api/v1/staffing/minimum', sup, { cells: [] });
  });

  it('отписка от писем по ссылке из письма; снова подписаться — из профиля', async () => {
    await t.pool.query(`UPDATE app_user SET unsubscribe_token = 'tok-test-123' WHERE id = $1`, [opId]);
    await t.pool.query(
      `INSERT INTO notification (id, user_id, kind, channel, dedupe_key, subject, body) VALUES ($1, $2, 'test', 'email', 'unsub-test-1', 'Письмо', '')`,
      [newId(), opId],
    );
    const page = await t.http().inject({ method: 'GET', url: '/api/v1/unsubscribe?token=tok-test-123' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/отписаны/);
    expect((await t.http().inject({ method: 'GET', url: '/api/v1/unsubscribe?token=nope' })).body).toMatch(
      /недействительна/,
    );
    const u = await t.pool.query(`SELECT email_unsubscribed_at FROM app_user WHERE id = $1`, [opId]);
    expect(u.rows[0].email_unsubscribed_at).not.toBeNull();
    const skipped = await t.pool.query(`SELECT status FROM notification WHERE dedupe_key = 'unsub-test-1'`);
    expect(skipped.rows[0].status).toBe('skipped');
    expect((await t.call('GET', '/api/v1/me/notify', op)).body.emailUnsubscribedAt).not.toBeNull();
    expect((await t.call('POST', '/api/v1/me/resubscribe', op)).status).toBe(200);
    expect((await t.call('GET', '/api/v1/me/notify', op)).body.emailUnsubscribedAt).toBeNull();
    // Вебхук relay без секрета — отказ.
    expect(
      (await t.call('POST', '/api/v1/inbound/unsubscribe', undefined, { email: 'operator1@demo.local' }))
        .status,
    ).toBe(401);
  });

  it('Д-094: матрица «сотрудник × событие» — каналы, условие «если ответственный», копирование на всех', async () => {
    const m = await t.call('GET', '/api/v1/notify/matrix', sup);
    expect(m.status).toBe(200);
    expect(m.body.events.map((e: { code: string }) => e.code)).toContain('ticket.open_reminder');
    expect(m.body.users.find((u: { id: string }) => u.id === opId)).toMatchObject({ telegramOk: false });
    expect((await t.call('GET', '/api/v1/notify/matrix', op)).status).toBe(403);
    // Оператору — Telegram (контакта нет: ячейка будет красной) и интерфейс, только если он ответственный.
    const put = await t.call('PUT', '/api/v1/notify/matrix/cell', sup, {
      userId: opId,
      event: 'ticket.overdue',
      channels: ['ui', 'telegram'],
      conditions: ['responsible'],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const ticketId = newId();
    const notice = (rel: string[]) =>
      emitNotice(t.pool, {
        event: 'ticket.overdue',
        subject: 'Просрочен тикет',
        dedupe: `mx-test:${ticketId}:${rel.length}`,
        relations: { responsible: rel },
      });
    await notice([]);
    const none = await t.pool.query(`SELECT 1 FROM notification WHERE user_id = $1 AND dedupe_key LIKE $2`, [
      opId,
      `mx-test:${ticketId}:0:%`,
    ]);
    expect(none.rowCount).toBe(0);
    await notice([opId]);
    const got = await t.pool.query<{ channel: string }>(
      `SELECT channel FROM notification WHERE user_id = $1 AND dedupe_key LIKE $2 ORDER BY channel`,
      [opId, `mx-test:${ticketId}:1:%`],
    );
    // Telegram не указан — уведомление в Telegram не создаётся, в программу — приходит.
    expect(got.rows.map((r) => r.channel)).toEqual(['ui']);
    // Telegram из справочника (номер чата) — теперь и в Telegram.
    expect(
      (await t.call('PATCH', `/api/v1/users/${opId}`, admin, { telegramContact: '700123456' })).status,
    ).toBe(200);
    expect((await t.call('PATCH', `/api/v1/users/${opId}`, admin, { telegramContact: 'a b' })).status).toBe(
      400,
    );
    await emitNotice(t.pool, {
      event: 'ticket.overdue',
      subject: 'Просрочен тикет',
      dedupe: `mx-test2:${ticketId}`,
      relations: { responsible: [opId] },
    });
    const tg = await t.pool.query(
      `SELECT 1 FROM notification WHERE user_id = $1 AND channel = 'telegram' AND dedupe_key LIKE $2`,
      [opId, `mx-test2:${ticketId}:%`],
    );
    expect(tg.rowCount).toBe(1);
    // Копирование строки оператора всем: у супервизора появляется та же ячейка.
    const copy = await t.call('POST', '/api/v1/notify/matrix/copy', sup, { fromUserId: opId });
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    expect(copy.body.users).toBeGreaterThan(1);
    const after = await t.call('GET', '/api/v1/notify/matrix', sup);
    expect(
      after.body.cells.find(
        (c: { userId: string; event: string }) => c.userId === supId && c.event === 'ticket.overdue',
      ),
    ).toMatchObject({ channels: ['ui', 'telegram'], conditions: ['responsible'] });
    // Пустые каналы — ячейка удаляется.
    await t.call('PUT', '/api/v1/notify/matrix/cell', sup, {
      userId: supId,
      event: 'ticket.overdue',
      channels: [],
    });
    const cleared = await t.call('GET', '/api/v1/notify/matrix', sup);
    expect(
      cleared.body.cells.some(
        (c: { userId: string; event: string }) => c.userId === supId && c.event === 'ticket.overdue',
      ),
    ).toBe(false);
  });
});
