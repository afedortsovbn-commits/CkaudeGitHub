// Перезапуск Kamailio (класс C, 02-архитектура 6.5) во время разговора оператора (браузер, WSS) с клиентом
// (SIPp, транк): разговор не обрывается, браузер переподключает WSS и перерегистрируется, после этого
// разговор завершается корректно в обе стороны — BYE доходит (DoD Ф11).
//   A) клиент кладёт трубку → BYE от узла Asterisk приходит в браузер по новому WSS-соединению;
//   B) оператор кладёт трубку → BYE из браузера доходит до клиента.
// Kamailio пересоздаётся (как при обновлении образа: ops/update-media.sh kamailio) — IP контейнера может смениться.
// Использование: node ops/test/kamailio-restart.mjs
// Предусловие: стек с SEED_DEMO=true (голосовой канал с номером 1000, operator1@demo.local).
import { spawnSync } from 'node:child_process';
import {
  apiLogin,
  browserOperator,
  dc,
  launchBrowser,
  MVP,
  setStatus,
  sh,
  sipp,
  sippResult,
  sleep,
  talkScenario,
  waitRegistered,
} from './lib/stack.mjs';

// Разные операторы: после сценария A у первого остаётся открытое обращение (голос занят до закрытия).
const OPERATORS = ['operator1@demo.local', 'operator2@demo.local'];
const results = [];

// Чистое начало: ни прежних SIPp этой проверки, ни вызовов на узлах (иначе оператор ответит на чужой вызов).
for (const n of ['krestart-a', 'krestart-b']) sh('docker', ['rm', '-f', n], { stdio: 'ignore' });
for (const node of ['asterisk-1', 'asterisk-2'])
  dc('exec', '-T', node, 'asterisk', '-rx', 'channel request hangup all');
await sleep(2000);

// Остальные операторы — «Офлайн»: вызов должен прийти именно в браузер этого оператора.
for (const email of ['operator1@demo.local', 'operator2@demo.local', 'operator3@demo.local']) {
  await setStatus(await apiLogin(email), 'offline');
}
const browser = await launchBrowser();
const pages = [];
for (const email of OPERATORS) pages.push(await browserOperator(browser, email));
let page = pages[0];
let call = page.getByTestId('softphone-call');

function restartKamailio() {
  const t0 = Date.now();
  const r = spawnSync('ops/update-media.sh', ['kamailio'], {
    cwd: MVP,
    stdio: 'inherit',
    env: { ...process.env, REPORT_FILE: '/dev/null' },
  });
  if (r.status !== 0) throw new Error('перезапуск Kamailio не удался');
  return Date.now() - t0;
}

async function answerIncoming() {
  await call.and(page.locator('[data-state="ringing"]')).waitFor({ timeout: 30_000 });
  await call.getByTestId('call-answer').click();
  await call.and(page.locator('[data-state="active"]')).waitFor({ timeout: 15_000 });
  // Идущий разговор: диалог подтверждён (ACK дошёл) и медиа установлено. Перезапуск в ту же секунду, что
  // и ответ, теряет ACK — JsSIP через 32 с (Timer H) завершит вызов; это не сценарий «идущего разговора».
  await sleep(5000);
}

async function ready(i) {
  page = pages[i];
  call = page.getByTestId('softphone-call');
  await page.getByTestId('agent-status').getByText('Готов').click();
}

async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    results.push({ name, ok: r.ok, ...r, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, error: String(e), ms: Date.now() - t0 });
  }
  // Между сценариями — снова «Офлайн».
  for (const email of OPERATORS) await setStatus(await apiLogin(email), 'offline').catch(() => undefined);
}

await ready(0);

await scenario('A: клиент кладёт трубку после перезапуска Kamailio', async () => {
  // Дольше 32 с (Timer H): потерянный ACK к браузеру оборвал бы разговор раньше BYE клиента.
  const TALK_S = 40;
  const name = sipp('krestart-a', talkScenario(TALK_S * 1000), ['-m', '1']);
  await answerIncoming();
  const windowMs = restartKamailio();
  await waitRegistered(page, 40_000);
  const stillActive = (await call.getAttribute('data-state')) === 'active';
  // SIPp кладёт трубку через TALK_S без запросов от КЦ — BYE идёт узлом Asterisk в браузер по новому WSS.
  let browserEndedAt = null;
  let sippDoneAt = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && (browserEndedAt === null || sippDoneAt === null)) {
    if (
      browserEndedAt === null &&
      ((await call.count()) === 0 || (await call.getAttribute('data-state')) === 'ended')
    ) {
      browserEndedAt = Date.now();
    }
    if (
      sippDoneAt === null &&
      sh('docker', ['inspect', '-f', '{{.State.Running}}', name]).trim() === 'false'
    ) {
      sippDoneAt = Date.now();
    }
    if (sippDoneAt !== null && Date.now() - sippDoneAt > 15_000) break;
    await sleep(250);
  }
  // Браузер должен закончить звонок по BYE клиента: не раньше (обрыв) и не позже 5 с.
  const lagMs = browserEndedAt !== null && sippDoneAt !== null ? browserEndedAt - sippDoneAt : null;
  const s = sippResult(name);
  return {
    ...(s.successful === 1 ? {} : { sippErrors: s.errors.slice(-3000) }),
    ok:
      stillActive && s.successful === 1 && s.failed === 0 && lagMs !== null && lagMs > -1000 && lagMs < 5000,
    kamailioWindowMs: windowMs,
    callActiveAfterRestart: stillActive,
    sipp: { successful: s.successful, failed: s.failed },
    browserEndedAfterClientByeMs: lagMs,
  };
});

await ready(1);

await scenario('B: оператор кладёт трубку после перезапуска Kamailio', async () => {
  const name = sipp('krestart-b', talkScenario(0), ['-m', '1']);
  await answerIncoming();
  const answeredAt = Date.now();
  const windowMs = restartKamailio();
  await waitRegistered(page, 40_000);
  // Разговор дольше 32 с (ACK к браузеру дошёл — иначе JsSIP сам завершил бы вызов), затем оператор кладёт трубку.
  await sleep(Math.max(2000, 40_000 - (Date.now() - answeredAt)));
  const stillActive = (await call.getAttribute('data-state')) === 'active';
  await call.getByTestId('call-hangup').click();
  const s = sippResult(name);
  return {
    ok: stillActive && s.successful === 1 && s.failed === 0,
    kamailioWindowMs: windowMs,
    callActiveAfterRestart: stillActive,
    sipp: { successful: s.successful, failed: s.failed },
    ...(s.successful === 1 ? {} : { sippErrors: s.errors.slice(-3000) }),
  };
});

await browser.close();
console.log(JSON.stringify(results, null, 2));
const ok = results.length === 2 && results.every((r) => r.ok);
console.log(
  ok
    ? 'РЕЗУЛЬТАТ: ОК — разговор пережил перезапуск Kamailio и корректно завершился в обе стороны'
    : 'РЕЗУЛЬТАТ: ПРОВАЛ',
);
process.exit(ok ? 0 : 1);
