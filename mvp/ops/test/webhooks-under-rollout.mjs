// Внешний канал и webhooks во время поэтапного обновления api и worker (Ф9, M-UPD-01, M-INT-02):
// сторонняя система шлёт сообщения по ключу API (POST /api/v1/ext/inbound), каждое становится сообщением
// обращения и приходит получателю webhook (message.created) — ровно один раз по id события, без потерь.
// Использование: node ops/test/webhooks-under-rollout.mjs <новый_тег> [секунд]
// Предусловие: стек с SEED_DEMO=true и профилем test (мок mock-selfservice на 127.0.0.1:8082);
// образы cc/{api,worker}:<тег> собраны.
import { spawn } from 'node:child_process';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const [newTag = 'next', seconds = '60'] = process.argv.slice(2);
const BASE = process.env.BASE_URL ?? 'https://localhost';
const MOCK = process.env.MOCK_SELFSERVICE_URL ?? 'http://127.0.0.1:8082';
const KEY = process.env.DEMO_FORM_API_KEY ?? 'cck_demo_form_key_change_me_0123456789abcd';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = `${Date.now()}`;

async function send(i) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const r = await fetch(`${BASE}/api/v1/ext/inbound`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          externalId: `rollout-${run}-${i}`,
          contact: { externalId: `rollout-client-${run}` },
          text: `rollout ${run} #${i}`,
        }),
      });
      if (r.status === 202) return true;
      if (r.status < 500) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    } catch (e) {
      if (String(e).includes('HTTP 4')) throw e;
    }
    // Повтор с тем же externalId безопасен: дубля не будет (так же поступит любая сторонняя система).
    await sleep(300 * (attempt + 1));
  }
  return false;
}

const rollout = (svc) =>
  new Promise((resolve) => {
    const tagVar = { api: 'API_TAG', worker: 'WORKER_TAG' }[svc];
    const p = spawn('ops/rollout.sh', [svc], { stdio: 'inherit', env: { ...process.env, [tagVar]: newTag } });
    p.on('exit', resolve);
  });

let running = true;
const sent = [];
const failed = [];
const loop = (async () => {
  for (let i = 0; running; i++) {
    if (await send(i)) sent.push(i);
    else failed.push(i);
    await sleep(200);
  }
})();

const started = Date.now();
await sleep(3000);
const codes = [];
for (const svc of ['worker', 'api']) codes.push(await rollout(svc));
while (Date.now() - started < Number(seconds) * 1000) await sleep(500);
running = false;
await loop;

// Ждём, пока доставка догонит (очередь webhook_delivery опустеет).
let got = [];
for (let t = 0; t < 60; t++) {
  const hits = await (await fetch(`${MOCK}/hooks/site-form`)).json();
  got = hits
    .map((h) => h.body)
    .filter(
      (b) =>
        b.type === 'message.created' && String(b.data?.message?.body ?? '').startsWith(`rollout ${run} #`),
    );
  if (got.length >= sent.length) break;
  await sleep(1000);
}
const ids = got.map((b) => b.id);
const nums = new Set(got.map((b) => Number(String(b.data.message.body).split('#')[1])));
const summary = {
  rolloutExitCodes: codes,
  sent: sent.length,
  sendFailures: failed.length,
  webhooksReceived: got.length,
  duplicateEvents: ids.length - new Set(ids).size,
  lost: sent.filter((i) => !nums.has(i)).length,
};
console.log(JSON.stringify(summary, null, 2));
const ok =
  codes.every((c) => c === 0) &&
  !failed.length &&
  summary.duplicateEvents === 0 &&
  summary.lost === 0 &&
  sent.length > 0;
process.exit(ok ? 0 : 1);
