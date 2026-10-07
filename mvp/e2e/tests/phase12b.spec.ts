import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, setAgentStatus, listView } from './helpers';

/**
 * Ф12b: пробелы приёмки — обязательный тег при закрытии (опция очереди, M-CARD-06), вкладки «Удержание» и
 * «Постобработка» (M-OP-02), ручное слияние дублей клиентов (M-CARD-01), консультативный перевод (M-OP-05,
 * M-TKT-11). Всё созданное тест закрывает сам.
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
  const file = join(tmpdir(), 'cc-e2e-tone12b.wav');
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
type Row = Record<string, unknown> & { id: string };

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

/** Закрыть обращения (уборка): тема «Сайт», тег, результат «Решено на 1-й линии». */
async function closeAll(a: Api, list: Row[]) {
  const topic = (await a.get<Row[]>('/topics')).find((t) => t.name === 'Сайт')!;
  const tag = (await a.get<Row[]>('/dict/tags'))[0]!;
  const disp = (await a.get<Row[]>('/dict/dispositions')).find((d) => d.code === 'resolved')!;
  for (const c of list) {
    await a.patch(`/conversations/${c.id}`, { topicId: topic.id, tagIds: [tag.id] });
    await a.post(`/conversations/${c.id}/close`, { dispositionId: disp.id });
  }
}
const closeAllOf = async (a: Api, name: string) =>
  closeAll(a, await a.get<Row[]>(`/conversations?tab=active&q=${encodeURIComponent(name)}`));

async function freeOperator(request: APIRequestContext, a: Api, email: string) {
  const op = await api(request, email, DEMO_PASSWORD);
  await closeAll(a, await op.get<Row[]>('/conversations?tab=mine'));
}

async function widgetClient(request: APIRequestContext, name: string, text: string) {
  const s = await request.post('/api/v1/client/session', {
    data: { publicKey: 'demo-webchat', consentVersion: '1', consentAccepted: true, name },
  });
  expect(s.status(), await s.text()).toBe(200);
  const { token } = (await s.json()) as { token: string };
  const m = await request.post('/api/v1/client/messages', {
    headers: { authorization: `Bearer ${token}` },
    data: { clientMessageId: randomUUID(), body: text },
  });
  expect(m.status(), await m.text()).toBeLessThan(300);
}

async function operator(browser: Browser, email: string, password = DEMO_PASSWORD): Promise<Page> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  await login(page, email, password);
  await nav(page, 'Рабочее место оператора');
  return page;
}

async function takeFromQueue(page: Page, text: string) {
  await listView(page, 'queue');
  const item = page.getByTestId('conv-item').filter({ hasText: text });
  await expect(item.first()).toBeVisible({ timeout: 30_000 });
  await item.first().getByTestId('take').click();
}

async function demoCall(browser: Browser, phone: string, name: string): Promise<Page> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  await page.goto('/demo-call');
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByTestId('demo-phone').fill(phone);
  await page.getByTestId('demo-did').fill('1000');
  await page.getByTestId('demo-call').click();
  await expect(page.getByTestId('demo-state')).toBeVisible();
  return page;
}

/** Оператор отвечает на входящий звонок. */
async function answer(op: Page) {
  const call = op.getByTestId('softphone-call');
  await expect(call).toHaveAttribute('data-state', 'ringing', { timeout: 30_000 });
  await call.getByTestId('call-answer').click();
  await expect(call).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
  return call;
}

