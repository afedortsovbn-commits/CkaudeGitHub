import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav } from './helpers';

/**
 * Ф6: IVR. Демо-сценарий IVR на номере 2000 (демо-данные): приветствие + объявление о сбое → меню
 * «Бонусная программа → Баланс» → запрос в мок самообслуживания → озвучен баланс → «0» — оператор →
 * очередь → ответ оператора → завершение → CSAT (DTMF) → запись и путь по IVR в карточке.
 * Демо-абонент — браузер с фейковым микрофоном (тон 440 Гц), DTMF — RFC 4733 из WebRTC.
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
  const file = join(tmpdir(), 'cc-e2e-tone6.wav');
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
const FLOW = 'Демо: контакт-центр сети АЗС';

async function operator(browser: Browser, email: string, password = DEMO_PASSWORD): Promise<Page> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  await login(page, email, password);
  await nav(page, 'Рабочее место оператора');
  await expect(page.getByTestId('softphone-status')).toHaveText('Телефон готов', { timeout: 20_000 });
  return page;
}

async function callIvr(browser: Browser, phone: string, name: string): Promise<Page> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  await page.goto('/demo-call');
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByTestId('demo-phone').fill(phone);
  await page.getByTestId('demo-did').fill('2000');
  await page.getByTestId('demo-call').click();
  // IVR отвечает сразу — разговор идёт уже со сценарием.
  await expect(page.getByTestId('demo-state')).toHaveText('Идёт разговор', { timeout: 20_000 });
  return page;
}

const dtmf = (page: Page, d: string) => page.getByTestId(`demo-dtmf-${d}`).click();

async function adminApi(request: APIRequestContext) {
  const r = await request.post('/api/v1/auth/login', {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  const token = (await r.json()).accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  return {
    get: async <T>(path: string) => (await (await request.get(`/api/v1${path}`, { headers })).json()) as T,
    post: async <T>(path: string, data: unknown) =>
      (await (await request.post(`/api/v1${path}`, { headers, data })).json()) as T,
  };
}

/** Журнал вызовов обращения клиента с этим номером (последнего). */
async function callsOf(api: Awaited<ReturnType<typeof adminApi>>, phone: string) {
  const list = await api.get<{ id: string; contactName: string }[]>('/conversations?tab=active');
  const closed = await api.get<{ id: string; contactName: string }[]>('/conversations?tab=closed');
  const conv = [...list, ...closed].find(
    (c) => c.contactName.includes(phone) || c.contactName.includes(stamp),
  );
  if (!conv) return null;
  return api.get<{ state: string; events: { type: string; data: Record<string, unknown> }[] }[]>(
    `/conversations/${conv.id}/calls`,
  );
}

