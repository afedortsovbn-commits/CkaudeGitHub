// Смена активного call-control во время суфлирования (DoD Ф14, 02-архитектура 6.3): клиент (SIPp) разговаривает с
// оператором (браузер), супервизор (браузер) суфлирует; активный экземпляр call-control узла останавливается.
// Подключение супервизора эфемерно (как прослушивание): оно завершается, отметка в вызове снимается, плашка у
// оператора исчезает — а разговор клиента с оператором продолжается и затем корректно завершается оператором.
// Использование: node ops/test/supervisor-under-switch.mjs [graceful|kill]
// Предусловие: стек с SEED_DEMO=true (номер 1000, operator1@demo.local, администратор с правами супервизора).
import { spawnSync } from 'node:child_process';
import {
  ADMIN,
  apiLogin,
  browserOperator,
  dbPool,
  dc,
  launchBrowser,
  req,
  setStatus,
  sh,
  sipp,
  sippResult,
  sleep,
  talkScenario,
} from './lib/stack.mjs';

const mode = process.argv[2] === 'kill' ? 'kill' : 'graceful';
const pool = dbPool();
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const fail = (msg, extra = {}) => {
  console.error(`ПРОВАЛ: ${msg}`, extra);
  process.exitCode = 1;
};

sh('docker', ['rm', '-f', 'svswitch'], { stdio: 'ignore' });
for (const node of ['asterisk-1', 'asterisk-2'])
  dc('exec', '-T', node, 'asterisk', '-rx', 'channel request hangup all');
await sleep(2000);
for (const email of ['operator1@demo.local', 'operator2@demo.local', 'operator3@demo.local'])
  await setStatus(await apiLogin(email), 'offline');

const browser = await launchBrowser();
const op = await browserOperator(browser, 'operator1@demo.local');
const sup = await browserOperator(browser, ADMIN.email, ADMIN.password);
const supToken = await apiLogin(ADMIN.email, ADMIN.password);
const since = new Date().toISOString();
await op.getByTestId('agent-status').getByText('Готов').click();

// Клиент ждёт, пока трубку положит оператор (BYE от КЦ — успех, обрыв раньше — провал SIPp).
const name = sipp('svswitch', talkScenario(0), ['-m', '1']);
const call = op.getByTestId('softphone-call');
await call.and(op.locator('[data-state="ringing"]')).waitFor({ timeout: 30_000 });
await call.getByTestId('call-answer').click();
await call.and(op.locator('[data-state="active"]')).waitFor({ timeout: 15_000 });
await op.getByTestId('agent-status').getByText('Офлайн').click();
await sleep(3000);

const c = await one(
  `SELECT id, node FROM call WHERE state = 'talking' AND started_at >= $1 ORDER BY started_at DESC LIMIT 1`,
  [since],
);
if (!c) throw new Error('разговор не найден');
const r = await req('POST', `/api/v1/calls/${c.id}/listen`, { token: supToken, body: { mode: 'whisper' } });
if (r.status !== 200) throw new Error(`суфлирование: ${r.status} ${JSON.stringify(r.body)}`);
await sup
  .getByTestId('supervisor-controls')
  .and(sup.locator('[data-mode="whisper"]'))
  .waitFor({ timeout: 20_000 });
await op
  .getByTestId('supervisor-banner')
  .and(op.locator('[data-mode="whisper"]'))
  .waitFor({ timeout: 10_000 });
const before = await one(`SELECT supervisor_mode FROM call WHERE id = $1`, [c.id]);
console.log(
  `суфлирование идёт (вызов ${c.id.slice(0, 8)}, узел ${c.node}, режим в БД: ${before.supervisor_mode})`,
);

// Активный экземпляр узла — по журналам аренды (как в ivr-under-switch.mjs).
const containers = sh('docker', ['ps', '--filter', 'name=call-control', '--format', '{{.Names}}'])
  .trim()
  .split('\n');
const events = [];
for (const name of containers) {
  const l = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
  for (const line of (l.stdout + l.stderr).split('\n')) {
    if (!line.includes('call-control: активный для узла') && !line.includes('узел передан резервному'))
      continue;
    try {
      const j = JSON.parse(line);
      events.push({ at: Date.parse(j.time), node: j.node, name, active: j.msg.includes('активный') });
    } catch {
      /* не JSON */
    }
  }
}
const leaderOf = {};
for (const e of events.sort((a, b) => a.at - b.at)) {
  if (e.active) leaderOf[e.node] = e.name;
  else if (leaderOf[e.node] === e.name) delete leaderOf[e.node];
}
const target = leaderOf[c.node];
if (!target) throw new Error(`не удалось определить активный call-control узла ${c.node}`);
console.log(`${mode === 'kill' ? 'аварийная остановка (kill)' : 'штатная остановка'} ${target}`);
if (mode === 'kill') sh('docker', ['kill', '-s', 'KILL', target]);
else sh('docker', ['stop', '-t', '35', target]);
sh('docker', ['start', target]); // вернётся резервным

// После переключения: подключение супервизора снято (отметка и плашка), разговор продолжается.
const deadline = Date.now() + 30_000;
let after;
for (;;) {
  after = await one(`SELECT state, supervisor_mode, end_reason FROM call WHERE id = $1`, [c.id]);
  if (!after.supervisor_mode || Date.now() > deadline) break;
  await sleep(500);
}
await op
  .getByTestId('supervisor-banner')
  .waitFor({ state: 'detached', timeout: 15_000 })
  .catch(() => undefined);
await sleep(8000); // разговор продолжается и после сверки
const opState = await call.getAttribute('data-state').catch(() => null);
const banner = await op.getByTestId('supervisor-banner').count();
const supCall = await sup.getByTestId('supervisor-controls').count();
const now = await one(`SELECT state, supervisor_mode FROM call WHERE id = $1`, [c.id]);
const journal = await pool.query(`SELECT type, data FROM call_event WHERE call_id = $1 ORDER BY at`, [c.id]);
console.log(
  `после переключения: вызов ${now.state}, режим супервизора ${now.supervisor_mode ?? '—'}, у оператора ${opState}, ` +
    `плашка ${banner ? 'есть' : 'нет'}, панель супервизора ${supCall ? 'есть' : 'нет'}`,
);
await call.getByTestId('call-hangup').click();
const s = sippResult(name);
const ended = await one(`SELECT end_reason FROM call WHERE id = $1`, [c.id]);
await browser.close();
await pool.end();

if (now.state !== 'talking' || opState !== 'active')
  fail('разговор оператора с клиентом прервался', { now, opState });
if (now.supervisor_mode) fail('отметка подключения супервизора не снята после переключения', { now });
if (banner) fail('у оператора осталась плашка супервизора');
if (supCall) fail('у супервизора осталась панель подключения (ожидалось завершение)');
if (!journal.rows.some((e) => e.type === 'supervisor_left' && e.data?.reason === 'failover'))
  fail('в журнале вызова нет события «супервизор отключился» (failover)');
if (s.successful !== 1 || s.failed !== 0)
  fail('SIPp: вызов завершился с ошибкой', { sipp: s.errors?.slice(-2000) });
if (ended.end_reason !== 'agent_hangup') fail(`вызов завершён не оператором: ${ended.end_reason}`);
if (!process.exitCode)
  console.log(
    `OK: при ${mode === 'kill' ? 'аварийной' : 'штатной'} смене call-control суфлирование завершено, разговор продолжился и завершён оператором`,
  );
