import { type Browser, expect, type Page, request, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, setAgentStatus } from './helpers';

const MOCK_TG = process.env.E2E_MOCK_TELEGRAM ?? 'http://127.0.0.1:8081';
const MOCK_TG_INTERNAL = 'http://mock-telegram:3000';

/**
 * Ф19 (Д-010, Д-011, Д-012, Д-013; 12.10.2026): бот Telegram для сотрудников (настройка, привязка по коду из профиля,
 * кнопка «Панель»), минимум операторов на линии (оператору нельзя уйти, супервизору — уведомление), правила
 * уведомлений и настройки почты. В конце — минимум снят, бот выключен.
 */
test.describe.serial('Ф19: уведомления, минимум операторов, бот для сотрудников', () => {
  const stamp = Date.now().toString().slice(-6);
  const token = `e2e${stamp}:staff-bot-token`;
  const chatId = 700000 + Number(stamp.slice(-4));
  const opts = { ignoreHTTPSErrors: true, locale: 'ru-RU', viewport: { width: 1440, height: 900 } };
  const as = async (browser: Browser, email: string, password = DEMO_PASSWORD): Promise<Page> => {
    const page = await (await browser.newContext(opts)).newPage();
    await login(page, email, password);
    return page;
  };
  const tgSay = async (text: string) => {
    const r = await fetch(`${MOCK_TG}/__test/${token}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, text, firstName: 'Супервизор' }),
    });
    expect(r.ok).toBe(true);
  };
  const tgSent = async () =>
    (await (await fetch(`${MOCK_TG}/__test/${token}/sent`)).json()) as { chat_id: string; text?: string }[];
  const waitSent = async (re: RegExp, timeoutMs = 30_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const sent = await tgSent();
      const hit = sent.find((m) => String(m.chat_id) === String(chatId) && re.test(m.text ?? ''));
      if (hit) return hit;
      if (Date.now() > until)
        throw new Error(`бот не ответил: ${re}; было: ${JSON.stringify(sent.slice(-3))}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  async function setMinimum(admin: Page, value: number) {
    await nav(admin, 'Уведомления');
    await admin.getByTestId('notify-tab-staffing').click();
    await admin.getByTestId('staffing-fill-value').fill(String(value));
    for (let d = 1; d <= 7; d++) await admin.getByTestId(`staffing-fill-${d}`).click();
    await admin.getByTestId('staffing-save').click();
    await expect(admin.getByText('Минимум сохранён')).toBeVisible();
  }

  test('администратор настраивает бота для сотрудников и минимум операторов', async ({ browser }) => {
    const admin = await as(browser, ADMIN.email, ADMIN.password);
    await nav(admin, 'Уведомления');
    await expect(admin.getByTestId('rules-table')).toContainText('Операторов на линии меньше минимума');
    await admin.getByTestId('notify-tab-telegram').click();
    await admin.getByTestId('bot-token').fill(token);
    await admin.getByTestId('bot-api-root').fill(MOCK_TG_INTERNAL);
    await admin.getByTestId('bot-save').click();
    await expect(admin.getByText('Сохранено')).toBeVisible();
    await expect(admin.getByTestId('bot-status')).toContainText('настроен');
    await admin.getByTestId('notify-tab-mail').click();
    await expect(admin.getByTestId('mail-copy-to')).toHaveValue(/beloil\.by/);
    await setMinimum(admin, 1);
    await admin.context().close();
  });

  test('супервизор привязывает Telegram по коду из профиля и получает сводку «Панель»', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const sup = await as(browser, 'supervisor@demo.local');
    await sup.goto('/profile');
    await expect(sup.getByTestId('tg-status')).toContainText('Не привязан');
    await sup.getByTestId('tg-link').click();
    const code = (await sup.getByTestId('tg-code').textContent())?.replace(/\D/g, '') ?? '';
    expect(code).toMatch(/^\d{6}$/);
    await tgSay(`/start ${code}`);
    await waitSent(/Telegram привязан/, 60_000);
    await sup.reload();
    await sup.goto('/profile');
    await expect(sup.getByTestId('tg-status')).toContainText('Привязан');
    // Уведомление «минимум операторов» — ещё и в Telegram (правило), «Панель» — сводка мониторинга.
    await tgSay('Панель');
    await waitSent(/Контакт-центр/);
    await sup.context().close();
  });

  test('оператор не может уйти с линии ниже минимума; супервизор получает уведомление в колокольчик и Telegram', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const admin = await as(browser, ADMIN.email, ADMIN.password);
    await nav(admin, 'Уведомления');
    const row = admin
      .getByTestId('rule-row')
      .filter({ hasText: 'Операторов на линии меньше минимума' })
      .first();
    await row.getByTestId('rule-edit').click();
    const dlg = admin.getByRole('dialog');
    await dlg.getByLabel('Каналы').click();
    await admin.getByRole('option', { name: 'Telegram' }).click();
    await dlg.getByLabel('Каналы').press('Escape');
    await dlg.getByRole('button', { name: 'Сохранить' }).click();
    await expect(admin.getByText('Сохранено')).toBeVisible();
    await admin.context().close();

    const op = await as(browser, 'operator1@demo.local');
    await nav(op, '1-я линия (оператор)');
    await setAgentStatus(op, 'ready');
    await op.getByTestId('agent-status').click();
    await op.getByTestId('agent-status-offline').click();
    await expect(op.getByText(/Невозможно: на линии останется/)).toBeVisible();
    await expect(op.getByTestId('agent-status')).toHaveAttribute('data-status', 'ready');

    const api = await request.newContext({ ignoreHTTPSErrors: true });
    const loginR = await api.post('/api/v1/auth/login', {
      data: { email: 'supervisor@demo.local', password: DEMO_PASSWORD },
    });
    const tokenSup = (await loginR.json()).accessToken as string;
    const notes = await (
      await api.get('/api/v1/notifications?limit=20', { headers: { authorization: `Bearer ${tokenSup}` } })
    ).json();
    expect(JSON.stringify(notes)).toMatch(/хочет уйти с линии/);
    await api.dispose();
    await waitSent(/хочет уйти с линии/, 60_000);

    // Минимум снят — уйти можно.
    const admin2 = await as(browser, ADMIN.email, ADMIN.password);
    await setMinimum(admin2, 0);
    await admin2.context().close();
    await setAgentStatus(op, 'offline');
    await expect(op.getByTestId('agent-status')).toHaveAttribute('data-status', 'offline');
    await op.context().close();
  });

  test('администратор выключает бота (привязка супервизора снимается)', async ({ browser }) => {
    const admin = await as(browser, ADMIN.email, ADMIN.password);
    await nav(admin, 'Уведомления');
    await admin.getByTestId('notify-tab-telegram').click();
    await admin.getByTestId('bot-token').fill('-');
    await admin.getByTestId('bot-save').click();
    await expect(admin.getByText('Сохранено')).toBeVisible();
    await expect(admin.getByTestId('bot-status')).toContainText('не настроен');
    await admin.context().close();
    const sup = await as(browser, 'supervisor@demo.local');
    await sup.goto('/profile');
    if (
      await sup
        .getByTestId('tg-unlink')
        .isVisible()
        .catch(() => false)
    )
      await sup.getByTestId('tg-unlink').click();
    await sup.context().close();
  });
});
