import { type Browser, expect, type Page, request, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ADMIN, DEMO_PASSWORD, login, nav } from './helpers';

const stamp = Date.now().toString().slice(-6);
/** Мок внешних систем (mock-selfservice): приёмник webhooks, анализатор, эхо-бот. */
const MOCK = process.env.E2E_MOCK_SELFSERVICE_URL ?? 'http://127.0.0.1:8082';
/** Ключ демо-формы сайта (сид демо-стенда). */
const FORM_KEY = process.env.E2E_DEMO_FORM_API_KEY ?? 'cck_demo_form_key_change_me_0123456789abcd';

async function openWidget(browser: Browser, name: string, key: string) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(`/widget/demo.html?key=${key}`);
  const w = page.locator('#cc-widget');
  await w.getByTestId('cc-open').click();
  await w.getByPlaceholder('Ваше имя (необязательно)').fill(name);
  await w.getByRole('checkbox').check();
  await w.getByRole('button', { name: 'Начать чат' }).click();
  return { page, w, ctx };
}

async function say(w: ReturnType<Page['locator']>, text: string) {
  await w.getByTestId('cc-input').fill(text);
  await w.getByTestId('cc-send').click();
}

async function takeFromQueue(page: Page, client: string) {
  await page.getByTestId('tabs').getByText('Очередь').click();
  const item = page.getByTestId('conv-item').filter({ hasText: client });
  await expect(item).toBeVisible({ timeout: 15000 });
  await item.getByTestId('take').click();
  await expect(page.getByTestId('reply')).toBeEnabled();
}

async function closeWithTopic(page: Page, topic: string) {
  await page.getByTestId('topic').click();
  await page.getByRole('option', { name: topic, exact: true }).click();
  await page.getByTestId('disposition').click();
  await page.getByRole('option', { name: 'Решено на 1-й линии' }).click();
  await page.getByTestId('close').click();
  await expect(page.getByText('Обращение закрыто.')).toBeVisible();
}

async function mock(path: string, body?: unknown) {
  const ctx = await request.newContext();
  const r =
    body === undefined ? await ctx.get(`${MOCK}${path}`) : await ctx.post(`${MOCK}${path}`, { data: body });
  expect(r.ok()).toBe(true);
  const json = (await r.json()) as unknown;
  await ctx.dispose();
  return json;
}

async function adminPage(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await login(page, ADMIN.email, ADMIN.password);
  return { ctx, page };
}

/** Включить/выключить подписку на странице Webhooks. */
async function setSubscription(page: Page, name: string, on: boolean) {
  const row = page.getByTestId('sub-row').filter({ hasText: name });
  const sw = row.getByTestId('sub-toggle');
  if ((await sw.isChecked()) !== on) await sw.click({ force: true });
  await expect(sw).toBeChecked({ checked: on });
  return row;
}

