import { type Browser, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, setAgentStatus } from './helpers';

/**
 * Ф17 (Д-017, 10.10.2026): распределение «по загрузке». Администратор включает режим; у оператора появляется
 * «Взять следующее» (пустая неспешная очередь — подсказка), чат назначается системой, после закрытия —
 * постобработка с «+2 мин»; чат с молчащим клиентом закрывается сам с сообщением клиенту; у супервизора —
 * занятость, незакрытые карточки, просроченные. В конце режим возвращается к обычному.
 */
test.describe.serial('Ф17: распределение «по загрузке»', () => {
  const stamp = Date.now().toString().slice(-6);
  const opts = { ignoreHTTPSErrors: true, locale: 'ru-RU', viewport: { width: 1440, height: 900 } };
  const as = async (browser: Browser, email: string, password = DEMO_PASSWORD): Promise<Page> => {
    const page = await (await browser.newContext(opts)).newPage();
    await login(page, email, password);
    return page;
  };
  async function openWidget(browser: Browser, name: string, text: string) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto('/widget/demo.html');
    const w = page.locator('#cc-widget');
    await w.getByTestId('cc-open').click();
    await w.getByPlaceholder('Ваше имя (необязательно)').fill(name);
    await w.getByRole('checkbox').check();
    await w.getByRole('button', { name: 'Начать чат' }).click();
    await w.getByTestId('cc-input').fill(text);
    await w.getByTestId('cc-send').click();
    return { page, w, ctx };
  }
  async function setMode(browser: Browser, mode: 'load' | 'standard', silenceMin?: number) {
    const admin = await as(browser, ADMIN.email, ADMIN.password);
    await nav(admin, 'Настройки');
    // Поля режима «по загрузке» видны только в нём: при возврате к обычному режиму сначала вернуть молчание клиента
    // к умолчанию (15 мин), затем переключить режим — иначе на стенде останется 1 мин.
    if (mode === 'standard') {
      // Настройки подгружаются после открытия страницы — дождаться поля (в обычном режиме его не будет).
      const silence = admin.getByTestId('routing-silence-min');
      await silence.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      if (await silence.isVisible()) await silence.fill('15');
    }
    await admin.getByTestId('routing-mode').click();
    await admin.getByRole('option', { name: mode === 'load' ? /По загрузке/ : /По группам каналов/ }).click();
    if (mode === 'load' && silenceMin !== undefined)
      await admin.getByTestId('routing-silence-min').fill(String(silenceMin));
    await admin.getByRole('button', { name: 'Сохранить' }).click();
    await expect(admin.getByText('Сохранено')).toBeVisible();
    await admin.context().close();
  }

  test('администратор включает режим «по загрузке» (молчание клиента — 1 мин)', async ({ browser }) => {
    await setMode(browser, 'load', 1);
  });

  test('оператор: «Взять следующее» при пустой очереди, чат от системы, «+2 мин» к постобработке', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, '1-я линия (оператор)');
    await setAgentStatus(page, 'ready');
    await expect(page.getByTestId('take-next')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('take-next').click();
    await expect(page.getByText('В неспешной очереди нет обращений')).toBeVisible();

    const client = await openWidget(browser, `Клиент Ф17-A ${stamp}`, `Вопрос Ф17-A ${stamp}`);
    const item = page.getByTestId('conv-item').filter({ hasText: `Клиент Ф17-A ${stamp}` });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByTestId('accept').click();
    await expect(page.getByTestId('messages')).toContainText(`Вопрос Ф17-A ${stamp}`);
    await page.getByTestId('reply').fill('Здравствуйте! Уточняю.');
    await page.getByTestId('send').click();

    await page.getByTestId('disposition').click();
    await page.getByRole('option', { name: 'Решено на 1-й линии' }).click();
    await page.getByTestId('topic').click();
    await page.getByRole('option', { name: 'Сайт', exact: true }).click();
    await page.getByTestId('close').click();
    await expect(page.getByText('Обращение закрыто.')).toBeVisible();
    // Постобработка (очередь, 15 с) — в режиме «по загрузке» доступно продление «+2 мин».
    await expect(page.getByTestId('agent-status')).toContainText('Постобработка', { timeout: 10_000 });
    await page.getByTestId('wrapup-extend').click();
    await expect(page.getByText('Постобработка продлена')).toBeVisible();
    // Таймер в шапке обновляется по опросу статуса (до 5 с).
    await expect
      .poll(
        async () =>
          Number(/(\d+)\s*с/.exec((await page.getByTestId('agent-status').textContent()) ?? '')?.[1] ?? 0),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(60);
    await setAgentStatus(page, 'offline');
    await client.ctx.close();
  });

  test('чат с молчащим клиентом закрывается сам с сообщением клиенту', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await login(page, 'operator2@demo.local', DEMO_PASSWORD);
    await nav(page, '1-я линия (оператор)');
    await setAgentStatus(page, 'ready');
    const client = await openWidget(browser, `Клиент Ф17-B ${stamp}`, `Вопрос Ф17-B ${stamp}`);
    const item = page.getByTestId('conv-item').filter({ hasText: `Клиент Ф17-B ${stamp}` });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByTestId('accept').click();
    await page.getByTestId('reply').fill('Подскажите, пожалуйста, номер АЗС.');
    await page.getByTestId('send').click();
    // Клиент молчит 1 минуту: worker закрывает чат, клиент получает сообщение из настройки.
    await expect(client.w).toContainText('давно не получали от вас ответа', { timeout: 120_000 });
    await expect(page.getByTestId('messages')).toContainText('закрыт автоматически', { timeout: 20_000 });
    await setAgentStatus(page, 'offline');
    await client.ctx.close();
  });

  test('супервизор видит занятость, незакрытые карточки и просроченные', async ({ page }) => {
    await login(page, 'supervisor@demo.local', DEMO_PASSWORD);
    await nav(page, 'Супервизор');
    await expect(page.getByTestId('supervisor-operators')).toContainText('Занятость');
    await expect(page.getByTestId('supervisor-operators')).toContainText('Не закрыто после звонка');
    await expect(page.getByTestId('supervisor-overdue')).toBeVisible();
    await expect(page.getByTestId('supervisor-occupancy').first()).toBeVisible();
  });

  test('администратор возвращает обычный режим', async ({ browser }) => {
    await setMode(browser, 'standard');
  });
});
