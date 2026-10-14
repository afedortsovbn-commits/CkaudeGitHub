import { type Browser, expect, type Page, test } from '@playwright/test';
import { DEMO_PASSWORD, login, nav } from './helpers';

/**
 * Ф20 (Д-014, 12.10.2026): обучение сотрудников. Супервизор назначает курс «Сеть АЗС» (загружен скриптом
 * load_courses.py) оператору; оператор открывает «Моё обучение», проходит первый урок: ситуация «как поступить»,
 * отметка о прочтении, тест после урока; супервизор видит прогресс в назначениях и результатах.
 */
test.describe.serial('Ф20: обучение сотрудников', () => {
  const opts = { ignoreHTTPSErrors: true, locale: 'ru-RU', viewport: { width: 1440, height: 900 } };
  const as = async (browser: Browser, email: string): Promise<Page> => {
    const page = await (await browser.newContext(opts)).newPage();
    await login(page, email, DEMO_PASSWORD);
    return page;
  };
  const COURSE = 'Сеть АЗС «Белоруснефть»';

  test('супервизор назначает курс оператору', async ({ browser }) => {
    const sup = await as(browser, 'supervisor@demo.local');
    await nav(sup, 'Обучение');
    await expect(sup.getByTestId('courses-table')).toContainText(COURSE);
    await sup.getByTestId('courses-tab-assign').click();
    await sup.getByTestId('course-assign-course').click();
    await sup.getByRole('option', { name: new RegExp(COURSE) }).click();
    await sup.getByTestId('course-assign-people').click();
    await sup.getByTestId('course-assign-people-search').fill('оператор');
    await sup.locator('.mantine-Popover-dropdown').getByText('Иванов Пётр (оператор)').first().click();
    await sup.getByTestId('course-assign-form').getByText('Назначить курс').click();
    const due = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString('en-CA', {
      timeZone: 'Europe/Minsk',
    });
    await sup.getByTestId('course-assign-due').fill(due);
    await sup.getByTestId('course-assign-submit').click();
    await expect(sup.getByText('Курс назначен')).toBeVisible();
    const row = sup
      .getByTestId('course-assignment-row')
      .filter({ hasText: 'Иванов Пётр' })
      .filter({ hasText: COURSE })
      .first();
    await expect(row).toHaveAttribute('data-status', 'open');
    await sup.context().close();
  });

  test('оператор проходит первый урок: ситуация, прочитано, тест — урок пройден', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, 'Моё обучение');
    const card = page.getByTestId('course-card').filter({ hasText: COURSE });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('course-status')).toContainText('Назначен');
    await card.getByTestId('course-open').click();
    await expect(page.getByTestId('lesson-view')).toContainText('Урок 1 из');
    // Ситуация: верный вариант содержит «одна сеть».
    const situation = page.getByTestId('situation').first();
    // Д-040: урок по слайдам — листать до слайда с ситуацией.
    for (let i = 0; i < 20 && !(await situation.isVisible()); i++) await page.getByTestId('slide-next').click();
    await situation.getByTestId('situation-option').filter({ hasText: 'одна сеть' }).click();
    await expect(situation.getByTestId('situation-result')).toContainText('Верно');
    await expect(page.getByTestId('situations-score')).toContainText('1 из 1 верно');
    await page.getByTestId('lesson-read').click();
    await expect(page.getByText('Прочитано')).toBeVisible();
    // Тест после урока: отвечаем по содержанию урока.
    await page.getByTestId('lesson-test').click();
    const answers = ['Девять', 'Зелёный', 'azs.belorusneft.by', 'Исторически', 'BelorusneftBot'];
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    for (const a of answers) await modal.getByText(a, { exact: false }).first().click();
    await modal.getByRole('button', { name: /Завершить|Проверить/ }).click();
    await expect(modal).toContainText(/сдан|Пройден|Результат/i, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('lesson-done')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('lesson-item').first()).toHaveAttribute('data-done', 'yes');
  });

  test('супервизор видит прогресс в назначениях и результатах', async ({ browser }) => {
    const sup = await as(browser, 'supervisor@demo.local');
    await nav(sup, 'Обучение');
    await sup.getByTestId('courses-tab-assign').click();
    const row = sup
      .getByTestId('course-assignment-row')
      .filter({ hasText: 'Иванов Пётр' })
      .filter({ hasText: COURSE })
      .first();
    // Д-040: в курсе 7 уроков — пройден 1 из 7.
    await expect(row).toContainText('14 %');
    await sup.getByTestId('courses-tab-results').click();
    await expect(sup.getByTestId('course-results')).toContainText('Иванов Пётр');
    await sup.context().close();
  });
});
