import { expect, type Locator, type Page, test } from '@playwright/test';
import { ADMIN, login, nav } from './helpers';

/**
 * Д-041: конструктор отчётов — перетаскивание полей и показателей в зоны, перекрёстная таблица с итогами,
 * перестановка уровней, сравнение периодов, фильтр значений, графики, сохранённый отчёт и выгрузка в Excel.
 * Проверки не зависят от объёма данных на стенде.
 */
const stamp = Date.now().toString().slice(-6);

async function drag(page: Page, from: Locator, to: Locator, fx = 0.9) {
  await from.scrollIntoViewIfNeeded();
  await to.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + a.height / 2 + 5, { steps: 4 });
  await page.mouse.move(b.x + b.width * fx, b.y + b.height / 2, { steps: 12 });
  await page.waitForTimeout(100);
  await page.mouse.up();
}

test.describe.serial('Ф22: конструктор отчётов', () => {
  test('поля перетаскиваются в зоны, таблица и графики строятся, отчёт сохраняется и выгружается', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Отчёты');
    await page.getByTestId('reports-tab-builder').click();
    await page.getByTestId('pivot-clear').click();
    await expect(page.getByTestId('pivot-zone-values')).toContainText('Показатели');

    // Поле — в строки, показатель — в значения, период — в столбцы.
    await page.getByTestId('pivot-sec-conv').click();
    await drag(page, page.getByTestId('pivot-cat-conv.channel'), page.getByTestId('pivot-zone-rows'));
    // Д-051: показатели — на своей вкладке каталога.
    await page.getByTestId('pivot-cat-kind').getByText('Показатели').click();
    await drag(page, page.getByTestId('pivot-cat-conv.count'), page.getByTestId('pivot-zone-values'));
    await page.getByTestId('pivot-cat-kind').getByText('Поля').click();
    await page.getByTestId('pivot-sec-time').click();
    await drag(page, page.getByTestId('pivot-cat-time.period'), page.getByTestId('pivot-zone-cols'));
    await page.getByTestId('pivot-view-cross').click();
    const table = page.getByTestId('pivot-table');
    await expect(table).toContainText('Канал (источник)');
    await expect(table.locator('tr.pivot-total')).toContainText('Итого');

    // Второй уровень строк и перестановка уровней перетаскиванием.
    await page.getByTestId('pivot-sec-org').click();
    await drag(page, page.getByTestId('pivot-cat-org.enterprise'), page.getByTestId('pivot-zone-rows'));
    const rows = page.getByTestId('pivot-zone-rows');
    await expect(rows.locator('[data-pivot-chip]')).toHaveCount(2);
    await drag(
      page,
      rows.getByTestId('pivot-chip-rows-org.enterprise'),
      rows.getByTestId('pivot-chip-rows-conv.channel'),
      0.1,
    );
    await expect(rows.locator('[data-pivot-chip]').first()).toContainText('Предприятие');
    await expect(table.locator('thead')).toContainText('Предприятие');

    // Сравнение с предыдущим периодом — у показателя появляются «сравн.» и «Δ, %».
    // Д-051: «Сравнить» — флажок; строка выбора периода сравнения появляется только при нём.
    await expect(page.getByTestId('pivot-compare-row')).toHaveCount(0);
    await page.getByTestId('pivot-compare-on').check();
    await expect(page.getByTestId('pivot-compare')).toHaveValue('Предыдущим периодом');
    await expect(table.locator('thead')).toContainText('Δ, %');
    await page.getByTestId('pivot-compare-on').uncheck();
    await expect(page.getByTestId('pivot-compare-row')).toHaveCount(0);

    // Фильтр: только «Телефон».
    await drag(page, page.getByTestId('pivot-cat-conv.channel'), page.getByTestId('pivot-zone-filters'));
    await expect(page.getByTestId('pivot-filter')).toBeVisible();
    await page.getByTestId('pivot-filter-search').fill('Телефон');
    await page.getByTestId('pivot-filter').getByText('Телефон', { exact: true }).click();
    // Д-052: окно фильтра целиком в экране; закрывается кнопкой «Применить».
    const box = await page.getByTestId('pivot-filter').boundingBox();
    const vp = page.viewportSize()!;
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
    await page.getByTestId('pivot-filter-apply').click();
    await expect(page.getByTestId('pivot-filter')).toBeHidden();
    await expect(page.getByTestId('pivot-zone-filters')).toContainText('Телефон');

    // Графики.
    await page.getByTestId('pivot-view-bar').click();
    await expect(page.getByTestId('pivot-chart').locator('canvas')).toBeVisible();
    await page.getByTestId('pivot-view-pie').click();
    await expect(page.getByTestId('pivot-chart').locator('canvas')).toBeVisible();
    await page.getByTestId('pivot-view-flat').click();
    await expect(table).toBeVisible();

    // Сохранение, открытие и удаление сохранённого отчёта.
    await page.getByTestId('pivot-save').click();
    await page.getByTestId('pivot-save-name').fill(`Отчёт e2e ${stamp}`);
    await page.getByTestId('pivot-save-ok').click();
    await expect(page.getByText('Отчёт сохранён')).toBeVisible();
    await page.getByTestId('pivot-clear').click();
    await page.getByTestId('pivot-open').click();
    await page.getByRole('menuitem', { name: `Отчёт e2e ${stamp}` }).click();
    await expect(page.getByTestId('pivot-zone-filters')).toContainText('Телефон');

    // Выгрузка в Excel.
    const download = page.waitForEvent('download');
    await page.getByTestId('pivot-excel').click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);

    await page.getByTestId('pivot-open').click();
    await page
      .getByRole('menuitem', { name: `Отчёт e2e ${stamp}` })
      .getByRole('button', { name: 'Удалить отчёт' })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить отчёт' }).click();
    await expect(page.getByText('Отчёт удалён')).toBeVisible();
  });
});
