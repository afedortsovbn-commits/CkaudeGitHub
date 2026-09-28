import { type Browser, expect, type Page, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, pick } from './helpers';
import { readMailbox, sendMail } from './mail';

const stamp = Date.now().toString().slice(-6);
/** Мок Telegram Bot API (профиль test): снаружи — для «клиента», изнутри контура — для коннектора. */
const MOCK_TG = process.env.E2E_MOCK_TELEGRAM ?? 'http://127.0.0.1:8081';
const MOCK_TG_INTERNAL = 'http://mock-telegram:3000';

const tgClientSays = async (token: string, chatId: number, text: string, firstName: string) => {
  const r = await fetch(`${MOCK_TG}/__test/${token}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, text, firstName }),
  });
  expect(r.ok).toBe(true);
};
const tgSent = async (token: string) =>
  (await (await fetch(`${MOCK_TG}/__test/${token}/sent`)).json()) as { chat_id: string; text?: string }[];

async function addTelegramBot(page: Page, name: string, token: string, mode: 'опрос' | 'webhook') {
  await page.getByRole('button', { name: 'Добавить' }).click();
  const d = page.getByRole('dialog');
  await pick(page, 'Тип', 'Telegram-бот');
  await d.getByLabel('Название').fill(name);
  await pick(page, 'Очередь по умолчанию', 'Общая');
  await d.getByLabel('Токен бота').fill(token);
  if (mode === 'webhook') await pick(page, 'Режим получения сообщений', 'Webhook', d, false);
  await d.getByLabel('Адрес Bot API').fill(MOCK_TG_INTERNAL);
  await d.getByRole('button', { name: 'Создать' }).click();
  await expect(d).toBeHidden();
}

async function expectConnected(page: Page, name: string) {
  const row = page.getByTestId('dict-channels').getByRole('row').filter({ hasText: name });
  await expect(async () => {
    await page.reload();
    await expect(row.getByTestId('channel-status')).toHaveText('Подключён', { timeout: 1500 });
  }).toPass({ timeout: 45_000 });
}

/** Оператор — в отдельном контексте браузера (администратор остаётся в своём). */
async function operator(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await login(page, email, DEMO_PASSWORD);
  await nav(page, 'Рабочее место оператора');
  return page;
}

async function takeFromQueue(page: Page, text: string) {
  await page.getByTestId('tabs').getByText('Очередь').click();
  const item = page.getByTestId('conv-item').filter({ hasText: text });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.getByTestId('take').click();
}

async function closeConversation(page: Page) {
  await page.getByTestId('disposition').click();
  await page.getByRole('option', { name: 'Решено на 1-й линии' }).click();
  await page.getByTestId('topic').click();
  await page.getByRole('option', { name: 'Сайт', exact: true }).click();
  await page.getByTestId('close').click();
  await expect(page.getByText('Обращение закрыто.')).toBeVisible();
}

test.describe.serial('Ф4: коннекторы Telegram и email', () => {
  test.setTimeout(120_000);
  const tg1 = `e2e${stamp}:polling-token`;
  const tg2 = `e2e${stamp}:webhook-token`;
  const chatId = Number(`7${stamp}`);

  test('Telegram-бот добавляется в админке без перезапуска; сообщение → обращение → ответ доставлен; клиент узнаётся', async ({
    page,
    browser,
  }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Каналы');
    await addTelegramBot(page, `Бот опрос ${stamp}`, tg1, 'опрос');
    await expectConnected(page, `Бот опрос ${stamp}`);

    await tgClientSays(tg1, chatId, `Здравствуйте, вопрос из Telegram ${stamp}`, `ТГ ${stamp}`);
    const op = await operator(browser, 'operator1@demo.local');
    await takeFromQueue(op, `ТГ ${stamp}`);
    await expect(op.getByTestId('messages')).toContainText(`вопрос из Telegram ${stamp}`);

    await op.getByTestId('reply').fill(`Ответ оператора в Telegram ${stamp}`);
    await op.getByTestId('send').click();
    await expect(op.getByTestId('delivery-sent')).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await tgSent(tg1)).filter((m) => m.text === `Ответ оператора в Telegram ${stamp}`))
      .toHaveLength(1);
    expect((await tgSent(tg1))[0]!.chat_id).toBe(String(chatId));

    // Клиент отвечает — сообщение приходит в открытое обращение без перезагрузки.
    await tgClientSays(tg1, chatId, `Спасибо ${stamp}`, `ТГ ${stamp}`);
    await expect(op.getByTestId('messages')).toContainText(`Спасибо ${stamp}`, { timeout: 20_000 });
    await closeConversation(op);

    // Повторное обращение (под другим именем в Telegram) — тот же клиент, история видна.
    await tgClientSays(tg1, chatId, `Ещё вопрос ${stamp}`, 'Другое имя');
    await takeFromQueue(op, `ТГ ${stamp}`);
    await op.getByRole('tab', { name: 'Клиент' }).click();
    await expect(op.getByTestId('history').locator('p')).toHaveCount(2);
  });

  test('второй бот (webhook) добавляется без перезапуска и принимает сообщения параллельно с первым', async ({
    page,
    browser,
  }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Каналы');
    await addTelegramBot(page, `Бот webhook ${stamp}`, tg2, 'webhook');
    await expectConnected(page, `Бот webhook ${stamp}`);
    const state = (await (await fetch(`${MOCK_TG}/__test/${tg2}/state`)).json()) as {
      webhook: { url: string };
    };
    expect(state.webhook.url).toMatch(/\/tg\/[0-9a-f-]{36}$/);

    await tgClientSays(tg2, chatId + 1, `Через webhook ${stamp}`, `ТГ2 ${stamp}`);
    const op = await operator(browser, 'operator2@demo.local');
    await takeFromQueue(op, `ТГ2 ${stamp}`);
    await expect(op.getByTestId('messages')).toContainText(`Через webhook ${stamp}`);
    await op.getByTestId('reply').fill(`Ответ через второго бота ${stamp}`);
    await op.getByTestId('send').click();
    await expect(op.getByTestId('delivery-sent')).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await tgSent(tg2)).map((m) => m.text))
      .toContain(`Ответ через второго бота ${stamp}`);
    await closeConversation(op);
  });

  test('письмо в ящик КЦ → обращение в той же очереди → ответ приходит клиенту в ту же цепочку', async ({
    page,
    browser,
  }) => {
    const box = `support${stamp}@cc.local`;
    const client = `client${stamp}@client.by`;
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Каналы');
    await page.getByRole('button', { name: 'Добавить' }).click();
    const d = page.getByRole('dialog');
    await pick(page, 'Тип', 'Электронная почта');
    await d.getByLabel('Название').fill(`Почта ${stamp}`);
    await pick(page, 'Очередь по умолчанию', 'Общая');
    await d.getByLabel('Адрес ящика').fill(box);
    await d.getByLabel('IMAP: сервер').fill('mail');
    await d.getByLabel('IMAP: порт').fill('3143');
    await d.getByLabel('IMAP: TLS').uncheck();
    await d.getByLabel('IMAP: пользователь').fill(box);
    await d.getByLabel('IMAP: пароль').fill('pw');
    await d.getByLabel('SMTP: сервер').fill('mail');
    await d.getByLabel('SMTP: порт').fill('3025');
    await d.getByLabel('SMTP: TLS').uncheck();
    await d.getByRole('button', { name: 'Создать' }).click();
    await expect(d).toBeHidden();
    await expectConnected(page, `Почта ${stamp}`);

    await sendMail({
      from: `Анна Клиентова <${client}>`,
      to: box,
      subject: `Возврат ${stamp}`,
      text: `Прошу вернуть деньги, заказ ${stamp}`,
      messageId: `<c1-${stamp}@client.by>`,
    });
    const op = await operator(browser, 'operator3@demo.local');
    await takeFromQueue(op, 'Анна Клиентова');
    await expect(op.getByTestId('messages')).toContainText(`заказ ${stamp}`);
    await op.getByTestId('reply').fill(`Деньги вернём в течение 3 дней ${stamp}`);
    await op.getByTestId('send').click();
    await expect(op.getByTestId('delivery-sent')).toBeVisible({ timeout: 20_000 });

    let reply: Awaited<ReturnType<typeof readMailbox>>[number] | undefined;
    await expect
      .poll(async () => {
        reply = (await readMailbox(client)).find((m) => m.text.includes(`вернём в течение 3 дней ${stamp}`));
        return !!reply;
      })
      .toBe(true);
    expect(reply!.subject).toBe(`Re: Возврат ${stamp}`);
    expect(reply!.inReplyTo).toBe(`<c1-${stamp}@client.by>`);

    // Клиент отвечает в цепочку — письмо в то же обращение.
    await sendMail({
      from: client,
      to: box,
      subject: `Re: Возврат ${stamp}`,
      text: `Спасибо, жду ${stamp}\n\nПоддержка написал(а):\n> Деньги вернём`,
      messageId: `<c2-${stamp}@client.by>`,
      references: [`<c1-${stamp}@client.by>`, reply!.messageId!],
    });
    await expect(op.getByTestId('messages')).toContainText(`Спасибо, жду ${stamp}`, { timeout: 30_000 });
    await expect(op.getByTestId('msg-in').filter({ hasText: 'Деньги вернём' })).toHaveCount(0);
    await closeConversation(op);
  });
});
