/** Интеграционные тесты каналов Ф4 (настройки, исходящие, статус доставки, цепочки писем) на реальной PostgreSQL. */
import { emailMessageId, newId, SECRET_MASK } from '@cc/contracts';
import { applyDeliveryStatus, ingestInbound } from '@cc/domain';
import { openSecret } from '@cc/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp, DEMO_PW, TEST_SECRETS_KEY } from './setup';

describe.skipIf(!ADMIN_URL)('Каналы Ф4 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let queueId: string;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local', DEMO_PW);
    queueId = (
      await t.pool.query(`SELECT queue_id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`)
    ).rows[0].queue_id;
  }, 60_000);
  afterAll(async () => t?.cleanup());

  const createChannel = async (kind: string, name: string, config: Record<string, unknown>) => {
    const r = await t.call('POST', '/api/v1/dict/channels', admin, { kind, name, queueId, config });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; config: Record<string, unknown> };
  };
  const stored = async (id: string) =>
    (await t.pool.query(`SELECT config FROM channel WHERE id = $1`, [id])).rows[0].config as Record<
      string,
      string
    >;

  it('секреты канала шифруются в БД и маскируются в ответах; маска при изменении сохраняет прежнее значение', async () => {
    const ch = await createChannel('telegram', 'Бот поддержки', { bot_token: '123456:secret-token-value' });
    expect(ch.config).toMatchObject({ bot_token: SECRET_MASK, mode: 'polling' });
    const raw = await stored(ch.id);
    expect(raw.bot_token).toMatch(/^enc:v1:/);
    expect(openSecret(raw.bot_token!, TEST_SECRETS_KEY)).toBe('123456:secret-token-value');

    // Переключение в webhook: токен не меняется (пришла маска), секрет webhook генерируется.
    const upd = await t.call('PATCH', `/api/v1/dict/channels/${ch.id}`, admin, {
      config: { bot_token: SECRET_MASK, mode: 'webhook' },
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.config).toMatchObject({
      bot_token: SECRET_MASK,
      webhook_secret: SECRET_MASK,
      mode: 'webhook',
    });
    const after = await stored(ch.id);
    expect(after.bot_token).toBe(raw.bot_token);
    expect(openSecret(after.webhook_secret!, TEST_SECRETS_KEY)).toMatch(/^[0-9a-f]{48}$/);

    // Ни список, ни журнал аудита секретов не содержат.
    const list = await t.call('GET', '/api/v1/dict/channels?active=all', admin);
    expect(JSON.stringify(list.body)).not.toContain('secret-token-value');
    expect(JSON.stringify(list.body)).not.toContain('enc:v1:');
    const audit = await t.pool.query(
      `SELECT before, after FROM audit_log WHERE entity = 'channel' AND entity_id = $1`,
      [ch.id],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit.rows)).not.toContain('enc:v1:');
  });

  it('настройки проверяются по типу канала; журнал канала доступен администратору', async () => {
    const bad = await t.call('POST', '/api/v1/dict/channels', admin, {
      kind: 'email',
      name: 'Почта',
      config: { address: 'не-адрес', imap_host: 'mail' },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.details)).toContain('config.address');
    const noToken = await t.call('POST', '/api/v1/dict/channels', admin, {
      kind: 'telegram',
      name: 'Без токена',
      config: { mode: 'polling' },
    });
    expect(noToken.status).toBe(400);

    const mail = await createChannel('email', 'Почта поддержки', {
      address: 'support@cc.local',
      imap_host: 'mail',
      imap_user: 'support@cc.local',
      imap_password: 'pw',
      smtp_host: 'mail',
    });
    expect(mail.config).toMatchObject({
      imap_port: 993,
      smtp_port: 465,
      mailbox: 'INBOX',
      imap_password: SECRET_MASK,
    });
    await t.pool.query(
      `INSERT INTO channel_log (id, channel_id, direction, ok, summary) VALUES ($1, $2, 'system', false, 'IMAP: нет связи')`,
      [newId(), mail.id],
    );
    const log = await t.call('GET', `/api/v1/channels/${mail.id}/log`, admin);
    expect(log.status).toBe(200);
    expect(log.body.entries[0]).toMatchObject({ direction: 'system', ok: false, summary: 'IMAP: нет связи' });
    const op = await t.login('operator1@demo.local');
    expect((await t.call('GET', `/api/v1/channels/${mail.id}/log`, op)).status).toBe(403);
    expect((await t.call('GET', `/api/v1/channels/${newId()}/log`, admin)).status).toBe(404);
  });

  it('ответ оператора в Telegram: команда в исходящие той же транзакцией, статус доставки идемпотентен', async () => {
    const ch = await createChannel('telegram', 'Бот 2', { bot_token: '222222:token-2' });
    const { conversationId } = await withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId: ch.id,
        channelKind: 'telegram',
        externalId: `${ch.id}:1`,
        identity: { kind: 'telegram', value: '5550001' },
        contact: { displayName: 'Клиент Telegram' },
        body: 'здравствуйте',
        attachments: [],
        receivedAt: Date.now(),
      }),
    );
    const op = await t.login('operator1@demo.local');
    expect((await t.call('POST', `/api/v1/conversations/${conversationId}/take`, op)).status).toBe(200);
    const sent = await t.call('POST', `/api/v1/conversations/${conversationId}/messages`, op, {
      body: 'Добрый день!',
    });
    expect(sent.status).toBe(201);
    const messageId = sent.body.id as string;
    expect(sent.body.deliveryStatus).toBe('pending');

    const cmd = await t.pool.query(`SELECT subject, payload FROM outbox WHERE id = $1`, [messageId]);
    expect(cmd.rows[0].subject).toBe('cc.outbound.telegram');
    expect(cmd.rows[0].payload).toMatchObject({ channelId: ch.id, to: '5550001', body: 'Добрый день!' });
    // Заметка во внешний канал не уходит.
    const note = await t.call('POST', `/api/v1/conversations/${conversationId}/messages`, op, {
      body: 'внутренняя заметка',
      note: true,
    });
    expect((await t.pool.query(`SELECT 1 FROM outbox WHERE id = $1`, [note.body.id])).rowCount).toBe(0);

    const status = (s: 'sent' | 'failed', error: string | null = null) =>
      withTx(t.pool, (tx) =>
        applyDeliveryStatus(tx, {
          messageId,
          channelId: ch.id,
          status: s,
          externalId: s === 'sent' ? `tg-out:${ch.id}:5550001:10` : null,
          error,
          at: Date.now(),
        }),
      );
    expect(await status('failed', 'временная ошибка')).toBe(true);
    expect(await status('sent')).toBe(true);
    expect(await status('sent')).toBe(false); // повторная доставка статуса
    expect(await status('failed', 'запоздалый статус')).toBe(false); // доставленное не откатывается
    const msgs = await t.call('GET', `/api/v1/conversations/${conversationId}/messages`, op);
    expect(msgs.body.find((m: { id: string }) => m.id === messageId)).toMatchObject({
      deliveryStatus: 'sent',
      externalId: `tg-out:${ch.id}:5550001:10`,
    });
    const ev = await t.pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE subject = 'cc.events.conversation.message_status'`,
    );
    expect(ev.rows[0].n).toBe(2);
  });

  it('email: ответ — в ту же цепочку (тема, In-Reply-To); ответ клиента с другого адреса по References — в то же обращение', async () => {
    const ch = await createChannel('email', 'Почта 2', {
      address: 'help@cc.local',
      imap_host: 'mail',
      imap_user: 'help@cc.local',
      imap_password: 'pw',
      smtp_host: 'mail',
    });
    const mail = (externalId: string, from: string, references: string[], subject: string) =>
      withTx(t.pool, (tx) =>
        ingestInbound(tx, {
          id: newId(),
          channelId: ch.id,
          channelKind: 'email',
          externalId,
          identity: { kind: 'email', value: from },
          contact: { email: from },
          body: 'текст письма',
          attachments: [],
          receivedAt: Date.now(),
          meta: { email: { subject, messageId: externalId, references } },
        }),
      );
    const first = await mail('<c1@client.by>', 'ivan@client.by', [], 'Возврат средств');
    expect(first.created).toBe(true);

    const op = await t.login('operator1@demo.local');
    await t.call('POST', `/api/v1/conversations/${first.conversationId}/take`, op);
    const reply = await t.call('POST', `/api/v1/conversations/${first.conversationId}/messages`, op, {
      body: 'Деньги вернём за 3 дня',
    });
    const cmd = await t.pool.query(`SELECT payload FROM outbox WHERE id = $1`, [reply.body.id]);
    expect(cmd.rows[0].payload).toMatchObject({
      to: 'ivan@client.by',
      email: { subject: 'Re: Возврат средств', inReplyTo: '<c1@client.by>', references: ['<c1@client.by>'] },
    });
    const outId = emailMessageId(reply.body.id, 'cc.local');
    await withTx(t.pool, (tx) =>
      applyDeliveryStatus(tx, {
        messageId: reply.body.id,
        channelId: ch.id,
        status: 'sent',
        externalId: outId,
        error: null,
        at: Date.now(),
      }),
    );

    // Коллега клиента отвечает в цепочку с другого адреса — то же обращение.
    const second = await mail(
      '<c2@client.by>',
      'anna@client.by',
      ['<c1@client.by>', outId],
      'Re: Возврат средств',
    );
    expect(second).toMatchObject({ created: false, conversationId: first.conversationId });
    // Новое письмо без цепочки от нового адреса — новое обращение.
    const other = await mail('<c3@other.by>', 'petr@other.by', [], 'Другой вопрос');
    expect(other.created).toBe(true);
    const meta = await t.pool.query(`SELECT channel_meta FROM conversation WHERE id = $1`, [
      first.conversationId,
    ]);
    expect(meta.rows[0].channel_meta).toMatchObject({
      subject: 'Возврат средств',
      lastMessageId: '<c2@client.by>',
    });
  });
});
