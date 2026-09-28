import { type Browser, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav } from './helpers';

/**
 * Ф5: телефония. Браузеры с фейковым микрофоном (Chromium --use-fake-device-for-media-stream):
 * демо-абонент звонит в КЦ по WebRTC → Kamailio → Asterisk → call-control → router → софтфон оператора.
 */
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['microphone'],
});

const stamp = Date.now().toString().slice(-6);
const clientPhone = `+37529${stamp}1`;

async function operator(browser: Browser, email: string, password = DEMO_PASSWORD): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'ru-RU', permissions: ['microphone'] });
  const page = await ctx.newPage();
  await login(page, email, password);
  await nav(page, 'Рабочее место оператора');
  await expect(page.getByTestId('softphone-status')).toHaveText('Телефон готов', { timeout: 20_000 });
  return page;
}

async function demoCall(browser: Browser, phone: string, name = `Клиент ${stamp}`): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'ru-RU', permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.goto('/demo-call');
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByTestId('demo-phone').fill(phone);
  await page.getByTestId('demo-call').click();
  await expect(page.getByTestId('demo-state')).toBeVisible();
  return page;
}

test.describe.serial('Ф5: телефония', () => {
  test.setTimeout(150_000);

  test('звонок → оператор отвечает → удержание → перевод второму оператору → завершение → запись в карточке', async ({
    browser,
  }) => {
    const op1 = await operator(browser, 'operator1@demo.local');
    const op2 = await operator(browser, 'operator2@demo.local');
    await op1.getByTestId('agent-status').getByText('Готов').click();

    const client = await demoCall(browser, clientPhone);
    const call1 = op1.getByTestId('softphone-call');
    await expect(call1).toHaveAttribute('data-state', 'ringing', { timeout: 20_000 });
    await expect(call1.getByTestId('softphone-remote')).toContainText(clientPhone);
    await call1.getByTestId('call-answer').click();
    await expect(call1).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
    await expect(client.getByTestId('demo-state')).toHaveText('Идёт разговор');

    // Карточка клиента по АОН открылась автоматически.
    await expect(op1.getByTestId('messages')).toContainText(`Входящий звонок с номера ${clientPhone}`);

    await call1.getByTestId('call-hold').click();
    await expect(call1.getByTestId('call-hold')).toHaveText('Снять с удержания', { timeout: 10_000 });
    await call1.getByTestId('call-hold').click();
    await expect(call1.getByTestId('call-hold')).toHaveText('Удержание', { timeout: 10_000 });

    // Слепой перевод второму оператору.
    await call1.getByTestId('call-transfer').click();
    await op1.getByTestId('transfer-target').click();
    await op1.getByRole('option', { name: 'Кузнецова Ольга (оператор)' }).click();
    await op1.getByTestId('transfer-submit').click();
    await expect(call1).toHaveCount(0, { timeout: 15_000 });

    const call2 = op2.getByTestId('softphone-call');
    await expect(call2).toHaveAttribute('data-state', 'ringing', { timeout: 20_000 });
    await call2.getByTestId('call-answer').click();
    await expect(call2).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
    await op2.waitForTimeout(2000);
    await call2.getByTestId('call-hangup').click();
    await expect(client.getByTestId('demo-info')).toContainText('Звонок завершён', { timeout: 15_000 });

    // Журнал вызова и запись разговора в карточке обращения.
    await op2.getByTestId('tab-calls').click();
    const item = op2.getByTestId('call-item').first();
    await expect(item.getByTestId('call-state')).toHaveText('завершён', { timeout: 15_000 });
    await expect(async () => {
      await op2.getByTestId('tab-calls').click();
      await expect(item.getByTestId('recording-play')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await item.getByTestId('recording-play').click();
    await expect(item.getByTestId('recording-audio')).toBeVisible();
  });

  test('исходящий звонок с нормализацией номера: абонент (транк) отвечает, обращение с журналом вызова', async ({
    browser,
  }) => {
    const op = await operator(browser, 'operator3@demo.local');
    await op.getByTestId('dial-open').click();
    await op.getByTestId('dial-number').fill(`8 029 ${stamp.slice(0, 3)}-${stamp.slice(3)}-2`);
    await op.getByTestId('dial-call').click();
    const call = op.getByTestId('softphone-call');
    await expect(call).toHaveAttribute('data-state', 'active', { timeout: 20_000 });
    await op.waitForTimeout(1500);
    await call.getByTestId('call-hangup').click();
    await expect(call).toHaveCount(0, { timeout: 10_000 });
    await op.getByTestId('tabs').getByText('Мои').click();
    const item = op.getByTestId('conv-item').filter({ hasText: `+37529${stamp}2` });
    await expect(item).toBeVisible({ timeout: 10_000 });
    await item.click();
    await op.getByTestId('tab-calls').click();
    await expect(op.getByTestId('call-item').first()).toContainText(`Исходящий +37529${stamp}2`);
    await expect(op.getByTestId('call-item').first().getByTestId('call-state')).toHaveText('завершён');
  });

  test('супервизор прослушивает идущий разговор (M-TEL-10)', async ({ browser }) => {
    const op = await operator(browser, 'operator1@demo.local');
    const sup = await operator(browser, ADMIN.email, ADMIN.password);
    await op.getByTestId('agent-status').getByText('Готов').click();
    const client = await demoCall(browser, `+37529${stamp}3`, `Слушаемый ${stamp}`);
    const call = op.getByTestId('softphone-call');
    await expect(call).toHaveAttribute('data-state', 'ringing', { timeout: 20_000 });
    await call.getByTestId('call-answer').click();
    await expect(call).toHaveAttribute('data-state', 'active', { timeout: 15_000 });

    await sup.getByTestId('tabs').getByText('Все открытые').click();
    await sup.getByTestId('conv-item').filter({ hasText: `Слушаемый ${stamp}` }).click();
    await sup.getByTestId('tab-calls').click();
    await sup.getByTestId('call-listen').click();
    const listen = sup.getByTestId('softphone-call');
    await expect(listen).toContainText('Прослушивание разговора', { timeout: 15_000 });
    await expect(listen).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
    // Прослушивание не мешает разговору; по окончании разговора завершается и у супервизора.
    await client.getByTestId('demo-hangup').click();
    await expect(call).toHaveCount(0, { timeout: 15_000 });
    await expect(listen).toHaveCount(0, { timeout: 15_000 });
    await op.getByTestId('agent-status').getByText('Офлайн').click();
  });
});
