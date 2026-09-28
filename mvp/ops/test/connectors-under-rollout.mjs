// Поток сообщений Telegram и email во время поэтапного обновления коннекторов (DoD Ф4, M-UPD-01):
// ни одно входящее не теряется и не дублируется в обращении, каждый ответ оператора доставлен клиенту ровно один раз.
// Использование: node ops/test/connectors-under-rollout.mjs <новый_тег> [секунд]
// Предусловие: стек запущен с SEED_DEMO=true и профилем test (мок Telegram, GreenMail);
// образы cc/connector-{telegram,email}:<тег> собраны.
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { connect } from 'node:net';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const [newTag = 'next', seconds = '60'] = process.argv.slice(2);
const BASE = process.env.BASE_URL ?? 'https://localhost';
const MOCK_TG = process.env.MOCK_TELEGRAM_URL ?? 'http://127.0.0.1:8081';
const MAIL_HOST = process.env.MAIL_HOST ?? '127.0.0.1';
const SMTP_PORT = Number(process.env.MAIL_SMTP_PORT ?? 3025);
const IMAP_PORT = Number(process.env.MAIL_IMAP_PORT ?? 3143);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36);

async function req(method, path, { token, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      if (r.status >= 500 && attempt < 5) throw new Error(`HTTP ${r.status}`);
      return { status: r.status, body: text ? JSON.parse(text) : undefined };
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
}

// --- почта: минимальные SMTP/IMAP-клиенты для GreenMail (авторизация отключена) ---
function mailConn(port) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const s = connect(port, MAIL_HOST, () =>
      resolve({
        write: (l) => s.write(`${l}\r\n`),
        close: () => s.end(),
        async until(re, timeoutMs = 15000) {
          const deadline = Date.now() + timeoutMs;
          while (!re.test(buf)) {
            if (Date.now() > deadline) throw new Error(`почтовый сервер не ответил: ${buf.slice(-200)}`);
            await sleep(20);
          }
          const out = buf;
          buf = '';
          return out;
        },
      }),
    );
    s.setEncoding('utf8');
    s.on('data', (d) => (buf += d));
    s.once('error', reject);
  });
}
async function sendMail(from, to, subject, text, messageId) {
  const c = await mailConn(SMTP_PORT);
  const ok = (code) => new RegExp(`(^|\\r\\n)${code} [^\\r\\n]*\\r\\n$`);
  await c.until(ok(220));
  for (const [cmd, code] of [
    ['HELO test', 250],
    [`MAIL FROM:<${from}>`, 250],
    [`RCPT TO:<${to}>`, 250],
    ['DATA', 354],
  ]) {
    c.write(cmd);
    await c.until(ok(code));
  }
  c.write(
    [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '.',
    ].join('\r\n'),
  );
  await c.until(ok(250));
  c.write('QUIT');
  c.close();
}
/** Тексты всех писем ящика (тело целиком). */
async function mailbox(user) {
  const c = await mailConn(IMAP_PORT);
  const tagged = (t) => new RegExp(`(^|\\r\\n)${t} (OK|NO|BAD)[^\\r\\n]*\\r\\n$`);
  await c.until(/\r\n/);
  c.write(`a1 LOGIN "${user}" "pw"`);
  await c.until(tagged('a1'));
  c.write('a2 SELECT INBOX');
  const n = Number(/\* (\d+) EXISTS/.exec(await c.until(tagged('a2')))?.[1] ?? 0);
  const out = [];
  if (n) {
    c.write(`a3 FETCH 1:${n} BODY.PEEK[TEXT]`);
    const r = await c.until(tagged('a3'), 30000);
    for (const part of r.split(/\r\n\* \d+ FETCH /)) out.push(decodeQp(part));
  }
  c.write('a4 LOGOUT');
  c.close();
  return out.filter(Boolean);
}
const decodeQp = (s) =>
  Buffer.from(
    s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))),
    'latin1',
  ).toString('utf8');

