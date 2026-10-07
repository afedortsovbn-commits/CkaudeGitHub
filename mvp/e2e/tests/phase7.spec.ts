import { type Browser, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, listView } from './helpers';

const stamp = Date.now().toString().slice(-6);

async function openWidget(browser: Browser, name: string, key = 'demo-webchat-bot') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(`/widget/demo.html?key=${key}`);
  const w = page.locator('#cc-widget');
  await w.getByTestId('cc-open').click();
  await w.getByPlaceholder('Ваше имя (необязательно)').fill(name);
  await w.getByRole('checkbox').check();
  await w.getByRole('button', { name: 'Начать чат' }).click();
  return { page, w, ctx };
}

async function say(w: ReturnType<Page['locator']>, text: string) {
  await w.getByTestId('cc-input').fill(text);
  await w.getByTestId('cc-send').click();
}

/** Оператор берёт обращение клиента из вкладки «Очередь». */
async function takeFromQueue(page: Page, client: string) {
  await listView(page, 'queue');
  const item = page.getByTestId('conv-item').filter({ hasText: client });
  await expect(item).toBeVisible({ timeout: 15000 });
  await item.getByTestId('take').click();
  await expect(page.getByTestId('reply')).toBeEnabled();
  // Подсказки по умолчанию свёрнуты — раскрыть.
  await page.getByTestId('assist-toggle').click();
}

