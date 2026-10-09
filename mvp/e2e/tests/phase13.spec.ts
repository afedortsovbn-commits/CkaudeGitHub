import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, listView } from './helpers';

/** Мок внешних систем (mock-selfservice): сервис ответов Rocket Data (учётная запись demo — демо-канал) и выгрузка АСУ. */
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
  test('демо-сценарий 10: Rocket Data присылает отзыв → обращение предприятия АЗС → ответ уходит в Rocket Data; отчёт', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const author = `Автор ${stamp}`;
    const text = `Грубый кассир на АЗС, отзыв ${stamp}`;
    const review = {
      TicketMapId: `9${stamp}`,
      DateReceipt: new Date(Date.now() - 3_600_000)
        .toLocaleString('sv-SE', { timeZone: 'Europe/Minsk' })
        .replace(' ', 'T'),
      // GUID демо-АЗС №1 — в виде, как в отзыве Rocket Data (с дефисами).
      StationGuid: 'DE000000-0000-0000-0000-000000000001',
      StationType: 'АЗС',
      StationNum: '1',
      EmitentName: 'Предприятие «Север»',
      ClientName: author,
      Message: text,
      Link: 'https://yandex.by/maps/org/1/reviews',
      Site: 'yandex.ru',
    };

    // Адрес приёма отзывов демо-канала — из списка каналов (его передают Rocket Data).
    const admin = await as(browser, ADMIN.email, ADMIN.password);
    await nav(admin, 'Каналы');
    const endpoint = (
      await admin
        .getByRole('row', { name: /Отзывы с карт \(Rocket Data, демо\)/ })
        .getByTestId('rd-endpoint')
        .innerText()
    ).trim();
    expect(endpoint).toMatch(/\/rd\/[0-9a-f-]{36}$/);
    const push = async (body: unknown) => {
      const r = await admin.request.post(endpoint, { data: body });
      return { status: r.status(), body: (await r.json()) as Record<string, unknown> };
    };
    // Ошибка формата — 400 с перечнем полей.
    const bad = await push({ ...review, StationGuid: '' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('StationGuid');
    expect(await push(review)).toEqual({
      status: 200,
      body: { result: 'ok', TicketMapId: review.TicketMapId },
    });

    const op = await as(browser, 'operator1@demo.local');
    await nav(op, 'Рабочее место оператора');
    await listView(op, 'queue');
    const item = op.getByTestId('conv-item').filter({ hasText: author });
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item).toContainText('Отзыв');
    await item.getByTestId('take').click();

    // Карточка отзыва: площадка, АЗС из отзыва, объект справочника, ссылка; предприятие — по объекту.
    const panel = op.getByTestId('review-panel');
    await expect(panel).toContainText('Яндекс Карты');
    await expect(op.getByTestId('review-object')).toHaveText('АЗС №1');
    await expect(op.getByTestId('review-station')).toContainText('АЗС №1, Предприятие «Север»');
    await expect(op.getByTestId('review-link')).toHaveAttribute('href', /yandex/);
    await expect(op.getByTestId('messages')).toContainText(text);

    // Ответ на отзыв уходит в сервис ответов Rocket Data: статус доставки и ответ в моке.
    const answer = `Спасибо за отзыв, ${author}! Разобрались с сотрудником.`;
    await expect(op.getByTestId('reply')).toHaveAttribute('placeholder', /Публичный ответ на отзыв/);
    await op.getByTestId('reply').fill(answer);
    await op.getByTestId('send').click();
    await expect(op.getByTestId('delivery-sent')).toBeVisible({ timeout: 30_000 });
    const answers = (await mock('/rocketdata/demo/__test/answers')) as {
      reviewId: string;
      text: string;
      dateAnswer: string;
    }[];
    expect(answers.filter((a) => a.text === answer)).toEqual([
      expect.objectContaining({ reviewId: review.TicketMapId, dateAnswer: expect.stringMatching(/^\d{4}-/) }),
    ]);

    // Дальше — как обычное обращение: тема, результат, закрытие.
    await choose(op, 'topic', 'Жалобы на персонал АЗС');
    // Предприятие из отзыва — в блоке АЗС (поля карточки видны после выбора темы).
    await expect(op.getByTestId('org')).toContainText('Предприятие «Север»');
    // Тема требует номер АЗС при закрытии (поле появляется после выбора темы).
    const station = op.getByRole('textbox', { name: 'Номер АЗС' });
    await station.fill('1');
    await station.blur();
    await choose(op, 'disposition', 'Решено на 1-й линии');
    await op.getByTestId('close').click();
    await expect(op.getByText('Обращение закрыто.')).toBeVisible();

    // Повторная передача того же отзыва (Rocket Data повторила запрос) — 200, без дубля: обращение одно.
    expect((await push(review)).status).toBe(200);
    await op.waitForTimeout(3000);
    await listView(op, 'closed');
    await expect(op.getByTestId('conv-item').filter({ hasText: author })).toHaveCount(1);

    // Отчёт по отзывам: по объектам, отзыв отвечен.
    await nav(admin, 'Отчёты');
    await choose(admin, 'report-kind', 'Отзывы с карт: оценки и доля отвеченных');
    await choose(admin, 'report-group', 'по объектам');
    const table = admin.getByTestId('report-table');
    await expect(table).toContainText('Доля отвеченных, %');
    await expect(table.locator('tr').filter({ hasText: 'АЗС №1' })).toBeVisible();
  });

  test('синхронизация объектов из АСУ НПО ЭК: проверка без изменений, запуск — изменение, деактивация, журнал', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    // Выгрузка АСУ: АЗС №2 переименована, АЗС №6 закрыта.
    await mock('/objects/__test/asu', { reset: true });
    const base = (await mock('/objects/asu')) as { azsnum: string; name1: string; status: string }[];
    const next = base.map((o) =>
      o.azsnum === '2'
        ? { ...o, name1: `АЗС №2 (${stamp})` }
        : o.azsnum === '6'
          ? { ...o, status: 'закрыта' }
          : o,
    );

    const admin = await as(browser, ADMIN.email, ADMIN.password);
    await nav(admin, 'Синхронизация объектов');
    await expect(admin.getByTestId('sync-url')).toHaveValue(/objects\/asu/);
    // Исходное состояние — справочник по исходной выгрузке (тест не зависит от предыдущих прогонов).
    await admin.getByTestId('sync-run').click();
    await expect(admin.getByTestId('sync-summary')).toContainText('успешно');
    await mock('/objects/__test/asu', { items: next });
    await admin.getByTestId('sync-dry').click();
    await expect(admin.getByTestId('sync-summary')).toContainText('проверка без изменений');
    await expect(admin.getByTestId('sync-changes')).toContainText(`АЗС №2 (${stamp})`);

    await admin.getByTestId('sync-run').click();
    await expect(admin.getByTestId('sync-summary')).not.toContainText('проверка без изменений');
    await expect(admin.getByTestId('sync-summary')).toContainText('успешно');
    const changes = admin.getByTestId('sync-changes');
    await expect(
      changes.locator('tr').filter({ hasText: 'AZS-6' }).filter({ hasText: 'деактивирован' }),
    ).toBeVisible();
    await expect(
      changes
        .locator('tr')
        .filter({ hasText: 'AZS-2' })
        .filter({ hasText: `АЗС №2 (${stamp})` })
        .first(),
    ).toBeVisible();
    await expect(admin.getByTestId('sync-runs').locator('tbody tr').first()).toContainText('вручную');

    // В справочнике: объект под синхронизацией, переименование применено, GUID из выгрузки.
    await nav(admin, 'Объекты');
    const row = admin.getByTestId('dict-objects').locator('tbody tr').filter({ hasText: 'AZS-2' });
    await expect(row).toContainText(`АЗС №2 (${stamp})`);
    await expect(row).toContainText('синхронизация');
    await expect(row).toContainText('DE000000000000000000000000000002');

    // Возврат исходной выгрузки: АЗС №6 снова активна, название восстановлено.
    await mock('/objects/__test/asu', { reset: true });
    await nav(admin, 'Синхронизация объектов');
    await admin.getByTestId('sync-run').click();
    await expect(
      admin
        .getByTestId('sync-changes')
        .locator('tr')
        .filter({ hasText: 'AZS-6' })
        .filter({ hasText: 'снова активен' }),
    ).toBeVisible();
  });
});
