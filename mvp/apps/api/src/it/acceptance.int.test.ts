/**
 * Интеграционные тесты Ф12 (доводка и приёмка): право «видит неклассифицированные обращения» (В-52) во всех
 * точках применения единого предиката области видимости — списки, поиск, карточка, история клиента, панель
 * супервизора, отчёты.
 */
import { totp, TOTP_STEP_S } from '@cc/auth';
import { newId } from '@cc/contracts';
import { ingestInbound } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp, DEMO_PW } from './setup';

type Row = Record<string, unknown>;

describe.skipIf(!ADMIN_URL)('Ф12: неклассифицированные обращения в правах (В-52)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const id: Record<string, string> = {};
  const tok: Record<string, string> = {};
  const one = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0];

  async function liveConversation(ext: string, name: string) {
    const channelId = (await one(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`)).id;
    const r = await withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId,
        channelKind: 'webchat',
        externalId: ext,
        identity: { kind: 'webchat', value: `acc-${ext}` },
        contact: { displayName: name },
        body: 'Вопрос',
        attachments: [],
        receivedAt: Date.now(),
      }),
    );
    return r.conversationId;
  }

  /** Что видит супервизор «Севера»: списки, поиск, карточка, история, панель, отчёт. */
  async function seen(who = 'sup') {
    const list = async (qs: string) =>
      ((await t.call('GET', `/api/v1/conversations?${qs}`, tok[who])).body as Row[]).map((r) => r.id);
    const active = await list('tab=active');
    const queue = await list('tab=queue');
    const search = await list(`tab=active&q=${encodeURIComponent('Неклассифицированный')}`);
    const card = (await t.call('GET', `/api/v1/conversations/${id.uncl}`, tok[who])).status;
    const history = (
      (await t.call('GET', `/api/v1/contacts/${id.unclContact}/conversations`, tok[who])).body as Row[]
    ).map((r) => r.id);
    const overview = (await t.call('GET', '/api/v1/supervisor/overview', tok[who])).body as {
      queues: Row[];
    };
    const waiting = overview.queues.find((q) => q.name === 'Общая')?.waiting;
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Minsk' });
    const rep = await t.call(
      'GET',
      `/api/v1/reports/conversations?from=${today}&to=${today}&groupBy=enterprise`,
      tok[who],
    );
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    return {
      list: active.includes(id.uncl),
      queue: queue.includes(id.uncl),
      search: search.includes(id.uncl),
      card: card === 200,
      history: history.includes(id.uncl),
      south: active.includes(id.south),
      north: active.includes(id.north),
      waiting,
      reportRows: (rep.body.rows as Row[]).map((r) => r.label),
    };
  }

  beforeAll(async () => {
    t = await createTestApp();
    id.e1 = (await one(`SELECT id FROM enterprise WHERE code = 'E1'`)).id;
    id.e2 = (await one(`SELECT id FROM enterprise WHERE code = 'E2'`)).id;
    id.sup = (await one(`SELECT id FROM app_user WHERE email = 'supervisor@demo.local'`)).id;
    id.uncl = await liveConversation('u1', 'Неклассифицированный клиент');
    id.north = await liveConversation('n1', 'Клиент Севера');
    id.south = await liveConversation('s1', 'Клиент Юга');
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [id.north, id.e1]);
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [id.south, id.e2]);
    id.unclContact = (await one(`SELECT contact_id FROM conversation WHERE id = $1`, [id.uncl])).contact_id;
    tok.admin = await t.login('admin@test.local');
    tok.sup = await t.login('supervisor@demo.local'); // область — только «Север»
  }, 120_000);
  afterAll(async () => t?.cleanup());

  it('по умолчанию супервизор с областью не видит неклассифицированные нигде, администратор — видит', async () => {
    const s = await seen();
    expect(s).toMatchObject({
      list: false,
      queue: false,
      search: false,
      card: false,
      history: false,
      north: true,
      south: false,
    });
    expect(s.reportRows).not.toContain('Не указано');
    const a = await seen('admin');
    expect(a).toMatchObject({
      list: true,
      queue: true,
      search: true,
      card: true,
      history: true,
      south: true,
    });
    expect(a.reportRows).toContain('Не указано');
    expect(a.waiting).toBe((s.waiting as number) + 2);
  });

  it('отметка у сотрудника — видит неклассифицированные везде, чужое предприятие — по-прежнему нет', async () => {
    const r = await t.call('PATCH', `/api/v1/users/${id.sup}`, tok.admin, { seesUnclassified: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.seesUnclassified).toBe(true);
    const s = await seen();
    expect(s).toMatchObject({
      list: true,
      queue: true,
      search: true,
      card: true,
      history: true,
      north: true,
      south: false,
    });
    expect(s.reportRows).toContain('Не указано');
    expect(s.reportRows).not.toContain('Предприятие «Юг»');
    const a = await seen('admin');
    expect(a.waiting).toBe((s.waiting as number) + 1);
  });

  it('право у роли; отметка сотрудника «не видит» важнее роли; изменения — с аудитом', async () => {
    await t.call('PATCH', `/api/v1/users/${id.sup}`, tok.admin, { seesUnclassified: null });
    expect((await seen()).list).toBe(false);
    const r = await t.call('PATCH', '/api/v1/users/roles/supervisor', tok.admin, { seesUnclassified: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as Row[]).find((x) => x.code === 'supervisor')!.permissions).toContain(
      'scope.unclassified',
    );
    expect(await seen()).toMatchObject({ list: true, card: true, south: false });
    await t.call('PATCH', `/api/v1/users/${id.sup}`, tok.admin, { seesUnclassified: false });
    expect(await seen()).toMatchObject({ list: false, card: false });
    await t.call('PATCH', '/api/v1/users/roles/supervisor', tok.admin, { seesUnclassified: false });
    const perms = (await one(`SELECT permissions FROM role WHERE code = 'supervisor'`)).permissions;
    expect(perms).not.toContain('scope.unclassified');
    const a = await one(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'role' AND entity_id = 'supervisor'`,
    );
    expect(a.n).toBe(2);
    // Не администратор не меняет права ролей.
    expect(
      (await t.call('PATCH', '/api/v1/users/roles/supervisor', tok.sup, { seesUnclassified: true })).status,
    ).toBe(403);
    expect(
      (await t.call('PATCH', '/api/v1/users/roles/nope', tok.admin, { seesUnclassified: true })).status,
    ).toBe(404);
  });
});

