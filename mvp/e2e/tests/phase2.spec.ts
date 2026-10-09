import { type Browser, expect, type Page, test } from '@playwright/test';
import { DEMO_PASSWORD, login, nav, listView } from './helpers';

const stamp = Date.now().toString().slice(-6);

async function openWidget(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto('/widget/demo.html');
  const w = page.locator('#cc-widget');
  await w.getByTestId('cc-open').click();
  await w.getByPlaceholder('Ваше имя (необязательно)').fill(`Клиент ${stamp}`);
  await w.getByRole('checkbox').check();
  await w.getByRole('button', { name: 'Начать чат' }).click();
  return { page, w, ctx };
}

async function clientSays(w: ReturnType<Page['locator']>, text: string) {
  await w.getByTestId('cc-input').fill(text);
  await w.getByTestId('cc-send').click();
}

test.describe.serial('Ф2: чат на сайте → оператор', () => {
  test('клиент пишет → оператор берёт → переписка с файлом → закрытие с темой; повторное обращение видит историю', async ({
    page,
    browser,
  }) => {
    const client = await openWidget(browser);
    await clientSays(client.w, `Здравствуйте, вопрос ${stamp}`);
    await expect(client.w.getByTestId('cc-msg-in').filter({ hasText: `вопрос ${stamp}` })).toBeVisible();

    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, 'Рабочее место оператора');
    await expect(page.getByTestId('rt-status')).toHaveText('онлайн');
    await listView(page, 'queue');
    const item = page.getByTestId('conv-item').filter({ hasText: `Клиент ${stamp}` });
    await expect(item).toBeVisible();
    await item.getByTestId('take').click();
    await expect(page.getByTestId('messages')).toContainText(`вопрос ${stamp}`);
    await expect(client.w.locator('.m.system').filter({ hasText: 'подключился' })).toBeVisible();

    // Ответ с вложением
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('attach').click();
    await (
      await chooser
    ).setFiles({
      name: 'инструкция.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Инструкция по возврату'),
    });
    await expect(page.getByText('инструкция.txt')).toBeVisible();
    await page.getByTestId('reply').fill('Добрый день! Направляем инструкцию.');
    await page.getByTestId('send').click();
    const reply = client.w.getByTestId('cc-msg-out').filter({ hasText: 'Направляем инструкцию' });
    await expect(reply).toBeVisible();
    await expect(reply.getByRole('link', { name: 'инструкция.txt' })).toBeVisible();

    // Клиент отвечает — оператор видит без перезагрузки (realtime)
    await clientSays(client.w, 'Спасибо, получил');
    await expect(page.getByTestId('messages')).toContainText('Спасибо, получил');

    // Внутренняя заметка клиенту не видна
    await page.getByLabel('Внутренняя заметка').check();
    await page.getByTestId('reply').fill('Заметка для коллег');
    await page.getByTestId('send').click();
    await expect(page.getByTestId('msg-note')).toContainText('Заметка для коллег');
    await page.getByLabel('Внутренняя заметка').uncheck();

    // Закрытие без темы запрещено; с темой — успешно
    await page.getByTestId('disposition').click();
    await page.getByRole('option', { name: 'Решено на 1-й линии' }).click();
    await page.getByTestId('close').click();
    await expect(page.getByText('Заполните обязательные поля')).toBeVisible();
    await page.getByTestId('topic').click();
    await page.getByRole('option', { name: 'Сайт', exact: true }).click();
    await expect(page.getByTestId('topic-full')).toContainText('Сайт');
    await page.getByTestId('close').click();
    await expect(page.getByText('Обращение закрыто.')).toBeVisible();
    await expect(client.w.locator('.m.system').filter({ hasText: 'Диалог завершён' })).toBeVisible();
    await expect(client.w.getByText('Заметка для коллег')).toHaveCount(0);

    // Повторное обращение того же клиента: новое обращение, история видна оператору
    await clientSays(client.w, 'И ещё вопрос');
    await listView(page, 'queue');
    const again = page.getByTestId('conv-item').filter({ hasText: `Клиент ${stamp}` });
    await again.getByTestId('take').click();
    await page.getByRole('tab', { name: 'Клиент' }).click();
    await expect(page.getByTestId('history').locator('p')).toHaveCount(2);
    await client.ctx.close();
  });

  test('виджет: без согласия на обработку ПДн начать чат нельзя', async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    await p.goto('/widget/demo.html');
    const w = p.locator('#cc-widget');
    await w.getByTestId('cc-open').click();
    await expect(w.getByRole('button', { name: 'Начать чат' })).toBeDisabled();
    await ctx.close();
  });
});