test.describe.serial('Ф7: автоответы, бот, подсказки, шаблоны', () => {
  test('демо-сценарий 2: автоответ + бот собирает телефон → оператор → подсказки → ответ одним кликом → закрытие с темой → оценка', async ({
    page,
    browser,
  }) => {
    const name = `Клиент Бот ${stamp}`;
    const client = await openWidget(browser, name);
    await say(client.w, 'Здравствуйте, хочу узнать про бонусы');
    // Автоответ по правилу и сообщения бота с кнопками.
    await expect(client.w.getByText('Спасибо, что написали в контакт-центр')).toBeVisible({ timeout: 15000 });
    await expect(client.w.getByText('Я виртуальный помощник')).toBeVisible();
    const buttons = client.w.getByTestId('cc-buttons');
    await expect(buttons.getByRole('button', { name: 'Баланс бонусов' })).toBeVisible();
    await buttons.getByRole('button', { name: 'Баланс бонусов' }).click();
    await expect(client.w.getByText('Напишите, пожалуйста, номер телефона')).toBeVisible({ timeout: 10000 });
    await say(client.w, 'мой номер скажу потом');
    await expect(client.w.getByText('Это не похоже на номер телефона')).toBeVisible({ timeout: 10000 });
    await say(client.w, '+375 29 123-45-67');
    // Бот сходил во внешнюю систему (мок самообслуживания) и перевёл на оператора.
    await expect(client.w.getByText(/на счёте \d+ бонусов/)).toBeVisible({ timeout: 15000 });
    await expect(client.w.getByText('Передаю диалог оператору')).toBeVisible();
    await expect(client.w.getByText('Вы в очереди')).toBeVisible();

    await login(page, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(page, 'Рабочее место оператора');
    await takeFromQueue(page, name);
    // История с ботом и собранные данные видны оператору.
    const msgs = page.getByTestId('messages');
    await expect(msgs).toContainText('Выберите, пожалуйста, тему обращения');
    await expect(msgs).toContainText('Бот собрал');
    await expect(msgs).toContainText('+375291234567');
    await expect(page.getByTestId('topic')).toHaveValue(/Баланс бонусов/);

    // Подсказки: шаблон и статья БЗ; вставка одним кликом.
    const assist = page.getByTestId('assist');
    await expect(assist.getByTestId('suggestion-template').first()).toBeVisible({ timeout: 10000 });
    await expect(
      assist.getByTestId('suggestion-article').filter({ hasText: 'Как узнать баланс бонусов' }),
    ).toBeVisible();
    await assist
      .getByTestId('suggestion-template')
      .filter({ hasText: 'Баланс бонусов' })
      .getByTestId('suggestion-insert')
      .click();
    await expect(page.getByTestId('reply')).toHaveValue(/Баланс бонусного счёта можно посмотреть/);
    await page.getByTestId('send').click();
    await expect(client.w.getByText('Баланс бонусного счёта можно посмотреть')).toBeVisible({
      timeout: 10000,
    });

    // Закрытие с темой (тема уже выставлена ботом) → клиент ставит оценку.
    await page.getByTestId('disposition').click();
    await page.getByRole('option', { name: 'Решено на 1-й линии' }).click();
    await page.getByTestId('close').click();
    await expect(page.getByText('Обращение закрыто.')).toBeVisible();
    await expect(client.w.getByTestId('cc-csat')).toBeVisible({ timeout: 10000 });
    await client.w.getByTestId('cc-csat-5').click();
    await expect(client.w.getByText('Спасибо за оценку!')).toBeVisible();
    await expect(page.getByTestId('chat-csat')).toContainText('Оценка клиента: 5 из 5', { timeout: 10000 });
    await client.ctx.close();
  });

  test('LLM-адаптер: включение без перезапуска → черновик ответа; падение провайдера не мешает подсказкам (демо-сценарий 8)', async ({
    page,
    browser,
  }) => {
    const adminCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const adminPage = await adminCtx.newPage();
    await login(adminPage, ADMIN.email, ADMIN.password);
    await nav(adminPage, 'Подсказки: провайдеры');
    await adminPage.getByLabel('Показывать отключённые').check();
    const row = adminPage.getByRole('row').filter({ hasText: 'LLM (локальная модель, демо)' });
    await row.getByRole('button', { name: 'Включить' }).click();
    await expect(row.getByText('Активна')).toBeVisible();
    await row.getByTestId('provider-test').click();
    await expect(adminPage.getByTestId('provider-test-result')).toContainText('Связь есть');
    await adminPage.keyboard.press('Escape');

    const name = `Клиент LLM ${stamp}`;
    const client = await openWidget(browser, name, 'demo-webchat');
    await say(client.w, 'Сколько бонусов у меня на карте?');
    await login(page, 'operator2@demo.local', DEMO_PASSWORD);
    await nav(page, 'Рабочее место оператора');
    await takeFromQueue(page, name);
    await expect(page.getByTestId('assist').getByTestId('suggestion-draft')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('assist-draft').click();
    await expect(page.getByTestId('reply')).toHaveValue(/Здравствуйте! Спасибо за обращение/);

    // Провайдер «упал» (адрес отдаёт 503): подсказки встроенного провайдера на месте, LLM помечен недоступным.
    await row.getByRole('button', { name: 'Изменить' }).click();
    const dlg = adminPage.getByRole('dialog');
    await dlg.getByRole('textbox', { name: 'Адрес' }).fill('http://mock-selfservice:3000/down/v1');
    await dlg.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dlg).toBeHidden();
    await say(client.w, 'А где посмотреть баланс бонусов?');
    await expect(page.getByTestId('assist-provider-failed')).toContainText('недоступен', { timeout: 15000 });
    await expect(page.getByTestId('assist').getByTestId('suggestion-article').first()).toBeVisible();

    // Вернуть демо-настройки: адрес и «выключен по умолчанию».
    await row.getByRole('button', { name: 'Изменить' }).click();
    await dlg.getByRole('textbox', { name: 'Адрес' }).fill('http://mock-selfservice:3000/v1');
    await dlg.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dlg).toBeHidden();
    await row.getByRole('button', { name: 'Отключить' }).click();
    await expect(row.getByText('Отключено')).toBeVisible();
    await client.ctx.close();
    // Контекст закрываем: иначе его софтфон остаётся зарегистрированным и перехватывает вызовы сотрудника
    // в следующих тестах (прослушивание Ф5).
    await adminCtx.close();
  });

  test('новый шаблон и правило автоответа действуют сразу: «/код» в поле ответа, ответ на ключевое слово (демо-сценарий 5)', async ({
    page,
    browser,
  }) => {
    await login(page, 'operator3@demo.local', DEMO_PASSWORD);
    await nav(page, 'Шаблоны ответов');
    await page.getByTestId('template-new').click();
    await page.getByTestId('template-title').fill(`Мой шаблон ${stamp}`);
    await page.getByTestId('template-shortcut').fill(`e2e${stamp}`);
    await page.getByTestId('template-body').fill('Добрый день, {{client.name}}! Уже проверяю.');
    await page.getByTestId('template-save').click();
    await expect(page.getByTestId('templates')).toContainText(`Мой шаблон ${stamp}`);

    const adminCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const adminPage = await adminCtx.newPage();
    await login(adminPage, ADMIN.email, ADMIN.password);
    await nav(adminPage, 'Автоответы');
    await adminPage.getByRole('button', { name: 'Добавить' }).click();
    const dlg = adminPage.getByRole('dialog');
    await dlg.getByRole('textbox', { name: 'Название' }).fill(`Ключевое слово ${stamp}`);
    await dlg.getByRole('textbox', { name: 'Вид' }).click();
    await adminPage.getByRole('option', { name: 'Ответ на ключевые слова' }).click();
    await dlg.getByRole('textbox', { name: 'Сравнение' }).click();
    await adminPage.getByRole('option', { name: 'Слова (через запятую)' }).click();
    await dlg.getByRole('textbox', { name: 'Ключевые слова / выражение' }).fill(`пароль${stamp}`);
    await dlg
      .getByRole('textbox', { name: 'Текст автоответа' })
      .fill(`Автоответ ${stamp}: пароль меняется в приложении.`);
    await dlg.getByRole('button', { name: 'Создать' }).click();
    await expect(dlg).toBeHidden();

    const name = `Клиент Шаблон ${stamp}`;
    const client = await openWidget(browser, name, 'demo-webchat');
    await say(client.w, `Как сменить пароль${stamp}?`);
    await expect(client.w.getByText(`Автоответ ${stamp}: пароль меняется в приложении.`)).toBeVisible({
      timeout: 15000,
    });

    await nav(page, 'Рабочее место оператора');
    await takeFromQueue(page, name);
    await page.getByTestId('reply').fill(`/e2e${stamp}`);
    await expect(page.getByTestId('slash-item').first()).toContainText(`Мой шаблон ${stamp}`);
    await page.getByTestId('reply').press('Enter');
    await expect(page.getByTestId('reply')).toHaveValue(`Добрый день, ${name}! Уже проверяю.`);
    await page.getByTestId('send').click();
    await expect(client.w.getByText(`Добрый день, ${name}! Уже проверяю.`)).toBeVisible({ timeout: 10000 });

    // Правило выключено — больше не срабатывает (без перезапуска).
    const rule = adminPage.getByRole('row').filter({ hasText: `Ключевое слово ${stamp}` });
    await rule.getByRole('button', { name: 'Отключить' }).click();
    await expect(rule).toBeHidden(); // список показывает только действующие правила
    await client.ctx.close();
    await adminCtx.close();
  });

  test('конструктор бота: тестовый прогон в виде чата', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Боты');
    await page.getByRole('link', { name: 'Демо: бот сайта сети АЗС' }).click();
    await expect(page.getByTestId('node-buttons')).toBeVisible();
    await page.getByTestId('flow-test').click();
    await page.getByTestId('test-start').click();
    const log = page.getByTestId('test-log');
    await expect(log).toContainText('Выберите, пожалуйста, тему обращения');
    await log.getByRole('button', { name: 'Топливные карты' }).click();
    await expect(log).toContainText('Соединяю со специалистом по топливным картам');
    await expect(log).toContainText('Перевод на оператора');
  });
});
