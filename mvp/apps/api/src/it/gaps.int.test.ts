/**
 * Интеграционные тесты Ф12b (пробелы приёмки): обязательный тег при закрытии — опция очереди (M-CARD-06),
 * вкладки «Удержание» и «Постобработка» (M-OP-02), ручное слияние дублей клиентов (M-CARD-01).
 */
import { newId } from '@cc/contracts';
import { endCall, ingestInbound, setCallHold, startInboundCall } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp } from './setup';

type Row = Record<string, unknown>;

describe.skipIf(!ADMIN_URL)('Ф12b: пробелы приёмки (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let channelId: string;
  let op: string;
  let opId: string;
  let admin: string;
  const one = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0];

  beforeAll(async () => {
    t = await createTestApp();
    channelId = (await one(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`)).id;
    op = await t.login('operator1@demo.local');
    opId = (await one(`SELECT id FROM app_user WHERE email = 'operator1@demo.local'`)).id;
    admin = await t.login('admin@test.local');
  }, 60_000);
  afterAll(async () => t?.cleanup());

  const inbound = (ext: string, identity: string, body = 'вопрос', displayName?: string) =>
    withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId,
        channelKind: 'webchat',
        externalId: ext,
        identity: { kind: 'webchat', value: identity },
        ...(displayName ? { contact: { displayName } } : {}),
        body,
        attachments: [],
        receivedAt: Date.now(),
      }),
    );
  const ids = async (tab: string, token = op) =>
    ((await t.call('GET', `/api/v1/conversations?tab=${tab}`, token)).body as Row[]).map((r) => r.id);

  it('M-CARD-06: очередь с обязательным тегом — закрыть и передать на 2-ю линию без тега нельзя', async () => {
    const queue = (await t.call('GET', '/api/v1/dict/queues', admin)).body.find((q: Row) => q.name === 'Общая');
    const upd = await t.call('PATCH', `/api/v1/dict/queues/${queue.id}`, admin, { requireTag: true });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.requireTag).toBe(true);

    const { conversationId: id } = await inbound('tag-1', 'tag-client');
    expect((await t.call('POST', `/api/v1/conversations/${id}/take`, op)).status).toBe(200);
    const goods = (await t.call('GET', '/api/v1/topics', op)).body.find(
      (x: Row) => x.name === 'Сопутствующие товары и питание',
    );
    const card = await t.call('PATCH', `/api/v1/conversations/${id}`, op, { topicId: goods.id });
    expect(card.body.queueRequireTag).toBe(true);
    const disp = (await t.call('GET', '/api/v1/dict/dispositions', op)).body.find(
      (d: Row) => d.code === 'resolved',
    ).id;
    const noTag = await t.call('POST', `/api/v1/conversations/${id}/close`, op, { dispositionId: disp });
    expect(noTag.status).toBe(400);
    expect(noTag.body.error).toBe('tag_required');
    expect(noTag.body.message).toMatch(/Общая/);
    const esc = await t.call('POST', `/api/v1/conversations/${id}/escalate`, op, {
      enterpriseId: newId(),
      departmentId: newId(),
      topicId: goods.id,
      summary: 'Суть',
    });
    expect(esc.body.error).toBe('tag_required');

    const tag = (await t.call('GET', '/api/v1/dict/tags', op)).body[0];
    await t.call('PATCH', `/api/v1/conversations/${id}`, op, { tagIds: [tag.id] });
    const ok = await t.call('POST', `/api/v1/conversations/${id}/close`, op, { dispositionId: disp });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    // Опция выключена — прежнее поведение.
    await t.call('PATCH', `/api/v1/dict/queues/${queue.id}`, admin, { requireTag: false });
    const { conversationId: id2 } = await inbound('tag-2', 'tag-client-2');
    await t.call('POST', `/api/v1/conversations/${id2}/take`, op);
    await t.call('PATCH', `/api/v1/conversations/${id2}`, op, { topicId: goods.id });
    expect(
      (await t.call('POST', `/api/v1/conversations/${id2}/close`, op, { dispositionId: disp })).status,
    ).toBe(200);
  });

  it('M-OP-02: «Удержание» — звонок на удержании; «Постобработка» — звонок завершён или клиент молчит после ответа', async () => {
    // Звонок: оператор разговаривает с клиентом.
    const call = await withTx(t.pool, (tx) =>
      startInboundCall(tx, { node: 'asterisk-1', clientChannel: newId(), callerNumber: '+375291112233', did: '1000' }),
    );
    expect(call).not.toBeNull();
    const { callId, conversationId: voice } = call!;
    await t.pool.query(
      `UPDATE call SET state = 'talking', agent_user_id = $2, connected_at = now() WHERE id = $1`,
      [callId, opId],
    );
    await t.pool.query(`UPDATE conversation SET status = 'active', assignee_id = $2 WHERE id = $1`, [
      voice,
      opId,
    ]);
    expect(await ids('hold')).not.toContain(voice);
    expect(await ids('wrapup')).not.toContain(voice);
    await withTx(t.pool, (tx) => setCallHold(tx, callId, true, opId));
    expect(await ids('hold')).toContain(voice);
    await withTx(t.pool, (tx) => setCallHold(tx, callId, false, opId));
    expect(await ids('hold')).not.toContain(voice);
    await withTx(t.pool, (tx) => endCall(tx, callId, 'client_hangup'));
    expect(await ids('wrapup')).toContain(voice);
    expect(await ids('mine')).toContain(voice);
    // Другой оператор не видит чужие вкладки.
    const op2 = await t.login('operator2@demo.local');
    expect(await ids('wrapup', op2)).not.toContain(voice);

    // Чат: последним ответил оператор, клиент молчит дольше настройки.
    const { conversationId: chat } = await inbound('wrap-1', 'wrap-client');
    await t.call('POST', `/api/v1/conversations/${chat}/take`, op);
    await t.call('POST', `/api/v1/conversations/${chat}/messages`, op, { body: 'Ответ оператора' });
    expect(await ids('wrapup')).not.toContain(chat);
    await t.pool.query(`UPDATE message SET sent_at = sent_at - interval '10 minutes' WHERE conversation_id = $1`, [
      chat,
    ]);
    expect(await ids('wrapup')).toContain(chat);
    // Порог — из «Настроек» без перезапуска.
    const s = await t.call('PATCH', '/api/v1/settings', admin, { 'operator.wrapup_chat_idle_s': 3600 });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(await ids('wrapup')).not.toContain(chat);
    await t.call('PATCH', '/api/v1/settings', admin, { 'operator.wrapup_chat_idle_s': 300 });
    // Клиент написал снова — чат уходит из «Постобработки».
    await inbound('wrap-2', 'wrap-client', 'ещё вопрос');
    expect(await ids('wrapup')).not.toContain(chat);
    expect((await t.call('GET', '/api/v1/conversations?tab=unknown', op)).status).toBe(400);
  });

  it('M-CARD-01: слияние дублей — идентификаторы, обращения, согласия к основному; дубль скрыт; права и аудит', async () => {
    const a = await inbound('merge-a', 'merge-A', 'из виджета', 'Ольга Дубль');
    const b = await inbound('merge-b', 'merge-B', 'снова', 'Ольга Основная');
    const ca = (await one('SELECT contact_id FROM conversation WHERE id = $1', [a.conversationId])).contact_id;
    const cb = (await one('SELECT contact_id FROM conversation WHERE id = $1', [b.conversationId])).contact_id;
    await t.pool.query(`UPDATE contact SET phone = '+375297778899' WHERE id = $1`, [ca]);
    await t.pool.query(
      `INSERT INTO consent (id, contact_id, channel_id, text_version) VALUES ($1, $2, $3, '1')`,
      [newId(), ca, channelId],
    );

    // Оператору слияние недоступно.
    expect((await t.call('GET', '/api/v1/contacts?q=Ольга', op)).status).toBe(403);
    expect((await t.call('POST', `/api/v1/contacts/${cb}/merge`, op, { duplicateId: ca })).status).toBe(403);

    const sup = await t.login('supervisor@demo.local');
    const found = (await t.call('GET', `/api/v1/contacts?q=Ольга&exclude=${cb}`, sup)).body as Row[];
    expect(found.map((c) => c.id)).toEqual([ca]);
    expect((await t.call('POST', `/api/v1/contacts/${cb}/merge`, sup, { duplicateId: cb })).status).toBe(400);

    const r = await t.call('POST', `/api/v1/contacts/${cb}/merge`, sup, { duplicateId: ca });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.moved).toMatchObject({ contact_identity: 1, conversation: 1, consent: 1 });
    expect(r.body.phone).toBe('+375297778899'); // пустое поле основного дополнено из дубля
    expect(r.body.displayName).toBe('Ольга Основная');

    const dup = await one('SELECT merged_into_id, merged_by FROM contact WHERE id = $1', [ca]);
    expect(dup.merged_into_id).toBe(cb);
    expect(dup.merged_by).toBeTruthy();
    const history = (await t.call("GET", `/api/v1/contacts/${cb}/conversations`, admin)).body as Row[];
    expect(history.map((h) => h.id).sort()).toEqual([a.conversationId, b.conversationId].sort());
    // Дубль не находится; повторное слияние — 409.
    expect(((await t.call('GET', '/api/v1/contacts?q=Дубль', sup)).body as Row[]).length).toBe(0);
    expect((await t.call('POST', `/api/v1/contacts/${cb}/merge`, sup, { duplicateId: ca })).status).toBe(409);
    // Аудит.
    const au = await one(`SELECT actor_id, after FROM audit_log WHERE action = 'contact.merge' AND entity_id = $1`, [
      ca,
    ]);
    expect(au.after.mergedIntoId).toBe(cb);

    // Новое сообщение по идентификатору дубля — к основному клиенту, в его открытое обращение.
    const again = await inbound('merge-a2', 'merge-A', 'я снова');
    expect(again.created).toBe(false);
    expect(
      (await one('SELECT contact_id FROM conversation WHERE id = $1', [again.conversationId])).contact_id,
    ).toBe(cb);

    // Сессия виджета, выданная дублю до слияния, — история и отправка от основного клиента.
    const token = await t.ctx.tokens.signClient({ contactId: ca, channelId, sessionKey: 'merge-A' });
    const cm = (await t.call('GET', '/api/v1/client/messages', token)).body as Row[];
    expect(cm.map((m) => m.body)).toEqual(expect.arrayContaining(['из виджета', 'снова', 'я снова']));

    // Администратор тоже может; ранее присоединённые к дублю переходят к новому основному.
    const c = await inbound('merge-c', 'merge-C', 'третий', 'Ольга Третья');
    const cc = (await one('SELECT contact_id FROM conversation WHERE id = $1', [c.conversationId])).contact_id;
    const r2 = await t.call('POST', `/api/v1/contacts/${cc}/merge`, admin, { duplicateId: cb });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect((await one('SELECT merged_into_id FROM contact WHERE id = $1', [ca])).merged_into_id).toBe(cc);
  });
});
