/**
 * Мок Telegram Bot API для тестов (демо-компонент, требования 6.2 к нему не применяются).
 * Bot API:  POST /bot<token>/{getMe,getUpdates,sendMessage,sendDocument,setWebhook,deleteWebhook,getFile}
 *           GET  /file/bot<token>/<path>
 * Управление тестом:
 *   POST /__test/<token>/message {chatId, text?, firstName?, document?: {filename, mime, base64}}
 *        — «клиент пишет боту»: обновление в очередь getUpdates или на webhook (с повторами, как Telegram);
 *   GET  /__test/<token>/sent — что отправил бот; GET /__test/<token>/state — webhook, очередь.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0'; // webhook на КЦ с самоподписанным сертификатом

interface Update {
  update_id: number;
  message: Record<string, unknown>;
}
interface Bot {
  nextUpdate: number;
  nextMessage: number;
  queue: Update[];
  waiters: (() => void)[];
  sent: { chat_id: string; text?: string; document?: string; caption?: string; message_id: number; at: number }[];
  webhook: { url: string; secret: string } | null;
  files: Map<string, { body: Buffer; mime: string; name: string }>;
}
const bots = new Map<string, Bot>();
const bot = (token: string): Bot => {
  let b = bots.get(token);
  if (!b) {
    b = { nextUpdate: 1, nextMessage: 1, queue: [], waiters: [], sent: [], webhook: null, files: new Map() };
    bots.set(token, b);
  }
  return b;
};

const json = (res: ServerResponse, code: number, data: unknown) =>
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
const ok = (res: ServerResponse, result: unknown) => json(res, 200, { ok: true, result });
const fail = (res: ServerResponse, code: number, description: string) =>
  json(res, code, { ok: false, error_code: code, description });

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function params(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await body(req);
  const type = String(req.headers['content-type'] ?? '');
  if (type.startsWith('multipart/form-data')) {
    const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(raw) }).formData();
    const out: Record<string, unknown> = {};
    for (const [k, v] of form) out[k] = typeof v === 'string' ? v : { name: v.name, size: v.size };
    return out;
  }
  return raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
}

/** Доставка на webhook с повторами — как Telegram: пока КЦ не ответит 200. */
async function pushWebhook(b: Bot, u: Update): Promise<void> {
  for (let attempt = 0; attempt < 60 && b.webhook; attempt++) {
    try {
      const r = await fetch(b.webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': b.webhook.secret },
        body: JSON.stringify(u),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return;
    } catch {
      /* повтор */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function botApi(token: string, method: string, req: IncomingMessage, res: ServerResponse) {
  const b = bot(token);
  const p = await params(req);
  switch (method) {
    case 'getMe':
      return ok(res, { id: 1, is_bot: true, first_name: 'Mock', username: `mock_${token.slice(0, 6)}_bot` });
    case 'setWebhook':
      b.webhook = { url: String(p.url), secret: String(p.secret_token ?? '') };
      for (const u of b.queue.splice(0)) void pushWebhook(b, u);
      return ok(res, true);
    case 'deleteWebhook':
      b.webhook = null;
      return ok(res, true);
    case 'getUpdates': {
      if (b.webhook) return fail(res, 409, 'Conflict: can\'t use getUpdates method while webhook is active');
      const offset = Number(p.offset ?? 0);
      b.queue = b.queue.filter((u) => u.update_id >= offset);
      if (!b.queue.length) {
        const timeout = Math.min(Number(p.timeout ?? 0), 25) * 1000;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, timeout);
          b.waiters.push(() => (clearTimeout(t), resolve()));
        });
      }
      return ok(res, b.queue.slice(0, 100));
    }
    case 'sendMessage':
    case 'sendDocument': {
      const message_id = b.nextMessage++;
      const doc = p.document as { name?: string } | undefined;
      b.sent.push({
        chat_id: String(p.chat_id),
        text: p.text as string | undefined,
        caption: p.caption as string | undefined,
        document: doc?.name,
        message_id,
        at: Date.now(),
      });
      return ok(res, { message_id, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id) } });
    }
    case 'getFile': {
      const f = b.files.get(String(p.file_id));
      return f ? ok(res, { file_id: p.file_id, file_path: `docs/${String(p.file_id)}` }) : fail(res, 400, 'file not found');
    }
    default:
      return fail(res, 404, 'Not Found');
  }
}

async function testApi(token: string, action: string, req: IncomingMessage, res: ServerResponse) {
  const b = bot(token);
  if (action === 'sent') return json(res, 200, b.sent);
  if (action === 'state') return json(res, 200, { webhook: b.webhook, queued: b.queue.length });
  if (action !== 'message' || req.method !== 'POST') return json(res, 404, {});
  const p = (await params(req)) as {
    chatId: number;
    text?: string;
    firstName?: string;
    document?: { filename: string; mime: string; base64: string };
  };
  const message: Record<string, unknown> = {
    message_id: b.nextMessage++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: p.chatId, type: 'private' },
    from: { id: p.chatId, is_bot: false, first_name: p.firstName ?? 'Клиент' },
  };
  if (p.document) {
    const fileId = `f${b.files.size + 1}_${Date.now()}`;
    b.files.set(fileId, { body: Buffer.from(p.document.base64, 'base64'), mime: p.document.mime, name: p.document.filename });
    message.document = { file_id: fileId, file_name: p.document.filename, mime_type: p.document.mime };
    if (p.text) message.caption = p.text;
  } else message.text = p.text ?? '';
  const u: Update = { update_id: b.nextUpdate++, message };
  if (b.webhook) void pushWebhook(b, u);
  else {
    b.queue.push(u);
    for (const w of b.waiters.splice(0)) w();
  }
  return json(res, 200, { update_id: u.update_id });
}

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]!;
  let m: RegExpExecArray | null;
  const handle = async () => {
    if (path === '/healthz' || path === '/readyz') return json(res, 200, { status: 'ok' });
    if ((m = /^\/bot([^/]+)\/(\w+)$/.exec(path))) return botApi(m[1]!, m[2]!, req, res);
    if ((m = /^\/file\/bot([^/]+)\/docs\/(.+)$/.exec(path))) {
      const f = bot(m[1]!).files.get(decodeURIComponent(m[2]!));
      return f ? res.writeHead(200, { 'content-type': f.mime }).end(f.body) : res.writeHead(404).end();
    }
    if ((m = /^\/__test\/([^/]+)\/(\w+)$/.exec(path))) return testApi(m[1]!, m[2]!, req, res);
    return json(res, 404, {});
  };
  handle().catch((err: unknown) => json(res, 500, { ok: false, description: String(err) }));
}).listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
