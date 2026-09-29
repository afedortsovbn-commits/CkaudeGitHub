/**
 * Ф9 — демо внешних систем для публичного API и webhooks (профили test и demo):
 *   POST /hooks/<имя>          — приёмник webhooks: запоминает запросы (заголовки, тело)
 *   GET  /hooks/<имя>          — что пришло; DELETE — очистить
 *   POST /control {"down":true} — «получатель упал»: /hooks, /analyzer, /bot отвечают 503; {"down":false} — ожил
 *   POST /analyzer/webhook     — демо-анализатор: на conversation.closed читает переписку по API и пишет
 *                                результат (поля «Тональность», «Кратко», заметка) ключом с правом conversations.write
 *   POST /bot/webhook          — демо внешний бот (эхо): отвечает с кнопкой «Оператор», по слову «оператор» —
 *                                переводит на оператора (ключ с правом bot.reply)
 * Подпись X-CC-Signature проверяется секретом подписки (демо-значения совпадают с сидом api).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const API_URL = (process.env.API_URL ?? 'http://api:3000').replace(/\/$/, '');
const ANALYZER_KEY = process.env.DEMO_ANALYZER_API_KEY ?? 'cck_demo_analyzer_key_change_me_0123456789';
const ANALYZER_SECRET = process.env.DEMO_ANALYZER_SECRET ?? 'whsec_demo_analyzer_change_me';
const BOT_KEY = process.env.DEMO_BOT_API_KEY ?? 'cck_demo_bot_key_change_me_0123456789abcdef';
const BOT_SECRET = process.env.DEMO_BOT_SECRET ?? 'whsec_demo_bot_change_me';

interface Hit {
  at: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  signatureOk?: boolean;
}
const hooks = new Map<string, Hit[]>();
let down = false;

type Send = (s: number, b: unknown) => void;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => resolve(raw));
  });
}

export function verify(secret: string, req: IncomingMessage, raw: string): boolean {
  const ts = String(req.headers['x-cc-timestamp'] ?? '');
  const sig = String(req.headers['x-cc-signature'] ?? '');
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  return fresh && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function api(method: string, path: string, key: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${API_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', service: 'mock-selfservice', msg, ...extra }));

/** «Анализ»: тональность по словам клиента и краткое содержание. */
export function analyze(texts: string[]): { sentiment: string; summary: string } {
  const all = texts.join(' ').toLowerCase();
  const neg = ['плохо', 'недовол', 'жалоб', 'ужас', 'обман', 'безобраз', 'грубо'].some((w) =>
    all.includes(w),
  );
  const pos = ['спасибо', 'отлично', 'благодар', 'хорошо'].some((w) => all.includes(w));
  return {
    sentiment: neg ? 'негативная' : pos ? 'позитивная' : 'нейтральная',
    summary: (texts[0] ?? '').slice(0, 120),
  };
}

async function runAnalyzer(conversationId: string): Promise<void> {
  const msgs = (await api('GET', `/api/v1/ext/conversations/${conversationId}/messages`, ANALYZER_KEY)) as {
    direction: string;
    text: string;
  }[];
  const client = msgs.filter((m) => m.direction === 'in').map((m) => m.text);
  const r = analyze(client);
  await api('PATCH', `/api/v1/ext/conversations/${conversationId}`, ANALYZER_KEY, {
    fields: { Тональность: r.sentiment, Кратко: r.summary },
    note: `Результат анализа: тональность ${r.sentiment}; сообщений клиента — ${client.length}.`,
  });
  log('анализ записан', { conversationId, sentiment: r.sentiment });
}

async function runBot(data: { conversationId: string; message: { text: string } }): Promise<void> {
  const id = data.conversationId;
  const text = data.message.text.trim();
  if (/оператор/i.test(text)) {
    await api('POST', `/api/v1/ext/conversations/${id}/handoff`, BOT_KEY, {
      text: 'Соединяю с оператором, подождите, пожалуйста.',
      note: 'Внешний бот: клиент попросил оператора.',
    });
    return;
  }
  await api('POST', `/api/v1/ext/conversations/${id}/messages`, BOT_KEY, {
    text: `Эхо-бот получил: «${text.slice(0, 200)}». Напишите «оператор», чтобы связаться со специалистом.`,
    buttons: ['Оператор'],
  });
}

/** Обработать запрос, если он относится к интеграциям Ф9; иначе false. */
export function handleIntegrations(req: IncomingMessage, url: URL, send: Send): boolean {
  const p = url.pathname;
  if (p === '/control' && req.method === 'POST') {
    void readBody(req).then((raw) => {
      down = !!(JSON.parse(raw || '{}') as { down?: boolean }).down;
      log('состояние приёмника', { down });
      send(200, { down });
    });
    return true;
  }
  const hook = /^\/hooks\/([\w.-]+)$/.exec(p);
  if (!hook && p !== '/analyzer/webhook' && p !== '/bot/webhook') return false;
  if (hook && req.method === 'GET') {
    send(200, hooks.get(hook[1]!) ?? []);
    return true;
  }
  if (hook && req.method === 'DELETE') {
    hooks.delete(hook[1]!);
    send(200, { ok: true });
    return true;
  }
  if (req.method !== 'POST') {
    send(405, { error: 'method' });
    return true;
  }
  void readBody(req).then((raw) => {
    if (down) return send(503, { error: 'receiver is down' });
    let body: { type?: string; data?: Record<string, unknown> } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return send(400, { error: 'json' });
    }
    const name = hook ? hook[1]! : p === '/analyzer/webhook' ? 'analyzer' : 'bot';
    const secret = name === 'analyzer' ? ANALYZER_SECRET : name === 'bot' ? BOT_SECRET : null;
    const signatureOk = secret ? verify(secret, req, raw) : undefined;
    const list = hooks.get(name) ?? [];
    list.push({ at: new Date().toISOString(), headers: req.headers, body, signatureOk });
    hooks.set(name, list.slice(-500));
    if (secret && !signatureOk) return send(401, { error: 'bad signature' });
    // Ответ сразу, работа — асинхронно (как рекомендовано получателям).
    send(200, { ok: true });
    if (name === 'analyzer' && body.type === 'conversation.closed')
      runAnalyzer(String(body.data?.conversationId)).catch((e: unknown) =>
        log('анализатор: ошибка', { err: String(e) }),
      );
    if (name === 'bot' && body.type === 'conversation.bot_turn')
      runBot(body.data as { conversationId: string; message: { text: string } }).catch((e: unknown) =>
        log('бот: ошибка', { err: String(e) }),
      );
  });
  return true;
}
