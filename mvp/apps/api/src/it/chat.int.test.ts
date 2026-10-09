/** Интеграционные тесты обращений (Ф2) на реальной PostgreSQL. */
import { newId } from '@cc/contracts';
import { ingestInbound } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Обращения Ф2 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let channelId: string;
  beforeAll(async () => {
    t = await createTestApp();
    channelId = (await t.pool.query(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`))
      .rows[0].id;
  }, 60_000);
  afterAll(async () => t?.cleanup());

  const inbound = (externalId: string, identity: string, body = 'текст') =>
    withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId,
        channelKind: 'webchat',
        externalId,
        identity: { kind: 'webchat', value: identity },
        body,
        attachments: [],
        receivedAt: Date.now(),
      }),
    );

  it('повторная доставка того же сообщения не создаёт дубль; сообщения клиента — в одном открытом обращении', async () => {
    const a = await inbound('m-1', 'client-A', 'первое');
    const dup = await inbound('m-1', 'client-A', 'первое');
    const b = await inbound('m-2', 'client-A', 'второе');
    expect(a.created).toBe(true);
    expect(dup).toMatchObject({ duplicate: true, conversationId: a.conversationId });
    expect(b).toMatchObject({ created: false, conversationId: a.conversationId });
    const n = await t.pool.query(
      `SELECT count(*)::int AS n FROM message WHERE conversation_id = $1 AND direction = 'in'`,
      [a.conversationId],
    );
    expect(n.rows[0].n).toBe(2);
    const ev = await t.pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE subject LIKE 'cc.events.conversation.%'`,
    );
    expect(ev.rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it('оператор: очередь → взять → ответ → заметка; клиент не видит заметку; закрытие требует тему и обязательные поля', async () => {
    const { conversationId } = await inbound('m-10', 'client-B', 'вопрос по жалобе');
    const op = await t.login('operator1@demo.local');
    const q = await t.call('GET', '/api/v1/conversations?tab=queue', op);
    expect(q.body.map((c: { id: string }) => c.id)).toContain(conversationId);
    expect(
      (await t.call('POST', `/api/v1/conversations/${conversationId}/messages`, op, { body: 'до взятия' }))
        .status,
    ).toBe(409);
    expect((await t.call('POST', `/api/v1/conversations/${conversationId}/take`, op)).status).toBe(200);
    const op2 = await t.login('operator2@demo.local');
    expect((await t.call('POST', `/api/v1/conversations/${conversationId}/take`, op2)).status).toBe(409);
    expect(
      (await t.call('POST', `/api/v1/conversations/${conversationId}/messages`, op, { body: 'ответ' }))
        .status,
    ).toBe(201);
    await t.call('POST', `/api/v1/conversations/${conversationId}/messages`, op, {
      body: 'секрет',
      note: true,
    });

    const disp = (await t.call('GET', '/api/v1/dict/dispositions', op)).body.find(
      (d: { code: string }) => d.code === 'resolved',
    ).id;
    const noTopic = await t.call('POST', `/api/v1/conversations/${conversationId}/close`, op, {
      dispositionId: disp,
    });
    expect(noTopic.body.message).toMatch(/тему/);
    const staff = (await t.call('GET', '/api/v1/topics', op)).body.find(
      (x: { name: string }) => x.name === 'Жалобы на персонал АЗС',
    );
    const patched = await t.call('PATCH', `/api/v1/conversations/${conversationId}`, op, {
      topicId: staff.id,
    });
    expect(patched.body.isImportant).toBe(false); // тема не ставит «особо важное» — его отмечает сотрудник
    const missing = await t.call('POST', `/api/v1/conversations/${conversationId}/close`, op, {
      dispositionId: disp,
    });
    expect(missing.body.message).toMatch(/Номер АЗС/);
    await t.call('PATCH', `/api/v1/conversations/${conversationId}`, op, { fields: { station: 'АЗС-7' } });
    expect(
      (await t.call('POST', `/api/v1/conversations/${conversationId}/close`, op, { dispositionId: disp }))
        .status,
    ).toBe(200);

    const contactId = (await t.call('GET', `/api/v1/conversations/${conversationId}`, op)).body.contactId;
    const clientToken = await t.ctx.tokens.signClient({ contactId, channelId, sessionKey: 'client-B' });
    const cm = await t.call('GET', '/api/v1/client/messages', clientToken);
    const bodies = cm.body.map((m: { body: string }) => m.body);
    expect(bodies).toContain('ответ');
    expect(bodies).not.toContain('секрет');
  });

  it('лимит одновременных чатов оператора', async () => {
    await t.call('PATCH', '/api/v1/settings', await t.login('admin@test.local'), { 'operator.max_chats': 1 });
    const op = await t.login('operator3@demo.local');
    const c1 = await inbound('m-20', 'client-C');
    const c2 = await inbound('m-21', 'client-D');
    expect((await t.call('POST', `/api/v1/conversations/${c1.conversationId}/take`, op)).status).toBe(200);
    const r = await t.call('POST', `/api/v1/conversations/${c2.conversationId}/take`, op);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/лимит/);
  });

  it('области видимости: супервизор «Север» не видит обращение другого предприятия, в т.ч. по прямому id', async () => {
    const adm = await t.login('admin@test.local');
    const ents = (await t.call('GET', '/api/v1/dict/enterprises', adm)).body;
    const south = ents.find((e: { code: string }) => e.code === 'E2').id;
    const north = ents.find((e: { code: string }) => e.code === 'E1').id;
    const a = await inbound('m-30', 'client-E');
    const b = await inbound('m-31', 'client-F');
    await t.call('PATCH', `/api/v1/conversations/${a.conversationId}`, adm, { enterpriseId: south });
    await t.call('PATCH', `/api/v1/conversations/${b.conversationId}`, adm, { enterpriseId: north });
    const sup = await t.login('supervisor@demo.local');
    const list = (await t.call('GET', '/api/v1/conversations?tab=active', sup)).body.map(
      (c: { id: string }) => c.id,
    );
    expect(list).toContain(b.conversationId);
    expect(list).not.toContain(a.conversationId);
    expect((await t.call('GET', `/api/v1/conversations/${a.conversationId}`, sup)).status).toBe(404);
    expect((await t.call('GET', `/api/v1/conversations/${a.conversationId}/messages`, sup)).status).toBe(404);
  });

  it('клиентский API: согласие обязательно; старая версия текста согласия отклоняется', async () => {
    const no = await t.call('POST', '/api/v1/client/session', undefined, {
      publicKey: 'demo-webchat',
      consentVersion: '1',
      consentAccepted: false,
    });
    expect(no.status).toBe(400);
    const old = await t.call('POST', '/api/v1/client/session', undefined, {
      publicKey: 'demo-webchat',
      consentVersion: '0',
      consentAccepted: true,
    });
    expect(old.status).toBe(400);
    const ok = await t.call('POST', '/api/v1/client/session', undefined, {
      publicKey: 'demo-webchat',
      consentVersion: '1',
      consentAccepted: true,
      phone: '+375 29 111-22-33',
    });
    expect(ok.status).toBe(200);
    const consent = await t.pool.query('SELECT text_version FROM consent WHERE contact_id = $1', [
      ok.body.contactId,
    ]);
    expect(consent.rows[0].text_version).toBe('1');
    const ids = await t.pool.query(
      `SELECT kind, value FROM contact_identity WHERE contact_id = $1 ORDER BY kind`,
      [ok.body.contactId],
    );
    expect(ids.rows.find((r) => r.kind === 'phone')?.value).toBe('+375291112233');
  });

  it('сессия чата с каналом, которого больше нет (стенд сброшен), — «устарела» (401), виджет начнёт чат заново', async () => {
    const stale = await t.ctx.tokens.signClient({
      channelId: newId(),
      contactId: newId(),
      sessionKey: 'stale',
    });
    const r = await t.call('GET', '/api/v1/client/messages', stale);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('token_invalid');
  });

  it('вложения: загрузка и скачивание оператором, чужие вложения нельзя прикрепить', async () => {
    const op = await t.login('operator1@demo.local');
    const up = await t.call('POST', '/api/v1/attachments', op, Buffer.from('файл'), {
      'content-type': 'text/plain',
      'x-filename': encodeURIComponent('акт.txt'),
    });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ filename: 'акт.txt', size: Buffer.byteLength('файл') });
    const dl = await t.http().inject({
      method: 'GET',
      url: `/api/v1/attachments/${up.body.id}`,
      headers: { authorization: `Bearer ${op}` },
    });
    expect(dl.body).toBe('файл');
    const c = await inbound('m-40', 'client-G');
    const op2 = await t.login('operator2@demo.local');
    await t.call('POST', `/api/v1/conversations/${c.conversationId}/take`, op2);
    const r = await t.call('POST', `/api/v1/conversations/${c.conversationId}/messages`, op2, {
      body: 'x',
      attachmentIds: [up.body.id],
    });
    expect(r.status).toBe(400); // вложение загружено другим оператором
  });
  it('статус оператора (Ф3): «Взять» не делает оператора «Готов»; закрытие на перерыве не уводит в постобработку', async () => {
    // Предыдущий тест снизил лимит до 1 и оставил у operator3 открытый чат.
    await t.call('PATCH', '/api/v1/settings', await t.login('admin@test.local'), { 'operator.max_chats': 5 });
    const op = await t.login('operator3@demo.local');
    const status = async () => (await t.call('GET', '/api/v1/agent-status/me', op)).body.status;
    const reason = (await t.call('GET', '/api/v1/dict/break-reasons', op)).body[0].id;
    const disp = (await t.call('GET', '/api/v1/dict/dispositions', op)).body.find(
      (d: { code: string }) => d.code === 'no_reply',
    ).id;

    await t.call('POST', '/api/v1/agent-status', op, { status: 'offline' });
    const a = await inbound('st-1', 'client-status-A');
    expect((await t.call('POST', `/api/v1/conversations/${a.conversationId}/take`, op)).status).toBe(200);
    expect(await status()).toBe('offline');

    await t.call('POST', '/api/v1/agent-status', op, { status: 'break', reasonId: reason });
    const closed = await t.call('POST', `/api/v1/conversations/${a.conversationId}/close`, op, {
      dispositionId: disp,
    });
    expect(closed.status).toBe(200);
    expect(await status()).toBe('break');

    await t.call('POST', '/api/v1/agent-status', op, { status: 'ready' });
    const b = await inbound('st-2', 'client-status-B');
    await t.call('POST', `/api/v1/conversations/${b.conversationId}/take`, op);
    await t.call('POST', `/api/v1/conversations/${b.conversationId}/close`, op, { dispositionId: disp });
    expect(await status()).toBe('wrap_up');
  });
});
