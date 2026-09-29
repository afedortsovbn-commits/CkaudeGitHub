/** Интеграционные тесты Ф9: ключи API, публичный API, внешний канал, анализ, webhooks, Bot Gateway, экспорт/импорт. */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type EventEnvelope, newId } from '@cc/contracts';
import {
  afterInbound,
  type DeliveryOptions,
  fanOutEvent,
  ingestInbound,
  processWebhookQueue,
  sweepExternalBots,
} from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBotDemo } from '../cli/bot-demo-seed';
import { exportConfig } from '../config/config-transfer';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp, DEMO_PW, TEST_SECRETS_KEY } from './setup';

interface Received {
  path: string;
  headers: Record<string, string>;
  raw: string;
  body: { id: string; type: string; data: Record<string, unknown> };
}

function wav(samples = 800): Buffer {
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

describe.skipIf(!ADMIN_URL)('Интеграции Ф9 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let op: string;
  let receiver: Server;
  let base: string;
  let down = false;
  const got: Received[] = [];
  const delivery = (): DeliveryOptions => ({
    secretsKey: TEST_SECRETS_KEY,
    baseUrl: 'https://cc.test',
    maxBackoffS: 30,
    maxAgeH: 24,
  });
  /** Как worker: события журнала → доставки по подпискам (повтор безопасен), затем отправка. */
  const pump = async () => {
    const { rows } = await t.pool.query<EventEnvelope & { occurred_at: Date }>(
      `SELECT id, type, version, occurred_at, source, data FROM event ORDER BY occurred_at`,
    );
    for (const r of rows)
      await fanOutEvent(t.pool, { ...r, occurredAt: r.occurred_at.toISOString() } as EventEnvelope);
    return processWebhookQueue(t.pool, delivery());
  };
  /** «Прошло время»: наступил момент пробной попытки подписки и повторов её доставок. */
  const elapse = async () => {
    await t.pool.query(
      `UPDATE webhook_subscription SET next_probe_at = now() - interval '1 second' WHERE id = $1`,
      [subId],
    );
    await t.pool.query(
      `UPDATE webhook_delivery SET next_attempt_at = now() - interval '1 second' WHERE subscription_id = $1 AND status = 'pending'`,
      [subId],
    );
  };
  const queueId = async () => (await t.pool.query(`SELECT id FROM queue WHERE name = 'Общая'`)).rows[0].id;

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local', DEMO_PW);
    op = await t.login('operator1@demo.local');
    receiver = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        if (down) return res.writeHead(503).end();
        got.push({
          path: req.url ?? '',
          headers: req.headers as Record<string, string>,
          raw,
          body: JSON.parse(raw) as Received['body'],
        });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    receiver?.close();
    await t?.cleanup();
  });

  const key = async (body: Record<string, unknown>) => {
    const r = await t.call('POST', '/api/v1/api-keys', admin, body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; key: string };
  };
  const ext = (method: string, path: string, k: string, payload?: unknown) =>
    t.call(method, `/api/v1/ext${path}`, undefined, payload, { authorization: `Bearer ${k}` });

  let apiChannel: string;
  let inboundKey: string;
  let readKey: { id: string; key: string };

  it('ключи API: выпуск (ключ — один раз), права, чужие токены, отзыв', async () => {
    expect(
      (await t.call('POST', '/api/v1/api-keys', op, { name: 'x', permissions: ['inbound'] })).status,
    ).toBe(403);
    readKey = await key({ name: 'Анализатор', permissions: ['conversations.read', 'conversations.write'] });
    expect(readKey.key).toMatch(/^cck_/);
    const list = await t.call('GET', '/api/v1/api-keys', admin);
    const row = list.body.find((k: { id: string }) => k.id === readKey.id);
    expect(row.prefix).toBe(readKey.key.slice(0, 12));
    expect(JSON.stringify(list.body)).not.toContain(readKey.key);
    expect(JSON.stringify(list.body)).not.toContain('keyHash');

    const me = await ext('GET', '/me', readKey.key);
    expect(me.status).toBe(200);
    expect(me.body.permissions).toEqual(['conversations.read', 'conversations.write']);
    expect((await ext('GET', '/me', 'cck_wrong')).status).toBe(401);
    // Токен сотрудника не принимается публичным API, ключ — рабочим местом.
    expect((await t.call('GET', '/api/v1/ext/me', op)).status).toBe(401);
    expect(
      (
        await t.call('GET', '/api/v1/conversations', undefined, undefined, {
          authorization: `Bearer ${readKey.key}`,
        })
      ).status,
    ).toBe(401);
    // Нет права — 403.
    expect((await ext('POST', '/inbound', readKey.key, {})).status).toBe(403);

    const tmp = await key({ name: 'Временный', permissions: ['conversations.read'] });
    expect((await ext('GET', '/conversations', tmp.key)).status).toBe(200);
    expect((await t.call('POST', `/api/v1/api-keys/${tmp.id}/revoke`, admin)).status).toBe(200);
    expect((await ext('GET', '/conversations', tmp.key)).status).toBe(401);
    const audit = await t.pool.query(
      `SELECT action FROM audit_log WHERE entity = 'api_key' AND entity_id = $1`,
      [tmp.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['create', 'revoke']));
  });

  it('внешний канал: сообщение по ключу → обращение в очереди, без дублей, клиент по телефону, поля формы', async () => {
    const ch = await t.call('POST', '/api/v1/dict/channels', admin, {
      kind: 'api',
      name: 'Форма сайта',
      queueId: await queueId(),
      config: {},
    });
    expect(ch.status).toBe(201);
    apiChannel = ch.body.id;
    // «Внешний канал» без канала — отказ.
    expect(
      (await t.call('POST', '/api/v1/api-keys', admin, { name: 'x', permissions: ['inbound'] })).status,
    ).toBe(400);
    inboundKey = (await key({ name: 'Сайт', permissions: ['inbound'], channelId: apiChannel })).key;
    const msg = {
      externalId: 'form-1',
      contact: { name: 'Пётр Формов', phone: '8 029 555-11-22' },
      text: 'Прошу перезвонить по поводу топливной карты',
      fields: { cardNumber: '7000-1111' },
    };
    const r1 = await ext('POST', '/inbound', inboundKey, msg);
    expect(r1.status, JSON.stringify(r1.body)).toBe(202);
    const r2 = await ext('POST', '/inbound', inboundKey, msg);
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.conversationId).toBe(r1.body.conversationId);
    const r3 = await ext('POST', '/inbound', inboundKey, {
      ...msg,
      externalId: 'form-2',
      text: 'Ещё вопрос',
    });
    expect(r3.body.conversationId).toBe(r1.body.conversationId);
    const conv = await t.pool.query(
      `SELECT c.status, c.channel_kind, c.fields, ct.phone, ct.display_name,
              (SELECT count(*)::int FROM message m WHERE m.conversation_id = c.id AND m.direction = 'in') AS n
         FROM conversation c JOIN contact ct ON ct.id = c.contact_id WHERE c.id = $1`,
      [r1.body.conversationId],
    );
    expect(conv.rows[0]).toMatchObject({
      status: 'queued',
      channel_kind: 'api',
      phone: '+375295551122',
      display_name: 'Пётр Формов',
      n: 2,
    });
    expect(conv.rows[0].fields).toMatchObject({ cardNumber: '7000-1111' });
    // Проверка данных: пустое сообщение, нераспознанный телефон.
    expect(
      (
        await ext('POST', '/inbound', inboundKey, {
          externalId: 'x',
          contact: { phone: 'нет телефона' },
          text: 'a',
        })
      ).status,
    ).toBe(400);
    expect(
      (await ext('POST', '/inbound', inboundKey, { externalId: 'x', contact: { externalId: 'u1' } })).status,
    ).toBe(400);
    // Оператор видит обращение в очереди.
    const q = await t.call('GET', '/api/v1/conversations?tab=queue', op);
    expect(q.body.map((c: { id: string }) => c.id)).toContain(r1.body.conversationId);
  });

  let subId: string;
  let secret: string;

  it('webhooks: подписка, подпись HMAC, фильтр по каналу, ответ оператора во внешний канал, тест-кнопка', async () => {
    const s = await t.call('POST', '/api/v1/webhooks', admin, {
      name: 'Сайт: ответы',
      url: `${base}/site`,
      eventTypes: ['message.created', 'conversation.closed'],
      channelIds: [apiChannel],
    });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    subId = s.body.id;
    secret = s.body.secret;
    expect(secret).toMatch(/^whsec_/);
    const stored = await t.pool.query(`SELECT secret FROM webhook_subscription WHERE id = $1`, [subId]);
    expect(stored.rows[0].secret).not.toContain(secret); // зашифрован
    expect(JSON.stringify((await t.call('GET', '/api/v1/webhooks', admin)).body)).not.toContain('whsec_');

    const test = await t.call('POST', `/api/v1/webhooks/${subId}/test`, admin);
    expect(test.body).toMatchObject({ ok: true, status: 200 });
    expect(got.at(-1)!.body.type).toBe('webhook.test');

    const conv = (await t.pool.query(`SELECT id FROM conversation WHERE channel_id = $1`, [apiChannel]))
      .rows[0].id as string;
    expect((await t.call('POST', `/api/v1/conversations/${conv}/take`, op)).status).toBe(200);
    expect(
      (await t.call('POST', `/api/v1/conversations/${conv}/messages`, op, { body: 'Перезвоним сегодня' }))
        .status,
    ).toBe(201);
    await t.call('POST', `/api/v1/conversations/${conv}/messages`, op, { body: 'внутреннее', note: true });
    got.length = 0;
    await pump();
    const site = got.filter((g) => g.path === '/site');
    // Входящие клиента, системное «подключился» и ответ оператора — да; заметка — нет.
    const texts = site.map((g) => (g.body.data.message as { body: string }).body);
    expect(texts).toContain('Перезвоним сегодня');
    expect(texts).toContain('Прошу перезвонить по поводу топливной карты');
    expect(texts).not.toContain('внутреннее');
    for (const g of site) {
      expect(g.body.type).toBe('message.created');
      const expected = `sha256=${createHmac('sha256', secret)
        .update(`${g.headers['x-cc-timestamp']}.${g.raw}`)
        .digest('hex')}`;
      expect(g.headers['x-cc-signature']).toBe(expected);
      expect(g.headers['x-cc-event']).toBe('message.created');
    }
    // Повторная раскладка тех же событий — без дублей.
    const before = got.length;
    await pump();
    expect(got.length).toBe(before);
    const log = await t.call('GET', `/api/v1/webhooks/${subId}/deliveries`, admin);
    expect(log.body.filter((d: { status: string }) => d.status === 'sent').length).toBe(site.length + 1);
  });

  let closedConv: string;

  it('анализ (демо-сценарий 8): webhook о закрытии → внешняя система пишет поля, теги и заметку через API', async () => {
    const hook = await t.call('POST', '/api/v1/webhooks', admin, {
      name: 'Анализатор',
      url: `${base}/analyzer`,
      eventTypes: ['conversation.closed'],
    });
    const conv = (await t.pool.query(`SELECT id FROM conversation WHERE channel_id = $1`, [apiChannel]))
      .rows[0].id as string;
    closedConv = conv;
    const topic = (await t.pool.query(`SELECT id FROM topic WHERE name = 'Баланс бонусов'`)).rows[0].id;
    const disp = (await t.pool.query(`SELECT id FROM disposition WHERE code = 'resolved'`)).rows[0].id;
    await t.call('PATCH', `/api/v1/conversations/${conv}`, op, { topicId: topic });
    const cl = await t.call('POST', `/api/v1/conversations/${conv}/close`, op, { dispositionId: disp });
    expect(cl.status, JSON.stringify(cl.body)).toBe(200);
    got.length = 0;
    await pump();
    const closed = got.filter((g) => g.path === '/analyzer');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.body.type).toBe('conversation.closed');
    expect(closed[0]!.body.data.conversationId).toBe(conv);
    expect(got.filter((g) => g.path === '/site' && g.body.type === 'conversation.closed')).toHaveLength(1);

    // «Анализатор» читает обращение и записывает результат.
    const detail = await ext('GET', `/conversations/${conv}`, readKey.key);
    expect(detail.body).toMatchObject({
      status: 'closed',
      topicName: 'Баланс бонусов',
      disposition: 'Решено на 1-й линии',
    });
    const msgs = await ext('GET', `/conversations/${conv}/messages`, readKey.key);
    expect(msgs.body.some((m: { direction: string }) => m.direction === 'note')).toBe(false);
    const res = await ext('PATCH', `/conversations/${conv}`, readKey.key, {
      fields: { sentiment: 'нейтральная', score: 0.4 },
      addTags: ['требует контроля'],
      note: 'Анализ: клиент просит перезвонить, тональность нейтральная',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fields).toMatchObject({ sentiment: 'нейтральная', score: 0.4, cardNumber: '7000-1111' });
    expect(res.body.tags).toEqual(['Требует контроля']);
    const card = await t.call('GET', `/api/v1/conversations/${conv}/messages`, op);
    const note = card.body.find(
      (m: { direction: string; body: string }) => m.direction === 'note' && m.body.startsWith('Анализ'),
    );
    expect(note.meta).toEqual({ external: 'Анализатор' });
    expect(
      (await ext('PATCH', `/conversations/${conv}`, readKey.key, { addTags: ['Нет такого'] })).status,
    ).toBe(400);
    expect((await ext('PATCH', `/conversations/${conv}`, inboundKey, { note: 'x' })).status).toBe(403);
    // Удаление поля.
    const del = await ext('PATCH', `/conversations/${conv}`, readKey.key, { fields: { score: null } });
    expect(del.body.fields.score).toBeUndefined();
    await t.call('POST', `/api/v1/webhooks/${hook.body.id}/deactivate`, admin);
  });

  it('область видимости ключа: обращение другого предприятия — 404 и нет в списке', async () => {
    const e1 = (await t.pool.query(`SELECT id FROM enterprise WHERE code = 'E1'`)).rows[0].id;
    const e2 = (await t.pool.query(`SELECT id FROM enterprise WHERE code <> 'E1' LIMIT 1`)).rows[0].id;
    const scoped = await key({
      name: 'Только Север',
      permissions: ['conversations.read'],
      scopeRules: [{ enterpriseIds: [e1], departmentIds: null, topicIds: null }],
    });
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [closedConv, e2]);
    expect((await ext('GET', `/conversations/${closedConv}`, scoped.key)).status).toBe(404);
    expect((await ext('GET', `/conversations/${closedConv}/messages`, scoped.key)).status).toBe(404);
    const list = await ext('GET', '/conversations?status=all&limit=200', scoped.key);
    expect(list.body.map((c: { id: string }) => c.id)).not.toContain(closedConv);
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [closedConv, e1]);
    expect((await ext('GET', `/conversations/${closedConv}`, scoped.key)).status).toBe(200);
    expect((await ext('GET', `/conversations/${newId()}`, scoped.key)).status).toBe(404);
  });

  it('получатель упал: операторы работают, доставка ждёт с задержкой и догоняет после восстановления, без дублей', async () => {
    down = true;
    const r = await ext('POST', '/inbound', inboundKey, {
      externalId: 'form-down-1',
      contact: { externalId: 'user-77', name: 'Клиент Сбоя' },
      text: 'Первое при сбое',
    });
    const conv = r.body.conversationId as string;
    expect((await t.call('POST', `/api/v1/conversations/${conv}/take`, op)).status).toBe(200);
    for (let i = 0; i < 5; i++)
      expect(
        (await t.call('POST', `/api/v1/conversations/${conv}/messages`, op, { body: `Ответ при сбое ${i}` }))
          .status,
      ).toBe(201);
    got.length = 0;
    await pump();
    const sub = await t.pool.query(
      `SELECT failures, next_probe_at, last_error FROM webhook_subscription WHERE id = $1`,
      [subId],
    );
    expect(sub.rows[0].failures).toBe(1);
    expect(sub.rows[0].last_error).toBe('HTTP 503');
    expect(new Date(sub.rows[0].next_probe_at).getTime()).toBeGreaterThan(Date.now());
    // До пробного момента — ни одной попытки (не «долбим» упавшего получателя).
    expect(await processWebhookQueue(t.pool, delivery())).toBe(0);
    const pending = await t.pool.query(
      `SELECT count(*)::int AS n FROM webhook_delivery WHERE subscription_id = $1 AND status = 'pending'`,
      [subId],
    );
    expect(pending.rows[0].n).toBeGreaterThanOrEqual(7);
    // Пробная попытка при всё ещё лежащем получателе — одна доставка, задержка растёт.
    await elapse();
    expect(await processWebhookQueue(t.pool, delivery())).toBe(1);
    expect(
      (await t.pool.query(`SELECT failures FROM webhook_subscription WHERE id = $1`, [subId])).rows[0]
        .failures,
    ).toBe(2);

    // Получатель восстановился: пробная доставка успешна — вся очередь уходит сразу.
    down = false;
    await elapse();
    // Два «экземпляра worker» одновременно — каждое событие ровно один раз.
    await Promise.all([processWebhookQueue(t.pool, delivery()), processWebhookQueue(t.pool, delivery())]);
    await Promise.all([processWebhookQueue(t.pool, delivery()), processWebhookQueue(t.pool, delivery())]);
    const texts = got.map((g) => (g.body.data.message as { body: string } | undefined)?.body);
    for (let i = 0; i < 5; i++) expect(texts.filter((x) => x === `Ответ при сбое ${i}`)).toHaveLength(1);
    expect(texts).toContain('Первое при сбое');
    const ids = got.map((g) => g.body.id);
    expect(new Set(ids).size).toBe(ids.length);
    const after = await t.pool.query(
      `SELECT failures, next_probe_at FROM webhook_subscription WHERE id = $1`,
      [subId],
    );
    expect(after.rows[0]).toMatchObject({ failures: 0, next_probe_at: null });
    expect(
      (
        await t.pool.query(
          `SELECT count(*)::int AS n FROM webhook_delivery WHERE subscription_id = $1 AND status = 'pending'`,
          [subId],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('истёкшие доставки → «не доставлено»; «Повторить» возвращает их в очередь', async () => {
    down = true;
    await ext('POST', '/inbound', inboundKey, {
      externalId: 'form-expire',
      contact: { externalId: 'user-88' },
      text: 'Истекает',
    });
    await pump();
    await t.pool.query(
      `UPDATE webhook_delivery SET created_at = now() - interval '2 days' WHERE subscription_id = $1 AND status = 'pending'`,
      [subId],
    );
    await elapse();
    await processWebhookQueue(t.pool, { ...delivery(), maxAgeH: 1 });
    const failed = await t.call('GET', `/api/v1/webhooks/${subId}/deliveries?status=failed`, admin);
    expect(failed.body.length).toBeGreaterThanOrEqual(1);
    down = false;
    const retry = await t.call('POST', `/api/v1/webhooks/${subId}/retry`, admin, {});
    expect(retry.body.requeued).toBeGreaterThanOrEqual(1);
    got.length = 0;
    await processWebhookQueue(t.pool, delivery());
    await processWebhookQueue(t.pool, delivery());
    expect(got.some((g) => (g.body.data.message as { body?: string } | undefined)?.body === 'Истекает')).toBe(
      true,
    );
  });

  it('Bot Gateway: ход боту, ответ с кнопками, перевод на оператора; не ответил — диалог к оператору', async () => {
    const bot = await t.call('POST', '/api/v1/webhooks', admin, {
      kind: 'bot',
      name: 'Внешний бот',
      url: `${base}/bot`,
      botTimeoutS: 20,
    });
    expect(bot.status).toBe(201);
    const ch = await t.call('POST', '/api/v1/dict/channels', admin, {
      kind: 'webchat',
      name: 'Чат с внешним ботом',
      queueId: await queueId(),
      botWebhookId: bot.body.id,
      config: { public_key: `ext-bot-${Date.now()}`, allowed_origins: ['*'] },
    });
    expect(ch.status, JSON.stringify(ch.body)).toBe(201);
    const botKey = (await key({ name: 'Бот', permissions: ['bot.reply'] })).key;
    const say = (identity: string, body: string) =>
      withTx(t.pool, async (tx) => {
        const r = await ingestInbound(tx, {
          id: newId(),
          channelId: ch.body.id,
          channelKind: 'webchat',
          externalId: newId(),
          identity: { kind: 'webchat', value: identity },
          body,
          attachments: [],
          receivedAt: Date.now(),
        });
        await afterInbound(tx, { conversationId: r.conversationId, created: r.created, body });
        return r.conversationId;
      });
    const conv = await say('ext-bot-client', 'Здравствуйте');
    const st = await t.pool.query(`SELECT status, bot_state, bot_wake_at FROM conversation WHERE id = $1`, [
      conv,
    ]);
    expect(st.rows[0].status).toBe('bot');
    expect(st.rows[0].bot_state).toEqual({ external: bot.body.id });
    expect(st.rows[0].bot_wake_at).not.toBeNull();
    got.length = 0;
    await processWebhookQueue(t.pool, delivery());
    const turn = got.find((g) => g.path === '/bot')!;
    expect(turn.body.type).toBe('conversation.bot_turn');
    expect(turn.body.data).toMatchObject({
      conversationId: conv,
      message: { text: 'Здравствуйте' },
      replyUrl: `https://cc.test/api/v1/ext/conversations/${conv}/messages`,
    });
    // Бот отвечает с кнопками — срок снят.
    const reply = await ext('POST', `/conversations/${conv}/messages`, botKey, {
      text: 'Чем помочь?',
      buttons: ['Баланс', 'Оператор'],
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.meta).toMatchObject({
      auto: 'bot',
      external: 'Бот',
      buttons: [{ label: 'Баланс' }, { label: 'Оператор' }],
    });
    expect(
      (await t.pool.query(`SELECT bot_wake_at FROM conversation WHERE id = $1`, [conv])).rows[0].bot_wake_at,
    ).toBeNull();
    // Следующее сообщение клиента — новый ход.
    await say('ext-bot-client', 'Оператор');
    got.length = 0;
    await processWebhookQueue(t.pool, delivery());
    expect(
      got.filter((g) => g.path === '/bot').map((g) => (g.body.data.message as { text: string }).text),
    ).toEqual(['Оператор']);
    // Ключ без права бота — 403; перевод на оператора с заметкой.
    expect((await ext('POST', `/conversations/${conv}/handoff`, readKey.key, {})).status).toBe(403);
    const h = await ext('POST', `/conversations/${conv}/handoff`, botKey, {
      text: 'Соединяю с оператором',
      note: 'Клиент хочет оператора',
    });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    const after = await t.pool.query(`SELECT status FROM conversation WHERE id = $1`, [conv]);
    expect(after.rows[0].status).toBe('queued');
    const m = await t.pool.query<{ direction: string; body: string }>(
      `SELECT direction, body FROM message WHERE conversation_id = $1 ORDER BY sent_at, seq`,
      [conv],
    );
    expect(m.rows.map((x) => x.body)).toEqual(
      expect.arrayContaining(['Чем помочь?', 'Соединяю с оператором', 'Клиент хочет оператора']),
    );
    // После перевода бот уже не отвечает.
    expect((await ext('POST', `/conversations/${conv}/messages`, botKey, { text: 'ещё' })).status).toBe(409);

    // Бот молчит: срок истёк — к оператору; запоздавший ход не отправляется.
    const conv2 = await say('ext-bot-client-2', 'Алло');
    expect(await withTx(t.pool, (tx) => sweepExternalBots(tx, new Date(Date.now() + 60_000)))).toBe(1);
    const c2 = await t.pool.query(`SELECT status FROM conversation WHERE id = $1`, [conv2]);
    expect(c2.rows[0].status).toBe('queued');
    expect(
      (
        await t.pool.query(`SELECT body FROM message WHERE conversation_id = $1 AND direction = 'system'`, [
          conv2,
        ])
      ).rows.map((r) => r.body),
    ).toContain('Внешний бот не ответил вовремя — диалог передан оператору');
    got.length = 0;
    await processWebhookQueue(t.pool, delivery());
    expect(got.filter((g) => g.path === '/bot')).toHaveLength(0);
    const stale = await t.pool.query(
      `SELECT status, last_error FROM webhook_delivery WHERE conversation_id = $1 AND event_type = 'conversation.bot_turn'`,
      [conv2],
    );
    expect(stale.rows[0]).toMatchObject({ status: 'failed', last_error: 'Диалог уже передан оператору' });
  });

  it('OpenAPI доступен без входа', async () => {
    const r = await t.call('GET', '/api/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.1.0');
    expect(Object.keys(r.body.paths)).toContain('/api/v1/ext/inbound');
  });

  it('экспорт/импорт: импорт в чистую систему воспроизводит настройки; повторный импорт ничего не меняет', async () => {
    await withTx(t.pool, (tx) => seedBotDemo(tx, { llmUrl: 'http://llm.local/v1' }));
    const audio = await t.call('POST', '/api/v1/ivr/audio?name=Приветствие', admin, wav(), {
      'content-type': 'audio/wav',
    });
    expect(audio.status, JSON.stringify(audio.body)).toBe(201);
    await t.call('PATCH', '/api/v1/settings', admin, { 'ticket.default_response_days': 12 });
    await t.call('POST', '/api/v1/dict/integrations', admin, {
      code: 'crm.lookup',
      name: 'CRM',
      url: 'http://crm.local/x',
      auth: { type: 'bearer', secret: 'top-secret' },
    });
    const exp = await t.call('GET', '/api/v1/config/export', admin);
    expect(exp.status).toBe(200);
    expect(exp.res.headers['content-disposition']).toMatch(/attachment; filename="cc-config-/);
    const doc = JSON.parse(exp.res.body);
    expect(doc.format).toBe('cc-config');
    expect(doc.sections.flows.length).toBeGreaterThan(0);
    expect(doc.files[audio.body.id]).toBeTruthy();
    expect(exp.res.body).not.toContain('top-secret');
    expect(exp.res.body).not.toContain('operator1@demo.local');
    expect(
      doc.sections.settings.find((s: { key: string }) => s.key === 'ticket.digest_last_date'),
    ).toBeUndefined();
    // Оператор не может.
    expect((await t.call('GET', '/api/v1/config/export', op)).status).toBe(403);

    const clean = await createTestApp({ seed: false });
    try {
      const cAdmin = await clean.login('admin@test.local', DEMO_PW);
      // В чистой системе уже есть тег с тем же названием (другой id) — ссылки перенаправятся на него.
      const tag = await clean.call('POST', '/api/v1/dict/tags', cAdmin, { name: 'VIP' });
      const body = Buffer.from(exp.res.body);
      const dry = await clean.call('POST', '/api/v1/config/import?dryRun=true', cAdmin, body, {
        'content-type': 'application/octet-stream',
      });
      expect(dry.status, JSON.stringify(dry.body)).toBe(200);
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.sections.find((s: { key: string }) => s.key === 'flows').created).toBeGreaterThan(0);
      expect((await clean.pool.query(`SELECT count(*)::int AS n FROM flow`)).rows[0].n).toBe(0);

      const imp = await clean.call('POST', '/api/v1/config/import', cAdmin, body, {
        'content-type': 'application/octet-stream',
      });
      expect(imp.status, JSON.stringify(imp.body)).toBe(200);
      expect(imp.body.remapped).toBeGreaterThanOrEqual(1);
      expect(imp.body.warnings.join(' ')).toMatch(/CRM.*секрет/);
      const tags = await clean.pool.query(`SELECT id FROM tag WHERE name = 'VIP'`);
      expect(tags.rows).toEqual([{ id: tag.body.id }]);

      // Сравнение: всё, что выгружено из исходной системы, воспроизведено (кроме перенаправленного id тега).
      const again = await exportConfig(clean.pool, clean.ctx.storage);
      const norm = (d: { sections: Record<string, unknown[]>; files?: Record<string, string> }) => {
        const s = JSON.stringify({ sections: d.sections, files: d.files }).replaceAll(tag.body.id, 'TAG');
        const origTag = doc.sections.tags.find((x: { name: string }) => x.name === 'VIP').id as string;
        return JSON.parse(s.replaceAll(origTag, 'TAG'));
      };
      const a = norm(doc);
      const b = norm(again);
      for (const k of Object.keys(a.sections)) {
        if (k === 'integrations') continue; // секрет не переносится
        expect(b.sections[k], k).toEqual(a.sections[k]);
      }
      expect(b.files).toEqual(a.files);
      // Опубликованная версия бота на месте; фраза — в хранилище.
      const flow = await clean.pool.query(
        `SELECT f.published_version_id, v.version FROM flow f JOIN flow_version v ON v.id = f.published_version_id`,
      );
      expect(flow.rows.length).toBeGreaterThan(0);
      const setting = await clean.pool.query(
        `SELECT value FROM system_setting WHERE key = 'ticket.default_response_days'`,
      );
      expect(setting.rows[0].value).toBe(12);
      const cfgEvents = await clean.pool.query(
        `SELECT count(*)::int AS n FROM outbox WHERE subject = 'cc.events.config.changed'`,
      );
      expect(cfgEvents.rows[0].n).toBeGreaterThanOrEqual(1);

      // Повторный импорт того же файла — ничего не меняется.
      const repeat = await clean.call('POST', '/api/v1/config/import', cAdmin, body, {
        'content-type': 'application/octet-stream',
      });
      expect(
        repeat.body.sections
          .filter((s: { key: string }) => s.key !== 'integrations')
          .every((s: { created: number; updated: number }) => s.created === 0 && s.updated === 0),
        JSON.stringify(repeat.body.sections),
      ).toBe(true);
      // Чужой файл — понятная ошибка.
      const bad = await clean.call('POST', '/api/v1/config/import', cAdmin, Buffer.from('{"a":1}'), {
        'content-type': 'application/octet-stream',
      });
      expect(bad.status).toBe(400);
    } finally {
      await clean.cleanup();
    }
  });
});