// --- подготовка: каналы, клиенты, обращения ---
const admin = (
  await req('POST', '/api/v1/auth/login', {
    body: {
      email: process.env.ADMIN_EMAIL ?? 'admin@cc.local',
      password: process.env.ADMIN_PASSWORD ?? 'Admin12345!',
    },
  })
).body.accessToken;
const op = (
  await req('POST', '/api/v1/auth/login', {
    body: {
      email: process.env.OPERATOR_EMAIL ?? 'operator2@demo.local',
      password: process.env.DEMO_PASSWORD ?? 'Demo12345!',
    },
  })
).body.accessToken;
// Операторы — «Офлайн»: обращения остаются в очереди до ручного «Взять» (иначе router предложит их
// оператору, оставленному в статусе «Готов» предыдущими проверками).
for (const email of ['operator1@demo.local', 'operator2@demo.local', 'operator3@demo.local']) {
  const t = (
    await req('POST', '/api/v1/auth/login', {
      body: { email, password: process.env.DEMO_PASSWORD ?? 'Demo12345!' },
    })
  ).body.accessToken;
  await req('POST', '/api/v1/agent-status', { token: t, body: { status: 'offline' } });
}
const queueId = (await req('GET', '/api/v1/dict/queues', { token: admin })).body.find(
  (q) => q.name === 'Общая',
).id;
const token = `ro${stamp}:rollout-token`;
const box = `rollout-${stamp}@cc.local`;
const client = `client-${stamp}@client.by`;
const chatId = 900000 + Math.floor(Math.random() * 99999);

const mk = async (kind, name, config) => {
  const r = await req('POST', '/api/v1/dict/channels', {
    token: admin,
    body: { kind, name, queueId, config },
  });
  if (r.status !== 201) throw new Error(`канал не создан: ${JSON.stringify(r.body)}`);
  return r.body.id;
};
const tgChannel = await mk('telegram', `Rollout TG ${stamp}`, {
  bot_token: token,
  mode: 'polling',
  api_root: 'http://mock-telegram:3000',
});
const mailChannel = await mk('email', `Rollout mail ${stamp}`, {
  address: box,
  imap_host: 'mail',
  imap_port: 3143,
  imap_secure: false,
  imap_user: box,
  imap_password: 'pw',
  smtp_host: 'mail',
  smtp_port: 3025,
  smtp_secure: false,
});
for (const id of [tgChannel, mailChannel]) {
  for (let i = 0; ; i++) {
    const s = (await req('GET', `/api/v1/channels/${id}/log`, { token: admin })).body;
    if (s.status === 'connected') break;
    if (i > 60) throw new Error(`канал ${id} не подключился: ${JSON.stringify(s)}`);
    await sleep(1000);
  }
}

