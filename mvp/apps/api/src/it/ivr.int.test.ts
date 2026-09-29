/** Интеграционные тесты Ф6: сценарии IVR (версии, привязка к номерам), аудио, интеграционные операции, домен IVR. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newId } from '@cc/contracts';
import {
  createCallbackTask,
  endCall,
  enqueueFromIvr,
  leaveQueueToIvr,
  publishedFlowForDid,
  saveCsat,
  startInboundCall,
} from '@cc/domain';
import type { FlowGraph } from '@cc/flow-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp, DEMO_PW } from './setup';

function wav(seconds: number, rate = 8000, channels = 1): Buffer {
  const data = Math.round(seconds * rate) * 2 * channels;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

describe.skipIf(!ADMIN_URL)('IVR Ф6 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let op: string;
  let ext: Server;
  let extUrl: string;
  let lastAuth = '';
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local', DEMO_PW);
    op = await t.login('operator1@demo.local');
    // «Внешняя система»: баланс по телефону; 500 — для номера на 0000; ответ через 1 с — на 9999.
    ext = createServer((req, res) => {
      lastAuth = String(req.headers.authorization ?? '');
      const phone = new URL(req.url ?? '/', 'http://x').searchParams.get('phone') ?? '';
      if (phone.endsWith('0000')) return res.writeHead(500).end('{}');
      const send = () =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ data: { balance: 1234.5, card: '7000-1' }, history: [{ station: 'АЗС 1' }] }),
          );
      if (phone.endsWith('9999')) setTimeout(send, 1000);
      else send();
    });
    await new Promise<void>((r) => ext.listen(0, '127.0.0.1', r));
    extUrl = `http://127.0.0.1:${(ext.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    ext?.close();
    await t?.cleanup();
  });

  const upload = (body: Buffer, query = 'name=Приветствие') =>
    t.call('POST', `/api/v1/ivr/audio?${query}`, admin, body, { 'content-type': 'audio/wav' });

  it('аудио: только WAV PCM 16 бит моно 8 кГц; новый фрагмент числа заменяет прежний', async () => {
    expect((await upload(Buffer.from('ID3 это mp3, а не wav, совсем не wav...........'))).status).toBe(400);
    expect((await upload(wav(1, 44100, 2))).body.message).toBe('Нужен WAV PCM 16 бит, моно, 8000 Гц');
    const ok = await upload(wav(1.5));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kind: 'prompt', durationMs: 1500, isActive: true });
    const f1 = await upload(wav(0.5), 'kind=fragment&fragmentKey=5&name=пять');
    const f2 = await upload(wav(0.5), 'kind=fragment&fragmentKey=5&name=пять (новая запись)');
    const frags = (await t.call('GET', '/api/v1/ivr/fragments', admin)).body as {
      key: string;
      audioId: string;
    }[];
    expect(frags.find((f) => f.key === '5')?.audioId).toBe(f2.body.id);
    expect(f1.body.id).not.toBe(f2.body.id);
    expect((await upload(wav(1), 'name=x')).status).toBe(201);
    expect(
      (await t.call('POST', '/api/v1/ivr/audio?name=x', op, wav(1), { 'content-type': 'audio/wav' })).status,
    ).toBe(403);
  });

  it('сценарий: номер — одному сценарию; ошибки блокируют публикацию; публикация и откат версий', async () => {
    const created = await t.call('POST', '/api/v1/flows', admin, { name: 'Тестовый IVR', dids: ['3000'] });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await t.call('POST', '/api/v1/flows', admin, { name: 'Другой', dids: ['3000'] })).status).toBe(
      409,
    );
    expect((await t.call('POST', '/api/v1/flows', op, { name: 'Оператор' })).status).toBe(403);
    // Пустой сценарий: «Начало» не подключено — публикация отклонена с перечнем ошибок.
    const bad = await t.call('POST', `/api/v1/flows/${id}/publish`, admin, {});
    expect(bad.status).toBe(400);
    expect(bad.body.details.errors[0].message).toContain('не подключён выход');
    expect(
      (await t.call('PATCH', `/api/v1/flows/${id}`, admin, { draft: { kind: 'voice', nodes: 1 } })).status,
    ).toBe(400);

    const audio = (await upload(wav(1), 'name=Здравствуйте')).body.id as string;
    const queue = (await t.call('GET', '/api/v1/dict/queues', admin)).body[0].id as string;
    const graph = (audioId: string): FlowGraph => ({
      version: 1,
      kind: 'voice',
      nodes: [
        { id: 's', type: 'start', params: {} },
        { id: 'p', type: 'play', params: { audio: [audioId] } },
        { id: 'q', type: 'queue', params: { queueId: queue } },
      ],
      edges: [
        { id: 'e1', source: 's', exit: 'next', target: 'p' },
        { id: 'e2', source: 'p', exit: 'next', target: 'q' },
      ],
    });
    // Ссылка на несуществующий файл — ошибка проверки на сервере.
    await t.call('PATCH', `/api/v1/flows/${id}`, admin, { draft: graph(newId()) });
    const v = await t.call('POST', `/api/v1/flows/${id}/validate`, admin, {});
    expect(v.body.errors.map((e: { message: string }) => e.message)).toContain(
      'Аудиофайл не найден(а) или отключен(а)',
    );

    expect((await t.call('PATCH', `/api/v1/flows/${id}`, admin, { draft: graph(audio) })).status).toBe(200);
    const p1 = await t.call('POST', `/api/v1/flows/${id}/publish`, admin, { comment: 'первая' });
    expect(p1.body).toMatchObject({ version: 1 });
    const p2 = await t.call('POST', `/api/v1/flows/${id}/publish`, admin, {});
    expect(p2.body).toMatchObject({ version: 2 });
    const byDid = await withTx(t.pool, (tx) => publishedFlowForDid(tx, '3000'));
    expect(byDid).toMatchObject({ versionId: p2.body.versionId, version: 2, flowName: 'Тестовый IVR' });
    const rb = await t.call('POST', `/api/v1/flows/${id}/rollback`, admin, { versionId: p1.body.versionId });
    expect(rb.body).toMatchObject({ version: 1 });
    expect((await withTx(t.pool, (tx) => publishedFlowForDid(tx, '3000')))?.versionId).toBe(
      p1.body.versionId,
    );
    const full = await t.call('GET', `/api/v1/flows/${id}`, admin);
    expect(full.body.versions.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    // Отключённый сценарий номер не обслуживает; аудит — публикация и откат.
    await t.call('POST', `/api/v1/flows/${id}/deactivate`, admin, {});
    expect(await withTx(t.pool, (tx) => publishedFlowForDid(tx, '3000'))).toBeNull();
    const audit = await t.pool.query(
      `SELECT action FROM audit_log WHERE entity = 'flow' AND entity_id = $1`,
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['publish', 'rollback', 'deactivate']),
    );
  });

  it('интеграционная операция: секрет зашифрован, маппинг ответа, ошибка и таймаут → фолбэк, журнал без тел', async () => {
    const created = await t.call('POST', '/api/v1/dict/integrations', admin, {
      code: 'test.balance',
      name: 'Баланс (тест)',
      url: `${extUrl}/balance?phone={{phone}}`,
      auth: { type: 'bearer', secret: 'top-secret' },
      inputs: [{ name: 'phone', label: 'Телефон' }],
      outputs: [
        { name: 'balance', label: 'Баланс', path: '$.data.balance' },
        { name: 'station', label: 'АЗС', path: '$.history[0].station' },
      ],
      timeoutMs: 300,
      fallback: { balance: '—' },
      showInCard: true,
      cardInput: 'phone',
    });
    expect(created.status).toBe(201);
    expect(created.body.auth).toEqual({ type: 'bearer', secret: '********' });
    const raw = await t.pool.query(`SELECT auth FROM integration_op WHERE id = $1`, [created.body.id]);
    expect(raw.rows[0].auth.secret).toMatch(/^enc:v1:/);
    const id = created.body.id as string;

    const ok = await t.call('POST', `/api/v1/integrations/${id}/test`, admin, {
      input: { phone: '+375291112233' },
    });
    expect(ok.body).toMatchObject({
      ok: true,
      httpStatus: 200,
      outputs: { balance: '1234.5', station: 'АЗС 1' },
    });
    expect(lastAuth).toBe('Bearer top-secret');
    const err = await t.call('POST', `/api/v1/integrations/${id}/test`, admin, {
      input: { phone: '+375290000000' },
    });
    expect(err.body).toMatchObject({ ok: false, error: 'HTTP 500', outputs: { balance: '—' } });
    const slow = await t.call('POST', `/api/v1/integrations/${id}/test`, admin, {
      input: { phone: '+375299999999' },
    });
    expect(slow.body).toMatchObject({ ok: false, error: 'Нет ответа за 300 мс', outputs: { balance: '—' } });

    // Изменение без секрета (маска) секрет сохраняет.
    await t.call('PATCH', `/api/v1/dict/integrations/${id}`, admin, {
      auth: { type: 'bearer', secret: '********' },
    });
    await t.call('POST', `/api/v1/integrations/${id}/test`, admin, { input: { phone: '+375291112233' } });
    expect(lastAuth).toBe('Bearer top-secret');

    const log = await t.call('GET', `/api/v1/integrations/${id}/log`, admin);
    expect(log.body.length).toBe(4);
    expect(Object.keys(log.body[0]).sort()).toEqual([
      'at',
      'conversationId',
      'durationMs',
      'error',
      'httpStatus',
      'ok',
      'source',
    ]);

    // Панель внешних данных клиента (M-CARD-07).
    const contact = newId();
    await t.pool.query(
      `INSERT INTO contact (id, display_name, phone) VALUES ($1, 'Клиент', '+375291112233')`,
      [contact],
    );
    const panel = await t.call('GET', `/api/v1/contacts/${contact}/external-data`, op);
    expect(panel.body).toEqual([
      {
        operationId: id,
        name: 'Баланс (тест)',
        ok: true,
        error: null,
        fields: [
          { name: 'balance', label: 'Баланс', value: '1234.5' },
          { name: 'station', label: 'АЗС', value: 'АЗС 1' },
        ],
      },
    ]);
    const resp = await t.login('resp1@demo.local');
    expect((await t.call('GET', `/api/v1/contacts/${contact}/external-data`, resp)).status).toBe(403);
  });

  it('объявления о сбоях ведёт и супервизор; оператору — нельзя', async () => {
    const audio = (await upload(wav(1), 'name=Сбой')).body.id as string;
    const sup = await t.login('supervisor@demo.local');
    const r = await t.call('POST', '/api/v1/dict/announcements', sup, {
      name: 'Сбой оплаты картой',
      audioId: audio,
    });
    expect(r.status).toBe(201);
    expect((await t.call('POST', `/api/v1/dict/announcements/${r.body.id}/deactivate`, sup, {})).status).toBe(
      200,
    );
    expect(
      (await t.call('POST', '/api/v1/dict/announcements', op, { name: 'x', audioId: audio })).status,
    ).toBe(403);
  });

  it('домен: вызов в IVR → очередь с темой → обратно по сценарию; завершение в IVR; перезвон не закрывается; CSAT один раз', async () => {
    const flow = await t.call('POST', '/api/v1/flows', admin, { name: 'Для домена', dids: ['1000'] });
    const version = newId();
    await t.pool.query(`INSERT INTO flow_version (id, flow_id, version, graph) VALUES ($1, $2, 1, '{}')`, [
      version,
      flow.body.id,
    ]);
    const start = (phone: string) =>
      withTx(t.pool, (tx) =>
        startInboundCall(tx, {
          node: 'asterisk-1',
          clientChannel: newId(),
          callerNumber: phone,
          did: '1000',
          ivr: { flowVersionId: version, flowName: 'Для домена, версия 1', state: { flow: { node: 's' } } },
        }),
      );
    const st = async (callId: string) =>
      (
        await t.pool.query(
          `SELECT c.state, cv.status, cv.topic_id, cv.priority, cv.callback_requested, cv.queue_id
             FROM call c JOIN conversation cv ON cv.id = c.conversation_id WHERE c.id = $1`,
          [callId],
        )
      ).rows[0];

    const a = (await start('+375291000001'))!;
    expect(await st(a.callId)).toMatchObject({ state: 'ivr', status: 'bot' });
    const q = (await t.pool.query(`SELECT id, priority FROM queue WHERE name = 'Общая'`)).rows[0];
    const topic = (await t.pool.query(`SELECT id FROM topic WHERE name = 'Баланс бонусов'`)).rows[0].id;
    expect(
      await withTx(t.pool, (tx) =>
        enqueueFromIvr(tx, a.callId, { queueId: q.id, topicId: topic, priority: 7 }),
      ),
    ).toBe(true);
    expect(await st(a.callId)).toMatchObject({
      state: 'queued',
      status: 'queued',
      topic_id: topic,
      priority: q.priority + 7,
    });
    expect(await withTx(t.pool, (tx) => leaveQueueToIvr(tx, a.callId, 'timeout'))).toBe(true);
    expect(await st(a.callId)).toMatchObject({ state: 'ivr', status: 'bot' });
    await withTx(t.pool, (tx) => endCall(tx, a.callId, 'client_hangup'));
    expect(await st(a.callId)).toMatchObject({ state: 'ended', status: 'closed' });

    // Голосовое сообщение: задача «перезвонить» в очереди; отбой клиента её не закрывает.
    const b = (await start('+375291000002'))!;
    await withTx(t.pool, (tx) =>
      createCallbackTask(tx, b.callId, { queueId: q.id, mode: 'voicemail', withRecording: true }),
    );
    await withTx(t.pool, (tx) => endCall(tx, b.callId, 'client_hangup'));
    expect(await st(b.callId)).toMatchObject({ state: 'ended', status: 'queued', callback_requested: true });
    const msgs = await t.pool.query(`SELECT body FROM message WHERE conversation_id = $1 ORDER BY seq`, [
      b.conversationId,
    ]);
    expect(msgs.rows.map((m) => m.body)).toContain(
      'Клиент оставил голосовое сообщение (вкладка «Звонки») — перезвоните по номеру +375291000002',
    );
    const list = await t.call('GET', '/api/v1/conversations?tab=queue&callback=true', op);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(b.conversationId);

    expect(await withTx(t.pool, (tx) => saveCsat(tx, b.callId, 4))).toBe(true);
    expect(await withTx(t.pool, (tx) => saveCsat(tx, b.callId, 5))).toBe(false);
    const csat = await t.pool.query(`SELECT score, channel_kind FROM csat_rating WHERE call_id = $1`, [
      b.callId,
    ]);
    expect(csat.rows).toEqual([{ score: 4, channel_kind: 'voice' }]);
  });
});
