import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { DEMO_PASSWORD, login, nav, tree } from './helpers';
import { readMailbox } from './mail';

const stamp = Date.now().toString().slice(-6);
const CLIENT = `Клиент 2Л ${stamp}`;

async function openWidget(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto('/widget/demo.html');
  const w = page.locator('#cc-widget');
  await w.getByTestId('cc-open').click();
  await w.getByPlaceholder('Ваше имя (необязательно)').fill(CLIENT);
  await w.getByRole('checkbox').check();
  await w.getByRole('button', { name: 'Начать чат' }).click();
  return { page, w, ctx };
}

/**
 * Контексты сотрудников закрываются после каждого теста: иначе зарегистрированный софтфон оператора остаётся
 * в системе, и звонки последующих e2e (Ф5, Ф6) уходят на эту регистрацию, а не на страницу теста.
 */
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

/** Отдельный браузерный контекст для каждого сотрудника: у каждого своя сессия. */
async function as(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await login(page, email, DEMO_PASSWORD);
  return page;
}

async function select(page: Page, testId: string, option: string, scope = page.locator('body')) {
  await scope.getByTestId(testId).click();
  await page.getByRole('option', { name: option, exact: true }).first().click();
}

/** Ждёт письмо в ящике GreenMail, удовлетворяющее условию. */
async function waitMail(user: string, match: (subject: string) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await readMailbox(user)).find((m) => match(m.subject));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`нет письма для ${user}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function openTicket(page: Page, number: string) {
  await page.goto('/tickets');
  const item = page.getByTestId('ticket-item').filter({ hasText: `№${number}` });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.getByTestId('ticket-preview')).toBeVisible();
  await page.getByTestId('ticket-open-full').click();
  await expect(page.getByTestId('ticket-title')).toHaveText(`Обращение (2 линия) №${number}`);
}

async function attach(page: Page, name: string, scope: ReturnType<Page['locator']>) {
  const chooser = page.waitForEvent('filechooser');
  await scope.getByTestId('ticket-attach').click();
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 скан') });
  await expect(scope.getByTestId('ticket-file').filter({ hasText: name })).toBeVisible();
}

test.describe.serial('Ф8: вторая линия', () => {
  test('демо-сценарий 4 (чат): передача с заменой ответственного → письмо «Важно!» → кабинет → переадресация → закрытие → возврат → повторное закрытие → принятие', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    // Клиент пишет в чат на сайте.
    const client = await openWidget(browser);
    await client.w.getByTestId('cc-input').fill('Сотрудник АЗС №12 нагрубил');
    await client.w.getByTestId('cc-send').click();

    // Оператор берёт обращение, классифицирует (тема особо важная — срок 10 дней), выбирает «Передать на 2-ю линию».
    const op = await as(browser, 'operator1@demo.local');
    await nav(op, 'Рабочее место оператора');
    await op.getByTestId('tabs').getByText('Очередь').click();
    const item = op.getByTestId('conv-item').filter({ hasText: CLIENT });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByTestId('take').click();
    await select(op, 'topic', 'Жалобы на персонал АЗС ❗');
    await op.getByRole('textbox', { name: 'Номер АЗС *' }).fill('12');
    await op.getByRole('textbox', { name: 'Номер АЗС *' }).blur();
    await op.getByTestId('disposition').click();
    await op.getByRole('option', { name: 'Передать на 2-ю линию' }).click();
    await op.getByTestId('escalate').click();

    const form = op.getByTestId('escalate-form');
    await tree(op, 'esc-org', 'Север клиент', 'Отдел по работе с клиентами', form);
    // Подстановка по матрице: ответственный и куратор, срок темы (10 дней).
    await expect(form.getByTestId('esc-responsible').locator('..')).toContainText('Васильев Андрей');
    await expect(form.getByTestId('esc-curators').locator('..')).toContainText('Козлов Дмитрий');
    const due = await form.getByTestId('esc-due').inputValue();
    const expected = new Date(Date.now() + 10 * 86_400_000).toLocaleDateString('en-CA', {
      timeZone: 'Europe/Minsk',
    });
    expect(due).toBe(expected);
    // Оператор меняет ответственного на другого.
    await form.getByTestId('esc-responsible').click();
    await form.getByTestId('esc-responsible').press('Backspace');
    await op.getByRole('option', { name: 'Новиков Игорь (ответственный)' }).click();
    await op.keyboard.press('Escape');
    await form.getByTestId('esc-summary').click();
    await form.getByTestId('esc-summary').fill('Клиент жалуется на грубость оператора АЗС №12');
    await form.getByTestId('esc-submit').click();
    await expect(op.getByText('Обращение передано на 2-ю линию')).toBeVisible();
    const badge = op.getByTestId('conv-ticket');
    await expect(badge).toBeVisible();
    const number = /№(\d+)/.exec((await badge.textContent()) ?? '')![1]!;
    // Клиенту — автосообщение о передаче; обращение ушло из «Моих».
    await expect(
      client.w.getByTestId('cc-msg-out').filter({ hasText: 'передано специалисту' }),
    ).toBeVisible();
    await expect(op.getByTestId('conv-item').filter({ hasText: CLIENT })).toHaveCount(0);

    // Назначенным — письмо «Важно!» с высоким приоритетом.
    const mail = await waitMail('resp3@demo.local', (s) => s.includes(`обращение (2 линия) №${number}`));
    expect(mail.subject).toMatch(/^Важно! Вам назначено обращение/);
    expect(mail.raw).toMatch(/^Importance: High/im);
    expect(mail.raw).toMatch(/^X-Priority: 1/im);
    expect(mail.text).toContain('грубость');
    expect(mail.text).toContain(`/tickets/`);
    await waitMail('curator1@demo.local', (s) => s.includes(`обращение (2 линия) №${number}`));

    // Ответственный видит тикет выделенным в кабинете (фильтр «Я ответственный»), открывает — «В работе».
    const r3 = await as(browser, 'resp3@demo.local');
    await expect(r3.getByTestId('bell-count')).toBeVisible();
    await nav(r3, 'Обращения на 2-й линии');
    await r3.getByTestId('flt-responsible').click();
    await r3.getByTestId('flt-responsible-me').click();
    await r3.keyboard.press('Escape');
    await expect(r3.getByTestId('flt-responsible')).toHaveAttribute('data-active', 'true');
    const mine = r3.getByTestId('ticket-item').filter({ hasText: `№${number}` });
    await expect(mine).toContainText('я ответственный');
    await expect(mine).toContainText('особо важное');
    await expect(mine.getByTestId('deadline')).toContainText('осталось 10 дней');
    await mine.click();
    await r3.getByTestId('ticket-open-full').click();
    await expect(r3.getByTestId('ticket-title')).toHaveText(`Обращение (2 линия) №${number}`);
    await expect(r3.getByTestId('ticket-status')).toHaveText('В работе');
    await expect(r3.getByTestId('ticket-messages')).toContainText('нагрубил');

    // Переадресация другому ответственному сменой подразделения (комментарий обязателен).
    await r3.getByTestId('ticket-redirect').click();
    const rf = r3.getByTestId('redirect-form');
    await tree(r3, 'redirect-org', 'Север эксплуатации', 'Служба эксплуатации АЗС', rf);
    await rf.getByTestId('redirect-responsible').click();
    await r3.getByRole('option', { name: 'Васильев Андрей (ответственный)' }).click();
    await r3.keyboard.press('Escape');
    await rf.getByTestId('redirect-comment').click();
    await rf.getByTestId('redirect-comment').fill('Вопрос к службе эксплуатации АЗС');
    await rf.getByTestId('redirect-submit').click();
    await expect(r3.getByText('Обращение переадресовано')).toBeVisible();
    await expect(r3.getByTestId('ticket-close')).toHaveCount(0);

    // Новый ответственный закрывает: «письмо на бумаге», суть, скан письма.
    const r1 = await as(browser, 'resp1@demo.local');
    await openTicket(r1, number);
    await r1.getByTestId('ticket-close').click();
    const cf = r1.getByTestId('close-form');
    await select(r1, 'answer-method', 'Письмо на бумаге', cf);
    await cf.getByTestId('answer-summary').fill('Направлено официальное письмо с извинениями');
    await attach(r1, 'письмо.pdf', cf);
    await cf.getByTestId('close-submit').click();
    await expect(r1.getByTestId('ticket-status')).toHaveText('На согласовании');

    // Оператору — всплывающее уведомление по событию realtime (без перезагрузки страницы, M-TKT-12).
    await expect(
      op
        .locator('.mantine-Notification-root')
        .filter({ hasText: `Обращение (2 линия) №${number}` })
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // Оператор во вкладке «На согласовании» возвращает на доработку.
    await op.goto('/workspace');
    await op.getByTestId('tabs-2nd-line').getByText('На согласовании').click();
    await op
      .getByTestId('ticket-item')
      .filter({ hasText: `№${number}` })
      .click();
    await expect(op.getByTestId('ticket-title')).toHaveText(`Обращение (2 линия) №${number}`);
    await op.getByRole('tab', { name: 'Комментарии и документы' }).click();
    await expect(op.getByTestId('ticket-comments')).toContainText('письмо.pdf');
    await op.getByTestId('ticket-return').click();
    await op.getByTestId('return-comment').fill('Нет подписи на письме');
    await op.getByTestId('return-submit').click();
    await expect(op.getByTestId('ticket-status')).toHaveText('На доработке');

    // Ответственный получает уведомление, прикладывает документ и закрывает повторно.
    await waitMail('resp1@demo.local', (s) => s.includes(`№${number} возвращено на доработку`));
    await r1.reload();
    await expect(r1.getByTestId('ticket-status')).toHaveText('В работе');
    await r1.getByTestId('ticket-close').click();
    await select(r1, 'answer-method', 'Письмо на бумаге', cf);
    await cf.getByTestId('answer-summary').fill('Письмо подписано, скан приложен');
    await attach(r1, 'письмо-с-подписью.pdf', cf);
    await cf.getByTestId('close-submit').click();
    await expect(r1.getByTestId('ticket-status')).toHaveText('На согласовании');

    // Супервизор видит тикет в списке всех согласований.
    const sup = await as(browser, 'supervisor@demo.local');
    await nav(sup, 'Контроль 2-й линии');
    await expect(sup.getByTestId('ticket-item').filter({ hasText: `№${number}` })).toBeVisible();

    // Оператор принимает: тикет и обращение закрыты.
    await op.reload();
    await op.getByTestId('ticket-approve').click();
    await op.getByTestId('approve-submit').click();
    await expect(op.getByTestId('ticket-status')).toHaveText('Закрыто');
    // История свёрнута в «Подробнее».
    await op.getByTestId('ticket-more-toggle').click();
    await expect(op.getByTestId('ticket-history')).toContainText('возвращено на доработку');
    await expect(op.getByTestId('ticket-history')).toContainText('переадресован');
    await expect(op.getByTestId('ticket-history')).toContainText('ответ принят, обращение закрыто');
    await op.goto('/workspace');
    await op.getByTestId('tabs').getByText('Закрытые').click();
    await expect(op.getByTestId('conv-item').filter({ hasText: CLIENT })).toBeVisible();
  });

  test('колокольчик: уведомление о новом тикете в реальном времени и переход в тикет', async ({
    browser,
  }) => {
    const r1 = await as(browser, 'resp1@demo.local');
    await r1.getByTestId('bell').click();
    const list = r1.getByTestId('bell-list');
    await expect(list.getByTestId('bell-item').first()).toBeVisible();
    await list.getByTestId('bell-item').first().click();
    await expect(r1).toHaveURL(/\/tickets\//);
  });
});
