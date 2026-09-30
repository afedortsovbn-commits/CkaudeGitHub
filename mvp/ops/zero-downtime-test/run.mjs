// Автотест «обновление под нагрузкой» (02-архитектура 6.8, M-UPD-06, DoD Ф11).
// Нагрузка не ниже M-NFR-05: 10 операторов в браузерах (Playwright, софтфон зарегистрирован), 30 одновременных
// вызовов (SIPp через Kamailio), 100 одновременных чатов (виджет + мок Telegram). Во время нагрузки выполняется
// выпуск версии N+1 — ops/release.sh <тег> (миграции, поэтапная замена всех прикладных сервисов, app.version)
// и обновление медиа осушением (Asterisk ×2, coturn ×2).
// Критерии: 0 оборванных разговоров (SIPp + журнал вызовов), 0 потерянных/дублированных сообщений (сверка
// отправленных и сохранённых), 0 разлогиненных операторов, p99 доставки сообщения оператору < 5 с.
//
// Использование: node ops/zero-downtime-test/run.mjs <тег N+1>
// Переменные: OPERATORS (10), CALLS (30), CALL_S (90), CHATS_WIDGET (20), CHATS_TG (80), MSG_EVERY_S (6),
//   MEDIA_TAG (обновить медиа до этого тега; пусто — без медиа), MEDIA_NODES («asterisk-1 asterisk-2 coturn-1
//   coturn-2»), REPORT (out/zero-downtime-report.json).
// Предусловие: стек версии N запущен с SEED_DEMO=true и профилем test (мок Telegram); образы N+1 собраны
// (для проверки миграции под нагрузкой — с EXTRA_MIGRATIONS_DIR=ops/zero-downtime-test/probe).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connect } from 'nats';
import {
  ADMIN,
  apiLogin,
  BASE,
  browserOperator,
  dbPool,
  launchBrowser,
  MVP,
  req,
  setStatus,
  sh,
  sipp,
  sippResult,
  sleep,
} from '../test/lib/stack.mjs';

const NEW_TAG = process.argv[2];
if (!NEW_TAG) {
  console.error('укажите тег версии N+1: node ops/zero-downtime-test/run.mjs <тег>');
  process.exit(2);
}
const N_OPERATORS = Number(process.env.OPERATORS ?? 10);
const N_CALLS = Number(process.env.CALLS ?? 30);
const CALL_S = Number(process.env.CALL_S ?? 90);
const N_WIDGET = Number(process.env.CHATS_WIDGET ?? 20);
const N_TG = Number(process.env.CHATS_TG ?? 80);
const MSG_EVERY_S = Number(process.env.MSG_EVERY_S ?? 6);
const MEDIA_TAG = process.env.MEDIA_TAG ?? '';
const MEDIA_NODES = process.env.MEDIA_NODES ?? 'asterisk-1 asterisk-2 coturn-1 coturn-2';
const REPORT = process.env.REPORT ?? join(MVP, 'out/zero-downtime-report.json');
// RELEASE=0 — та же нагрузка без выпуска (базовая линия для сравнения задержек).
const DO_RELEASE = process.env.RELEASE !== '0';
const MOCK_TG = process.env.MOCK_TELEGRAM_URL ?? 'http://127.0.0.1:8081';
const stamp = Date.now().toString(36);
const t0 = Date.now();
const log = (m) => console.log(`[zdt ${new Date().toISOString().slice(11, 19)}] ${m}`);
const db = dbPool();
/** Строки результата как массивы значений (для сверки с БД). */
const q = async (sql) => (await db.query({ text: sql, rowMode: 'array' })).rows;

