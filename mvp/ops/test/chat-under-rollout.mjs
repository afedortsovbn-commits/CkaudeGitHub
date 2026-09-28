// Переписка клиент ↔ оператор во время поэтапного обновления api, worker и realtime (DoD Ф2, M-UPD-01):
// ни одно сообщение не теряется и не дублируется; WebSocket переподключается, пропущенное догружается по REST.
// Использование: node ops/test/chat-under-rollout.mjs <новый_тег> [секунд]
// Предусловие: стек запущен с SEED_DEMO=true; образы cc/{api,worker,realtime}:<тег> собраны.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const [newTag = 'next', seconds = '60'] = process.argv.slice(2);
const BASE = process.env.BASE_URL ?? 'https://localhost';
const ORIGIN = BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, { token, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          origin: ORIGIN,
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

/** WebSocket с переподключением и догрузкой пропущенного через onReconnect. */
function socket(url, onMessage, onReconnect) {
  let ws;
  let stopped = false;
  let reconnects = 0;
  const open = () => {
    ws = new WebSocket(url, { headers: { origin: ORIGIN } });
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onopen = () => reconnects > 0 && onReconnect();
    ws.onclose = () => {
      if (stopped) return;
      reconnects++;
      setTimeout(open, 300);
    };
  };
  open();
  return { stop: () => ((stopped = true), ws.close()), reconnects: () => reconnects };
}

const login = await req('POST', '/api/v1/auth/login', {
  body: { email: 'operator1@demo.local', password: process.env.DEMO_PASSWORD ?? 'Demo12345!' },
});
const opToken = login.body.accessToken;
const session = await req('POST', '/api/v1/client/session', {
  body: { publicKey: 'demo-webchat', consentAccepted: true, consentVersion: '1', name: 'Тест обновления' },
});
const clientToken = session.body.token;

const clientSent = new Set();
const opSent = [];
const opSeen = new Set(); // клиентские сообщения, увиденные оператором (clientMessageId)
const clientSeen = new Set(); // ответы оператора, увиденные клиентом (id)

async function sendClient(i) {
  const id = randomUUID();
  clientSent.add(id);
  for (;;) {
    const r = await req('POST', '/api/v1/client/messages', {
      token: clientToken,
      body: { clientMessageId: id, body: `клиент ${i}` },
    });
    if (r.status === 202) return;
    await sleep(300); // повтор с тем же id безопасен
  }
}

await sendClient(0);
let conversationId;
for (let i = 0; i < 50 && !conversationId; i++) {
  await sleep(200);
  const q = await req('GET', '/api/v1/conversations?tab=queue', { token: opToken });
  conversationId = q.body.find((c) => c.contactId === session.body.contactId)?.id;
}
if (!conversationId) throw new Error('обращение не появилось в очереди');
await req('POST', `/api/v1/conversations/${conversationId}/take`, { token: opToken });

const opSync = async () => {
  const r = await req('GET', `/api/v1/conversations/${conversationId}/messages`, { token: opToken });
  for (const m of r.body) if (m.direction === 'in' && m.externalId) opSeen.add(m.externalId);
};
const clientSync = async () => {
  const r = await req('GET', '/api/v1/client/messages', { token: clientToken });
  for (const m of r.body) if (m.direction === 'out') clientSeen.add(m.id);
};
const opWs = socket(
  `${BASE.replace('https', 'wss')}/ws?token=${opToken}`,
  (d) => {
    const m = d.data?.message;
    if (d.type === 'event' && m?.direction === 'in' && m.externalId) opSeen.add(m.externalId);
  },
  opSync,
);
const clWs = socket(
  `${BASE.replace('https', 'wss')}/ws?client=${clientToken}`,
  (d) => {
    if (d.type === 'message' && d.message.direction === 'out') clientSeen.add(d.message.id);
  },
  clientSync,
);

let running = true;
const clientLoop = (async () => {
  for (let i = 1; running; i++) {
    await sendClient(i);
    await sleep(100);
  }
})();
const opLoop = (async () => {
  for (let i = 1; running; i++) {
    const r = await req('POST', `/api/v1/conversations/${conversationId}/messages`, {
      token: opToken,
      body: { body: `оператор ${i}` },
    });
    if (r.status === 201 || r.status === 200) opSent.push(r.body.id);
    await sleep(300);
  }
})();

const run = (svc) =>
  new Promise((resolve) => {
    const tagVar = { api: 'API_TAG', worker: 'WORKER_TAG', realtime: 'REALTIME_TAG' }[svc];
    const p = spawn('ops/rollout.sh', [svc], { stdio: 'inherit', env: { ...process.env, [tagVar]: newTag } });
    p.on('exit', resolve);
  });

const started = Date.now();
await sleep(3000);
const codes = [];
for (const svc of ['worker', 'realtime', 'api']) codes.push(await run(svc));
while (Date.now() - started < Number(seconds) * 1000) await sleep(500);
running = false;
await Promise.all([clientLoop, opLoop]);
await sleep(4000); // дать worker обработать хвост очереди
await opSync();
await clientSync();

const db = await req('GET', `/api/v1/conversations/${conversationId}/messages`, { token: opToken });
const inbound = db.body.filter((m) => m.direction === 'in');
const ext = inbound.map((m) => m.externalId);
const dupes = ext.length - new Set(ext).size;
const lostClient = [...clientSent].filter((id) => !ext.includes(id));
const outIds = new Set(db.body.filter((m) => m.direction === 'out').map((m) => m.id));
const lostOp = opSent.filter((id) => !outIds.has(id));
const unseenByOp = [...clientSent].filter((id) => !opSeen.has(id));
const unseenByClient = opSent.filter((id) => !clientSeen.has(id));
opWs.stop();
clWs.stop();

const summary = {
  rolloutExitCodes: codes,
  clientSent: clientSent.size,
  operatorSent: opSent.length,
  duplicates: dupes,
  lostClientMessages: lostClient.length,
  lostOperatorMessages: lostOp.length,
  notDeliveredToOperator: unseenByOp.length,
  notDeliveredToClient: unseenByClient.length,
  wsReconnects: { operator: opWs.reconnects(), client: clWs.reconnects() },
};
console.log(JSON.stringify(summary, null, 2));
const ok =
  codes.every((c) => c === 0) &&
  !dupes &&
  !lostClient.length &&
  !lostOp.length &&
  !unseenByOp.length &&
  !unseenByClient.length;
console.log(ok ? 'РЕЗУЛЬТАТ: ОК — переписка во время обновления без потерь и дублей' : 'РЕЗУЛЬТАТ: ПРОВАЛ');
process.exit(ok ? 0 : 1);
