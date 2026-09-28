/** Интеграционные тесты телефонии Ф5 (учётные данные софтфона, вызовы, записи, права) на реальной PostgreSQL. */
import { createHmac } from 'node:crypto';
import { newId } from '@cc/contracts';
import { endCall, startInboundCall } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp, TEST_SIP_SECRET } from './setup';

describe.skipIf(!ADMIN_URL)('Телефония Ф5 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let op: string;
  beforeAll(async () => {
    t = await createTestApp();
    op = await t.login('operator1@demo.local');
  }, 60_000);
  afterAll(async () => t?.cleanup());

  const inbound = (phone: string | null, did = '1000') =>
    withTx(t.pool, (tx) =>
      startInboundCall(tx, { node: 'asterisk-1', clientChannel: newId(), callerNumber: phone, did }),
    );

  it('учётные данные софтфона: короткоживущий SIP-пароль HMAC по схеме TURN REST, TURN — тоже', async () => {
    const r = await t.call('GET', '/api/v1/telephony/softphone', op, undefined, { host: 'cc.example.by' });
    expect(r.status).toBe(200);
    const me = (await t.call('GET', '/api/v1/auth/me', op)).body;
    expect(r.body).toMatchObject({
      wsUri: 'wss://cc.example.by:8443',
      sipUri: `sip:op-${me.id}@cc.local`,
      domain: 'cc.local',
    });
    const [exp, user] = String(r.body.authorizationUser).split(':');
    expect(user).toBe(`op-${me.id}`);
    expect(Number(exp) * 1000).toBeGreaterThan(Date.now() + 3600_000);
    expect(r.body.password).toBe(
      createHmac('sha1', TEST_SIP_SECRET).update(r.body.authorizationUser).digest('base64'),
    );
    expect(r.body.iceServers[1]).toMatchObject({ urls: ['turn:turn.test:3478'] });
    expect(r.body.iceServers[0]).toMatchObject({ urls: ['stun:turn.test:3478'] });
    // Сотруднику без права работы с обращениями софтфон не выдаётся.
    const resp = await t.login('resp1@demo.local');
    expect((await t.call('GET', '/api/v1/telephony/softphone', resp)).status).toBe(403);
  });

  it('демо-абонент доступен только на демо-стенде; номер нормализуется', async () => {
    expect((await t.call('POST', '/api/v1/telephony/demo-caller', undefined, {})).status).toBe(404);
    t.ctx.config.DEMO_CALLER_ENABLED = 'true';
    try {
      const r = await t.call('POST', '/api/v1/telephony/demo-caller', undefined, {
        phone: '8 029 111-22-33',
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ sipUri: 'sip:demo-375291112233@cc.local', did: '1000' });
      expect(
        (await t.call('POST', '/api/v1/telephony/demo-caller', undefined, { phone: 'abc' })).status,
      ).toBe(400);
    } finally {
      t.ctx.config.DEMO_CALLER_ENABLED = 'false';
    }
  });

  it('входящий вызов: клиент по АОН, обращение в очереди канала; брошенный звонок закрывается как пропущенный', async () => {
    const a = await inbound('+375 29 555-00-01');
    const b = await inbound('80295550001');
    expect(a && b).toBeTruthy();
    const conv = await t.pool.query(
      `SELECT c.status, c.contact_id, q.name AS queue FROM conversation c JOIN queue q ON q.id = c.queue_id WHERE c.id = ANY($1)`,
      [[a!.conversationId, b!.conversationId]],
    );
    expect(conv.rows.map((r) => r.status)).toEqual(['queued', 'queued']);
    expect(conv.rows[0].contact_id).toBe(conv.rows[1].contact_id); // один клиент по номеру
    expect(conv.rows[0].queue).toBe('Общая');

    await withTx(t.pool, (tx) => endCall(tx, a!.callId, 'client_hangup'));
    const closed = await t.pool.query(`SELECT status FROM conversation WHERE id = $1`, [a!.conversationId]);
    expect(closed.rows[0].status).toBe('closed');
    const msgs = await t.pool.query(`SELECT body FROM message WHERE conversation_id = $1 ORDER BY seq`, [
      a!.conversationId,
    ]);
    expect(msgs.rows.map((m) => m.body).join(' | ')).toContain('Пропущенный звонок');
    // Повторное завершение — без эффекта (идемпотентно).
    expect(await withTx(t.pool, (tx) => endCall(tx, a!.callId, 'client_hangup'))).toBe(false);
  });

  it('журнал вызовов и запись: доступ по области видимости, прослушивание — в аудит', async () => {
    const c = await inbound('+375295550002');
    await t.pool.query(
      `UPDATE call SET state = 'ended', connected_at = started_at + interval '5 seconds', ended_at = started_at + interval '65 seconds' WHERE id = $1`,
      [c!.callId],
    );
    const recId = newId();
    await t.ctx.storage.put('recordings/test.wav', Buffer.from('RIFF....WAVE'), 'audio/wav');
    await t.pool.query(
      `INSERT INTO call_recording (id, call_id, conversation_id, node, name, status, storage_key, size_bytes, duration_s)
       VALUES ($1, $2, $3, 'asterisk-1', 'cc-test', 'uploaded', 'recordings/test.wav', 12, 60)`,
      [recId, c!.callId, c!.conversationId],
    );
    const calls = await t.call('GET', `/api/v1/conversations/${c!.conversationId}/calls`, op);
    expect(calls.status).toBe(200);
    expect(calls.body[0]).toMatchObject({
      direction: 'in',
      fromNumber: '+375295550002',
      waitS: 5,
      talkS: 60,
    });
    expect(calls.body[0].recordings[0]).toMatchObject({ id: recId, status: 'uploaded' });

    const file = await t.http().inject({
      method: 'GET',
      url: `/api/v1/recordings/${recId}`,
      headers: { authorization: `Bearer ${op}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('audio/wav');
    expect(file.body).toBe('RIFF....WAVE');
    const audit = await t.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'recording.play' AND entity_id = $1`,
      [recId],
    );
    expect(audit.rows[0].n).toBe(1);

    // Супервизор с областью «Север» не видит обращение без предприятия — ни журнал, ни запись (как «не существует»).
    const sup = await t.login('supervisor@demo.local');
    expect((await t.call('GET', `/api/v1/conversations/${c!.conversationId}/calls`, sup)).status).toBe(404);
    expect((await t.call('GET', `/api/v1/recordings/${recId}`, sup)).status).toBe(404);
  });

  it('управление звонком: завершённый — 404, без call-control — 503, прослушивание — только супервизору', async () => {
    const c = await inbound('+375295550003');
    expect((await t.call('POST', `/api/v1/calls/${c!.callId}/hold`, op)).status).toBe(503); // в тесте нет NATS
    expect((await t.call('POST', `/api/v1/calls/${c!.callId}/listen`, op)).status).toBe(403);
    expect((await t.call('POST', `/api/v1/calls/${c!.callId}/dance`, op)).status).toBe(404);
    expect(
      (await t.call('POST', `/api/v1/calls/${c!.callId}/transfer`, op, { target: { kind: 'queue' } })).status,
    ).toBe(400);
    await withTx(t.pool, (tx) => endCall(tx, c!.callId, 'client_hangup'));
    expect((await t.call('POST', `/api/v1/calls/${c!.callId}/hold`, op)).status).toBe(404);
  });
});
