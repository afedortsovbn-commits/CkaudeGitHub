import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, totpCode, setAgentStatus, listView } from './helpers';
import { sendMail } from './mail';

/**
 * Ф12: доводка и приёмка. Демо-сценарий 3 (чат, звонок, email и Telegram одного клиента — единая история и одна
 * очередь) и новые функции в браузере: вход с кодом (2FA), право «видит неклассифицированные обращения» (В-52),
 * параметры SL (В-51), реестр согласий и обезличивание клиента. Всё созданное тест закрывает сам — обращения
 * не остаются в очереди для следующих тестов.
 */
function toneFile(): string {
  const rate = 16000;
  const pcm = Buffer.alloc(rate * 2 * 2);
  for (let i = 0; i < rate * 2; i++)
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  const file = join(tmpdir(), 'cc-e2e-tone12.wav');
  writeFileSync(file, Buffer.concat([h, pcm]));
  return file;
}

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${toneFile()}`,
    ],
  },
  permissions: ['microphone'],
});

const stamp = Date.now().toString().slice(-6);
const MOCK_TG = process.env.E2E_MOCK_TELEGRAM ?? 'http://127.0.0.1:8081';
type Row = Record<string, unknown> & { id: string };

/** REST от имени сотрудника (для подготовки данных и уборки за собой). */
async function api(request: APIRequestContext, email = ADMIN.email, password = ADMIN.password) {
  const r = await request.post('/api/v1/auth/login', { data: { email, password } });
  const token = (await r.json()).accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  const call = async <T>(method: 'get' | 'post' | 'patch', path: string, data?: unknown) => {
    const res = await request[method](`/api/v1${path}`, { headers, data });
    const text = await res.text();
    return { status: res.status(), body: (text ? JSON.parse(text) : undefined) as T };
  };
  return {
    get: async <T>(path: string) => (await call<T>('get', path)).body,
    post: <T>(path: string, data: unknown = {}) => call<T>('post', path, data),
    patch: <T>(path: string, data: unknown) => call<T>('patch', path, data),
  };
}
type Api = Awaited<ReturnType<typeof api>>;

/** Закрыть обращения клиента (уборка): тема «Сайт», результат «Решено на 1-й линии». */
async function closeAllOf(a: Api, contactName: string) {
  const topic = (await a.get<Row[]>('/topics')).find((t) => t.name === 'Сайт')!;
  const disp = (await a.get<Row[]>('/dict/dispositions')).find((d) => d.code === 'resolved')!;
  const list = await a.get<Row[]>(`/conversations?tab=active&q=${encodeURIComponent(contactName)}`);
  for (const c of list) {
    await a.patch(`/conversations/${c.id}`, { topicId: topic.id });
    await a.post(`/conversations/${c.id}/close`, { dispositionId: disp.id });
  }
}

/** Освободить оператора: закрыть его открытые обращения, оставшиеся от предыдущих тестов (лимит чатов). */
async function freeOperator(request: APIRequestContext, a: Api, email: string) {
  const op = await api(request, email, DEMO_PASSWORD);
  const topic = (await a.get<Row[]>('/topics')).find((t) => t.name === 'Сайт')!;
  const disp = (await a.get<Row[]>('/dict/dispositions')).find((d) => d.code === 'resolved')!;
  for (const c of await op.get<Row[]>('/conversations?tab=mine')) {
    await a.patch(`/conversations/${c.id}`, { topicId: topic.id });
    await a.post(`/conversations/${c.id}/close`, { dispositionId: disp.id });
  }
}

/** Клиент веб-чата (без браузера): сессия с формой до диалога и сообщение. */
async function widgetClient(
  request: APIRequestContext,
  form: { name: string; phone?: string; email?: string },
  text: string,
) {
  const s = await request.post('/api/v1/client/session', {
    data: { publicKey: 'demo-webchat', consentVersion: '1', consentAccepted: true, ...form },
  });
  expect(s.status(), await s.text()).toBe(200);
  const { token, contactId } = (await s.json()) as { token: string; contactId: string };
  if (text) {
    const m = await request.post('/api/v1/client/messages', {
      headers: { authorization: `Bearer ${token}` },
      data: { clientMessageId: randomUUID(), body: text },
    });
    expect(m.status(), await m.text()).toBeLessThan(300);
  }
  return { token, contactId };
}

async function operator(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  await login(page, email, DEMO_PASSWORD);
  await nav(page, '1-я линия (оператор)');
  return page;
}

async function takeFromQueue(page: Page, text: string, timeout = 30_000) {
  await listView(page, 'queue');
  const item = page.getByTestId('conv-item').filter({ hasText: text });
  await expect(item.first()).toBeVisible({ timeout });
  await item.first().getByTestId('take').click();
}

async function historyCount(page: Page, n: number) {
  await page.getByRole('tab', { name: 'Клиент' }).click();
  await expect(page.getByText(`История обращений (${n})`)).toBeVisible({ timeout: 15_000 });
}

test.describe.serial('Ф12: доводка и приёмка', () => {
  test.setTimeout(180_000);

  test('демо-сценарий 3: чат, звонок и email одного клиента — один клиент и единая история; Telegram — в ту же очередь', async ({
    browser,
    request,
  }) => {
    const a = await api(request);
    const queue = (await a.get<Row[]>('/dict/queues')).find((q) => q.name === 'Общая')!;
    const box = `demo3-${stamp}@cc.local`;
    const mail = await a.post<Row>('/dict/channels', {
      kind: 'email',
      name: `Почта демо-3 ${stamp}`,
      queueId: queue.id,
      config: {
        address: box,
        imap_host: 'mail',
        imap_port: 3143,
        imap_secure: false,
        imap_user: box,
        imap_password: 'pw',
        smtp_host: 'mail',
        smtp_port: 3025,
        smtp_secure: false,
      },
    });
    expect(mail.status, JSON.stringify(mail.body)).toBe(201);
    const tgToken = `e2e${stamp}:demo3-token`;
    const tg = await a.post<Row>('/dict/channels', {
      kind: 'telegram',
      name: `Telegram демо-3 ${stamp}`,
      queueId: queue.id,
      config: { bot_token: tgToken, mode: 'polling', api_root: 'http://mock-telegram:3000' },
    });
    expect(tg.status, JSON.stringify(tg.body)).toBe(201);

    const name = `Клиент Три ${stamp}`;
    const phone = `+37529${stamp}3`;
    const email = `client3-${stamp}@client.by`;
    await freeOperator(request, a, 'operator3@demo.local');
    const op = await operator(browser, 'operator3@demo.local');
    try {
      // 1) Чат на сайте с телефоном и email в форме до диалога.
      await widgetClient(request, { name, phone, email }, `Вопрос в чате ${stamp}`);
      await takeFromQueue(op, name);
      await expect(op.getByTestId('messages')).toContainText(`Вопрос в чате ${stamp}`);
      await op.getByTestId('reply').fill('Здравствуйте! Уже смотрим.');
      await op.getByTestId('send').click();
      await historyCount(op, 1);
      await expect(op.getByTestId('contact-consent')).toContainText('Согласие на обработку ПДн: версия 1');

      // 2) Письмо с адреса из формы — тот же клиент, та же очередь, история из двух обращений.
      await sendMail({
        from: `${name} <${email}>`,
        to: box,
        subject: `Вопрос по почте ${stamp}`,
        text: `Пишу по почте ${stamp}`,
        messageId: `<d3-${stamp}@client.by>`,
      });
      await takeFromQueue(op, `Пишу по почте ${stamp}`, 60_000);
      await expect(op.getByTestId('messages')).toContainText(`Пишу по почте ${stamp}`);
      await historyCount(op, 2);

      // 3) Тот же клиент звонит с номера из формы — узнан по номеру: история из трёх обращений. Звонок — последним:
      // в статусе «Готов» оператору предлагаются и накопившиеся в очереди чаты (лимит одновременных чатов).
      await expect(op.getByTestId('softphone-status')).toHaveText('Телефон готов', { timeout: 20_000 });
      await setAgentStatus(op, 'ready');
      const cctx = await browser.newContext({
        ignoreHTTPSErrors: true,
        locale: 'ru-RU',
        permissions: ['microphone'],
      });
      const client = await cctx.newPage();
      await client.goto('/demo-call');
      await client.getByLabel('Ваше имя').fill(name);
      await client.getByTestId('demo-phone').fill(phone);
      await client.getByTestId('demo-did').fill('1000');
      await client.getByTestId('demo-call').click();
      const call = op.getByTestId('softphone-call');
      await expect(call).toHaveAttribute('data-state', 'ringing', { timeout: 30_000 });
      await call.getByTestId('call-answer').click();
      await expect(call).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
      await historyCount(op, 3);
      await op.waitForTimeout(1500);
      await call.getByTestId('call-hangup').click();
      await expect(call).toHaveCount(0, { timeout: 10_000 });
      await setAgentStatus(op, 'offline');
      await cctx.close();

      // 4) Telegram — новое обращение в той же очереди «Общая».
      const r = await fetch(`${MOCK_TG}/__test/${tgToken}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId: Number(`8${stamp}`),
          text: `Из Telegram ${stamp}`,
          firstName: `Тг ${stamp}`,
        }),
      });
      expect(r.ok).toBe(true);
      await listView(op, 'queue');
      await expect(op.getByTestId('conv-item').filter({ hasText: `Тг ${stamp}` })).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await closeAllOf(a, name);
      await closeAllOf(a, `Тг ${stamp}`);
      await a.post(`/dict/channels/${(tg.body as Row).id}/deactivate`);
      await a.post(`/dict/channels/${(mail.body as Row).id}/deactivate`);
    }
  });

  test('вход с кодом (2FA): включение в профиле, вход с кодом; обязательная настройка для администраторов', async ({
    page,
    request,
  }) => {
    const a = await api(request);
    const mk = async (email: string) => {
      const u = await a.post<Row>('/users', {
        fullName: `Администратор 2FA ${stamp}`,
        email,
        password: DEMO_PASSWORD,
        roles: ['admin'],
      });
      expect(u.status, JSON.stringify(u.body)).toBe(201);
    };
    const e1 = `admin2fa-${stamp}@cc.local`;
    await mk(e1);
    await login(page, e1, DEMO_PASSWORD);
    await expect(page.getByTestId('browser-warning')).toHaveCount(0); // Chromium поддерживается (M-NFR-02)
    await page.getByTestId('current-user').click();
    await expect(page.getByTestId('totp-status')).toHaveText('Вход с кодом выключен');
    await page.getByTestId('totp-begin').click();
    await expect(page.getByTestId('totp-qr')).toBeVisible();
    const secret = (await page.getByTestId('totp-secret').textContent())!;
    await page.getByTestId('totp-code').fill(totpCode(secret));
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.getByTestId('totp-status')).toHaveText('Вход с кодом включён');

    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.getByLabel('Email').fill(e1);
    await page.getByLabel('Пароль').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.getByLabel('Код из приложения-аутентификатора').fill('000000');
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.getByText('Неверный код подтверждения')).toBeVisible();
    await page.getByLabel('Код из приложения-аутентификатора').fill(totpCode(secret, 1));
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.getByTestId('current-user')).toBeVisible();

    // Обязательная 2FA для администраторов: новый администратор настраивает её при входе (QR-код).
    const e2 = `admin2fa-b-${stamp}@cc.local`;
    await mk(e2);
    expect((await a.patch('/settings', { 'security.admin_2fa_required': true })).status).toBe(200);
    try {
      await page.getByRole('button', { name: 'Выйти' }).click();
      await page.getByLabel('Email').fill(e2);
      await page.getByLabel('Пароль').fill(DEMO_PASSWORD);
      await page.getByRole('button', { name: 'Войти' }).click();
      await expect(page.getByText('Настройка входа с кодом')).toBeVisible();
      await expect(page.getByTestId('totp-qr')).toBeVisible();
      const s2 = (await page.getByTestId('totp-secret').textContent())!;
      await page.getByLabel('Код из приложения-аутентификатора').fill(totpCode(s2));
      await page.getByRole('button', { name: 'Подтвердить' }).click();
      await expect(page.getByTestId('current-user')).toBeVisible();
      await page.getByTestId('current-user').click();
      await expect(page.getByText('Для администраторов обязателен')).toBeVisible();
    } finally {
      await a.patch('/settings', { 'security.admin_2fa_required': false });
    }
  });

  test('В-52: супервизор с областью видит неклассифицированные обращения только с правом из карточки сотрудника', async ({
    page,
    browser,
    request,
  }) => {
    const a = await api(request);
    const name = `Без темы ${stamp}`;
    await widgetClient(request, { name }, `Неклассифицированный вопрос ${stamp}`);
    const sup = await operator(browser, 'supervisor@demo.local'); // область — только «Север»
    const queued = () => sup.getByTestId('conv-item').filter({ hasText: name });
    try {
      await listView(sup, 'queue');
      await sup.waitForTimeout(1500);
      await expect(queued()).toHaveCount(0);

      await login(page, ADMIN.email, ADMIN.password);
      await nav(page, 'Сотрудники');
      await page.getByText('Смирнова Анна (супервизор)').click();
      await page.getByRole('tab', { name: 'Области видимости' }).click();
      await page.getByTestId('unclassified-select').click();
      await page.getByRole('option', { name: 'видит', exact: true }).click();
      await page.getByTestId('unclassified-save').click();
      await expect(page.getByText('Сохранено').first()).toBeVisible();

      await expect(async () => {
        await sup.reload();
        await listView(sup, 'queue');
        await expect(queued()).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 30_000 });
    } finally {
      const supId = (await a.get<Row[]>(`/users?q=supervisor@demo.local`))[0]!.id;
      await a.patch(`/users/${supId}`, { seesUnclassified: null });
      await closeAllOf(a, name);
    }
  });

  test('В-51: параметры SL в «Настройках» сохраняются и сразу меняют расчёт в отчёте', async ({
    page,
    request,
  }) => {
    const a = await api(request);
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Настройки');
    const sw = page.getByTestId('setting-report.sl_count_short_abandons');
    await expect(sw).not.toBeChecked();
    try {
      await sw.check({ force: true });
      await page.getByRole('textbox', { name: 'Общая: голос' }).fill('30');
      await page.getByRole('button', { name: 'Сохранить' }).first().click();
      await expect(page.getByText('Сохранено').first()).toBeVisible();
      await page.reload();
      await expect(page.getByTestId('setting-report.sl_count_short_abandons')).toBeChecked();
      await expect(page.getByRole('textbox', { name: 'Общая: голос' })).toHaveValue('30');
      const rep = await a.get<{ notes: string[] }>('/reports/service-level');
      expect(rep.notes.join(' ')).toContain('учитываются как пропущенные');
      expect(rep.notes.join(' ')).toContain('задан свой порог');
    } finally {
      await a.patch('/settings', {
        'report.sl_count_short_abandons': false,
        'report.sl_queue_thresholds': {},
      });
    }
  });

  test('персональные данные: реестр согласий с версией текста, обезличивание клиента', async ({
    page,
    request,
  }) => {
    const name = `Субъект ПДн ${stamp}`;
    await widgetClient(request, { name, phone: `+37533${stamp}1` }, '');
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Персональные данные');
    await page.getByPlaceholder('Клиент: имя, телефон, email').fill(name);
    const row = page.getByTestId('consent-registry').getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Чат на сайте');
    await page.getByRole('tab', { name: 'Тексты согласий' }).click();
    await expect(page.getByTestId('consent-texts')).toContainText('Я согласен');

    await page.getByRole('tab', { name: 'Обезличивание клиента' }).click();
    await page.getByTestId('erase-search').fill(name);
    await page.getByTestId('erase-reason').fill(`Заявление № ${stamp}`);
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Обезличить' }).click();
    await expect(page.getByText('Клиент обезличен')).toBeVisible();
    // Имени больше нет — поиск его не находит, в реестре согласие остаётся за обезличенным клиентом.
    await page.getByTestId('erase-search').fill(`+37533${stamp}1`);
    await expect(page.getByRole('cell', { name })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Реестр согласий' }).click();
    await page.getByPlaceholder('Клиент: имя, телефон, email').fill('Клиент (обезличен)');
    await expect(page.getByTestId('consent-registry').getByText('обезличен').first()).toBeVisible();
  });
});
