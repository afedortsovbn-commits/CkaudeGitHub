import { readFileSync } from 'node:fs';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, listView } from './helpers';

const stamp = Date.now().toString().slice(-6);

/** Контексты закрываются после каждого теста (софтфон сотрудника не должен оставаться зарегистрированным). */
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

async function as(browser: Browser, email: string, password = DEMO_PASSWORD): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await login(page, email, password);
  return page;
}

async function openWidget(browser: Browser, name: string, text: string) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto('/widget/demo.html');
  const w = page.locator('#cc-widget');
  await w.getByTestId('cc-open').click();
  await w.getByPlaceholder('Ваше имя (необязательно)').fill(name);
  await w.getByRole('checkbox').check();
  await w.getByRole('button', { name: 'Начать чат' }).click();
  await w.getByTestId('cc-input').fill(text);
  await w.getByTestId('cc-send').click();
  return w;
}

async function choose(page: Page, testId: string, option: string) {
  await page.getByTestId(testId).click();
  await page.getByRole('option', { name: option, exact: true }).first().click();
}

/** Оператор берёт обращение из очереди, указывает предприятие и тему и закрывает «Решено на 1-й линии». */
async function handle(op: Page, client: string, enterprise: string, topic: string, station?: string) {
  await listView(op, 'queue');
  const item = op.getByTestId('conv-item').filter({ hasText: client });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.getByTestId('take').click();
  // Поля карточки (в т.ч. блок АЗС с предприятием) появляются после выбора темы; блок АЗС может быть свёрнут.
  await choose(op, 'topic', topic);
  if (!(await op.getByTestId('org').isVisible()))
    await op.getByTestId('block-azs').getByTestId('block-more').click();
  await op.getByTestId('org').click();
  await op.getByRole('option', { name: enterprise, exact: true }).click();
  if (station) {
    await op.getByRole('textbox', { name: 'Номер АЗС' }).fill(station);
    await op.getByRole('textbox', { name: 'Номер АЗС' }).blur();
  }
  await op.getByTestId('reply').fill('Здравствуйте! Вопрос решён.');
  await op.getByTestId('send').click();
  await choose(op, 'disposition', 'Решено на 1-й линии');
  await op.getByTestId('close').click();
  await expect(op.getByText('Обращение закрыто.')).toBeVisible();
}

async function openReport(page: Page, title: string, group?: string) {
  await nav(page, 'Отчёты');
  await choose(page, 'report-kind', title);
  if (group) await choose(page, 'report-group', group);
  await expect(page.getByTestId('report-table')).toBeVisible();
}

test.describe.serial('Ф10: упрощённая аналитика', () => {
  test('демо-сценарий 7: панель реального времени с порогами, отчёты и выгрузка CSV', async ({ browser }) => {
    test.setTimeout(120_000);
    const admin = await as(browser, ADMIN.email, ADMIN.password);
    // Порог «ожидающих в очереди — внимание» = 1: любая ожидающая очередь подсвечивается (без перезапуска).
    await nav(admin, 'Настройки');
    await admin.getByTestId('setting-queueWarn').fill('1');
    await admin.getByRole('button', { name: 'Сохранить' }).click();
    await expect(admin.getByText('Сохранено')).toBeVisible();

    await openWidget(browser, `Клиент ОТЧ ${stamp}`, 'Когда откроется АЗС?');
    await nav(admin, 'Супервизор');
    await expect(admin.getByTestId('supervisor-summary')).toBeVisible();
    const row = admin.getByTestId('queue-row-Общая');
    await expect(row).toHaveAttribute('data-level', /[12]/, { timeout: 15_000 });
    await expect(admin.getByText(/Подсветка: ожидание от/)).toBeVisible();

    // Отчёты: SL по каналам, обращения за 7 дней, выгрузка CSV.
    await openReport(admin, 'Уровень обслуживания (SL) и пропущенные', 'по каналам');
    await expect(admin.getByTestId('report-table')).toContainText('SL, %');
    await openReport(admin, 'Обращения по каналам, темам и результатам', 'по каналам');
    await expect(admin.getByTestId('report-totals')).toContainText('Итого');
    await expect(admin.getByTestId('report-table')).toContainText('Чат на сайте');
    const download = admin.waitForEvent('download');
    await admin.getByTestId('report-csv').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(
      /^report-conversations-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    const text = readFileSync((await file.path())!, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')[0]).toMatch(/^Канал;Поступило;Закрыто;/);
    expect(text).toContain('Итого;');

    // Порог — обратно по умолчанию.
    await nav(admin, 'Настройки');
    await admin.getByTestId('setting-queueWarn').fill('5');
    await admin.getByRole('button', { name: 'Сохранить' }).click();
    await expect(admin.getByText('Сохранено').first()).toBeVisible();
  });

  test('демо-сценарий 9: область видимости в отчётах и быстрый фильтр «Особо важные»', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const south = `Клиент Юг ${stamp}`;
    const north = `Клиент Север ${stamp}`;
    await openWidget(browser, south, 'Не работает сайт');
    await openWidget(browser, north, 'Нагрубили на АЗС');
    const op = await as(browser, 'operator1@demo.local');
    await nav(op, 'Рабочее место оператора');
    await handle(op, south, 'Предприятие «Юг»', 'Сайт');
    // Тема особо важная — обращение помечается автоматически.
    await handle(op, north, 'Предприятие «Север»', 'Жалобы на персонал АЗС ❗', '12');

    // Администратор (область — всё) видит оба предприятия.
    const admin = await as(browser, ADMIN.email, ADMIN.password);
    await openReport(admin, 'Обращения по каналам, темам и результатам', 'по предприятиям');
    await expect(admin.getByTestId('report-table')).toContainText('Предприятие «Юг»');
    await expect(admin.getByTestId('report-table')).toContainText('Предприятие «Север»');

    // Супервизор с областью «Север» не видит «Юг» ни в строках, ни в фильтре по предприятию.
    const sup = await as(browser, 'supervisor@demo.local');
    await openReport(sup, 'Обращения по каналам, темам и результатам', 'по предприятиям');
    await expect(sup.getByTestId('report-table')).toContainText('Предприятие «Север»');
    await expect(sup.getByTestId('report-table')).not.toContainText('Предприятие «Юг»');
    await sup.getByTestId('report-filter-enterpriseId').click();
    await sup.getByRole('option', { name: 'Предприятие «Юг»', exact: true }).click();
    await expect(sup.getByTestId('report-table')).toContainText('Нет данных за период');
    await sup.getByTestId('report-filter-enterpriseId').click();
    await sup.getByRole('option', { name: 'Предприятие «Юг»', exact: true }).click(); // снять выбор

    // «Особо важные»: только обращения по особо важным темам.
    await choose(sup, 'report-group', 'по темам');
    await expect(sup.getByTestId('report-table')).toContainText('Жалобы на персонал АЗС');
    await sup.getByText('Особо важные', { exact: true }).click();
    await expect(sup.getByTestId('report-table')).toContainText('Жалобы на персонал АЗС');
    await expect(sup.getByTestId('report-table')).not.toContainText('Сайт');
    // Реестр просроченных открывается и у супервизора.
    await choose(sup, 'report-kind', 'Реестр просроченных тикетов');
    await expect(sup.getByTestId('report-table')).toContainText('№ тикета');
  });
});