const tgSent = new Set();
const mailSent = new Set();
async function tgSay(i) {
  const text = `тг ${stamp} ${i}`;
  tgSent.add(text);
  const r = await fetch(`${MOCK_TG}/__test/${token}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, text, firstName: `Rollout ${stamp}` }),
  });
  if (!r.ok) throw new Error(`мок Telegram: ${r.status}`);
}
async function mailSay(i) {
  const text = `письмо ${stamp} ${i}`;
  mailSent.add(text);
  await sendMail(client, box, `Rollout ${stamp}`, text, `<m${i}-${stamp}@client.by>`);
}

async function conversationOf(contactName) {
  for (let i = 0; i < 60; i++) {
    const q = await req('GET', '/api/v1/conversations?tab=queue', { token: op });
    const c = q.body.find((x) => x.contactName === contactName);
    if (c) return c.id;
    await sleep(500);
  }
  throw new Error(`обращение клиента ${contactName} не появилось в очереди`);
}
await tgSay(0);
await mailSay(0);
const tgConv = await conversationOf(`Rollout ${stamp}`);
const mailConv = await conversationOf(client);
for (const id of [tgConv, mailConv]) {
  const r = await req('POST', `/api/v1/conversations/${id}/take`, { token: op });
  if (r.status !== 200) throw new Error(`не удалось взять обращение: ${JSON.stringify(r.body)}`);
}

// --- поток во время обновления ---
const opSent = { [tgConv]: [], [mailConv]: [] };
let running = true;
const loops = [
  (async () => {
    for (let i = 1; running; i++) {
      await tgSay(i);
      await sleep(150);
    }
  })(),
  (async () => {
    for (let i = 1; running; i++) {
      await mailSay(i);
      await sleep(400);
    }
  })(),
  (async () => {
    for (let i = 1; running; i++) {
      for (const conv of [tgConv, mailConv]) {
        const body = `ответ ${stamp} ${conv.slice(0, 4)} ${i}.`; // точка — граница номера при поиске в письме
        const r = await req('POST', `/api/v1/conversations/${conv}/messages`, { token: op, body: { body } });
        if (r.status === 201) opSent[conv].push(body);
      }
      await sleep(400);
    }
  })(),
];
const run = (svc) =>
  new Promise((resolve) => {
    const tagVar = {
      'connector-telegram': 'CONNECTOR_TELEGRAM_TAG',
      'connector-email': 'CONNECTOR_EMAIL_TAG',
    }[svc];
    const p = spawn('ops/rollout.sh', [svc], { stdio: 'inherit', env: { ...process.env, [tagVar]: newTag } });
    p.on('exit', resolve);
  });
const started = Date.now();
await sleep(3000);
const codes = [];
for (const svc of ['connector-telegram', 'connector-email']) codes.push(await run(svc));
while (Date.now() - started < Number(seconds) * 1000) await sleep(500);
running = false;
await Promise.all(loops);

// --- проверка: ждём хвост (опрос ящика, повторы доставки), затем сверяем ---
const count = (arr, v) => arr.filter((x) => x === v).length;
let result;
for (let attempt = 0; attempt < 30; attempt++) {
  await sleep(2000);
  const msgs = async (id) => (await req('GET', `/api/v1/conversations/${id}/messages`, { token: op })).body;
  const [tgMsgs, mailMsgs] = [await msgs(tgConv), await msgs(mailConv)];
  const inTg = tgMsgs.filter((m) => m.direction === 'in').map((m) => m.body);
  const inMail = mailMsgs.filter((m) => m.direction === 'in').map((m) => m.body.trim());
  const outs = [...tgMsgs, ...mailMsgs].filter((m) => m.direction === 'out');
  const tgDelivered = ((await (await fetch(`${MOCK_TG}/__test/${token}/sent`)).json()) ?? []).map(
    (m) => m.text,
  );
  const mailDelivered = await mailbox(client);
  const deliveredMail = (body) => mailDelivered.filter((t) => t.includes(body)).length;
  result = {
    rolloutExitCodes: codes,
    telegram: {
      clientSent: tgSent.size,
      lost: [...tgSent].filter((t) => !inTg.includes(t)).length,
      duplicates: [...tgSent].filter((t) => count(inTg, t) > 1).length,
      operatorSent: opSent[tgConv].length,
      notDelivered: opSent[tgConv].filter((b) => count(tgDelivered, b) === 0).length,
      deliveredTwice: opSent[tgConv].filter((b) => count(tgDelivered, b) > 1).length,
    },
    email: {
      clientSent: mailSent.size,
      lost: [...mailSent].filter((t) => !inMail.includes(t)).length,
      duplicates: [...mailSent].filter((t) => count(inMail, t) > 1).length,
      operatorSent: opSent[mailConv].length,
      notDelivered: opSent[mailConv].filter((b) => deliveredMail(b) === 0).length,
      deliveredTwice: opSent[mailConv].filter((b) => deliveredMail(b) > 1).length,
    },
    deliveryStatus: {
      sent: outs.filter((m) => m.deliveryStatus === 'sent').length,
      pending: outs.filter((m) => m.deliveryStatus === 'pending').length,
      failed: outs.filter((m) => m.deliveryStatus === 'failed').length,
    },
  };
  const t = result.telegram;
  const e = result.email;
  if (!t.lost && !e.lost && !t.notDelivered && !e.notDelivered && !result.deliveryStatus.pending) break;
}
console.log(JSON.stringify(result, null, 2));
const { telegram: t, email: e } = result;
const ok =
  codes.every((c) => c === 0) &&
  [t, e].every(
    (x) => x.operatorSent > 0 && !x.lost && !x.duplicates && !x.notDelivered && !x.deliveredTwice,
  ) &&
  !result.deliveryStatus.pending &&
  !result.deliveryStatus.failed;
console.log(ok ? 'РЕЗУЛЬТАТ: ОК — обновление коннекторов без потерь и дублей' : 'РЕЗУЛЬТАТ: ПРОВАЛ');
process.exit(ok ? 0 : 1);