test.describe.serial('Ф9: публичный API, webhooks, Bot Gateway, экспорт конфигурации', () => {
  test.afterAll(async () => {
    await mock('/control', { down: false });
  });

  test('демо-сценарий 8: webhook о закрытии → внешний анализатор записывает результат в поля и заметку через API', async ({
    page,
    browser,
  }) => {
    const admin = await adminPage(browser);
    await nav(admin.page, 'Webhooks');
    await setSubscription(admin.page, 'Демо: анализатор (закрытые обращения)', true);

    const name = `Клиент Анализ ${stamp}`;
    const client = await openWidget(browser, name, 'demo-webchat');
    await say(client.w, 'Я недоволен обслуживанием на АЗС, кассир нагрубил');
    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, 'Рабочее место оператора');
    await takeFromQueue(page, name);
    await page.getByTestId('reply').fill('Приносим извинения, разберёмся.');
    await page.getByTestId('send').click();
    await closeWithTopic(page, 'Сайт');

    // Внешняя система получила webhook и записала результат через публичный API — оператор видит его в карточке.
    await expect(
      page.getByTestId('msg-note').filter({ hasText: 'Результат анализа: тональность негативная' }),
    ).toBeVisible({
      timeout: 20000,
    });
    await expect(page.getByTestId('msg-note').first()).toContainText(
      'внешняя система «Демо: анализатор обращений»',
    );
    await expect(page.getByTestId('extra-field-Тональность')).toContainText('негативная');

    // Журнал доставки: событие conversation.closed доставлено.
    const row = admin.page.getByTestId('sub-row').filter({ hasText: 'Демо: анализатор' });
    await row.getByTestId('sub-log').click();
    await expect(
      admin.page
        .getByTestId('delivery-row')
        .filter({ hasText: 'conversation.closed' })
        .filter({ hasText: 'доставлено' })
        .first(),
    ).toBeVisible({ timeout: 10000 });
    await admin.page.keyboard.press('Escape');
    await client.ctx.close();
    await admin.ctx.close();
  });

  test('получатель webhooks упал: операторы работают, доставка догоняет после восстановления', async ({
    page,
    browser,
  }) => {
    await mock('/control', { down: true });
    const name = `Клиент Сбой ${stamp}`;
    const client = await openWidget(browser, name, 'demo-webchat');
    await say(client.w, 'Спасибо за быструю помощь вчера, всё отлично');
    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, 'Рабочее место оператора');
    await takeFromQueue(page, name);
    await page.getByTestId('reply').fill('Рады помочь!');
    await page.getByTestId('send').click();
    await expect(client.w.getByText('Рады помочь!')).toBeVisible({ timeout: 10000 });
    await closeWithTopic(page, 'Сайт');

    const admin = await adminPage(browser);
    await nav(admin.page, 'Webhooks');
    const row = admin.page.getByTestId('sub-row').filter({ hasText: 'Демо: анализатор' });
    await expect(row.getByTestId('sub-state')).toContainText('Сбой', { timeout: 20000 });
    await expect(page.getByTestId('msg-note').filter({ hasText: 'Результат анализа' })).toHaveCount(0);

    // Получатель восстановился — доставка догоняет сама (пробная попытка по расписанию повторов).
    await mock('/control', { down: false });
    await expect(
      page.getByTestId('msg-note').filter({ hasText: 'Результат анализа: тональность позитивная' }),
    ).toBeVisible({
      timeout: 60000,
    });
    await expect(row.getByTestId('sub-state')).toContainText('Работает', { timeout: 10000 });
    await setSubscription(admin.page, 'Демо: анализатор (закрытые обращения)', false);
    await client.ctx.close();
    await admin.ctx.close();
  });

  test('Bot Gateway: внешний бот отвечает в виджете с кнопкой и переводит на оператора', async ({
    page,
    browser,
  }) => {
    const name = `Клиент Внешний бот ${stamp}`;
    const client = await openWidget(browser, name, 'demo-webchat-extbot');
    await say(client.w, 'Привет, бот');
    await expect(client.w.getByText('Эхо-бот получил: «Привет, бот»')).toBeVisible({ timeout: 15000 });
    const buttons = client.w.getByTestId('cc-buttons');
    await buttons.getByRole('button', { name: 'Оператор' }).click();
    await expect(client.w.getByText('Соединяю с оператором')).toBeVisible({ timeout: 15000 });

    await login(page, 'operator2@demo.local', DEMO_PASSWORD);
    await nav(page, 'Рабочее место оператора');
    await takeFromQueue(page, name);
    const msgs = page.getByTestId('messages');
    await expect(msgs).toContainText('Эхо-бот получил');
    await expect(msgs).toContainText('Внешний бот · Демо: внешний эхо-бот');
    await expect(page.getByTestId('msg-note')).toContainText('клиент попросил оператора');
    await page.getByTestId('reply').fill('Здравствуйте, я оператор.');
    await page.getByTestId('send').click();
    await expect(client.w.getByText('Здравствуйте, я оператор.')).toBeVisible({ timeout: 10000 });
    await closeWithTopic(page, 'Сайт');
    await client.ctx.close();
  });

  test('внешний канал: сообщение сторонней системы по ключу API → обращение; ответ оператора → webhook', async ({
    page,
  }) => {
    const api = await request.newContext({ ignoreHTTPSErrors: true });
    const name = `Форма ${stamp}`;
    const r = await api.post('/api/v1/ext/inbound', {
      headers: { authorization: `Bearer ${FORM_KEY}` },
      data: {
        externalId: `e2e-${stamp}`,
        contact: { name, email: `form-${stamp}@example.by` },
        text: 'Заявка с сайта: не пришёл чек на почту',
        fields: { Заказ: `A-${stamp}` },
      },
    });
    expect(r.status()).toBe(202);
    // Без ключа — 401.
    expect((await api.post('/api/v1/ext/inbound', { data: {} })).status()).toBe(401);
    await api.dispose();

    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, 'Рабочее место оператора');
    await takeFromQueue(page, name);
    await expect(page.getByTestId('messages')).toContainText('Заявка с сайта');
    await expect(page.getByTestId('extra-field-Заказ')).toContainText(`A-${stamp}`);
    await page.getByTestId('reply').fill(`Чек отправлен повторно ${stamp}`);
    await page.getByTestId('send').click();
    await expect
      .poll(
        async () =>
          ((await mock('/hooks/site-form')) as { body: { data: { message?: { body: string } } } }[]).some(
            (h) => h.body.data.message?.body === `Чек отправлен повторно ${stamp}`,
          ),
        { timeout: 20000 },
      )
      .toBe(true);
    await closeWithTopic(page, 'Сайт');
  });

  test('администрирование: ключ API (один раз, отзыв), подписка с проверкой «Тест», документация API', async ({
    page,
  }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Ключи API');
    await page.getByTestId('key-create').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Название (кто пользуется ключом)').fill(`CRM ${stamp}`);
    await dlg.getByLabel(/Чтение обращений/).check();
    await page.getByTestId('key-save').click();
    await expect(page.getByTestId('secret-value')).toContainText('cck_');
    const key = (await page.getByTestId('secret-value').innerText()).trim();
    await page.getByRole('button', { name: 'Готово' }).click();
    const api = await request.newContext({ ignoreHTTPSErrors: true });
    const me = await api.get('/api/v1/ext/me', { headers: { authorization: `Bearer ${key}` } });
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { name: string }).name).toBe(`CRM ${stamp}`);
    page.once('dialog', (d) => void d.accept());
    await page
      .getByTestId('key-row')
      .filter({ hasText: `CRM ${stamp}` })
      .getByRole('button', { name: 'Отозвать' })
      .click();
    await expect(page.getByTestId('key-row').filter({ hasText: `CRM ${stamp}` })).toContainText('Отозван');
    await expect
      .poll(
        async () =>
          (await api.get('/api/v1/ext/me', { headers: { authorization: `Bearer ${key}` } })).status(),
        {
          timeout: 15000,
        },
      )
      .toBe(401);
    await api.dispose();

    await nav(page, 'Webhooks');
    await page.getByTestId('sub-create').click();
    await dlg.getByLabel('Название').fill(`BI ${stamp}`);
    await dlg.getByLabel('Адрес получателя (URL)').fill(`http://mock-selfservice:3000/hooks/bi-${stamp}`);
    await page.getByTestId('sub-save').click();
    await expect(page.getByTestId('secret-value')).toContainText('whsec_');
    await page.getByRole('button', { name: 'Готово' }).click();
    await page
      .getByTestId('sub-row')
      .filter({ hasText: `BI ${stamp}` })
      .getByTestId('sub-test')
      .click();
    await expect(page.getByText('Проверка прошла')).toBeVisible({ timeout: 10000 });
    const hits = (await mock(`/hooks/bi-${stamp}`)) as { body: { type: string } }[];
    expect(hits.map((h) => h.body.type)).toContain('webhook.test');
    await page
      .getByTestId('sub-row')
      .filter({ hasText: `BI ${stamp}` })
      .getByTestId('sub-toggle')
      .click({ force: true });

    await nav(page, 'Документация API');
    await expect(page.getByTestId('api-docs')).toContainText('Контакт-центр — публичный API');
    await expect(page.getByTestId('api-op').filter({ hasText: '/api/v1/ext/inbound' })).toBeVisible();
  });

  test('экспорт конфигурации и импорт файла: проверка и применение', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Экспорт и импорт');
    const dl = page.waitForEvent('download');
    await page.getByTestId('export').click();
    const file = await (await dl).path();
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      format: string;
      sections: Record<string, unknown[]>;
    };
    expect(doc.format).toBe('cc-config');
    expect(doc.sections.flows!.length).toBeGreaterThan(0);

    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('import-file').click();
    await (await chooser).setFiles(file);
    await expect(page.getByTestId('import-report-title')).toContainText('Проверка файла');
    await expect(page.getByTestId('import-report')).toContainText('Сценарии IVR и боты');
    await page.getByTestId('import-run').click();
    await expect(page.getByTestId('import-report-title')).toContainText('Импорт выполнен');
  });
});
