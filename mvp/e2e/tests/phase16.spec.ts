import { expect, test, type Browser, type Page } from '@playwright/test';
import { DEMO_PASSWORD, login, nav } from './helpers';

/**
 * Ф16 (доработки 09.10.2026): тестирование сотрудников и рейтинги. Супервизор создаёт тест с вопросами по теме и
 * назначает его операторам со сроком; оператор видит значок срока в шапке, проходит тест (разбор ответов),
 * проходит ещё раз; супервизор видит результаты, компетентность по темам и рейтинг вопросов; рейтинг операторов.
 */
test.describe.serial('Ф16: тестирование сотрудников и рейтинги', () => {
  const stamp = Date.now().toString(36);
  const title = `Тест Ф16 ${stamp}`;
  const opts = { ignoreHTTPSErrors: true, locale: 'ru-RU', viewport: { width: 1440, height: 900 } };
  const as = async (browser: Browser, email: string): Promise<Page> => {
    const page = await (await browser.newContext(opts)).newPage();
    await login(page, email, DEMO_PASSWORD);
    return page;
  };

  async function question(p: Page, i: number, text: string, options: [string, boolean][]) {
    if (i > 0) await p.getByTestId('editor-add-question').click();
    const q = p.getByTestId('editor-question').nth(i);
    await q.getByTestId('editor-question-text').fill(text);
    for (let k = 2; k < options.length; k++) await q.getByTestId('editor-add-option').click();
    for (const [k, [o, correct]] of options.entries()) {
      await q.getByTestId('editor-option-text').nth(k).fill(o);
      const box = q.getByTestId('editor-option-correct').nth(k);
      if ((await box.isChecked()) !== correct) await box.click({ force: true });
    }
  }

  test('супервизор создаёт тест по теме и назначает операторам со сроком', async ({ browser }) => {
    const sup = await as(browser, 'supervisor@demo.local');
    await nav(sup, 'Тестирование');
    await sup.getByTestId('test-create').click();
    // Без правильного варианта и названия — сообщение со списком, что заполнить.
    await sup.getByTestId('test-save').click();
    await expect(sup.getByText('Заполните обязательные поля')).toBeVisible();
    await sup.getByTestId('test-title').fill(title);
    await sup.getByTestId('test-topics').click();
    await sup.getByTestId('test-topics-search').fill('персонал');
    await sup.locator('.mantine-Popover-dropdown').getByText('Жалобы на персонал АЗС').first().click();
    await sup.getByTestId('test-title').click();
    await question(sup, 0, 'Когда обращение передаётся на 2-ю линию?', [
      ['Когда нужен ответственный предприятия', true],
      ['Всегда', false],
    ]);
    await question(sup, 1, 'Что заполнить перед закрытием?', [
      ['Тему', true],
      ['Итог разговора', true],
      ['Номер карты', false],
    ]);
    await sup.getByTestId('test-save').click();
    const row = sup.getByTestId('test-row').filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Жалобы на персонал АЗС');

    await sup.getByTestId('tests-tab-assignments').click();
    await sup.getByTestId('assign-test').click();
    await sup.getByRole('option', { name: title }).click();
    await sup.getByTestId('assign-people').click();
    await sup.getByTestId('assign-people-search').fill('оператор');
    await sup.locator('.mantine-Popover-dropdown').getByText('Иванов Пётр (оператор)').first().click();
    await sup.getByTestId('assign-form').getByText('Назначить тест').click();
    const due = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Minsk' });
    await sup.getByTestId('assign-due').fill(due);
    await sup.getByTestId('assign-submit').click();
    const a = sup.getByTestId('assignment-row').filter({ hasText: title });
    await expect(a).toContainText('Иванов Пётр');
    await expect(a.getByTestId('assignment-status')).toHaveAttribute('data-status', 'open');
  });

  test('оператор: значок срока, прохождение с разбором, повторная попытка — «Пройден»', async ({ browser }) => {
    const op = await as(browser, 'operator1@demo.local');
    await expect(op.getByTestId('test-due')).toBeVisible({ timeout: 15_000 });
    await op.getByTestId('test-due').click();
    await expect(op).toHaveURL(/\/my-tests/);
    const card = op.getByTestId('my-assignment').filter({ hasText: title });
    // Первая попытка: второй вопрос — не все правильные варианты.
    await card.getByTestId('my-test-start').click();
    const qs = op.getByTestId('take-question');
    await expect(qs).toHaveCount(2);
    await qs.nth(0).getByTestId('take-option').nth(0).click();
    await qs.nth(1).getByTestId('take-option').nth(0).click();
    await op.getByTestId('take-finish').click();
    await expect(op.getByTestId('attempt-score')).toContainText('Правильно 1 из 2 — 50 %');
    await expect(op.getByTestId('attempt-question').nth(1)).not.toHaveAttribute('data-correct', /.*/);
    await op.getByTestId('take-close').click();
    // Вторая попытка — всё верно.
    await card.getByTestId('my-test-start').click();
    await expect(qs).toHaveCount(2);
    await qs.nth(0).getByTestId('take-option').nth(0).click();
    await qs.nth(1).getByTestId('take-option').nth(0).click();
    await qs.nth(1).getByTestId('take-option').nth(1).click();
    await op.getByTestId('take-finish').click();
    await expect(op.getByTestId('attempt-score')).toContainText('Правильно 2 из 2 — 100 %');
    await op.getByTestId('take-close').click();
    await expect(card.getByTestId('assignment-status')).toHaveAttribute('data-status', 'passed');
    await expect(op.getByTestId('attempt-row').filter({ hasText: title })).toHaveCount(2);
    await expect(op.getByTestId('my-rating')).toBeVisible();
  });

  test('супервизор: результаты сотрудника, компетентность по темам, рейтинг вопросов; рейтинг операторов', async ({
    browser,
  }) => {
    const sup = await as(browser, 'supervisor@demo.local');
    await nav(sup, 'Тестирование');
    await sup.getByTestId('tests-tab-results').click();
    await sup.getByTestId('result-row').filter({ hasText: 'Иванов Пётр' }).click();
    const user = sup.getByTestId('user-results');
    await expect(user.getByTestId('attempt-row').filter({ hasText: title })).toHaveCount(2);
    await user.getByTestId('attempt-row').filter({ hasText: title }).last().click();
    await expect(sup.getByTestId('attempt-result')).toContainText('50 %');
    await sup.keyboard.press('Escape');
    await sup.keyboard.press('Escape');

    await sup.getByTestId('tests-tab-competence').click();
    const comp = sup.getByTestId('competence-table');
    await expect(comp).toContainText('Жалобы на персонал АЗС');
    await expect(comp.getByRole('row').filter({ hasText: 'Иванов Пётр' })).toContainText('100 %');

    await sup.getByTestId('tests-tab-questions').click();
    const q = sup
      .getByTestId('question-row')
      .filter({ hasText: 'Что заполнить перед закрытием?' })
      .filter({ hasText: title });
    await expect(q).toContainText('50 %');
    await q.click();
    await expect(sup.getByTestId('question-detail')).toContainText('Иванов Пётр');
    await sup.keyboard.press('Escape');

    await nav(sup, 'Рейтинг операторов');
    const me = sup.getByTestId('rating-row').filter({ hasText: 'Иванов Пётр' });
    await expect(me).toBeVisible();
    await expect(me).toContainText('100 %');
    // Супервизоры и администраторы в рейтинг операторов не попадают.
    await expect(sup.getByTestId('rating-row').filter({ hasText: 'Смирнова Анна' })).toHaveCount(0);
  });
});
