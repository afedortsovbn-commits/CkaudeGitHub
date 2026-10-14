import { type Browser, expect, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, listView, login, nav } from './helpers';

/**
 * Д-030, Д-031: нейросеть-заглушка — «Заполнить нейросетью» в карточке (тема и суть по переписке, поля
 * подсвечены), исправление оператора попадает в «Журнал нейросети»; помощник администратора отвечает в шапке.
 */
const stamp = Date.now().toString().slice(-6);
const CLIENT = `Клиент ИИ ${stamp}`;

async function openWidget(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto('/widget/demo.html');
  const w = page.locator('#cc-widget');
  await w.getByTestId('cc-open').click();
  await w.getByPlaceholder('Ваше имя (необязательно)').fill(CLIENT);
  await w.getByRole('checkbox').check();
  await w.getByRole('button', { name: 'Начать чат' }).click();
  return { page, w, ctx };
}

test.describe.serial('Ф21: нейросеть (заглушка)', () => {
  test('оператор: «Заполнить нейросетью», исправление — в журнал; супервизор видит журнал', async ({ browser, page }) => {
    test.setTimeout(120_000);
    const client = await openWidget(browser);
    await client.w.getByTestId('cc-input').fill(`Сотрудник АЗС №12 нагрубил на кассе ${stamp}`);
    await client.w.getByTestId('cc-send').click();

    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, '1-я линия (оператор)');
    await listView(page, 'queue');
    const item = page.getByTestId('conv-item').filter({ hasText: CLIENT });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByTestId('take').click();

    await page.getByTestId('ai-fill').click();
    await expect(page.getByText(/Заполнено полей/)).toBeVisible({ timeout: 15_000 });
    // Суть — из сообщения клиента, отмечена «проверьте».
    const summary = page.getByTestId('issue-summary');
    await expect(summary).toHaveValue(new RegExp(`нагрубил на кассе ${stamp}`));
    await expect(page.getByText('Заполнено нейросетью — проверьте').first()).toBeVisible();
    // Оператор исправляет суть.
    await summary.fill(`Грубость кассира на АЗС №12 ${stamp}`);
    await summary.blur();
    // Тема — точно «Жалобы на персонал АЗС» (заглушка могла выбрать соседнюю), № АЗС обязателен при закрытии.
    await page.getByTestId('topic').click();
    await page.getByRole('option', { name: 'Жалобы на персонал АЗС', exact: true }).first().click();
    const azs = page.getByRole('textbox', { name: 'Номер АЗС' });
    // Поля темы появляются после её загрузки.
    await azs.waitFor({ timeout: 8000 }).catch(() => undefined);
    if ((await azs.count()) && !(await azs.inputValue())) {
      await azs.fill('12');
      await azs.blur();
    }
    await page.getByTestId('reply').fill('Здравствуйте! Передадим руководству АЗС.');
    await page.getByTestId('send').click();
    await page.getByTestId('mode-close').click();
    await page.getByTestId('disposition').click();
    await page.getByRole('option', { name: 'Решено на 1-й линии' }).click();
    await page.getByTestId('close').click();
    await expect(page.getByText('Обращение закрыто.')).toBeVisible({ timeout: 15_000 });
    await client.ctx.close();

    // Супервизор: исправление сути в журнале.
    const sup = await browser.newPage({ ignoreHTTPSErrors: true });
    await login(sup, 'supervisor@demo.local', DEMO_PASSWORD);
    await nav(sup, 'Журнал нейросети');
    const row = sup.getByTestId('ai-row').filter({ hasText: `Грубость кассира на АЗС №12 ${stamp}` });
    await expect(row.first()).toBeVisible({ timeout: 15_000 });
    await expect(row.first()).toContainText(CLIENT);
    await row.first().getByTestId('ai-review').click();
    await expect(row.first()).toContainText('Просмотрел');
    await sup.context().close();
  });

  test('помощник администратора отвечает (заглушка) и даёт ссылку на раздел', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await page.getByTestId('ai-assistant-open').click();
    await page.getByTestId('ai-assistant-input').fill('Как поменять голосовое меню?');
    await page.getByTestId('ai-assistant-send').click();
    const a = page.getByTestId('ai-a').last();
    await expect(a).toContainText('Сценарии голосовых', { timeout: 15_000 });
    await expect(a.getByRole('link', { name: /Сценарии голосовых/ })).toBeVisible();
  });
});