test.describe.serial('Ф12b: пробелы приёмки', () => {
  test.setTimeout(180_000);

  test('M-CARD-06: обязательный тег при закрытии — опция очереди в справочнике и проверка в карточке', async ({
    browser,
    request,
  }) => {
    const a = await api(request);
    const queue = (await a.get<Row[]>('/dict/queues')).find((q) => q.name === 'Общая')!;
    const admin = await operator(browser, ADMIN.email, ADMIN.password);
    // Опция очереди — в справочнике «Очереди».
    await nav(admin, 'Справочники');
    await admin.getByRole('tab', { name: 'Очереди' }).click();
    await admin
      .getByTestId('dict-queues')
      .getByRole('row')
      .filter({ has: admin.getByRole('cell', { name: 'Общая', exact: true }) })
      .getByRole('button', { name: 'Изменить' })
      .click();
    const dlg = admin.getByRole('dialog');
    await dlg.getByLabel('Обязательный тег при закрытии').check({ force: true });
    await dlg.getByRole('button', { name: 'Сохранить' }).click();
    await expect
      .poll(async () => (await a.get<Row[]>('/dict/queues')).find((q) => q.id === queue.id)?.requireTag)
      .toBe(true);

    const name = `Тег ${stamp}`;
    await freeOperator(request, a, 'operator3@demo.local');
    const op = await operator(browser, 'operator3@demo.local');
    try {
      await widgetClient(request, name, `Нужен тег ${stamp}`);
      await takeFromQueue(op, name);
      await expect(op.getByTestId('messages')).toContainText(`Нужен тег ${stamp}`);
      await op.getByTestId('topic').click();
      await op.getByRole('option', { name: 'Сайт', exact: true }).click();
      await op.getByTestId('disposition').click();
      await op.getByRole('option', { name: 'Решено на 1-й линии' }).click();
      await expect(op.getByText('В этой очереди тег обязателен при закрытии')).toBeVisible();
      await expect(op.getByTestId('close')).toBeDisabled();
      await op.getByRole('textbox', { name: 'Теги' }).click({ force: true });
      await op.getByRole('option', { name: 'VIP' }).click();
      await op.keyboard.press('Escape');
      await expect(op.getByTestId('close')).toBeEnabled({ timeout: 10_000 });
      await op.getByTestId('close').click();
      await expect(op.getByText('Обращение закрыто').first()).toBeVisible();
    } finally {
      await a.patch(`/dict/queues/${queue.id}`, { requireTag: false });
      await closeAllOf(a, name);
    }
  });

  test('M-CARD-01: слияние дублей — «Объединить с…» в карточке клиента, единая история', async ({
    browser,
    request,
  }) => {
    const a = await api(request);
    const main = `Слияние Основной ${stamp}`;
    const dup = `Слияние Дубль ${stamp}`;
    await widgetClient(request, main, `Первое ${stamp}`);
    await widgetClient(request, dup, `Второе ${stamp}`);
    const admin = await operator(browser, ADMIN.email, ADMIN.password);
    try {
      await listView(admin, 'active');
      await admin.getByTestId('conv-item').filter({ hasText: main }).first().click();
      await admin.getByRole('tab', { name: 'Клиент' }).click();
      await expect(admin.getByText('История обращений (1)')).toBeVisible({ timeout: 15_000 });
      await admin.getByTestId('contact-merge').click();
      const dlg = admin.getByRole('dialog', { name: 'Объединить клиентов' });
      await dlg.getByTestId('merge-search').fill(dup);
      await dlg.getByTestId('merge-candidate').filter({ hasText: dup }).click();
      await dlg.getByTestId('merge-confirm').click();
      await expect(admin.getByText('Клиенты объединены')).toBeVisible();
      await expect(admin.getByText('История обращений (2)')).toBeVisible({ timeout: 15_000 });
      // Дубль больше не находится; оба обращения — у основного клиента.
      const found = await a.get<Row[]>(`/contacts?q=${encodeURIComponent(dup)}`);
      expect(found).toHaveLength(0);
      const convs = await a.get<Row[]>(`/conversations?tab=active&q=${encodeURIComponent(main)}`);
      expect(convs).toHaveLength(2);
    } finally {
      await closeAllOf(a, main);
      await closeAllOf(a, dup);
    }
  });

  test('M-OP-02: вкладки «Удержание» и «Постобработка»; M-OP-05: консультация — «Вернуться к клиенту» и «Соединить»', async ({
    browser,
    request,
  }) => {
    const a = await api(request);
    await freeOperator(request, a, 'operator1@demo.local');
    await freeOperator(request, a, 'operator2@demo.local');
    const op1 = await operator(browser, 'operator1@demo.local');
    const op2 = await operator(browser, 'operator2@demo.local');
    for (const p of [op1, op2])
      await expect(p.getByTestId('softphone-status')).toHaveText('Телефон готов', { timeout: 20_000 });
    const name = `Консультация ${stamp}`;
    const phone = `+37529${stamp}7`;
    // Очередь — пустая к моменту «Готов» (router предлагает накопившиеся обращения).
    await closeAll(a, await a.get<Row[]>('/conversations?tab=queue'));
    await setAgentStatus(op1, 'ready');
    const client = await demoCall(browser, phone, name);
    try {
      const call1 = await answer(op1);
      await expect(client.getByTestId('demo-state')).toHaveText('Идёт разговор');

      // «Удержание»: звонок на удержании — обращение во вкладке.
      await call1.getByTestId('call-hold').click();
      await expect(call1.getByTestId('call-hold')).toHaveText('Снять с удержания', { timeout: 10_000 });
      await listView(op1, 'hold');
      await expect(op1.getByTestId('conv-item').filter({ hasText: name })).toBeVisible({ timeout: 10_000 });
      await call1.getByTestId('call-hold').click();
      await expect(call1.getByTestId('call-hold')).toHaveText('Удержание', { timeout: 10_000 });
      await expect(op1.getByTestId('conv-item').filter({ hasText: name })).toHaveCount(0, {
        timeout: 10_000,
      });

      // Консультация с коллегой → «Вернуться к клиенту».
      const consult = async () => {
        await call1.getByTestId('call-consult').click();
        await op1.getByTestId('transfer-target').click();
        await op1.getByRole('option', { name: 'Кузнецова Ольга (оператор)' }).click();
        await op1.getByTestId('transfer-submit').click();
        await expect(call1.getByTestId('consult-panel')).toHaveAttribute('data-state', 'dialing', {
          timeout: 10_000,
        });
        const call2 = op2.getByTestId('softphone-call');
        await expect(call2).toContainText('Консультация коллеги', { timeout: 20_000 });
        await call2.getByTestId('call-answer').click();
        await expect(call2).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
        await expect(call1.getByTestId('consult-panel')).toHaveAttribute('data-state', 'talking', {
          timeout: 10_000,
        });
        // Пока идёт консультация, у адресата нет удержания и перевода — звонок ещё не его.
        await expect(call2.getByTestId('call-hold')).toHaveCount(0);
        return call2;
      };
      let call2 = await consult();
      await call1.getByTestId('consult-cancel').click();
      await expect(call2).toHaveCount(0, { timeout: 15_000 });
      await expect(call1.getByTestId('consult-panel')).toHaveCount(0, { timeout: 10_000 });
      await expect(call1.getByTestId('call-hold')).toHaveText('Удержание');
      await expect(client.getByTestId('demo-state')).toHaveText('Идёт разговор');

      // Консультация → «Соединить»: клиент говорит с коллегой, первый оператор отключён.
      call2 = await consult();
      await call1.getByTestId('consult-complete').click();
      await expect(call1).toHaveCount(0, { timeout: 15_000 });
      await expect(call2.getByTestId('call-hold')).toBeVisible({ timeout: 15_000 });
      await expect(call2).not.toContainText('Консультация коллеги');
      await expect(client.getByTestId('demo-state')).toHaveText('Идёт разговор');

      // Журнал вызова: консультация и перевод после неё.
      await listView(op2, 'mine');
      await op2.getByTestId('conv-item').filter({ hasText: name }).first().click();
      await op2.getByTestId('tab-contact').click();
      await expect(op2.getByTestId('call-item').first()).toContainText('консультация', { timeout: 15_000 });
      await expect(op2.getByTestId('call-item').first()).toContainText(
        'перевод оператору после консультации',
      );

      // «Постобработка»: коллега завершил разговор — обращение ждёт закрытия.
      await call2.getByTestId('call-hangup').click();
      await expect(call2).toHaveCount(0, { timeout: 15_000 });
      await listView(op2, 'wrapup');
      await expect(op2.getByTestId('conv-item').filter({ hasText: name })).toBeVisible({ timeout: 15_000 });
    } finally {
      await setAgentStatus(op1, 'offline');
      await closeAllOf(a, phone);
    }
  });
});
