import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav } from './helpers';

/** Мок внешних систем (mock-selfservice): Rocket Data (учётная запись demo — демо-канал) и выгрузка объектов. */
const MOCK = process.env.E2E_MOCK_SELFSERVICE_URL ?? 'http://127.0.0.1:8082';
const stamp = Date.now().toString().slice(-6);

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

async function choose(page: Page, testId: string, option: string) {
  await page.getByTestId(testId).click();
  await page.getByRole('option', { name: option, exact: true }).first().click();
}

async function mock(path: string, body?: unknown) {
  const r = await fetch(`${MOCK}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(r.ok, `${path}: ${r.status}`).toBeTruthy();
  return r.json();
}

test.describe.serial('Ф13: отзывы с карт (Rocket Data) и синхронизация объектов', () => {
  test('демо-сценарий 10: отзыв по объекту → обращение предприятия → ответ уходит в Rocket Data; отчёт по отзывам', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const author = `Автор ${stamp}`;
    const text = `Грубый кассир на АЗС, отзыв ${stamp}`;
    await mock('/rocketdata/demo/__test/reviews', {
      id: `e2e-${stamp}`,
      location_id: 'rd-azs-1',
      platform: 'yandex',
      rating: 1,
      text,
      author_name: author,
    });

    const op = await as(browser, 'operator1@demo.local');
    await nav(op, 'Рабочее место оператора');
    await op.getByTestId('tabs').getByText('Очередь').click();
    // Канал опрашивает Rocket Data раз в 10 с (демо-настройка).
    const item = op.getByTestId('conv-item').filter({ hasText: author });
    await expect(item).toBeVisible({ timeout: 45_000 });
    await expect(item).toContainText('Отзыв');
    await expect(item).toContainText('★☆☆☆☆');
    await expect(item).toContainText('срочное');
    await item.getByTestId('take').click();

    // Карточка отзыва: площадка, оценка, объект, ссылка; предприятие — по объекту.
    const panel = op.getByTestId('review-panel');
    await expect(panel).toContainText('Яндекс Карты');
    await expect(op.getByTestId('review-rating')).toHaveText('★☆☆☆☆');
    await expect(op.getByTestId('review-object')).toHaveText('АЗС №1');
    await expect(op.getByTestId('review-link')).toHaveAttribute('href', /yandex/);
    await expect(op.getByTestId('messages')).toContainText(text);
    await expect(op.getByRole('textbox', { name: 'Предприятие', exact: true })).toHaveValue(
      'Предприятие «Север»',
    );

    // Ответ на отзыв публикуется через Rocket Data: статус доставки и ответ в моке.
    const answer = `Спасибо за отзыв, ${author}! Разобрались с сотрудником.`;
    await expect(op.getByTestId('reply')).toHaveAttribute('placeholder', /Публичный ответ на отзыв/);
    await op.getByTestId('reply').fill(answer);
    await op.getByTestId('send').click();
    await expect(op.getByTestId('delivery-sent')).toBeVisible({ timeout: 30_000 });
    const answers = (await mock('/rocketdata/demo/__test/answers')) as { reviewId: string; text: string }[];
    expect(answers.filter((a) => a.text === answer)).toEqual([
      expect.objectContaining({ reviewId: `e2e-${stamp}` }),
    ]);

    // Дальше — как обычное обращение: тема, результат, закрытие.
    await choose(op, 'topic', 'Жалобы на персонал АЗС ❗');
    // Тема требует номер АЗС при закрытии (поле появляется после выбора темы).
    const station = op.getByRole('textbox', { name: 'Номер АЗС *' });
    await station.fill('1');
    await station.blur();
    await choose(op, 'disposition', 'Решено на 1-й линии');
    await op.getByTestId('close').click();
    await expect(op.getByText('Обращение закрыто.')).toBeVisible();

    // Повторная загрузка (следующий опрос) не создаёт дубля: обращение одно.
    await op.waitForTimeout(12_000);
    await op.getByTestId('tabs').getByText('Закрытые').click();
    await expect(op.getByTestId('conv-item').filter({ hasText: author })).toHaveCount(1);

    // Отчёт по отзывам: по объектам, отзыв отвечен.
    const admin = await as(browser, ADMIN.email, ADMIN.password);
    await nav(admin, 'Отчёты');
    await choose(admin, 'report-kind', 'Отзывы с карт: оценки и доля отвеченных');
    await choose(admin, 'report-group', 'по объектам');
    const table = admin.getByTestId('report-table');
    await expect(table).toContainText('Доля отвеченных, %');
    await expect(table.locator('tr').filter({ hasText: 'АЗС №1' })).toBeVisible();
  });

  test('синхронизация объектов: проверка без изменений, запуск — добавление, изменение, деактивация, журнал', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    // Выгрузка источника: новая АЗС, переименованная, закрытая ЭЗС.
    await mock('/objects/__test/feed', { reset: true });
    const base = await (
      await fetch(`${MOCK}/objects/feed.json`, { headers: { authorization: 'Bearer demo-objects-token' } })
    ).json();
    const next = (base as { code: string; name: string; is_active?: boolean }[]).map((o) =>
      o.code === 'AZS-2'
        ? { ...o, name: `АЗС №2 (${stamp})` }
        : o.code === 'EV-1'
          ? { ...o, is_active: false }
          : o,
    );

    const admin = await as(browser, ADMIN.email, ADMIN.password);
    await nav(admin, 'Синхронизация объектов');
    await expect(admin.getByTestId('sync-url')).toHaveValue(/objects\/feed\.json/);
    // Исходное состояние — справочник по исходной выгрузке (тест не зависит от предыдущих прогонов).
    await admin.getByTestId('sync-run').click();
    await expect(admin.getByTestId('sync-summary')).toContainText('успешно');
    await mock('/objects/__test/feed', { items: next });
    await admin.getByTestId('sync-dry').click();
    await expect(admin.getByTestId('sync-summary')).toContainText('проверка без изменений');
    await expect(admin.getByTestId('sync-changes')).toContainText(`АЗС №2 (${stamp})`);

    await admin.getByTestId('sync-run').click();
    await expect(admin.getByTestId('sync-summary')).not.toContainText('проверка без изменений');
    await expect(admin.getByTestId('sync-summary')).toContainText('успешно');
    const changes = admin.getByTestId('sync-changes');
    // У объекта может быть две строки: переход под синхронизацию (источник) и деактивация.
    await expect(
      changes.locator('tr').filter({ hasText: 'EV-1' }).filter({ hasText: 'деактивирован' }),
    ).toBeVisible();
    await expect(
      changes
        .locator('tr')
        .filter({ hasText: 'AZS-2' })
        .filter({ hasText: `АЗС №2 (${stamp})` })
        .first(),
    ).toBeVisible();
    await expect(admin.getByTestId('sync-runs').locator('tbody tr').first()).toContainText('вручную');

    // В справочнике: объекты под синхронизацией, переименование применено; ручная правка запрещена.
    await nav(admin, 'Объекты');
    const row = admin.getByTestId('dict-objects').locator('tbody tr').filter({ hasText: 'AZS-2' });
    await expect(row).toContainText(`АЗС №2 (${stamp})`);
    await expect(row).toContainText('синхронизация');

    // Возврат исходной выгрузки: ЭЗС снова активна, название восстановлено.
    await mock('/objects/__test/feed', { reset: true });
    await nav(admin, 'Синхронизация объектов');
    await admin.getByTestId('sync-run').click();
    await expect(
      admin
        .getByTestId('sync-changes')
        .locator('tr')
        .filter({ hasText: 'EV-1' })
        .filter({ hasText: 'снова активен' }),
    ).toBeVisible();
  });
});
