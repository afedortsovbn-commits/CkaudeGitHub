import { type Browser, expect, test } from '@playwright/test';
import { DEMO_PASSWORD, login, nav } from './helpers';

const stamp = Date.now().toString().slice(-6);

async function openWidget(browser: Browser, name: string) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto('/widget/demo.html');
  const w = page.locator('#cc-widget');
  await w.getByTestId('cc-open').click();
  await w.getByPlaceholder('Ваше имя (необязательно)').fill(name);
  await w.getByRole('checkbox').check();
  await w.getByRole('button', { name: 'Начать чат' }).click();
  return { page, w, ctx };
}

test.describe.serial('Ф3: маршрутизация (ACD), статусы операторов, супервизор', () => {
  // «Готов» оставляют только на время своего теста — иначе последующие сценарии (в т.ч. Ф2, ручное «Взять»)
  // получат обращение уже в статусе «offered» от router и не найдут его во вкладке «Очередь».
  test.afterEach(async ({ page }) => {
    if (
      await page
        .getByTestId('agent-status')
        .isVisible()
        .catch(() => false)
    ) {
      await page
        .getByTestId('agent-status')
        .getByText('Офлайн')
        .click()
        .catch(() => undefined);
    }
  });

  test('оператор «Готов» → автоматическое предложение → принятие → закрытие → постобработка → «Готов»', async ({
    page,
    browser,
  }) => {
    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, 'Рабочее место оператора');
    await page.getByTestId('agent-status').getByText('Готов').click();

    const client = await openWidget(browser, `Клиент ACD-A ${stamp}`);
    await client.w.getByTestId('cc-input').fill(`Вопрос ACD-A ${stamp}`);
    await client.w.getByTestId('cc-send').click();

    const item = page.getByTestId('conv-item').filter({ hasText: `Клиент ACD-A ${stamp}` });
    await expect(item).toBeVisible({ timeout: 15000 });
    await expect(item.getByText('предложено')).toBeVisible();
    await item.getByTestId('accept').click();
    await expect(page.getByTestId('messages')).toContainText(`Вопрос ACD-A ${stamp}`);

    await page.getByTestId('reply').fill('Здравствуйте! Чем можем помочь?');
    await page.getByTestId('send').click();

    await page.getByTestId('disposition').click();
    await page.getByRole('option', { name: 'Решено на 1-й линии' }).click();
    await page.getByTestId('topic').click();
    await page.getByRole('option', { name: 'Сайт', exact: true }).click();
    await page.getByTestId('close').click();
    await expect(page.getByText('Обращение закрыто.')).toBeVisible();

    // Постобработка (M-RT-06): статус автоматически «Постобработка», затем сам router возвращает «Готов».
    await expect(page.getByTestId('agent-status')).toContainText('Постобработка', { timeout: 5000 });
    await expect(page.getByTestId('agent-status')).toContainText('Готов', { timeout: 25000 });
    await client.ctx.close();
  });

  test('отказ от предложения возвращает обращение в очередь оператору не предлагается повторно', async ({
    page,
    browser,
  }) => {
    await login(page, 'operator2@demo.local', DEMO_PASSWORD);
    await nav(page, 'Рабочее место оператора');
    await page.getByTestId('agent-status').getByText('Готов').click();

    const client = await openWidget(browser, `Клиент ACD-B ${stamp}`);
    await client.w.getByTestId('cc-input').fill(`Вопрос ACD-B ${stamp}`);
    await client.w.getByTestId('cc-send').click();

    const item = page.getByTestId('conv-item').filter({ hasText: `Клиент ACD-B ${stamp}` });
    await expect(item).toBeVisible({ timeout: 15000 });
    await item.getByTestId('decline').click();

    await page.getByTestId('tabs').getByText('Очередь').click();
    await expect(page.getByTestId('conv-item').filter({ hasText: `Клиент ACD-B ${stamp}` })).toBeVisible({
      timeout: 10000,
    });
    await client.ctx.close();
  });

  test('супервизор видит панель очередей и операторов в реальном времени', async ({ page }) => {
    await login(page, 'supervisor@demo.local', DEMO_PASSWORD);
    await nav(page, 'Супервизор');
    await expect(page.getByTestId('supervisor-queues')).toBeVisible();
    await expect(page.getByTestId('supervisor-operators')).toBeVisible();
    await expect(page.getByTestId('supervisor-operators')).toContainText('Иванов Пётр');
  });
});
