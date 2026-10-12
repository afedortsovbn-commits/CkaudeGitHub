import { expect, request, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, listView, login, nav, setAgentStatus } from './helpers';

const GAS_KEY = process.env.E2E_DEMO_GAS_API_KEY ?? 'cck_demo_gas_key_change_me_0123456789abcdef';

/**
 * Ф18 (Д-019, Д-020, 12.10.2026): заявление на скидку по газу из личного кабинета сайта приходит по API в канал с
 * темой «Акция по газу»: у оператора — поля заявления, документ, срок ответа; повторное заявление по той же карте —
 * предупреждение о похожем обращении; «Скидка присвоена — закрыть». Администратор задаёт срок по каналу; отчёт.
 */
test.describe.serial('Ф18: акция по газу и сроки по каналам', () => {
  const stamp = Date.now().toString().slice(-6);
  const card = `2000 0116 ${stamp}`;
  const name1 = `Газов Иван ${stamp}`;
  const name2 = `Газова Анна ${stamp}`;

  test('два заявления по API (второе — повтор по номеру карты)', async () => {
    const api = await request.newContext({ ignoreHTTPSErrors: true });
    const send = async (externalId: string, fullName: string, plate: string) =>
      api.post('/api/v1/ext/inbound', {
        headers: { authorization: `Bearer ${GAS_KEY}` },
        data: {
          externalId,
          contact: { externalId: `lk-${externalId}`, name: fullName },
          text: '',
          fields: {
            card_number: card,
            full_name: fullName,
            sto_name: 'ИП Жосан Е.В.',
            sto_region: 'Брестская',
            plate,
            install_date: '2026-09-11',
          },
          attachments: [
            {
              filename: 'заявление.txt',
              contentType: 'text/plain',
              base64: Buffer.from(`Заявление на скидку, ${fullName}`).toString('base64'),
            },
          ],
        },
      });
    const r1 = await send(`gas-${stamp}-1`, name1, `1111AA${stamp.slice(-1)}`);
    expect(r1.status()).toBe(202);
    const r2 = await send(`gas-${stamp}-2`, name2, `2222BB${stamp.slice(-1)}`);
    expect(r2.status()).toBe(202);
    await api.dispose();
  });

  test('оператор: поля заявления и срок, предупреждение о повторе, «Скидка присвоена — закрыть»', async ({
    page,
  }) => {
    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, '1-я линия (оператор)');
    await setAgentStatus(page, 'offline');
    await listView(page, 'queue');
    const item = page.getByTestId('conv-item').filter({ hasText: name2 });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item.getByTestId('badge-due')).toBeVisible();
    await expect(item).toContainText('Акция по газу');
    await item.getByTestId('take').click();
    await expect(page.getByTestId('topic-fields')).toContainText('Номер карты');
    await expect(page.getByTestId('duplicates-banner')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('duplicates-banner')).toContainText('Номер карты');
    await expect(page.getByTestId('messages')).toContainText('заявление.txt');
    await page.getByTestId('gas-grant').click();
    await expect(page.getByText('Скидка присвоена, обращение закрыто')).toBeVisible();
  });

  test('администратор задаёт срок по каналу; супервизор видит таблицу сроков', async ({ browser }) => {
    const admin = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await login(admin, ADMIN.email, ADMIN.password);
    await nav(admin, 'Настройки');
    const row = admin.getByTestId('due-row').filter({ hasText: 'Акция по газу' });
    await expect(row).toBeVisible();
    await row.getByTestId('due-days-api').fill('3');
    await admin.getByTestId('due-save').click();
    await expect(admin.getByText('Сохранено')).toBeVisible();
    await admin.reload();
    await expect(
      admin.getByTestId('due-row').filter({ hasText: 'Акция по газу' }).getByTestId('due-days-api'),
    ).toHaveValue('3');
    await admin
      .getByTestId('due-row')
      .filter({ hasText: 'Акция по газу' })
      .getByTestId('due-days-api')
      .fill('2');
    await admin.getByTestId('due-save').click();
    await expect(admin.getByText('Сохранено')).toBeVisible();
    await admin.context().close();

    const sup = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await login(sup, 'supervisor@demo.local', DEMO_PASSWORD);
    await nav(sup, 'Супервизор');
    await expect(sup.getByTestId('channel-due')).toBeVisible();
    await expect(sup.getByTestId('due-row').filter({ hasText: 'Акция по газу' })).toBeVisible();
    await sup.context().close();
  });

  test('отчёт «Акция по газу» показывает заявления с номером карты и скидкой', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Отчёты');
    await page.getByTestId('report-kind').click();
    await page.getByRole('option', { name: /Акция по газу/ }).click();
    await expect(page.getByTestId('report-table')).toContainText(card, { timeout: 15_000 });
    await expect(page.getByTestId('report-table')).toContainText(name2);
  });
});
