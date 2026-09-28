import { expect, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, pick } from './helpers';

const suffix = Date.now().toString().slice(-6);
const ENT = `Предприятие E2E ${suffix}`;
const DEP = `Отдел E2E ${suffix}`;
const TOPIC = `Тема E2E ${suffix}`;
const SUB = `Подтема E2E ${suffix}`;

test.describe.serial('Ф1: администрирование оргструктуры и прав', () => {
  test('администратор: предприятие, подразделение в двух предприятиях, тема со сроком и полем, ответственный и куратор', async ({
    page,
  }) => {
    await login(page, ADMIN.email, ADMIN.password);

    await nav(page, 'Предприятия');
    await page.getByRole('button', { name: 'Добавить' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Код').fill(`E2E${suffix}`);
    await dlg.getByLabel('Название').fill(ENT);
    await dlg.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByTestId('dict-enterprises').getByText(ENT)).toBeVisible();

    await nav(page, 'Подразделения');
    await page.getByRole('button', { name: 'Добавить' }).click();
    await dlg.getByLabel('Код').fill(`D${suffix}`);
    await dlg.getByLabel('Название').fill(DEP);
    await dlg.getByRole('button', { name: 'Создать' }).click();
    await page.getByTestId(`dep-links-D${suffix}`).click();
    await pick(page, 'Предприятия, в которых есть подразделение', ENT);
    await pick(page, 'Предприятия, в которых есть подразделение', 'Предприятие «Север»');
    await page.keyboard.press('Escape');
    await dlg.getByRole('button', { name: 'Сохранить' }).first().click();
    await expect(dlg.getByRole('cell', { name: ENT })).toBeVisible();
    await expect(dlg.getByRole('cell', { name: 'Предприятие «Север»' })).toBeVisible();
    await dlg
      .getByRole('button', { name: 'Close' })
      .or(dlg.locator('button.mantine-Modal-close'))
      .first()
      .click();

    await nav(page, 'Темы и поля');
    await page.getByRole('button', { name: 'Добавить тему' }).click();
    await dlg.getByLabel('Название').fill(TOPIC);
    await dlg.getByLabel(/Особо важная/).check();
    await dlg.getByRole('button', { name: 'Создать' }).click();
    const topicRow = page.getByTestId(`topic-${TOPIC}`);
    await expect(topicRow.getByText('особо важная')).toBeVisible();
    await topicRow.getByTitle('Добавить подтему').click();
    await dlg.getByLabel('Название').fill(SUB);
    await dlg.getByLabel(/Срок ответа/).fill('5');
    await dlg.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByTestId(`topic-${SUB}`).getByText('срок 5 дн.')).toBeVisible();
    await topicRow.getByText(TOPIC, { exact: true }).click();
    await page.getByRole('button', { name: 'Добавить поле' }).click();
    await dlg.getByLabel('Ключ (латиница)').fill('station');
    await dlg.getByLabel('Название').fill('Номер АЗС');
    await dlg.getByLabel('Обязательно при передаче на 2-ю линию').check();
    await dlg.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByRole('cell', { name: 'Номер АЗС' })).toBeVisible();

    await nav(page, 'Матрица ответственности');
    for (const [who, kind] of [
      ['Новиков Игорь', 'Ответственный'],
      ['Лебедева Татьяна', 'Куратор'],
    ] as const) {
      await page.getByTestId('assign-open').click();
      await pick(page, 'Подразделения на предприятиях', `${ENT} — ${DEP}`);
      await pick(page, 'Подразделения на предприятиях', `Предприятие «Север» — ${DEP}`);
      await page.keyboard.press('Escape');
      await pick(page, 'Темы / подтемы', TOPIC);
      await page.keyboard.press('Escape');
      await pick(page, 'Сотрудники (роль 2-й линии)', who, page.getByRole('dialog'), false);
      await page.keyboard.press('Escape');
      await pick(page, 'Роль в матрице', kind);
      await page.getByTestId('assign-save').click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    const table = page.getByTestId('matrix-table');
    await expect(
      table.getByRole('row').filter({ hasText: ENT }).filter({ hasText: 'Новиков Игорь' }),
    ).toHaveCount(1);
    await expect(
      table.getByRole('row').filter({ hasText: ENT }).filter({ hasText: 'Лебедева Татьяна' }),
    ).toHaveCount(1);

    // Проверка подстановки: подтема наследует назначения темы, срок — от подтемы.
    await page.getByRole('tab', { name: 'Проверка подстановки' }).click();
    const main = page.getByRole('tabpanel', { name: 'Проверка подстановки' });
    await pick(page, 'Предприятие', ENT, main);
    await pick(page, 'Подразделение', DEP, main);
    await pick(page, 'Тема', `— ${SUB}`, main);
    await page.getByRole('button', { name: 'Проверить подстановку' }).click();
    const res = page.getByTestId('defaults-result');
    await expect(res).toContainText('Ответственные: Новиков Игорь (ответственный)');
    await expect(res).toContainText('Кураторы: Лебедева Татьяна (куратор)');
    await expect(res).toContainText('Срок ответа: 5 дн.');

    await nav(page, 'Журнал аудита');
    await expect(page.getByRole('cell', { name: 'bulk_assign' }).first()).toBeVisible();
  });

  test('супервизор с областью «Север» видит только своё предприятие и не видит администрирование', async ({
    page,
  }) => {
    await login(page, 'supervisor@demo.local', DEMO_PASSWORD);
    const menu = page.getByRole('navigation');
    await expect(menu.getByRole('link', { name: 'Сотрудники' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: 'Настройки' })).toHaveCount(0);

    await nav(page, 'Объекты');
    const rows = page.getByTestId('dict-objects').locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    await expect(rows.filter({ hasText: 'Предприятие «Север»' })).toHaveCount(count);
    await expect(page.getByRole('button', { name: 'Добавить' })).toHaveCount(0);

    await nav(page, 'Матрица ответственности');
    const mrows = page.getByTestId('matrix-table').locator('tbody tr');
    await expect(mrows.first()).toBeVisible();
    await expect(mrows.filter({ hasNotText: 'Предприятие «Север»' })).toHaveCount(0);
    await expect(page.getByTestId('assign-open')).toHaveCount(0);
  });

  test('после выхода и перезагрузки — снова экран входа; обновление страницы сохраняет сессию', async ({
    page,
  }) => {
    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await page.reload();
    await expect(page.getByTestId('current-user')).toContainText('Иванов Пётр');
    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  });
});
