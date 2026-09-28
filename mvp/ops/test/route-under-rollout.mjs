// Распределение обращений во время поэтапного обновления router (DoD Ф3, M-UPD-01):
// ни одно обращение не остаётся в очереди навсегда — router продолжает назначать операторов,
// пока часть экземпляров заменяется новой версией.
// Использование: node ops/test/route-under-rollout.mjs <новый_тег>
// Предусловие: стек запущен с SEED_DEMO=true; образ cc/router:<тег> собран.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const [newTag = 'next'] = process.argv.slice(2);
const BASE = process.env.BASE_URL ?? 'https://localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, { token, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          origin: BASE,
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

const password = process.env.DEMO_PASSWORD ?? 'Demo12345!';
const ops = await Promise.all(
  ['operator1@demo.local', 'operator2@demo.local', 'operator3@demo.local'].map(async (email) => {
    const login = await req('POST', '/api/v1/auth/login', { body: { email, password } });
    const token = login.body.accessToken;
    await req('POST', '/api/v1/agent-status', { token, body: { status: 'ready' } });
    return token;
  }),
);
const adminLogin = await req('POST', '/api/v1/auth/login', {
  body: { email: 'admin@cc.local', password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'Admin12345!' },
});
const adminToken = adminLogin.body.accessToken;
// Ёмкость операторов — не тема этого теста (её покрывают интеграционные тесты router), снимаем как фактор
// в пределах допустимого настройкой максимума (org.controller.ts: operator.max_chats ≤ 20).
const capacity = await req('PATCH', '/api/v1/settings', {
  token: adminToken,
  body: { 'operator.max_chats': 20 },
});
if (capacity.status !== 200)
  throw new Error(`не удалось поднять ёмкость операторов: ${JSON.stringify(capacity.body)}`);

// Клиентский API ограничивает частоту создания сессий одним IP — 10 за 60 с (M-CH-03, client.controller.ts).
// Заводим заведомо меньше и раньше времени, чтобы сам rollout не зависел от гонки с этим лимитом.
const CONVERSATIONS = 8;
async function makeConversation(i) {
  const session = await req('POST', '/api/v1/client/session', {
    body: {
      publicKey: 'demo-webchat',
      consentAccepted: true,
      consentVersion: '1',
      name: `Rollout-router ${i}`,
    },
  });
  if (session.status !== 200)
    throw new Error(`не удалось создать сессию клиента: ${session.status} ${JSON.stringify(session.body)}`);
  const sent = await req('POST', '/api/v1/client/messages', {
    token: session.body.token,
    body: { clientMessageId: randomUUID(), body: `вопрос ${i}` },
  });
  if (sent.status !== 202)
    throw new Error(`не удалось отправить сообщение клиента: ${sent.status} ${JSON.stringify(sent.body)}`);
  return session.body.contactId;
}

const contactIds = [];
for (let i = 0; i < CONVERSATIONS; i++) {
  contactIds.push(await makeConversation(i));
  await sleep(500);
}

// Часть обращений router уже успевает предложить оператору ДО начала обновления — проверяем,
// что переживают замену экземпляров и уже назначенные (offered/active), и ещё дожидающиеся (queued).
await sleep(2000);
const before = await req('GET', '/api/v1/conversations?tab=active', { token: adminToken });
const conversationIds = contactIds.map((cid) => before.body?.find?.((c) => c.contactId === cid)?.id);
if (conversationIds.some((x) => !x)) {
  throw new Error(
    `не все ${CONVERSATIONS} обращений появились до начала обновления: ${JSON.stringify(conversationIds)}`,
  );
}

const rolloutCode = await new Promise((resolve) => {
  const p = spawn('ops/rollout.sh', ['router'], {
    stdio: 'inherit',
    env: { ...process.env, ROUTER_TAG: newTag },
  });
  p.on('exit', resolve);
});

// После обновления даём router несколько секунд разобрать всё, что ещё не назначено.
let stuck = [...conversationIds];
for (let a = 0; a < 25 && stuck.length; a++) {
  await sleep(1000);
  const statuses = await Promise.all(
    stuck.map((id) => req('GET', `/api/v1/conversations/${id}`, { token: ops[0] })),
  );
  stuck = stuck.filter((_, i) => statuses[i].body?.status === 'queued');
}

const summary = { rolloutExitCode: rolloutCode, created: conversationIds.length, stillQueued: stuck.length };
console.log(JSON.stringify(summary, null, 2));
const ok = rolloutCode === 0 && summary.stillQueued === 0;
console.log(
  ok ? 'РЕЗУЛЬТАТ: ОК — обращения распределены без потерь во время обновления router' : 'РЕЗУЛЬТАТ: ПРОВАЛ',
);
process.exit(ok ? 0 : 1);