describe.skipIf(!ADMIN_URL)('Ф12: вход администратора со второй ступенью (TOTP)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const one = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0];
  const login = (email: string, password = DEMO_PW) =>
    t.call('POST', '/api/v1/auth/login', undefined, { email, password });
  const step2 = (mfaToken: string, code: string) =>
    t.call('POST', '/api/v1/auth/login/totp', undefined, { mfaToken, code });
  const next = (secret: string) => totp(secret, Date.now() + TOTP_STEP_S * 1000);

  beforeAll(async () => {
    t = await createTestApp();
  }, 120_000);
  afterAll(async () => t?.cleanup());

  it('сотрудник включает 2FA сам: вход — пароль, затем код; неверный и повторный код отклоняются', async () => {
    const tok = await t.login('admin@test.local');
    expect((await t.call('GET', '/api/v1/auth/totp', tok)).body).toMatchObject({
      enabled: false,
      required: false,
    });
    const setup = await t.call('POST', '/api/v1/auth/totp/setup', tok);
    const secret = setup.body.secret as string;
    expect(setup.body.otpauthUrl).toContain(`secret=${secret}`);
    // Секрет в БД — только зашифрованным.
    const row = await one(`SELECT totp_pending_secret FROM app_user WHERE email = 'admin@test.local'`);
    expect(row.totp_pending_secret).toMatch(/^enc:v1:/);
    expect((await t.call('POST', '/api/v1/auth/totp/enable', tok, { code: '000000' })).status).toBe(400);
    const en = await t.call('POST', '/api/v1/auth/totp/enable', tok, { code: totp(secret) });
    expect(en.status, JSON.stringify(en.body)).toBe(200);
    expect(en.body.enabled).toBe(true);

    const r1 = await login('admin@test.local');
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ mfaRequired: true });
    expect(r1.body.accessToken).toBeUndefined();
    // Промежуточный токен не даёт доступа к API.
    expect((await t.call('GET', '/api/v1/auth/me', r1.body.mfaToken)).status).toBe(401);
    expect((await step2(r1.body.mfaToken, '123456')).status).toBe(401);
    const code = next(secret);
    const ok = await step2(r1.body.mfaToken, code);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await t.call('GET', '/api/v1/auth/me', ok.body.accessToken)).status).toBe(200);
    // Тот же код второй раз не принимается.
    const r2 = await login('admin@test.local');
    expect((await step2(r2.body.mfaToken, code)).status).toBe(401);
    const audit = await one(
      `SELECT array_agg(action ORDER BY at) AS a FROM audit_log WHERE action LIKE 'login.%' OR action LIKE 'totp.%'`,
    );
    expect(audit.a).toEqual(
      expect.arrayContaining(['totp.enabled', 'login.totp_failed', 'login.success_totp']),
    );
  });

  it('обязательная 2FA для администраторов: настройка при входе, оператора не касается; сброс администратором', async () => {
    // admin@test.local уже с 2FA (предыдущий тест).
    expect((await login('admin@test.local')).body.mfaRequired).toBe(true);
    // Второй администратор без 2FA.
    const adm2 = (await one(`SELECT id FROM app_user WHERE email = 'operator1@demo.local'`)).id;
    await t.pool.query(`INSERT INTO user_role VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [adm2]);
    await t.pool.query(`UPDATE system_setting SET value = 'true' WHERE key = 'security.admin_2fa_required'`);

    const r = await login('operator1@demo.local');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mfaSetupRequired: true });
    expect(r.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(r.body.accessToken).toBeUndefined();
    const ok = await step2(r.body.mfaToken, totp(r.body.secret));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const tok2 = ok.body.accessToken as string;
    expect((await t.call('GET', '/api/v1/auth/totp', tok2)).body).toMatchObject({
      enabled: true,
      required: true,
    });
    // Отключить обязательную 2FA нельзя.
    const dis = await t.call('POST', '/api/v1/auth/totp/disable', tok2, { code: next(r.body.secret) });
    expect(dis.status).toBe(400);
    // Оператор (не администратор) входит по паролю.
    const op = await login('operator2@demo.local');
    expect(op.body.accessToken).toBeTruthy();
    // Сброс 2FA администратором: сессии сотрудника завершены, при входе — снова настройка.
    const res = await t.call('POST', `/api/v1/users/${adm2}/totp/reset`, tok2);
    expect(res.status).toBe(204);
    expect((await t.call('GET', '/api/v1/auth/me', tok2)).status).toBe(401);
    expect((await login('operator1@demo.local')).body.mfaSetupRequired).toBe(true);
    await t.pool.query(`UPDATE system_setting SET value = 'false' WHERE key = 'security.admin_2fa_required'`);
  });

  it('подбор кода блокирует вход, как подбор пароля; смена пароля обесценивает промежуточный токен', async () => {
    const r = await login('admin@test.local');
    for (let i = 0; i < 5; i++) await step2(r.body.mfaToken, '000000');
    const locked = await step2(r.body.mfaToken, '111111');
    expect(locked.status).toBe(423);
    await t.pool.query(
      `UPDATE app_user SET locked_until = NULL, failed_login_attempts = 0 WHERE email = 'admin@test.local'`,
    );
    const r2 = await login('admin@test.local');
    await t.pool.query(`UPDATE app_user SET password_hash = 'x' WHERE email = 'admin@test.local'`);
    expect((await step2(r2.body.mfaToken, '000000')).body.error).toBe('mfa_expired');
  });
});

describe.skipIf(!ADMIN_URL)('Ф12: согласия, сроки хранения, обезличивание (M-NFR-07)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  const one = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0];

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local');
  }, 120_000);
  afterAll(async () => t?.cleanup());

  it('версии текста согласия хранятся; тот же номер версии с другим текстом — отказ; реестр согласий', async () => {
    const ch = await one(`SELECT id, config FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`);
    const texts = await t.call('GET', `/api/v1/admin/consent-texts?channelId=${ch.id}`, admin);
    expect(texts.body).toHaveLength(1);
    expect(texts.body[0]).toMatchObject({ version: '1' });
    const s1 = await t.call('POST', '/api/v1/client/session', undefined, {
      publicKey: 'demo-webchat',
      consentVersion: '1',
      consentAccepted: true,
      name: 'Согласный Клиент',
    });
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    // Изменить текст без новой версии нельзя.
    const same = await t.call('PATCH', `/api/v1/dict/channels/${ch.id}`, admin, {
      config: { ...ch.config, consent_text: 'Новый текст согласия' },
    });
    expect(same.status).toBe(400);
    expect(JSON.stringify(same.body)).toContain('новую версию');
    const v2 = await t.call('PATCH', `/api/v1/dict/channels/${ch.id}`, admin, {
      config: { ...ch.config, consent_text: 'Новый текст согласия', consent_version: '2' },
    });
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    const s2 = await t.call('POST', '/api/v1/client/session', undefined, {
      publicKey: 'demo-webchat',
      consentVersion: '2',
      consentAccepted: true,
    });
    expect(s2.status).toBe(200);
    const all = (await t.call('GET', `/api/v1/admin/consent-texts?channelId=${ch.id}`, admin)).body;
    expect(all.map((x: Row) => [x.version, x.accepted])).toEqual([
      ['2', 1],
      ['1', 1],
    ]);
    expect(all[1].text).toBe(ch.config.consent_text ?? 'Я согласен(на) на обработку персональных данных.');
    const reg = (await t.call('GET', `/api/v1/admin/consents?channelId=${ch.id}`, admin)).body as Row[];
    expect(reg.map((x) => x.textVersion)).toEqual(['2', '1']);
    expect(reg.every((x) => x.textId)).toBe(true);
    // Оператору реестр недоступен; в карточке клиента согласие видно.
    const op = await t.login('operator1@demo.local');
    expect((await t.call('GET', '/api/v1/admin/consents', op)).status).toBe(403);
    const card = await t.call('GET', `/api/v1/contacts/${s1.body.contactId}`, op);
    expect(card.body.consents[0]).toMatchObject({ textVersion: '1' });
  });

  it('записи разговоров старше срока хранения удаляются из хранилища, строка остаётся', async () => {
    const channelId = (await one(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`)).id;
    const conv = {
      id: (
        await withTx(t.pool, (tx) =>
          ingestInbound(tx, {
            id: newId(),
            channelId,
            channelKind: 'webchat',
            externalId: `ret-${newId()}`,
            identity: { kind: 'webchat', value: `ret-${newId()}` },
            body: 'Вопрос',
            attachments: [],
            receivedAt: Date.now(),
          }),
        )
      ).conversationId,
    };
    const mk = async (daysAgo: number, key: string) => {
      const callId = newId();
      await t.pool.query(
        `INSERT INTO call (id, conversation_id, node, client_channel, direction, state, started_at)
         VALUES ($1, $2, 'ast-1', $3, 'in', 'ended', now() - make_interval(days => $4))`,
        [callId, conv.id, `ch-${callId}`, daysAgo],
      );
      const id = newId();
      await t.pool.query(
        `INSERT INTO call_recording (id, call_id, conversation_id, node, name, status, storage_key, created_at)
         VALUES ($1, $2, $3, 'ast-1', $4, 'uploaded', $4, now() - make_interval(days => $5))`,
        [id, callId, conv.id, key, daysAgo],
      );
      await t.ctx.storage.put(key, Buffer.from('RIFF'), 'audio/wav');
      return id;
    };
    const old = await mk(200, `rec/old-${newId()}.wav`);
    const fresh = await mk(10, `rec/new-${newId()}.wav`);
    const r = await t.call('POST', '/api/v1/admin/retention/run', admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ days: 180 });
    expect(r.body.deleted).toBeGreaterThanOrEqual(1);
    expect(
      (await one(`SELECT deleted_at FROM call_recording WHERE id = $1`, [old])).deleted_at,
    ).not.toBeNull();
    expect((await one(`SELECT deleted_at FROM call_recording WHERE id = $1`, [fresh])).deleted_at).toBeNull();
    const oldKey = (await one(`SELECT storage_key FROM call_recording WHERE id = $1`, [old])).storage_key;
    await expect(t.ctx.storage.get(oldKey)).rejects.toThrow();
    expect((await t.call('GET', `/api/v1/recordings/${old}`, admin)).status).toBe(410);
    // Срок — из «Настроек», без перезапуска.
    await t.call('PATCH', '/api/v1/settings', admin, { 'recording.retention_days': 5 });
    expect((await t.call('POST', '/api/v1/admin/retention/run', admin)).body).toMatchObject({ days: 5 });
    expect(
      (await one(`SELECT deleted_at FROM call_recording WHERE id = $1`, [fresh])).deleted_at,
    ).not.toBeNull();
    await t.call('PATCH', '/api/v1/settings', admin, { 'recording.retention_days': 180 });
  });

  it('обезличивание клиента: профиль, идентификаторы, тексты и файлы, журнал событий; факт согласия и обращения остаются', async () => {
    const channelId = (await one(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`)).id;
    const r = await withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId,
        channelKind: 'webchat',
        externalId: `pd-${newId()}`,
        identity: { kind: 'phone', value: '+375291112233' },
        contact: { displayName: 'Иван Петров', phone: '+375291112233', email: 'ivan@mail.by' },
        body: 'Мой номер +375291112233, паспорт МР1234567',
        attachments: [],
        receivedAt: Date.now(),
      }),
    );
    const contactId = (await one(`SELECT contact_id FROM conversation WHERE id = $1`, [r.conversationId]))
      .contact_id;
    await t.pool.query(
      `INSERT INTO consent (id, contact_id, channel_id, text_version, ip, user_agent) VALUES ($1,$2,$3,'1','10.0.0.1','UA')`,
      [newId(), contactId, channelId],
    );
    const attKey = `att/${newId()}`;
    await t.ctx.storage.put(attKey, Buffer.from('file'), 'text/plain');
    const attId = newId();
    await t.pool.query(
      `INSERT INTO attachment (id, conversation_id, contact_id, filename, content_type, size_bytes, storage_key)
       VALUES ($1, $2, $3, 'скан.txt', 'text/plain', 4, $4)`,
      [attId, r.conversationId, contactId, attKey],
    );
    const body = { confirm: true, reason: 'Заявление клиента № 15 от 30.09' };
    // Незакрытое обращение — сначала закрыть.
    expect((await t.call('POST', `/api/v1/contacts/${contactId}/anonymize`, admin, body)).status).toBe(409);
    await t.pool.query(`UPDATE conversation SET status = 'closed', closed_at = now() WHERE id = $1`, [
      r.conversationId,
    ]);
    // Без подтверждения и основания — нет; оператору — нельзя.
    expect(
      (await t.call('POST', `/api/v1/contacts/${contactId}/anonymize`, admin, { reason: 'x' })).status,
    ).toBe(400);
    const op = await t.login('operator1@demo.local');
    expect((await t.call('POST', `/api/v1/contacts/${contactId}/anonymize`, op, body)).status).toBe(403);
    const a = await t.call('POST', `/api/v1/contacts/${contactId}/anonymize`, admin, body);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.filesRemoved).toBe(1);

    const c = await one(`SELECT display_name, phone, email, anonymized_at FROM contact WHERE id = $1`, [
      contactId,
    ]);
    expect(c).toMatchObject({ display_name: 'Клиент (обезличен)', phone: null, email: null });
    expect(c.anonymized_at).not.toBeNull();
    const ids = (await t.pool.query(`SELECT value FROM contact_identity WHERE contact_id = $1`, [contactId]))
      .rows;
    expect(ids.every((x) => String(x.value).startsWith('anon:'))).toBe(true);
    const msgs = (
      await t.pool.query(`SELECT body FROM message WHERE conversation_id = $1 AND direction = 'in'`, [
        r.conversationId,
      ])
    ).rows;
    expect(msgs.map((m) => m.body)).toEqual(['[удалено: обезличивание]']);
    // Журнал событий: текстов и телефона клиента больше нет, события на месте.
    const ev = await one(
      `SELECT count(*)::int AS n, bool_or(data::text LIKE '%375291112233%') AS pd FROM event WHERE data ->> 'contactId' = $1`,
      [contactId],
    );
    expect(ev.n).toBeGreaterThan(0);
    expect(ev.pd).toBe(false);
    // Журнал по-прежнему неизменяем без процедуры обезличивания.
    await expect(
      t.pool.query(`UPDATE event SET data = '{}' WHERE data ->> 'contactId' = $1`, [contactId]),
    ).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    // Вложение удалено из хранилища и недоступно через API; согласие — без IP, но факт сохранён.
    await expect(t.ctx.storage.get(attKey)).rejects.toThrow();
    expect((await t.call('GET', `/api/v1/attachments/${attId}`, admin)).status).toBe(410);
    expect(
      await one(`SELECT ip, user_agent, text_version FROM consent WHERE contact_id = $1`, [contactId]),
    ).toEqual({
      ip: null,
      user_agent: null,
      text_version: '1',
    });
    expect(
      (await one(`SELECT count(*)::int AS n FROM conversation WHERE contact_id = $1`, [contactId])).n,
    ).toBe(1);
    const au = await one(
      `SELECT after FROM audit_log WHERE action = 'contact.anonymized' AND entity_id = $1`,
      [contactId],
    );
    expect(au.after.reason).toBe(body.reason);
    // Повторно — 409; тот же телефон при новом обращении — новый клиент.
    expect((await t.call('POST', `/api/v1/contacts/${contactId}/anonymize`, admin, body)).status).toBe(409);
    const again = await withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId,
        channelKind: 'webchat',
        externalId: `pd-${newId()}`,
        identity: { kind: 'phone', value: '+375291112233' },
        body: 'Снова я',
        attachments: [],
        receivedAt: Date.now(),
      }),
    );
    expect(
      (await one(`SELECT contact_id FROM conversation WHERE id = $1`, [again.conversationId])).contact_id,
    ).not.toBe(contactId);
  });

  it('обезличивание уволенного сотрудника: только отключённого; ФИО и контакты стёрты, вход невозможен, история на месте', async () => {
    const u = await one(`SELECT id FROM app_user WHERE email = 'operator2@demo.local'`);
    const body = { confirm: true, reason: 'Увольнение, приказ 12-к' };
    expect((await t.call('POST', `/api/v1/users/${u.id}/anonymize`, admin, body)).status).toBe(409);
    expect((await t.call('POST', `/api/v1/users/${u.id}/deactivate`, admin)).status).toBe(200);
    const r = await t.call('POST', `/api/v1/users/${u.id}/anonymize`, admin, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = await one(
      `SELECT full_name, email, phone, password_hash, can_login FROM app_user WHERE id = $1`,
      [u.id],
    );
    expect(row.full_name).toMatch(/^Сотрудник удалён/);
    expect(row.email).toMatch(/@anonymized\.invalid$/);
    expect(row).toMatchObject({ phone: null, password_hash: null, can_login: false });
    const login = await t.call('POST', '/api/v1/auth/login', undefined, {
      email: 'operator2@demo.local',
      password: DEMO_PW,
    });
    expect(login.status).toBe(401);
  });
});
