import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login, nav, setAgentStatus, listView } from './helpers';

/**
 * Ф14 (указания заказчика 01.10): тайм-аут молчания в боте, позиция в очереди, супервизор — прослушивание →
 * суфлирование → вмешательство → перехват (звук проверяется энергией принятого аудио по getStats), подсказка
 * оператору и перехват чата.
 */
const stamp = Date.now().toString().slice(-6);

/** Тон 440 Гц для фейкового микрофона (как в Ф5): без файла Chromium в безголовом режиме отдаёт тишину. */
function toneFile(): string {
  const rate = 16000;
  const pcm = Buffer.alloc(rate * 2 * 2);
  for (let i = 0; i < rate * 2; i++)
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  const file = join(tmpdir(), 'cc-e2e-tone.wav');
  writeFileSync(file, Buffer.concat([h, pcm]));
  return file;
}

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${toneFile()}`,
    ],
  },
  permissions: ['microphone'],
});

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

/** Все RTCPeerConnection страницы — в window.__pcs: энергия принятого звука и выключение микрофона в проверках. */
function trackPeerConnections() {
  const Orig = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  window.RTCPeerConnection = class extends Orig {
    constructor(...a: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...a);
      pcs.push(this);
    }
  } as typeof RTCPeerConnection;
}

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    permissions: ['microphone'],
  });
  contexts.push(ctx);
  await ctx.addInitScript(trackPeerConnections);
  return ctx.newPage();
}

async function staff(browser: Browser, email: string, password = DEMO_PASSWORD): Promise<Page> {
  const page = await newPage(browser);
  await login(page, email, password);
  await nav(page, 'Рабочее место оператора');
  await expect(page.getByTestId('softphone-status')).toHaveText('Телефон готов', { timeout: 20_000 });
  return page;
}

async function demoCall(browser: Browser, phone: string, name: string): Promise<Page> {
  const page = await newPage(browser);
  await page.goto('/demo-call');
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByTestId('demo-phone').fill(phone);
  await page.getByTestId('demo-call').click();
  await expect(page.getByTestId('demo-state')).toBeVisible();
  return page;
}

/** Суммарная энергия принятого звука (inbound-rtp totalAudioEnergy) по живым соединениям страницы. */
const energy = (page: Page) =>
  page.evaluate(async () => {
    let sum = 0;
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs) {
      if (pc.connectionState === 'closed') continue;
      (await pc.getStats()).forEach((r: Record<string, unknown>) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') sum += Number(r.totalAudioEnergy ?? 0);
      });
    }
    return sum;
  });

/** Энергия звука, принятого страницей за ms (inbound-rtp totalAudioEnergy). */
async function heard(page: Page, ms = 3000): Promise<number> {
  const a = await energy(page);
  await page.waitForTimeout(ms);
  return (await energy(page)) - a;
}

/** Выключить микрофон страницы (треки отправителей): слышно будет только то, что подмешает супервизор. */
const silence = (page: Page) =>
  page.evaluate(() => {
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs)
      for (const s of pc.getSenders()) if (s.track) s.track.enabled = false;
  });

/**
 * Пороги энергии за 3 с: тон супервизора, прошедший Opus и мост Asterisk, — около 0,002 (стабильно во всех режимах),
 * тишина — 0 (фактически менее 10⁻⁶).
 */
const LOUD = 0.0005;
const QUIET = 0.0001;

async function api(request: APIRequestContext, email = ADMIN.email, password = ADMIN.password) {
  const r = await request.post('/api/v1/auth/login', { data: { email, password } });
  expect(r.ok()).toBeTruthy();
  const token = (await r.json()).accessToken as string;
  const call = async (method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown) => {
    const res = await request.fetch(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(data !== undefined ? { data } : {}),
    });
    expect(res.status(), `${method} ${path}: ${await res.text()}`).toBeLessThan(300);
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  };
  return call;
}

async function openWidget(browser: Browser, name: string, key: string) {
  const page = await newPage(browser);
  await page.goto(`/widget/demo.html?key=${key}`);
  const w = page.locator('#cc-widget');
  await w.getByTestId('cc-open').click();
  await w.getByPlaceholder('Ваше имя (необязательно)').fill(name);
  await w.getByRole('checkbox').check();
  await w.getByRole('button', { name: 'Начать чат' }).click();
  return { page, w };
}

async function say(w: ReturnType<Page['locator']>, text: string) {
  await w.getByTestId('cc-input').fill(text);
  await w.getByTestId('cc-send').click();
}

test.describe.serial('Ф14: бот, очередь, супервизор', () => {
  test('бот: клиент молчит → напоминание → «нет ответа» → оператор (M-AUTO-04)', async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000);
    const call = await api(request);
    const queues = (await call('GET', '/dict/queues')) as { id: string; name: string }[];
    const queueId = queues.find((q) => q.name === 'Общая')!.id;
    const flow = await call('POST', '/flows', { name: `Бот с ожиданием ${stamp}`, kind: 'text' });
    await call('PATCH', `/flows/${flow.id}`, {
      draft: {
        version: 1,
        kind: 'text',
        nodes: [
          { id: 'start', type: 'start', params: {} },
          {
            id: 'menu',
            type: 'buttons',
            params: {
              text: 'Чем помочь?',
              buttons: [{ id: 'b', label: 'Баланс' }],
              retries: 1,
              waitSec: 10,
              reminders: 1,
              remindText: 'Вы ещё здесь? Выберите, пожалуйста, тему.',
            },
          },
          { id: 'silent', type: 'message', params: { text: 'Не дождались ответа — передаю оператору.' } },
          { id: 'op', type: 'handoff', params: { queueId, text: '' } },
        ],
        edges: [
          { id: '1', source: 'start', exit: 'next', target: 'menu' },
          { id: '2', source: 'menu', exit: 'btn:b', target: 'op' },
          { id: '3', source: 'menu', exit: 'other', target: 'op' },
          { id: '4', source: 'menu', exit: 'noanswer', target: 'silent' },
          { id: '5', source: 'silent', exit: 'next', target: 'op' },
        ],
      },
    });
    await call('POST', `/flows/${flow.id}/publish`, { comment: 'e2e Ф14' });
    const key = `bot-wait-${stamp}`;
    await call('POST', '/dict/channels', {
      kind: 'webchat',
      name: `Сайт: бот с ожиданием ${stamp}`,
      queueId,
      botFlowId: flow.id,
      config: { public_key: key, allowed_origins: ['*'] },
    });

    const name = `Молчун ${stamp}`;
    const client = await openWidget(browser, name, key);
    await say(client.w, 'здравствуйте');
    await expect(client.w.getByText('Чем помочь?')).toBeVisible({ timeout: 15_000 });
    // Клиент молчит: через 10 с — напоминание, ещё через 10 с — ветка «нет ответа» и перевод на оператора.
    await expect(client.w.getByText('Вы ещё здесь? Выберите, пожалуйста, тему.')).toBeVisible({
      timeout: 25_000,
    });
    await expect(client.w.getByText('Не дождались ответа — передаю оператору.')).toBeVisible({
      timeout: 25_000,
    });

    const op = await newPage(browser);
    await login(op, 'operator1@demo.local', DEMO_PASSWORD);
    await nav(op, 'Рабочее место оператора');
    await listView(op, 'queue');
    const item = op.getByTestId('conv-item').filter({ hasText: name });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByTestId('take').click();
    const msgs = op.getByTestId('messages');
    await expect(msgs).toContainText('Вы ещё здесь?');
    await expect(msgs).toContainText('Бот передал диалог оператору');
    await say(client.w, 'спасибо');
    await expect(msgs).toContainText('спасибо');
    // Закрыть, чтобы обращение не осталось у оператора в следующих проверках.
    await op.getByTestId('disposition').click();
    await op.getByRole('option', { name: 'Решено на 1-й линии' }).click();
    await op.getByTestId('topic').click();
    await op.getByRole('option', { name: 'Сайт', exact: true }).click();
    await op.getByTestId('close').click();
    await expect(op.getByText('Обращение закрыто.')).toBeVisible();
  });

  test('конструктор бота: поле «Ждать ответа» и выход «нет ответа»; тестовый прогон — «Клиент молчит»', async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Боты');
    await page.getByRole('link', { name: `Бот с ожиданием ${stamp}` }).click();
    await expect(page.getByTestId('node-buttons')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('exit-noanswer')).toBeVisible();
    await page.getByTestId('node-buttons').click();
    await expect(page.getByTestId('param-waitSec')).toHaveValue('10');
    await page.getByTestId('flow-test').click();
    await page.getByTestId('test-start').click();
    await expect(page.getByTestId('test-log')).toContainText('Чем помочь?');
    await page.getByTestId('test-silence').click();
    await expect(page.getByTestId('test-log')).toContainText('Вы ещё здесь?');
    await page.getByTestId('test-silence').click();
    await expect(page.getByTestId('test-log')).toContainText('Не дождались ответа');
  });

  test('позиция в очереди: включена — второму звонящему звучит «второй» (журнал вызова), выключена — не звучит', async ({
    browser,
    request,
  }) => {
    test.setTimeout(150_000);
    const call = await api(request);
    const channels = (await call('GET', '/dict/channels')) as {
      kind: string;
      queueId: string;
      config: { dids?: string[] };
    }[];
    const voiceQueue = channels.find((c) => c.kind === 'voice' && c.config.dids?.includes('1000'))!.queueId;
    const callers: Page[] = [];
    const callsOf = async (name: string) => {
      const list = (await call('GET', `/conversations?tab=active&q=${encodeURIComponent(name)}`)) as {
        id: string;
      }[];
      expect(list.length).toBeGreaterThan(0);
      return (await call('GET', `/conversations/${list[0]!.id}/calls`)) as {
        events: { type: string; data?: { position?: number; spoken?: boolean } }[];
      }[];
    };
    try {
      await call('PATCH', `/dict/queues/${voiceQueue}`, {
        announcePosition: true,
        announcePositionEveryS: 15,
      });
      callers.push(await demoCall(browser, `+37529${stamp}5`, `Первый ${stamp}`));
      await callers[0]!.waitForTimeout(1500);
      callers.push(await demoCall(browser, `+37529${stamp}6`, `Второй ${stamp}`));
      await expect(async () => {
        const ev = (await callsOf(`Второй ${stamp}`))[0]!.events.filter((e) => e.type === 'position');
        expect(ev.map((e) => e.data?.position)).toContain(2);
        // Фраза собрана из фрагментов аудиобиблиотеки (не «spoken: false» — нет фрагментов).
        expect(ev.every((e) => e.data?.spoken !== false)).toBe(true);
      }).toPass({ timeout: 20_000 });
      // Первому — «первый».
      const first = (await callsOf(`Первый ${stamp}`))[0]!.events.filter((e) => e.type === 'position');
      expect(first.map((e) => e.data?.position)).toContain(1);

      // Выключено (без перезапуска) — новому звонящему позиция не сообщается.
      await call('PATCH', `/dict/queues/${voiceQueue}`, { announcePosition: false });
      callers.push(await demoCall(browser, `+37529${stamp}7`, `Третий ${stamp}`));
      await callers[2]!.waitForTimeout(8000);
      const third = (await callsOf(`Третий ${stamp}`))[0]!.events.filter((e) => e.type === 'position');
      expect(third).toHaveLength(0);
    } finally {
      await call('PATCH', `/dict/queues/${voiceQueue}`, { announcePosition: false });
      for (const c of callers)
        await c
          .getByTestId('demo-hangup')
          .click()
          .catch(() => undefined);
    }
  });

  test('супервизор: прослушивание → суфлирование (слышит только оператор) → вмешательство (слышат оба) → перехват', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const op = await staff(browser, 'operator1@demo.local');
    const sup = await staff(browser, ADMIN.email, ADMIN.password);
    await setAgentStatus(op, 'ready');
    const name = `Суфлёр ${stamp}`;
    const client = await demoCall(browser, `+37529${stamp}8`, name);
    const call = op.getByTestId('softphone-call');
    await expect(call).toHaveAttribute('data-state', 'ringing', { timeout: 20_000 });
    await call.getByTestId('call-answer').click();
    await expect(call).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
    await expect(client.getByTestId('demo-state')).toHaveText('Идёт разговор');
    // «Готов» снимаем сразу: router не должен предлагать оператору новые обращения посреди проверки.
    await setAgentStatus(op, 'offline');
    // Клиент и оператор молчат — всё, что они слышат, — от супервизора (его микрофон — тон 440 Гц).
    await silence(client);
    await silence(op);

    await listView(sup, 'active');
    await sup.getByTestId('conv-item').filter({ hasText: name }).click();
    await sup.getByTestId('tab-contact').click();
    await sup.getByTestId('call-listen').click();
    const panel = sup.getByTestId('softphone-call');
    await expect(panel).toContainText('Прослушивание разговора', { timeout: 15_000 });
    await expect(panel).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
    const controls = panel.getByTestId('supervisor-controls');
    await expect(controls).toHaveAttribute('data-mode', 'listen');
    // Прослушивание: супервизора не слышит никто, оператор плашки не видит.
    await expect(op.getByTestId('supervisor-banner')).toHaveCount(0);
    expect(await heard(op)).toBeLessThan(QUIET);
    expect(await heard(client)).toBeLessThan(QUIET);

    // Суфлирование — без переподключения: супервизора слышит только оператор.
    await controls.getByTestId('supervisor-mode').getByText('Суфлировать').click();
    await expect(controls).toHaveAttribute('data-mode', 'whisper', { timeout: 10_000 });
    await expect(op.getByTestId('supervisor-banner')).toHaveAttribute('data-mode', 'whisper', {
      timeout: 10_000,
    });
    await expect(op.getByTestId('supervisor-banner')).toContainText('Супервизор подсказывает');
    await op.waitForTimeout(1000);
    expect(await heard(op)).toBeGreaterThan(LOUD);
    expect(await heard(client)).toBeLessThan(QUIET);

    // Вмешательство: слышат оба.
    await controls.getByTestId('supervisor-mode').getByText('Вмешаться').click();
    await expect(op.getByTestId('supervisor-banner')).toHaveAttribute('data-mode', 'barge', {
      timeout: 10_000,
    });
    await expect(op.getByTestId('supervisor-banner')).toContainText('Супервизор в разговоре');
    await op.waitForTimeout(1000);
    expect(await heard(op)).toBeGreaterThan(LOUD);
    expect(await heard(client)).toBeGreaterThan(LOUD);

    // Обратно к прослушиванию: плашка исчезает, снова никого не слышно.
    await controls.getByTestId('supervisor-mode').getByText('Слушать').click();
    await expect(op.getByTestId('supervisor-banner')).toHaveCount(0, { timeout: 10_000 });
    await op.waitForTimeout(1000);
    expect(await heard(client)).toBeLessThan(QUIET);
    await expect(panel).toHaveAttribute('data-state', 'active');

    // Перехват: оператор отключён (уведомление), звонок у супервизора, клиент на линии и слышит супервизора.
    await controls.getByTestId('supervisor-takeover').click();
    await expect(call).toHaveCount(0, { timeout: 15_000 });
    await expect(op.getByText('Обращение перехвачено супервизором')).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByTestId('supervisor-controls')).toHaveCount(0, { timeout: 10_000 });
    await expect(panel.getByTestId('call-hold')).toBeVisible();
    await expect(client.getByTestId('demo-state')).toHaveText('Идёт разговор');
    await sup.waitForTimeout(1000);
    expect(await heard(client)).toBeGreaterThan(LOUD);
    // Обращение переназначено супервизору; журнал вызова — с подключениями и перехватом.
    await listView(sup, 'mine');
    await expect(sup.getByTestId('conv-item').filter({ hasText: name })).toBeVisible({ timeout: 10_000 });
    await sup.getByTestId('conv-item').filter({ hasText: name }).click();
    await sup.getByTestId('tab-contact').click();
    const item = sup.getByTestId('call-item').first();
    await expect(item).toContainText('супервизор суфлирует');
    await expect(item).toContainText('супервизор вмешался');
    await expect(item).toContainText('перехват супервизором');
    await panel.getByTestId('call-hangup').click();
    await expect(client.getByTestId('demo-info')).toContainText('Звонок завершён', { timeout: 15_000 });
  });

  test('чат: подсказка оператору (клиент не видит) и перехват чата супервизором', async ({ browser }) => {
    test.setTimeout(120_000);
    const name = `Подсказка ${stamp}`;
    const client = await openWidget(browser, name, 'demo-webchat');
    await say(client.w, 'не проходит оплата картой');
    const op = await newPage(browser);
    await login(op, 'operator2@demo.local', DEMO_PASSWORD);
    await nav(op, 'Рабочее место оператора');
    await listView(op, 'queue');
    const item = op.getByTestId('conv-item').filter({ hasText: name });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByTestId('take').click();
    await expect(op.getByTestId('reply')).toBeEnabled();

    const sup = await newPage(browser);
    await login(sup, ADMIN.email, ADMIN.password);
    await nav(sup, 'Рабочее место оператора');
    await listView(sup, 'active');
    await sup.getByTestId('conv-item').filter({ hasText: name }).click();
    await sup.getByTestId('hint-mode').click();
    await sup.getByTestId('reply').fill(`Предложи оплату по QR ${stamp}`);
    await sup.getByTestId('send').click();

    // Оператору — сообщение в карточке с подписью и всплывающее уведомление; клиенту — ничего.
    await expect(op.getByTestId('msg-hint')).toContainText(`Предложи оплату по QR ${stamp}`, {
      timeout: 10_000,
    });
    await expect(op.getByTestId('msg-hint')).toContainText('Подсказка супервизора');
    await expect(op.getByText('Подсказка супервизора').first()).toBeVisible();
    await op.getByTestId('reply').fill('Попробуйте оплату по QR-коду');
    await op.getByTestId('send').click();
    await expect(client.w.getByText('Попробуйте оплату по QR-коду')).toBeVisible({ timeout: 10_000 });
    await expect(client.w.getByText(`Предложи оплату по QR ${stamp}`)).toHaveCount(0);

    // Перехват чата: обращение у супервизора, оператору — уведомление.
    await sup.getByTestId('takeover').click();
    await expect(op.getByText('Обращение перехвачено супервизором')).toBeVisible({ timeout: 10_000 });
    await expect(sup.getByTestId('messages')).toContainText('перехватил диалог у оператора');
    await sup.getByTestId('hint-mode').waitFor({ state: 'detached', timeout: 10_000 });
    await sup.getByTestId('reply').fill('Здравствуйте, на связи старший смены');
    await sup.getByTestId('send').click();
    await expect(client.w.getByText('Здравствуйте, на связи старший смены')).toBeVisible({ timeout: 10_000 });
    await sup.getByTestId('disposition').click();
    await sup.getByRole('option', { name: 'Решено на 1-й линии' }).click();
    await sup.getByTestId('topic').click();
    await sup.getByRole('option', { name: 'Сайт', exact: true }).click();
    await expect(sup.getByTestId('topic-full')).toContainText('Сайт');
    await sup.getByTestId('close').click();
    await expect(sup.getByText('Обращение закрыто.')).toBeVisible();
  });
});