test.describe.serial('Ф6: IVR', () => {
  test.setTimeout(180_000);

  test('демо-сценарий 1: IVR → баланс из внешней системы → «0» → оператор → CSAT → путь и оценка в карточке', async ({
    browser,
  }) => {
    const phone = `+37529${stamp}6`;
    const op = await operator(browser, 'operator1@demo.local');
    await op.getByTestId('agent-status').getByText('Готов').click();

    const client = await callIvr(browser, phone, `Клиент IVR ${stamp}`);
    // Объявление о сбое и приветствие — затем главное меню: «1» — бонусная программа, «1» — баланс.
    await client.waitForTimeout(15_000);
    await dtmf(client, '1');
    await client.waitForTimeout(2_000);
    await dtmf(client, '1');
    // Запрос баланса и озвучивание суммы, снова меню бонусов: «0» — оператор.
    await client.waitForTimeout(9_000);
    await dtmf(client, '0');

    const call = op.getByTestId('softphone-call');
    await expect(call).toHaveAttribute('data-state', 'ringing', { timeout: 30_000 });
    await call.getByTestId('call-answer').click();
    await expect(call).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
    await expect(op.getByTestId('messages')).toContainText(
      'IVR: звонок в очереди «Общая», тема «Баланс бонусов»',
    );
    // Панель внешних данных клиента (M-CARD-07) — из того же мока самообслуживания.
    await op.getByRole('tab', { name: 'Клиент' }).click();
    await expect(op.getByTestId('external-data')).toContainText('Баланс бонусов', { timeout: 15_000 });
    await expect(op.getByTestId('external-data')).toContainText('Последняя заправка');

    await op.waitForTimeout(2_000);
    await call.getByTestId('call-hangup').click();
    await expect(call).toHaveCount(0, { timeout: 10_000 });
    // Оператор завершил разговор — клиент остаётся на линии: вопрос об оценке, «4».
    await expect(client.getByTestId('demo-state')).toHaveText('Идёт разговор');
    await client.waitForTimeout(2_000);
    await dtmf(client, '4');
    // Благодарность и прощание — отбой со стороны КЦ.
    await expect(client.getByTestId('demo-info')).toContainText('Звонок завершён', { timeout: 30_000 });

    await op.getByTestId('tab-calls').click();
    const item = op.getByTestId('call-item').first();
    await expect(item.getByTestId('call-state')).toHaveText('завершён', { timeout: 15_000 });
    await expect(item.getByTestId('call-ivr-path')).toContainText(
      'Главное меню → [1] → Бонусная программа → [1] → Запрос баланса → (ответ получен) → Озвучить баланс',
    );
    await expect(item.getByTestId('call-csat')).toHaveText('Оценка клиента: 4 из 5');
    await expect(async () => {
      await op.getByTestId('tab-calls').click();
      await expect(item.getByTestId('recording-play')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await op.getByTestId('agent-status').getByText('Офлайн').click();
  });

  test('публикация новой версии не влияет на идущий звонок; откат на прежнюю версию (демо-сценарий 5)', async ({
    browser,
    request,
  }) => {
    const api = await adminApi(request);
    const flows = await api.get<{ id: string; name: string; publishedVersion: number }[]>('/flows');
    const flow = flows.find((f) => f.name === FLOW)!;
    const before = flow.publishedVersion;
    const phone = `+37529${stamp}7`;
    const client = await callIvr(browser, phone, `Версия ${stamp}`);
    await client.waitForTimeout(3_000);

    // Публикуем новую версию, пока клиент в IVR.
    const pub = await api.post<{ version: number }>(`/flows/${flow.id}/publish`, { comment: `e2e ${stamp}` });
    expect(pub.version).toBe(before + 1);
    // Клиент продолжает по своей версии: меню работает, путь идёт дальше.
    await client.waitForTimeout(12_000);
    await dtmf(client, '1');
    await client.waitForTimeout(3_000);
    await client.getByTestId('demo-hangup').click();
    const calls = await callsOf(api, phone);
    const start = calls![0]!.events.find((e) => e.type === 'ivr_start')!;
    expect(String(start.data.flow)).toContain(`версия ${before}`);
    expect(calls![0]!.events.some((e) => e.type === 'ivr' && e.data.node === 'bonus')).toBe(true);

    // Откат из интерфейса (M-IVR-06): версия, бывшая опубликованной, снова опубликована.
    const admin = await browser.newPage();
    await login(admin, ADMIN.email, ADMIN.password);
    await nav(admin, 'Сценарии IVR');
    await admin.getByRole('link', { name: FLOW }).click();
    await expect(admin.getByTestId('flow-published')).toHaveText(`опубликована версия ${before + 1}`);
    await admin.getByRole('button', { name: 'Версии' }).click();
    await admin.getByTestId(`rollback-${before}`).click();
    await expect(admin.getByTestId('flow-published')).toHaveText(`опубликована версия ${before}`, {
      timeout: 10_000,
    });
  });

  test('конструктор: демо-сценарий на холсте, тестовый прогон с запросом во внешнюю систему; новый сценарий без программирования', async ({
    page,
  }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Сценарии IVR');
    await page.getByRole('link', { name: FLOW }).click();
    await expect(page.getByTestId('node-menu')).toHaveCount(4);
    await expect(page.getByTestId('flow-valid')).toBeVisible();

    // Тестовый прогон тем же исполнителем, что и в call-control.
    await page.getByTestId('flow-test').click();
    await page.getByTestId('test-start').click();
    await page.getByTestId('test-done').click(); // объявления
    await page.getByTestId('test-done').click(); // приветствие
    await page.getByTestId('test-digit-1').click();
    await page.getByTestId('test-digit-1').click();
    await page.getByTestId('test-http').click();
    const log = page.getByTestId('test-log');
    await expect(log).toContainText('Ответ: {"balance":"');
    await expect(log).toContainText('«Демо: Ваш баланс:»');
    await page.keyboard.press('Escape');

    // Новый сценарий: «Начало» → «Проиграть сообщение» → «Завершить».
    await nav(page, 'Сценарии IVR');
    await page.getByTestId('flow-new').click();
    await page.getByTestId('flow-name').fill(`Тест ${stamp}`);
    await page.getByTestId('flow-create').click();
    await expect(page.getByTestId('node-start')).toBeVisible();
    await page.getByTestId('palette-play').click();
    await page.getByTestId('param-audio').click();
    await page.getByRole('option', { name: /Демо: Здравствуйте/ }).click();
    await page.keyboard.press('Escape');
    await page.getByTestId('palette-hangup').click();
    const connect = async (from: string, to: string) => {
      await page
        .getByTestId(from)
        .locator('.react-flow__handle-bottom')
        .first()
        .dragTo(page.getByTestId(to).locator('.react-flow__handle-top'));
    };
    await page.locator('.react-flow__controls-fitview').click();
    await page.waitForTimeout(500);
    await connect('node-start', 'node-play');
    await connect('node-play', 'node-hangup');
    await expect(page.getByTestId('flow-valid')).toBeVisible();
    await page.getByTestId('flow-publish').click();
    await expect(page.getByTestId('flow-published')).toHaveText('опубликована версия 1', { timeout: 10_000 });
  });

  test('интеграционная операция: проверка из админки; объявление о сбое выключает и включает супервизор', async ({
    page,
    browser,
  }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Интеграции');
    await page
      .getByRole('row', { name: /selfservice\.balance/ })
      .getByTestId('op-test')
      .click();
    await page.getByTestId('op-run').click();
    await expect(page.getByTestId('op-result')).toHaveText('успех');
    await expect(page.getByTestId('op-outputs')).toContainText('"card": "7000 ****');

    const sup = await browser.newPage();
    await login(sup, 'supervisor@demo.local', DEMO_PASSWORD);
    await nav(sup, 'Объявления о сбоях');
    const row = sup.getByRole('row', { name: /Задержка начисления бонусов/ });
    await expect(row).toContainText('звучит сейчас');
    await row.getByRole('button', { name: 'Отключить' }).click();
    // Отключённое объявление больше не звучит и скрыто из списка действующих.
    await expect(row).toHaveCount(0);
    await sup.getByLabel('Показывать отключённые').check();
    await sup
      .getByRole('row', { name: /Задержка начисления бонусов/ })
      .getByRole('button', { name: 'Включить' })
      .click();
    await expect(sup.getByRole('row', { name: /Задержка начисления бонусов/ })).toContainText(
      'звучит сейчас',
    );
  });
});
