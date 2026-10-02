/** Интеграционные тесты Ф14: тайм-аут молчания в боте, позиция в очереди, супервизор (перехват, подсказки). */
import { newId } from '@cc/contracts';
import {
  afterInbound,
  endCall,
  ingestInbound,
  queuePosition,
  setSupervisorMode,
  startInboundCall,
  sweepBotWaits,
  sweepInactivity,
  takeoverCall,
} from '@cc/domain';
import type { FlowGraph } from '@cc/flow-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp, DEMO_PW } from './setup';

describe.skipIf(!ADMIN_URL)('Ф14 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let queueId: string;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local', DEMO_PW);
    queueId = (await t.pool.query(`SELECT id FROM queue WHERE name = 'Общая'`)).rows[0].id;
  }, 60_000);
  afterAll(async () => {
    await t?.cleanup();
  });

  /** Входящее сообщение так же, как его обрабатывает worker: сохранение + автоматика одной транзакцией. */
  const inbound = (channel: string, externalId: string, identity: string, body: string) =>
    withTx(t.pool, async (tx) => {
      const r = await ingestInbound(tx, {
        id: newId(),
        channelId: channel,
        channelKind: 'webchat',
        externalId,
        identity: { kind: 'webchat', value: identity },
        body,
        attachments: [],
        receivedAt: Date.now(),
      });
      if (!r.duplicate)
        await afterInbound(tx, { conversationId: r.conversationId, created: r.created, body });
      return r;
    });
  const messages = async (conversationId: string) =>
    (
      await t.pool.query<{ direction: string; body: string; meta: Record<string, unknown> }>(
        `SELECT direction, body, meta FROM message WHERE conversation_id = $1 ORDER BY sent_at, seq`,
        [conversationId],
      )
    ).rows;
  const later = (s: number) => new Date(Date.now() + s * 1000);
  const status = async (id: string) =>
    (await t.pool.query(`SELECT status FROM conversation WHERE id = $1`, [id])).rows[0].status as string;

  it('бот: клиент молчит → напоминание → «нет ответа» → оператор; ответ клиента отменяет ожидание', async () => {
    const graph: FlowGraph = {
      version: 1,
      kind: 'text',
      nodes: [
        { id: 'start', type: 'start', params: {} },
        {
          id: 'menu',
          type: 'buttons',
          params: {
            text: 'Выберите тему',
            buttons: [{ id: 'b', label: 'Баланс' }],
            retries: 1,
            waitSec: 60,
            reminders: 1,
            remindText: 'Вы ещё здесь? Выберите тему.',
          },
        },
        { id: 'silent', type: 'message', params: { text: 'Не дождались ответа — зову оператора.' } },
        { id: 'op', type: 'handoff', params: { queueId, text: '' } },
        { id: 'bye', type: 'hangup', params: { text: 'Пока!' } },
      ],
      edges: [
        { id: '1', source: 'start', exit: 'next', target: 'menu' },
        { id: '2', source: 'menu', exit: 'btn:b', target: 'bye' },
        { id: '3', source: 'menu', exit: 'other', target: 'op' },
        { id: '4', source: 'menu', exit: 'noanswer', target: 'silent' },
        { id: '5', source: 'silent', exit: 'next', target: 'op' },
      ],
    };
    const flow = await t.call('POST', '/api/v1/flows', admin, { name: 'Бот с ожиданием', kind: 'text' });
    await t.call('PATCH', `/api/v1/flows/${flow.body.id}`, admin, { draft: graph });
    const pub = await t.call('POST', `/api/v1/flows/${flow.body.id}/publish`, admin);
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    const ch = await t.call('POST', '/api/v1/dict/channels', admin, {
      kind: 'webchat',
      name: 'Сайт с ботом (Ф14)',
      queueId,
      botFlowId: flow.body.id,
      config: { public_key: 'bot-wait-key', allowed_origins: ['*'] },
    });
    expect(ch.status).toBe(201);
    // Правило автозакрытия на тот же канал: пока бот ждёт с тайм-аутом, оно не срабатывает.
    await t.call('POST', '/api/v1/dict/auto-replies', admin, {
      name: 'Молчание (Ф14)',
      kind: 'inactivity',
      channelIds: [ch.body.id],
      text: 'Вы ещё здесь? (автозакрытие)',
      params: { warnAfterSec: 10, closeAfterSec: 10 },
    });

    const conv = (await inbound(ch.body.id, 'w-1', 'client-wait', 'здравствуйте')).conversationId;
    expect(await status(conv)).toBe('bot');
    const st = (await t.pool.query(`SELECT bot_state FROM conversation WHERE id = $1`, [conv])).rows[0]
      .bot_state;
    expect(st.wait).toMatchObject({ node: 'menu', attempt: 0, reminded: 0 });
    // До срока — ничего; автозакрытие не трогает диалог, который ждёт бот.
    await withTx(t.pool, (tx) => sweepBotWaits(tx, later(30)));
    await withTx(t.pool, (tx) => sweepInactivity(tx, later(30)));
    expect((await messages(conv)).map((m) => m.body)).toEqual(['здравствуйте', 'Выберите тему']);
    // Срок истёк — напоминание (с кнопками), ожидание заново; повторный обход того же срока — без дубля.
    await withTx(t.pool, (tx) => sweepBotWaits(tx, later(61)));
    await withTx(t.pool, (tx) => sweepBotWaits(tx, later(62)));
    let m = await messages(conv);
    expect(m.map((x) => x.body)).toEqual(['здравствуйте', 'Выберите тему', 'Вы ещё здесь? Выберите тему.']);
    expect(m[2]!.meta).toMatchObject({ auto: 'bot', buttons: [{ id: 'b', label: 'Баланс' }] });
    // Второй срок — «нет ответа» → сообщение → оператор.
    await withTx(t.pool, (tx) => sweepBotWaits(tx, later(200)));
    m = await messages(conv);
    expect(m.map((x) => x.body)).toContain('Не дождались ответа — зову оператора.');
    expect(await status(conv)).toBe('queued');
    expect(
      (await t.pool.query(`SELECT bot_state ? 'wait' AS w FROM conversation WHERE id = $1`, [conv])).rows[0]
        .w,
    ).toBe(false);

    // Ответ клиента отменяет ожидание: срок прошёл, но шаг уже другой — перехода нет.
    const conv2 = (await inbound(ch.body.id, 'w-2', 'client-wait-2', 'привет')).conversationId;
    await inbound(ch.body.id, 'w-3', 'client-wait-2', 'баланс');
    expect(await status(conv2)).toBe('closed');
    await withTx(t.pool, (tx) => sweepBotWaits(tx, later(500)));
    expect((await messages(conv2)).map((x) => x.body)).not.toContain('Не дождались ответа — зову оператора.');

    // Ожидание не своего шага (например, шаг сменил прежний экземпляр worker) снимается без перехода.
    const conv3 = (await inbound(ch.body.id, 'w-4', 'client-wait-3', 'привет')).conversationId;
    await t.pool.query(
      `UPDATE conversation SET bot_state = jsonb_set(bot_state, '{attempt}', '1') WHERE id = $1`,
      [conv3],
    );
    await withTx(t.pool, (tx) => sweepBotWaits(tx, later(61)));
    expect((await messages(conv3)).map((x) => x.body)).toEqual(['привет', 'Выберите тему']);
    expect(
      (await t.pool.query(`SELECT bot_state ? 'wait' AS w FROM conversation WHERE id = $1`, [conv3])).rows[0]
        .w,
    ).toBe(false);
  });
  const enterprise = async (code: string) =>
    (await t.pool.query(`SELECT id FROM enterprise WHERE code = $1`, [code])).rows[0].id as string;
  const userId = async (email: string) =>
    (await t.pool.query(`SELECT id FROM app_user WHERE email = $1`, [email])).rows[0].id as string;
  const lastEvent = async (conversationId: string, type = 'cc.events.conversation.updated') =>
    (
      await t.pool.query(
        `SELECT payload FROM outbox WHERE subject = $2 AND payload #>> '{data,conversationId}' = $1
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [conversationId, type],
      )
    ).rows[0]?.payload.data as Record<string, unknown> | undefined;

  it('позиция в очереди: опция очереди (по умолчанию выкл.), порядок router, {{позиция}} в «в очереди»', async () => {
    const q = await t.call('POST', '/api/v1/dict/queues', admin, {
      name: 'Позиция (Ф14)',
      channels: ['webchat'],
    });
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({ announcePosition: false, announcePositionEveryS: 60 });
    const ch = await t.call('POST', '/api/v1/dict/channels', admin, {
      kind: 'webchat',
      name: 'Сайт (позиция)',
      queueId: q.body.id,
      config: { public_key: 'position-key', allowed_origins: ['*'] },
    });
    expect(ch.status, JSON.stringify(ch.body)).toBe(201);
    await t.call('POST', '/api/v1/dict/auto-replies', admin, {
      name: 'В очереди (Ф14)',
      kind: 'queued',
      channelIds: [ch.body.id],
      text: 'Вы в очереди.{{позиция}}',
    });
    const a = await inbound(ch.body.id, 'p-1', 'client-p1', 'вопрос 1');
    // Опция выключена — переменная пустая.
    expect((await messages(a.conversationId)).map((m) => m.body)).toContain('Вы в очереди.');
    const on = await t.call('PATCH', `/api/v1/dict/queues/${q.body.id}`, admin, {
      announcePosition: true,
      announcePositionEveryS: 30,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ announcePosition: true, announcePositionEveryS: 30 });
    expect(
      (await t.call('PATCH', `/api/v1/dict/queues/${q.body.id}`, admin, { announcePositionEveryS: 5 }))
        .status,
    ).toBe(400);
    const b = await inbound(ch.body.id, 'p-2', 'client-p2', 'вопрос 2');
    expect((await messages(b.conversationId)).map((m) => m.body)).toContain('Вы в очереди.2');
    expect(await queuePosition(t.pool, a.conversationId)).toBe(1);
    expect(await queuePosition(t.pool, b.conversationId)).toBe(2);
    // Приоритет важнее времени ожидания (порядок распределения router).
    await t.pool.query(`UPDATE conversation SET priority = priority + 10 WHERE id = $1`, [b.conversationId]);
    expect(await queuePosition(t.pool, b.conversationId)).toBe(1);
    expect(await queuePosition(t.pool, a.conversationId)).toBe(2);
    // Звонки той же очереди — своя очередь ёмкости: чаты не считаются, задачи «перезвонить» — тоже.
    const voice = await withTx(t.pool, (tx) =>
      startInboundCall(tx, {
        node: 'asterisk-1',
        clientChannel: newId(),
        callerNumber: '+375295551401',
        did: '1000',
      }),
    );
    const cb = await withTx(t.pool, (tx) =>
      startInboundCall(tx, {
        node: 'asterisk-1',
        clientChannel: newId(),
        callerNumber: '+375295551402',
        did: '1000',
      }),
    );
    await t.pool.query(`UPDATE conversation SET queue_id = $2 WHERE id = ANY($1)`, [
      [voice!.conversationId, cb!.conversationId],
      q.body.id,
    ]);
    await t.pool.query(
      `UPDATE conversation SET callback_requested = true, queued_at = now() - interval '1 hour' WHERE id = $1`,
      [cb!.conversationId],
    );
    expect(await queuePosition(t.pool, voice!.conversationId)).toBe(1);
    expect(await queuePosition(t.pool, a.conversationId)).toBe(2);
    // Обращение не в очереди — позиции нет.
    await t.pool.query(`UPDATE conversation SET status = 'closed' WHERE id = $1`, [b.conversationId]);
    expect(await queuePosition(t.pool, b.conversationId)).toBeNull();
    expect(await queuePosition(t.pool, a.conversationId)).toBe(1);
    // Включение — событие config.changed (call-control и автоответы читают настройку из БД без перезапуска).
    const ev = await t.pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE subject = 'cc.events.config.changed' AND payload::text LIKE '%queue%'`,
    );
    expect(ev.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('чат: подсказка супервизора видна оператору и супервизору, не клиенту; перехват', async () => {
    const sup = await t.login('supervisor@demo.local');
    const op1 = await t.login('operator1@demo.local');
    const op2 = await t.login('operator2@demo.local');
    const op1Id = await userId('operator1@demo.local');
    const supId = await userId('supervisor@demo.local');
    const webchat = (
      await t.pool.query<{ id: string }>(
        `SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`,
      )
    ).rows[0]!.id;
    const conv = (await inbound(webchat, 'h-1', 'client-hint', 'не могу оплатить')).conversationId;
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [
      conv,
      await enterprise('E1'),
    ]);
    expect((await t.call('POST', `/api/v1/conversations/${conv}/take`, op1)).status).toBe(200);

    // Подсказка: только с правом conversations.hint; клиенту не уходит.
    expect((await t.call('POST', `/api/v1/conversations/${conv}/hint`, op2, { body: 'x' })).status).toBe(403);
    const h = await t.call('POST', `/api/v1/conversations/${conv}/hint`, sup, {
      body: 'Предложи оплату картой',
    });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    expect(h.body).toMatchObject({ direction: 'note', meta: { hint: true } });
    const bodies = async (tok: string) =>
      (await t.call('GET', `/api/v1/conversations/${conv}/messages`, tok)).body.map(
        (m: { body: string }) => m.body,
      );
    expect(await bodies(op1)).toContain('Предложи оплату картой');
    expect(await bodies(sup)).toContain('Предложи оплату картой');
    expect(await bodies(op2)).not.toContain('Предложи оплату картой');
    const contactId = (await t.call('GET', `/api/v1/conversations/${conv}`, op1)).body.contactId;
    const client = await t.ctx.tokens.signClient({
      contactId,
      channelId: webchat,
      sessionKey: 'client-hint',
    });
    const cm = (await t.call('GET', '/api/v1/client/messages', client)).body as { body: string }[];
    expect(cm.map((m) => m.body)).not.toContain('Предложи оплату картой');
    // Ответом клиенту не считается (первый ответ — по-прежнему не дан).
    expect(
      (await t.pool.query(`SELECT first_response_at FROM conversation WHERE id = $1`, [conv])).rows[0]
        .first_response_at,
    ).toBeNull();
    const msgEv = await lastEvent(conv, 'cc.events.conversation.message_created');
    expect(msgEv?.message).toMatchObject({ meta: { hint: true } });
    expect((await t.call('POST', `/api/v1/conversations/${conv}/hint`, sup, { body: '   ' })).status).toBe(
      400,
    );

    // Перехват: только с правом; обращение — у супервизора, запись в истории, событие с признаком перехвата.
    expect((await t.call('POST', `/api/v1/conversations/${conv}/takeover`, op2)).status).toBe(403);
    const tk = await t.call('POST', `/api/v1/conversations/${conv}/takeover`, sup);
    expect(tk.status, JSON.stringify(tk.body)).toBe(200);
    expect(tk.body).toMatchObject({ status: 'active', assigneeId: supId });
    expect(await bodies(sup)).toContain(
      'Супервизор Смирнова Анна (супервизор) перехватил диалог у оператора Иванов Пётр (оператор)',
    );
    expect(await lastEvent(conv)).toMatchObject({
      action: 'transferred',
      transferKind: 'user',
      takeover: true,
      byUserId: supId,
      fromUserId: op1Id,
      notifyUserIds: [op1Id],
      assigneeId: supId,
    });
    const audit = await t.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'conversation.takeover' AND entity_id = $1`,
      [conv],
    );
    expect(audit.rows[0].n).toBe(1);
    expect((await t.call('POST', `/api/v1/conversations/${conv}/takeover`, sup)).status).toBe(409);
    // Своё обращение — подсказка не нужна; оператор больше не ведёт и не видит подсказку.
    expect((await t.call('POST', `/api/v1/conversations/${conv}/hint`, sup, { body: 'x' })).status).toBe(409);
    expect(await bodies(op1)).not.toContain('Предложи оплату картой');

    // Вне области супервизора — 404 (как «не существует»).
    const other = (await inbound(webchat, 'h-2', 'client-hint-2', 'вопрос')).conversationId;
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [
      other,
      await enterprise('E2'),
    ]);
    expect((await t.call('POST', `/api/v1/conversations/${other}/takeover`, sup)).status).toBe(404);
    expect((await t.call('POST', `/api/v1/conversations/${other}/hint`, sup, { body: 'x' })).status).toBe(
      404,
    );
    // Без назначенного оператора подсказывать некому.
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [
      other,
      await enterprise('E1'),
    ]);
    expect((await t.call('POST', `/api/v1/conversations/${other}/hint`, sup, { body: 'x' })).status).toBe(
      409,
    );
    // Из очереди — тоже перехват (обращение сразу у супервизора).
    expect((await t.call('POST', `/api/v1/conversations/${other}/takeover`, sup)).body).toMatchObject({
      status: 'active',
      assigneeId: supId,
    });
  });

  it('звонок: права на суфлирование/вмешательство/перехват; режим и перехват в вызове; отметка снимается в конце', async () => {
    const sup = await t.login('supervisor@demo.local');
    const op1 = await t.login('operator1@demo.local');
    const op1Id = await userId('operator1@demo.local');
    const supId = await userId('supervisor@demo.local');
    const c = await withTx(t.pool, (tx) =>
      startInboundCall(tx, {
        node: 'asterisk-1',
        clientChannel: newId(),
        callerNumber: '+375295551403',
        did: '1000',
      }),
    );
    const agentChannel = newId();
    await t.pool.query(
      `UPDATE call SET state = 'talking', agent_user_id = $2, agent_channel = $3, connected_at = now() WHERE id = $1`,
      [c!.callId, op1Id, agentChannel],
    );
    await t.pool.query(
      `UPDATE conversation SET status = 'active', assignee_id = $2, enterprise_id = $3 WHERE id = $1`,
      [c!.conversationId, op1Id, await enterprise('E1')],
    );
    // Права проверяются до обращения к call-control (в тесте его нет — 503 означает «права есть»).
    expect((await t.call('POST', `/api/v1/calls/${c!.callId}/listen`, op1, { mode: 'whisper' })).status).toBe(
      403,
    );
    expect((await t.call('POST', `/api/v1/calls/${c!.callId}/takeover`, op1)).status).toBe(403);
    expect((await t.call('POST', `/api/v1/calls/${c!.callId}/listen`, sup, { mode: 'whisper' })).status).toBe(
      503,
    );
    expect(
      (await t.call('POST', `/api/v1/calls/${c!.callId}/supervise`, sup, { mode: 'barge' })).status,
    ).toBe(503);
    expect((await t.call('POST', `/api/v1/calls/${c!.callId}/takeover`, sup)).status).toBe(503);
    expect(
      (await t.call('POST', `/api/v1/calls/${c!.callId}/supervise`, sup, { mode: 'shout' })).status,
    ).toBe(400);
    // Без права «вмешательство» (роль изменена) — 403.
    await t.pool.query(
      `UPDATE role SET permissions = array_remove(permissions, 'calls.barge') WHERE code = 'supervisor'`,
    );
    expect(
      (await t.call('POST', `/api/v1/calls/${c!.callId}/supervise`, sup, { mode: 'barge' })).status,
    ).toBe(403);
    await t.pool.query(
      `UPDATE role SET permissions = array_append(permissions, 'calls.barge') WHERE code = 'supervisor'`,
    );
    // Звонок вне области — 404.
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [
      c!.conversationId,
      await enterprise('E2'),
    ]);
    expect((await t.call('POST', `/api/v1/calls/${c!.callId}/listen`, sup)).status).toBe(404);
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [
      c!.conversationId,
      await enterprise('E1'),
    ]);

    // Режим подключения — в строке вызова и событии conversation.call (плашка оператору).
    await withTx(t.pool, (tx) => setSupervisorMode(tx, c!.callId, { userId: supId, mode: 'whisper' }));
    expect(await lastEvent(c!.conversationId, 'cc.events.conversation.call')).toMatchObject({
      agentUserId: op1Id,
      supervisor: { userId: supId, mode: 'whisper' },
    });
    // Повтор того же режима — без нового события в журнале; отключение «чужим» — без изменений.
    await withTx(t.pool, (tx) => setSupervisorMode(tx, c!.callId, { userId: supId, mode: 'whisper' }));
    await withTx(t.pool, (tx) => setSupervisorMode(tx, c!.callId, { userId: op1Id, mode: null }));
    await withTx(t.pool, (tx) => setSupervisorMode(tx, c!.callId, { userId: supId, mode: 'barge' }));
    const ev = await t.pool.query<{ type: string }>(
      `SELECT type FROM call_event WHERE call_id = $1 AND type LIKE 'supervisor%' ORDER BY at`,
      [c!.callId],
    );
    expect(ev.rows.map((r) => r.type)).toEqual(['supervisor_whisper', 'supervisor_barge']);

    // Перехват: канал супервизора — ведущий, обращение у супервизора, событие перевода с признаком перехвата.
    const supChannel = newId();
    const r = await withTx(t.pool, (tx) =>
      takeoverCall(tx, c!.callId, { userId: supId, userName: 'Смирнова Анна', channel: supChannel }),
    );
    expect(r).toEqual({ fromUserId: op1Id });
    const call = (
      await t.pool.query(
        `SELECT agent_user_id, agent_channel, supervisor_user_id, supervisor_mode FROM call WHERE id = $1`,
        [c!.callId],
      )
    ).rows[0];
    expect(call).toEqual({
      agent_user_id: supId,
      agent_channel: supChannel,
      supervisor_user_id: null,
      supervisor_mode: null,
    });
    expect(await lastEvent(c!.conversationId)).toMatchObject({
      action: 'transferred',
      takeover: true,
      fromUserId: op1Id,
      assigneeId: supId,
      notifyUserIds: [op1Id],
    });
    const journal = await t.call('GET', `/api/v1/conversations/${c!.conversationId}/calls`, sup);
    expect(journal.body[0].events.map((e: { type: string }) => e.type)).toContain('takeover');
    // Повторный перехват завершённого/не идущего — нет.
    await withTx(t.pool, (tx) => setSupervisorMode(tx, c!.callId, { userId: op1Id, mode: 'listen' }));
    await withTx(t.pool, (tx) => endCall(tx, c!.callId, 'client_hangup'));
    expect(
      (await t.pool.query(`SELECT supervisor_user_id, supervisor_mode FROM call WHERE id = $1`, [c!.callId]))
        .rows[0],
    ).toEqual({ supervisor_user_id: null, supervisor_mode: null });
    expect(
      await withTx(t.pool, (tx) =>
        takeoverCall(tx, c!.callId, { userId: supId, userName: 'x', channel: newId() }),
      ),
    ).toBeNull();
  });
});