// ---------------------------------------------------------------- подготовка
log(`подготовка: ${N_OPERATORS} операторов, ${N_CALLS} вызовов по ${CALL_S} с, ${N_WIDGET + N_TG} чатов`);
for (const n of ['zdt-calls']) sh('docker', ['rm', '-f', n], { stdio: 'ignore' });
const admin = await apiLogin(ADMIN.email, ADMIN.password);
const OP_PASSWORD = 'Zdt-operator-12345';
const operators = [];
for (let i = 1; i <= N_OPERATORS; i++) {
  const email = `zdt-op${String(i).padStart(2, '0')}@zdt.local`;
  const r = await req('POST', '/api/v1/users', {
    token: admin,
    body: { fullName: `Оператор нагрузки ${i}`, email, password: OP_PASSWORD, roles: ['operator'] },
  });
  if (r.status >= 300 && r.status !== 409 && !/существует|exists|unique/i.test(JSON.stringify(r.body))) {
    throw new Error(`сотрудник ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  operators.push(email);
}
// Все операторы — «Офлайн»: обращения и вызовы ждут в очередях (клиенты слышат музыку — установленные
// разговоры на узлах Asterisk), операторы остаются в системе с зарегистрированными софтфонами.
for (const email of ['operator1@demo.local', 'operator2@demo.local', 'operator3@demo.local']) {
  await setStatus(await apiLogin(email), 'offline');
}
for (const email of operators) await setStatus(await apiLogin(email, OP_PASSWORD), 'offline');

const queueId = (await req('GET', '/api/v1/dict/queues', { token: admin })).body.find(
  (q) => q.name === 'Общая',
).id;
const tgToken = `zdt${stamp}:zdt-token`;
const tgChannel = await req('POST', '/api/v1/dict/channels', {
  token: admin,
  body: {
    kind: 'telegram',
    name: `ZDT Telegram ${stamp}`,
    queueId,
    config: { bot_token: tgToken, mode: 'polling', api_root: 'http://mock-telegram:3000' },
  },
});
if (tgChannel.status !== 201) throw new Error(`канал Telegram: ${JSON.stringify(tgChannel.body)}`);
for (let i = 0; ; i++) {
  const s = (await req('GET', `/api/v1/channels/${tgChannel.body.id}/log`, { token: admin })).body;
  if (s.status === 'connected') break;
  if (i > 60) throw new Error(`канал Telegram не подключился: ${JSON.stringify(s)}`);
  await sleep(1000);
}

// ---------------------------------------------------------------- операторы в браузерах
const browser = await launchBrowser();
const pages = [];
for (let i = 0; i < operators.length; i += 5) {
  pages.push(
    ...(await Promise.all(operators.slice(i, i + 5).map((e) => browserOperator(browser, e, OP_PASSWORD)))),
  );
}
// Метка в окне: если вкладка перезагрузится (автообновление до новой версии вне звонка), метка исчезнет.
for (const p of pages) await p.evaluate(() => (globalThis.__zdt = 1));
log(`операторы в системе: ${pages.length}, софтфоны зарегистрированы`);

// ---------------------------------------------------------------- приём сообщений «у оператора»
// Канал realtime оператора (как у рабочего места): время доставки каждого сообщения клиента.
const monitorToken = await apiLogin(operators[0], OP_PASSWORD);
const sentAt = new Map(); // текст → момент отправки (мс)
const deliveredAt = new Map(); // текст → момент получения оператором
let wsDown = null;
let wsMaxGapMs = 0;
let wsReconnects = 0;
const convIds = new Set();
let resynced = 0;
/**
 * После переподключения рабочее место перечитывает данные по REST (источник истины — БД): пропущенное за время
 * разрыва сообщение «доставлено» в момент догрузки.
 */
async function resync() {
  const q = await req('GET', '/api/v1/conversations?tab=queue', { token: monitorToken });
  for (const c of Array.isArray(q.body) ? q.body : []) convIds.add(c.id);
  for (const id of convIds) {
    const r = await req('GET', `/api/v1/conversations/${id}/messages`, { token: monitorToken });
    for (const m of Array.isArray(r.body) ? r.body : []) {
      if (m.direction === 'in' && sentAt.has(m.body) && !deliveredAt.has(m.body)) {
        deliveredAt.set(m.body, Date.now());
        resynced++;
      }
    }
  }
}
function monitor() {
  let ws;
  let stopped = false;
  const open = () => {
    ws = new WebSocket(`${BASE.replace('https', 'wss')}/ws?token=${monitorToken}`, {
      headers: { origin: BASE },
    });
    ws.onopen = () => {
      if (wsDown !== null) {
        wsMaxGapMs = Math.max(wsMaxGapMs, Date.now() - wsDown);
        wsReconnects++;
        wsDown = null;
        void resync().catch(() => undefined);
      }
    };
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      const m = d.data?.message;
      if (d.data?.conversationId) convIds.add(d.data.conversationId);
      if (d.type === 'event' && m?.direction === 'in' && sentAt.has(m.body) && !deliveredAt.has(m.body)) {
        deliveredAt.set(m.body, Date.now());
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      wsDown ??= Date.now();
      setTimeout(open, 300);
    };
  };
  open();
  return () => ((stopped = true), ws.close());
}
const stopMonitor = monitor();

// ---------------------------------------------------------------- чаты: виджет и Telegram
const widgetClients = [];
for (let i = 0; i < N_WIDGET; i++) {
  for (let attempt = 0; ; attempt++) {
    const s = await req('POST', '/api/v1/client/session', {
      body: {
        publicKey: 'demo-webchat',
        consentAccepted: true,
        consentVersion: '1',
        name: `ZDT ${stamp} ${i}`,
      },
    });
    if (s.status === 200 || s.status === 201) {
      widgetClients.push(s.body.token);
      break;
    }
    if (s.status !== 429 || attempt > 30)
      throw new Error(`сессия виджета: ${s.status} ${JSON.stringify(s.body)}`);
    await sleep(3000); // ограничение частоты создания сессий с одного адреса
  }
}
log(`чаты: виджет ${widgetClients.length}, Telegram ${N_TG}`);

let chatsRunning = true;
const sendErrors = [];
// Чаты стартуют вразнобой в пределах одного интервала — как живые клиенты, а не одновременным залпом.
const stagger = () => sleep(Math.random() * MSG_EVERY_S * 1000);
async function widgetLoop(token, i) {
  await stagger();
  for (let n = 0; chatsRunning; n++) {
    const text = `zdt ${stamp} w${i} #${n}`;
    const id = randomUUID();
    sentAt.set(text, Date.now());
    for (let a = 0; ; a++) {
      const r = await req('POST', '/api/v1/client/messages', {
        token,
        body: { clientMessageId: id, body: text },
      });
      if (r.status === 202) break;
      if (a > 20) {
        sendErrors.push(`виджет ${text}: ${r.status}`);
        break;
      }
      await sleep(500); // повтор с тем же clientMessageId безопасен
    }
    await sleep(MSG_EVERY_S * 1000 * (0.7 + Math.random() * 0.6));
  }
}
async function tgLoop(i) {
  const chatId = 700000 + i;
  await stagger();
  for (let n = 0; chatsRunning; n++) {
    const text = `zdt ${stamp} t${i} #${n}`;
    sentAt.set(text, Date.now());
    for (let a = 0; ; a++) {
      try {
        const r = await fetch(`${MOCK_TG}/__test/${tgToken}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, text, firstName: `ZDT ${i}` }),
        });
        if (r.ok) break;
        throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        if (a > 10) {
          sendErrors.push(`telegram ${text}: ${e}`);
          break;
        }
        await sleep(500);
      }
    }
    await sleep(MSG_EVERY_S * 1000 * (0.7 + Math.random() * 0.6));
  }
}
const chatLoops = [
  ...widgetClients.map((t, i) => widgetLoop(t, i)),
  ...Array.from({ length: N_TG }, (_, i) => tgLoop(i)),
];

// ---------------------------------------------------------------- вызовы
// SIPp держит N_CALLS одновременных разговоров (-l), новый вызов — по мере завершения старых (1 в секунду).
const callsName = sipp('zdt-calls', 'uac-call.xml', [
  '-r',
  '1',
  '-l',
  String(N_CALLS),
  '-d',
  String(CALL_S * 1000),
  '-m',
  '100000',
  '-timeout_error',
]);
const callsFrom = new Date().toISOString();
log(`вызовы: разгон до ${N_CALLS} одновременных`);
await sleep((N_CALLS + 10) * 1000);
const liveCalls = async () =>
  Number(
    (await q(`SELECT count(*) FROM call WHERE state <> 'ended' AND started_at >= '${callsFrom}'`))[0][0],
  );
log(`идёт вызовов: ${await liveCalls()}, отправлено сообщений: ${sentAt.size}`);

// ---------------------------------------------------------------- очереди во времени
// Хвост входящих (CC_INBOUND, потребитель worker) и неотправленный outbox — где копится задержка.
const nc = await connect({ servers: process.env.NATS_URL ?? '127.0.0.1:4222' }).catch(() => null);
const timeline = [];
let sampling = true;
const sampler = (async () => {
  const jsm = nc ? await nc.jetstreamManager() : null;
  while (sampling) {
    let inboundPending = null;
    try {
      const ci = await jsm?.consumers.info('CC_INBOUND', 'worker-inbound');
      inboundPending = ci ? ci.num_pending + ci.num_ack_pending : null;
    } catch {
      /* узел NATS перезапускается */
    }
    let outbox = null;
    try {
      outbox = Number((await q('SELECT count(*) FROM outbox WHERE published_at IS NULL'))[0][0]);
    } catch {
      /* PostgreSQL недоступен — пропуск отсчёта */
    }
    const now = Date.now();
    const recent = [...sentAt.entries()].filter(
      ([t]) => deliveredAt.has(t) && deliveredAt.get(t) > now - 10_000,
    );
    const lat = recent.map(([t, s]) => deliveredAt.get(t) - s).sort((a, b) => a - b);
    timeline.push({
      s: Math.round((now - t0) / 1000),
      inboundPending,
      outbox,
      delivered10s: lat.length,
      p50: lat[Math.floor(lat.length / 2)] ?? null,
      max: lat.at(-1) ?? null,
    });
    await sleep(5000);
  }
})();

// Выпуск — в установившемся режиме: первые сообщения 100 новых чатов (создание обращений, автоответы) и старт
// вызовов дают разовый всплеск; ждём, пока хвост входящих не станет небольшим (не дольше 90 с).
for (let i = 0; i < 45; i++) {
  const last = timeline.at(-1);
  if (
    last &&
    last.inboundPending !== null &&
    last.inboundPending < 10 &&
    last.p50 !== null &&
    last.p50 < 2000
  )
    break;
  await sleep(2000);
}

// ---------------------------------------------------------------- выпуск N+1 под нагрузкой
const run = (cmd, args, env) =>
  new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(cmd, args, { cwd: MVP, stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('exit', (code) => resolve({ code, ms: Date.now() - started }));
  });
const releaseStart = Date.now();
log(`выпуск ${NEW_TAG}: ops/release.sh${MEDIA_TAG ? ` + медиа ${MEDIA_TAG} (${MEDIA_NODES})` : ''}`);
const release = DO_RELEASE
  ? await run('ops/release.sh', [NEW_TAG], {
      PERSIST_TAGS: '0',
      REPORT_DIR: join(MVP, 'out/releases'),
      ...(MEDIA_TAG ? { MEDIA_TAG, MEDIA_NODES, MAX_DRAIN: String(CALL_S * 3), DRAIN_DECISION: 'exit' } : {}),
    })
  : (await sleep(Number(process.env.BASELINE_S ?? 120) * 1000), { code: 0, ms: 0, skipped: true });
const releaseEnd = Date.now();
log(
  `выпуск завершён: код ${release.code} за ${Math.round(release.ms / 1000)} с; идёт вызовов: ${await liveCalls()}`,
);

// Нагрузка ещё немного после обновления, затем остановка: новые вызовы не начинаются, идущие доживают.
await sleep(20_000);
chatsRunning = false;
await Promise.all(chatLoops);
sh('docker', ['kill', '-s', 'SIGUSR1', callsName], { stdio: 'ignore' });
log('нагрузка остановлена, ждём завершения вызовов и обработки хвоста сообщений');
const calls = sippResult(callsName);
await sleep(8000);
sampling = false;
await sampler;
await nc?.close();

/** Ошибки SIPp по видам с первым и последним временем (что именно не так с неудачными вызовами). */
function sippErrorSummary(text) {
  const kinds = new Map();
  for (const m of text.matchAll(/(\d{2}:\d{2}:\d{2})\.\d+\t[\d.]+: ([^\n]*)/g)) {
    const kind = m[2]
      .replace(/Call-Id '[^']*'/, "Call-Id '…'")
      .replace(/received '([A-Z]+|SIP\/2\.0 \d+)[\s\S]*/, "received '$1…'")
      .slice(0, 160);
    const k = kinds.get(kind) ?? { count: 0, first: m[1], last: m[1] };
    k.count++;
    k.last = m[1];
    kinds.set(kind, k);
  }
  return Object.fromEntries(kinds);
}

// ---------------------------------------------------------------- проверки
// Сообщения: всё отправленное сохранено ровно один раз (источник истины — БД).
const stored = new Map();
for (const [body, n] of await q(
  `SELECT body, count(*) FROM message WHERE body LIKE 'zdt ${stamp} %' GROUP BY body`,
)) {
  stored.set(body, Number(n));
}
const lost = [...sentAt.keys()].filter((t) => !stored.has(t));
const dupes = [...stored.entries()].filter(([, n]) => n > 1).map(([t]) => t);
// Доставка оператору: событие realtime или догрузка по REST после переподключения. Не дошедшее ни так,
// ни так считается доставленным в конце теста (заведомо хуже порога — провал p99).
await resync().catch(() => undefined);
const latencies = [...sentAt.entries()]
  .map(([t, s]) => (deliveredAt.get(t) ?? Date.now()) - s)
  .sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] ?? 0;
// Критерий 02 (6.8) — доставка во время обновления: сообщения, отправленные от начала выпуска до 20 с после.
const duringRelease = [...sentAt.entries()]
  .filter(([, s]) => s >= releaseStart && s <= releaseEnd + 20_000)
  .map(([t, s]) => (deliveredAt.get(t) ?? Date.now()) - s)
  .sort((a, b) => a - b);
const p99Release =
  duringRelease[Math.min(duringRelease.length - 1, Math.floor(duringRelease.length * 0.99))] ?? 0;
const notRealtime = [...sentAt.keys()].filter((t) => !deliveredAt.has(t)).length + resynced;

// Вызовы: журнал (CDR) — все вызовы теста завершены клиентом, ни один не оборван системой.
const cdr = await q(
  `SELECT coalesce(end_reason, state), count(*) FROM call WHERE started_at >= '${callsFrom}'
     AND from_number LIKE '+37529%' GROUP BY 1 ORDER BY 1`,
);
const cdrBad = cdr.filter(([r]) => r !== 'client_hangup').reduce((s, [, n]) => s + Number(n), 0);

// Операторы: все в системе (не выброшены на вход), софтфоны зарегистрированы.
const ops = [];
for (const [i, p] of pages.entries()) {
  const loggedIn = await p
    .getByTestId('current-user')
    .isVisible()
    .catch(() => false);
  const onLogin = await p
    .getByRole('button', { name: 'Войти' })
    .isVisible()
    .catch(() => false);
  let registered = false;
  try {
    await p.getByTestId('softphone-status').filter({ hasText: 'Телефон готов' }).waitFor({ timeout: 30_000 });
    registered = true;
  } catch {
    /* не зарегистрирован */
  }
  const reloaded = await p.evaluate(() => globalThis.__zdt !== 1).catch(() => null);
  ops.push({
    operator: operators[i],
    loggedIn: loggedIn && !onLogin,
    registered,
    reloadedToNewVersion: reloaded,
  });
}
const loggedOut = ops.filter((o) => !o.loggedIn).length;
const unregistered = ops.filter((o) => !o.registered).length;
stopMonitor();
await browser.close();
await db.end();

const summary = {
  newTag: NEW_TAG,
  mediaTag: MEDIA_TAG || null,
  durationS: Math.round((Date.now() - t0) / 1000),
  release: { exitCode: release.code, seconds: Math.round(release.ms / 1000), skipped: !DO_RELEASE },
  load: { operators: pages.length, concurrentCalls: N_CALLS, chats: widgetClients.length + N_TG },
  calls: {
    sipp: { successful: calls.successful, failed: calls.failed, errors: sippErrorSummary(calls.errors) },
    cdr: Object.fromEntries(cdr.map(([r, n]) => [r, Number(n)])),
    droppedBySystem: cdrBad,
  },
  messages: {
    sent: sentAt.size,
    stored: stored.size,
    lost: lost.length,
    duplicated: dupes.length,
    sendErrors: sendErrors.length,
    deliveryMs: { p50: pct(50), p95: pct(95), p99: pct(99), max: latencies.at(-1) ?? 0 },
    duringRelease: { count: duringRelease.length, p99: p99Release },
    notSeenInRealtime: notRealtime,
    resyncedAfterReconnect: resynced,
    ws: { reconnects: wsReconnects, maxGapMs: wsMaxGapMs },
  },
  operators: {
    loggedOut,
    unregistered,
    reloadedToNewVersion: ops.filter((o) => o.reloadedToNewVersion).length,
  },
  examples: { lost: lost.slice(0, 5), duplicated: dupes.slice(0, 5), sendErrors: sendErrors.slice(0, 5) },
  timeline,
};
const checks = {
  'выпуск без ошибок': release.code === 0,
  '0 оборванных разговоров (SIPp)': calls.failed === 0 && calls.successful > 0,
  '0 оборванных разговоров (журнал вызовов)': cdrBad === 0,
  '0 потерянных сообщений': lost.length === 0 && sendErrors.length === 0,
  '0 дублированных сообщений': dupes.length === 0,
  '0 разлогиненных операторов': loggedOut === 0 && unregistered === 0,
  'p99 доставки оператору во время обновления < 5 с': duringRelease.length > 0 && p99Release < 5000,
};
summary.checks = checks;
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
const ok = Object.values(checks).every(Boolean);
for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`);
console.log(ok ? 'РЕЗУЛЬТАТ: ОК — обновление под нагрузкой без простоя' : 'РЕЗУЛЬТАТ: ПРОВАЛ');
process.exit(ok ? 0 : 1);
