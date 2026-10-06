/** Интеграционные тесты Ф7: шаблоны, база знаний, подсказки (Assist), бот, автоответы, оценка чата. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newId } from '@cc/contracts';
import { afterInbound, claimStaleBotSteps, ingestInbound, resumeBotHttp, sweepInactivity } from '@cc/domain';
import type { FlowGraph } from '@cc/flow-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp, DEMO_PW } from './setup';

describe.skipIf(!ADMIN_URL)('Автоматизация Ф7 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let op: string;
  let op2: string;
  let channelId: string;
  let queueId: string;
  let llm: Server;
  let llmUrl: string;
  let llmMode: 'ok' | 'down' | 'slow' = 'ok';
  let lastPrompt = '';
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local', DEMO_PW);
    op = await t.login('operator1@demo.local');
    op2 = await t.login('operator2@demo.local');
    channelId = (await t.pool.query(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`))
      .rows[0].id;
    queueId = (await t.pool.query(`SELECT id FROM queue WHERE name = 'Общая'`)).rows[0].id;
    // Локальный «OpenAI-совместимый» сервер: ok / 503 / ответ через 3 с.
    llm = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        lastPrompt = raw;
        if (llmMode === 'down') return res.writeHead(503).end('{}');
        const send = () =>
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(
              JSON.stringify({ choices: [{ message: { content: 'Черновик: проверю баланс и отвечу.' } }] }),
            );
        if (llmMode === 'slow') setTimeout(send, 3000);
        else send();
      });
    });
    await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
    llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  }, 60_000);
  afterAll(async () => {
    llm?.close();
    await t?.cleanup();
  });

  /** Входящее сообщение так же, как его обрабатывает worker: сохранение + автоматика одной транзакцией. */
  const inbound = (externalId: string, identity: string, body: string, channel = channelId) =>
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
      const http = r.duplicate
        ? null
        : await afterInbound(tx, { conversationId: r.conversationId, created: r.created, body });
      return { ...r, http };
    });
  const messages = async (conversationId: string) =>
    (
      await t.pool.query<{ direction: string; body: string; meta: Record<string, unknown> }>(
        `SELECT direction, body, meta FROM message WHERE conversation_id = $1 ORDER BY sent_at, seq`,
        [conversationId],
      )
    ).rows;
  const topicId = async (name: string) =>
    (await t.pool.query(`SELECT id FROM topic WHERE name = $1`, [name])).rows[0].id as string;

  it('шаблоны: личный виден и меняется только владельцем, общий создаёт только администратор; поиск по коду и тексту', async () => {
    const mine = await t.call('POST', '/api/v1/templates', op, {
      title: 'Мой ответ',
      body: 'Проверю и вернусь с ответом',
      shortcut: 'вернусь',
    });
    expect(mine.status).toBe(201);
    expect(mine.body.shared).toBe(false);
    expect(
      (await t.call('POST', '/api/v1/templates', op, { title: 'x', body: 'y', shared: true })).status,
    ).toBe(403);
    const shared = await t.call('POST', '/api/v1/templates', admin, {
      title: 'Баланс бонусов',
      body: 'Здравствуйте, {{client.name}}! Баланс видно в приложении.',
      shortcut: 'баланс',
      topicId: await topicId('Баланс бонусов'),
      shared: true,
    });
    expect(shared.body.shared).toBe(true);
    const ids = (r: { body: { id: string }[] }) => r.body.map((x) => x.id);
    expect(ids(await t.call('GET', '/api/v1/templates', op))).toEqual(
      expect.arrayContaining([mine.body.id, shared.body.id]),
    );
    expect(ids(await t.call('GET', '/api/v1/templates', op2))).not.toContain(mine.body.id);
    expect((await t.call('PATCH', `/api/v1/templates/${mine.body.id}`, op2, { title: 'чужой' })).status).toBe(
      404,
    );
    expect(
      (await t.call('PATCH', `/api/v1/templates/${shared.body.id}`, op, { title: 'нельзя' })).status,
    ).toBe(403);
    expect(ids(await t.call('GET', `/api/v1/templates?q=${encodeURIComponent('бал')}`, op))[0]).toBe(
      shared.body.id,
    );
    // Полнотекстовый поиск: другая словоформа.
    expect(ids(await t.call('GET', `/api/v1/templates?q=${encodeURIComponent('приложению')}`, op))).toContain(
      shared.body.id,
    );
    const ev = await t.pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE subject = 'cc.events.config.changed' AND payload::text LIKE '%reply_template%'`,
    );
    expect(ev.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('шаблоны 2-й линии: создаёт ответственный (всегда общие), по теме с подтемами; операторам не видны', async () => {
    const resp = await t.login('resp1@demo.local');
    const fuel = await topicId('Топливо');
    const quality = await topicId('Качество топлива');
    const tpl = await t.call('POST', '/api/v1/templates', resp, {
      title: 'Ответ по топливу',
      body: 'Провели проверку качества топлива на АЗС',
      topicId: fuel,
      line: 'second',
    });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
    expect(tpl.body).toMatchObject({ shared: true, line: 'second' });
    // ответственный не создаёт и не видит шаблоны 1-й линии; оператор не создаёт шаблоны 2-й
    expect((await t.call('POST', '/api/v1/templates', resp, { title: 'x', body: 'y' })).status).toBe(403);
    expect((await t.call('GET', '/api/v1/templates', resp)).status).toBe(403);
    expect(
      (await t.call('POST', '/api/v1/templates', op, { title: 'x', body: 'y', line: 'second' })).status,
    ).toBe(403);
    const ids = (r: { body: { id: string }[] }) => r.body.map((x) => x.id);
    // подтема видит шаблон темы; оператор (1-я линия, подсказки) — нет
    expect(ids(await t.call('GET', `/api/v1/templates?line=second&forTopic=${quality}`, resp))).toContain(
      tpl.body.id,
    );
    expect(ids(await t.call('GET', '/api/v1/templates', op))).not.toContain(tpl.body.id);
    // автор правит свой шаблон; другой ответственный — нет
    expect(
      (await t.call('PATCH', `/api/v1/templates/${tpl.body.id}`, resp, { title: 'Топливо' })).status,
    ).toBe(200);
    const resp2 = await t.login('resp2@demo.local');
    expect(
      (await t.call('PATCH', `/api/v1/templates/${tpl.body.id}`, resp2, { title: 'нельзя' })).status,
    ).toBe(403);
  });

  it('подсказки: шаблон и статья БЗ по тексту и теме; LLM — черновик; упавший или медленный провайдер не мешает', async () => {
    const cat = await t.call('POST', '/api/v1/dict/kb-categories', admin, { name: 'Бонусы' });
    const art = await t.call('POST', '/api/v1/kb/articles', admin, {
      title: 'Как узнать баланс бонусов',
      body: 'Баланс бонусного счёта отображается в мобильном приложении и в чеке.',
      categoryId: cat.body.id,
      keywords: 'остаток баллов',
    });
    expect(art.status).toBe(201);
    expect(
      (await t.call('GET', `/api/v1/kb/articles?q=${encodeURIComponent('баллов')}`, op)).body.map(
        (a: { id: string }) => a.id,
      ),
    ).toContain(art.body.id);

    const { conversationId } = await inbound('a-1', 'client-assist', 'Сколько у меня бонусов на балансе?');
    await t.call('POST', `/api/v1/conversations/${conversationId}/take`, op);
    const s = await t.call('GET', `/api/v1/conversations/${conversationId}/suggestions`, op);
    expect(s.status).toBe(200);
    const types = s.body.suggestions.map((x: { type: string }) => x.type);
    expect(types).toContain('template');
    expect(types).toContain('article');
    expect(s.body.suggestions.find((x: { type: string }) => x.type === 'template').text).toMatch(
      /^Здравствуйте, ! Баланс/,
    );

    // Облачный адрес без явного разрешения — отказ (В-05); локальный — можно.
    expect(
      (
        await t.call('POST', '/api/v1/dict/assist-providers', admin, {
          name: 'Облако',
          kind: 'openai',
          config: { baseUrl: 'https://api.example.com/v1', model: 'x' },
        })
      ).body.message,
    ).toMatch(/вне контура/);
    const p = await t.call('POST', '/api/v1/dict/assist-providers', admin, {
      name: 'LLM',
      kind: 'openai',
      config: { baseUrl: llmUrl, model: 'mock', apiKey: 'sk-secret' },
      functions: ['suggest', 'draft'],
      timeoutMs: 1000,
    });
    expect(p.status).toBe(201);
    expect(p.body.config.apiKey).toBe('********');
    const stored = await t.pool.query(`SELECT config ->> 'apiKey' AS k FROM assist_provider WHERE id = $1`, [
      p.body.id,
    ]);
    expect(stored.rows[0].k).not.toContain('sk-secret');
    expect((await t.call('POST', `/api/v1/assist/providers/${p.body.id}/test`, admin)).body.ok).toBe(true);

    const draft = await t.call('POST', `/api/v1/conversations/${conversationId}/draft`, op);
    expect(draft.body.draft).toMatchObject({ type: 'draft', text: 'Черновик: проверю баланс и отвечу.' });
    expect(lastPrompt).toContain('Как узнать баланс бонусов'); // статья БЗ — контекст для модели

    llmMode = 'down';
    const down = await t.call('GET', `/api/v1/conversations/${conversationId}/suggestions`, op);
    expect(down.body.providers.find((x: { name: string }) => x.name === 'LLM')).toMatchObject({ ok: false });
    expect(down.body.suggestions.length).toBeGreaterThanOrEqual(2);
    llmMode = 'slow';
    const started = Date.now();
    const slow = await t.call('GET', `/api/v1/conversations/${conversationId}/suggestions`, op);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(slow.body.providers.find((x: { name: string }) => x.name === 'LLM').error).toMatch(/нет ответа/);
    expect(slow.body.suggestions.length).toBeGreaterThanOrEqual(2);
    expect((await t.call('POST', `/api/v1/conversations/${conversationId}/draft`, op)).status).toBe(503);
    // Выключение — без перезапуска: провайдер больше не опрашивается.
    await t.call('POST', `/api/v1/dict/assist-providers/${p.body.id}/deactivate`, admin);
    const off = await t.call('GET', `/api/v1/conversations/${conversationId}/suggestions`, op);
    expect(off.body.providers.map((x: { name: string }) => x.name)).not.toContain('LLM');
    llmMode = 'ok';

    // Обращение вне области видимости — 404.
    const ents = (await t.call('GET', '/api/v1/dict/enterprises', admin)).body;
    await t.call('PATCH', `/api/v1/conversations/${conversationId}`, admin, {
      enterpriseId: ents.find((e: { code: string }) => e.code === 'E2').id,
    });
    const sup = await t.login('supervisor@demo.local');
    expect((await t.call('GET', `/api/v1/conversations/${conversationId}/suggestions`, sup)).status).toBe(
      404,
    );
  });

  it('бот: автоответ + кнопки → сбор телефона → запрос во внешнюю систему → перевод на оператора с темой и историей', async () => {
    const tBalance = await topicId('Баланс бонусов');
    const graph: FlowGraph = {
      version: 1,
      kind: 'text',
      nodes: [
        { id: 'start', type: 'start', params: {} },
        { id: 'hi', type: 'message', params: { text: 'Я бот.' } },
        {
          id: 'menu',
          type: 'buttons',
          params: {
            text: 'Выберите тему',
            buttons: [
              { id: 'b', label: 'Баланс бонусов' },
              { id: 'o', label: 'Другое' },
            ],
            retries: 1,
            variable: 'Тема',
          },
        },
        {
          id: 'phone',
          type: 'ask',
          params: {
            text: 'Ваш телефон?',
            variable: 'Телефон',
            validation: 'phone',
            retries: 1,
            saveTo: 'phone',
          },
        },
        { id: 'http', type: 'http', params: { operationId: newId(), input: { phone: '{{Телефон}}' } } },
        { id: 'said', type: 'message', params: { text: 'Баланс: {{balance}}' } },
        { id: 'op', type: 'handoff', params: { queueId, topicId: tBalance, text: 'Соединяю с оператором.' } },
      ],
      edges: [
        { id: '1', source: 'start', exit: 'next', target: 'hi' },
        { id: '2', source: 'hi', exit: 'next', target: 'menu' },
        { id: '3', source: 'menu', exit: 'btn:b', target: 'phone' },
        { id: '4', source: 'menu', exit: 'btn:o', target: 'op' },
        { id: '5', source: 'phone', exit: 'next', target: 'http' },
        { id: '6', source: 'http', exit: 'ok', target: 'said' },
        { id: '7', source: 'http', exit: 'error', target: 'op' },
        { id: '8', source: 'said', exit: 'next', target: 'op' },
      ],
    };
    const flow = await t.call('POST', '/api/v1/flows', admin, { name: 'Бот', kind: 'text' });
    await t.call('PATCH', `/api/v1/flows/${flow.body.id}`, admin, { draft: graph });
    // Ссылка на несуществующую операцию — публикация запрещена.
    expect((await t.call('POST', `/api/v1/flows/${flow.body.id}/publish`, admin)).status).toBe(400);
    const opId = (
      await t.call('POST', '/api/v1/dict/integrations', admin, {
        code: 'bal',
        name: 'Баланс',
        url: 'http://127.0.0.1:9/balance?phone={{phone}}',
        outputs: [{ name: 'balance', path: '$.balance' }],
      })
    ).body.id;
    graph.nodes[4]!.params.operationId = opId;
    await t.call('PATCH', `/api/v1/flows/${flow.body.id}`, admin, { draft: graph });
    expect((await t.call('POST', `/api/v1/flows/${flow.body.id}/publish`, admin)).status).toBe(200);

    const ch = await t.call('POST', '/api/v1/dict/channels', admin, {
      kind: 'webchat',
      name: 'Сайт с ботом',
      queueId,
      botFlowId: flow.body.id,
      config: { public_key: 'bot-test-key', allowed_origins: ['*'] },
    });
    expect(ch.status).toBe(201);
    await t.call('POST', '/api/v1/dict/auto-replies', admin, {
      name: 'Привет',
      kind: 'greeting',
      channelIds: [ch.body.id],
      text: 'Здравствуйте!',
    });
    await t.call('POST', '/api/v1/dict/auto-replies', admin, {
      name: 'Очередь',
      kind: 'queued',
      channelIds: [ch.body.id],
      text: 'Вы в очереди.',
    });

    const first = await inbound('b-1', 'client-bot', 'добрый день', ch.body.id);
    const conv = first.conversationId;
    expect((await t.pool.query(`SELECT status FROM conversation WHERE id = $1`, [conv])).rows[0].status).toBe(
      'bot',
    );
    let m = await messages(conv);
    expect(m.map((x) => x.body)).toEqual(['добрый день', 'Здравствуйте!', 'Я бот.', 'Выберите тему']);
    expect(m[1]!.meta).toEqual({ auto: 'greeting' });
    expect(m[3]!.meta.buttons).toHaveLength(2);
    // Повторная доставка — ни дубля, ни второго ответа бота.
    expect((await inbound('b-1', 'client-bot', 'добрый день', ch.body.id)).duplicate).toBe(true);
    expect(await messages(conv)).toHaveLength(4);
    // «У бота» видно в списке, в «Очереди» — нет.
    expect(
      (await t.call('GET', '/api/v1/conversations?tab=bot', op)).body.map((c: { id: string }) => c.id),
    ).toContain(conv);

    await inbound('b-2', 'client-bot', 'баланс бонусов', ch.body.id);
    const phone = await inbound('b-3', 'client-bot', '8 029 555-44-33', ch.body.id);
    expect(phone.http).toMatchObject({
      conversationId: conv,
      operationId: opId,
      input: { phone: '+375295554433' },
    });
    const contact = await t.pool.query(
      `SELECT ct.phone, (SELECT count(*)::int FROM contact_identity i WHERE i.contact_id = ct.id AND i.kind = 'phone') AS ids
         FROM conversation c JOIN contact ct ON ct.id = c.contact_id WHERE c.id = $1`,
      [conv],
    );
    expect(contact.rows[0]).toEqual({ phone: '+375295554433', ids: 1 });
    // Клиент пишет, пока идёт запрос, — шаг не меняется.
    await inbound('b-4', 'client-bot', 'ну что там?', ch.body.id);
    // Экземпляр worker «упал» посреди запроса: шаг забирает другой (срок истёк).
    await t.pool.query(`UPDATE conversation SET bot_wake_at = now() - interval '1 s' WHERE id = $1`, [conv]);
    const stale = await withTx(t.pool, (tx) => claimStaleBotSteps(tx));
    expect(stale.map((s) => s.token)).toEqual([phone.http!.token]);
    // Ответ по чужому (устаревшему) token игнорируется.
    expect(
      await withTx(t.pool, (tx) =>
        resumeBotHttp(tx, { conversationId: conv, token: newId() }, { ok: true, outputs: {} }),
      ),
    ).toBeNull();
    await withTx(t.pool, (tx) => resumeBotHttp(tx, phone.http!, { ok: true, outputs: { balance: '1234' } }));
    // Повтор того же ответа (второй экземпляр) — без дублей.
    await withTx(t.pool, (tx) => resumeBotHttp(tx, phone.http!, { ok: true, outputs: { balance: '1234' } }));

    const c = (
      await t.pool.query(`SELECT status, queue_id, topic_id, bot_wake_at FROM conversation WHERE id = $1`, [
        conv,
      ])
    ).rows[0];
    expect(c).toMatchObject({ status: 'queued', queue_id: queueId, topic_id: tBalance, bot_wake_at: null });
    m = await messages(conv);
    const tail = m.slice(-5).map((x) => `${x.direction}:${x.body}`);
    expect(tail[0]).toBe('out:Баланс: 1234');
    expect(tail[1]).toBe('out:Соединяю с оператором.');
    expect(tail[2]).toMatch(
      /^system:Бот передал диалог оператору \(очередь «Общая», тема «Баланс бонусов»\)/,
    );
    expect(tail[3]).toMatch(/^note:Бот собрал:\nТема: Баланс бонусов\nТелефон: \+375295554433/);
    expect(tail[4]).toBe('out:Вы в очереди.');
    expect(m.filter((x) => x.body === 'Баланс: 1234')).toHaveLength(1);
    // Оператор видит всю переписку с ботом.
    await t.call('POST', `/api/v1/conversations/${conv}/take`, op);
    const hist = await t.call('GET', `/api/v1/conversations/${conv}/messages`, op);
    expect(hist.body.map((x: { body: string }) => x.body)).toContain('Выберите тему');
  });

  it('автоответы: ключевые слова (один раз), нерабочее время, автозакрытие при молчании клиента', async () => {
    const sch = await t.call('POST', '/api/v1/dict/schedules', admin, { name: 'Никогда', week: {} });
    expect(
      (
        await t.call('POST', '/api/v1/dict/auto-replies', admin, {
          name: 'x',
          kind: 'after_hours',
          text: 'y',
        })
      ).status,
    ).toBe(400);
    await t.call('POST', '/api/v1/dict/auto-replies', admin, {
      name: 'Нерабочее',
      kind: 'after_hours',
      channelIds: [channelId],
      scheduleId: sch.body.id,
      text: 'Сейчас нерабочее время.',
    });
    const kw = await t.call('POST', '/api/v1/dict/auto-replies', admin, {
      name: 'Часы',
      kind: 'keyword',
      channelIds: [channelId],
      matchType: 'keyword',
      pattern: 'часы работы, режим',
      text: 'Работаем круглосуточно.',
    });
    const a = await inbound('k-1', 'client-kw', 'Подскажите часы работы');
    await inbound('k-2', 'client-kw', 'И ещё раз: часы работы?');
    const bodies = (await messages(a.conversationId)).map((x) => x.body);
    expect(bodies.filter((b) => b === 'Работаем круглосуточно.')).toHaveLength(1);
    expect(bodies).toContain('Сейчас нерабочее время.');
    // Правило выключено — действует сразу.
    await t.call('POST', `/api/v1/dict/auto-replies/${kw.body.id}/deactivate`, admin);
    const b = await inbound('k-3', 'client-kw2', 'режим работы?');
    expect((await messages(b.conversationId)).map((x) => x.body)).not.toContain('Работаем круглосуточно.');

    await t.call('POST', '/api/v1/dict/auto-replies', admin, {
      name: 'Молчание',
      kind: 'inactivity',
      channelIds: [channelId],
      text: 'Вы ещё здесь?',
      params: { warnAfterSec: 60, closeAfterSec: 60, closeText: 'Закрыто: нет ответа.' },
    });
    const c = await inbound('k-4', 'client-silent', 'вопрос');
    await t.call('POST', `/api/v1/conversations/${c.conversationId}/take`, op);
    await t.call('POST', `/api/v1/conversations/${c.conversationId}/messages`, op, {
      body: 'Уточните, пожалуйста',
    });
    const later = (s: number) => new Date(Date.now() + s * 1000);
    await withTx(t.pool, (tx) => sweepInactivity(tx, later(30)));
    expect((await messages(c.conversationId)).map((x) => x.body)).not.toContain('Вы ещё здесь?');
    await withTx(t.pool, (tx) => sweepInactivity(tx, later(70)));
    expect((await messages(c.conversationId)).at(-1)?.body).toBe('Вы ещё здесь?');
    // Клиент ответил — предупреждение снято, обращение не закрывается.
    await inbound('k-5', 'client-silent', 'да, я здесь');
    await withTx(t.pool, (tx) => sweepInactivity(tx, later(200)));
    expect(
      (await t.pool.query(`SELECT status FROM conversation WHERE id = $1`, [c.conversationId])).rows[0]
        .status,
    ).toBe('active');
    await t.call('POST', `/api/v1/conversations/${c.conversationId}/messages`, op, { body: 'Ещё вопрос?' });
    await withTx(t.pool, (tx) => sweepInactivity(tx, later(70)));
    await withTx(t.pool, (tx) => sweepInactivity(tx, later(140)));
    const closed = await t.pool.query(`SELECT status, closed_by FROM conversation WHERE id = $1`, [
      c.conversationId,
    ]);
    expect(closed.rows[0]).toEqual({ status: 'closed', closed_by: null });
    expect((await messages(c.conversationId)).at(-1)?.body).toBe('Закрыто: нет ответа.');
  });

  it('оценка чата: запрос при закрытии оператором, одна оценка на обращение, видна в карточке', async () => {
    const { conversationId } = await inbound('c-1', 'client-csat', 'спасибо, всё понятно');
    await t.call('POST', `/api/v1/conversations/${conversationId}/take`, op);
    const contactId = (await t.call('GET', `/api/v1/conversations/${conversationId}`, op)).body.contactId;
    const token = await t.ctx.tokens.signClient({ contactId, channelId, sessionKey: 'client-csat' });
    // До закрытия оценку поставить нельзя.
    expect((await t.call('POST', '/api/v1/client/csat', token, { conversationId, score: 5 })).status).toBe(
      404,
    );
    await t.call('PATCH', `/api/v1/conversations/${conversationId}`, op, {
      topicId: await topicId('Баланс бонусов'),
    });
    const disp = (await t.call('GET', '/api/v1/dict/dispositions', op)).body.find(
      (d: { code: string }) => d.code === 'resolved',
    ).id;
    expect(
      (await t.call('POST', `/api/v1/conversations/${conversationId}/close`, op, { dispositionId: disp }))
        .status,
    ).toBe(200);
    const cm = (await t.call('GET', '/api/v1/client/messages', token)).body;
    expect(cm.at(-1)).toMatchObject({ direction: 'system', meta: { csat: true }, rated: false });
    expect((await t.call('POST', '/api/v1/client/csat', token, { conversationId, score: 5 })).body).toEqual({
      ok: true,
      duplicate: false,
    });
    expect(
      (await t.call('POST', '/api/v1/client/csat', token, { conversationId, score: 1 })).body.duplicate,
    ).toBe(true);
    expect((await t.call('GET', `/api/v1/conversations/${conversationId}`, op)).body.chatCsat).toBe(5);
    const r = await t.pool.query(`SELECT agent_user_id, score FROM csat_rating WHERE conversation_id = $1`, [
      conversationId,
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].agent_user_id).not.toBeNull();
    expect((await t.call('GET', '/api/v1/client/messages', token)).body.at(-1).rated).toBe(true);
  });
});
