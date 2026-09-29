// Сценарии IVR при смене активного call-control (DoD Ф6, 02-архитектура 6.3): SIPp-клиенты ходят по меню
// демо-сценария (номер 2000) нажатиями DTMF; в это время активный экземпляр call-control узла останавливается
// штатно (graceful: SIGTERM — аренда передаётся резервному) или аварийно (kill: резервный ждёт истечения
// аренды). Критерии: ни один вызов не оборван; сценарий каждого вызова продолжен новым активным
// (событие ivr_resumed), нажатия после переключения обработаны; пауза в IVR — штатно ≤ 3 с, аварийно ≤ 8 с.
// Использование: node ops/test/ivr-under-switch.mjs graceful|kill
// Предусловие: стек запущен с SEED_DEMO=true (демо-сценарий IVR на номере 2000), профиль test не нужен.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ivrScenario } from './sipp/ivr-scenario.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const mode = process.argv[2] === 'kill' ? 'kill' : 'graceful';
const LIMIT_MS = mode === 'kill' ? 8000 : 3000;
const CALLS = Number(process.env.CALLS ?? 6);
const BASE = process.env.BASE_URL ?? 'https://localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const sql = (q) =>
  sh('docker', [
    'exec',
    process.env.PG_CONTAINER ?? 'cc-postgres-1',
    'psql',
    '-U',
    'cc',
    '-d',
    'cc',
    '-At',
    '-F',
    '|',
    '-c',
    q,
  ]).trim();

async function login(email) {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD ?? 'Demo12345!' }),
  });
  return (await r.json()).accessToken;
}
// Операторы — «Офлайн»: из очереди звонки уйдут по сценарию в голосовое сообщение, в браузеры не пойдут.
for (const email of ['operator1@demo.local', 'operator2@demo.local', 'operator3@demo.local']) {
  const t = await login(email);
  await fetch(`${BASE}/api/v1/agent-status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'offline' }),
  });
}

// Клиент: после приветствия — «2» (топливные карты), затем переходы «1» (блокировка) / «*» (назад) каждые 5 с,
// в конце «0» — в очередь → нет операторов → голосовое сообщение → отбой клиента.
const steps = [[13000, '2']];
for (let i = 0; i < 7; i++) steps.push([5000, '1'], [5000, '*']);
steps.push([5000, '0']);
const dir = mkdtempSync(join(tmpdir(), 'ivr-switch-'));
writeFileSync(join(dir, 'ivr.xml'), ivrScenario(steps, 15000));
writeFileSync(
  join(dir, 'callers.csv'),
  `SEQUENTIAL\n${Array.from({ length: CALLS }, (_, i) => `+37529${String(7000000 + i)}`).join('\n')}\n`,
);
execFileSync('chmod', ['-R', 'a+rX', dir]);

const since = sql(`SELECT now()`);
const name = `sipp-ivr-${Date.now()}`;
sh('docker', [
  'run',
  '-d',
  '--name',
  name,
  '--network',
  'cc',
  '-v',
  `${dir}:/s:ro`,
  process.env.SIPP_IMAGE ?? 'ctaloi/sipp:latest',
  '-sf',
  '/s/ivr.xml',
  '-inf',
  '/s/callers.csv',
  'kamailio:5060',
  '-s',
  '2000',
  '-r',
  String(CALLS),
  '-m',
  String(CALLS),
  '-l',
  String(CALLS),
  '-timeout_error',
  '-nostdin',
]);
console.log(`SIPp: ${CALLS} клиентов в IVR (номер 2000), ~110 с каждый`);
await sleep(35_000);

// Активный экземпляр узла — тот, кто держит аренду; берём экземпляр, ведущий хотя бы один узел с вызовами.
const containers = sh('docker', ['ps', '--filter', 'name=call-control', '--format', '{{.Names}}'])
  .trim()
  .split('\n');
const events = [];
for (const c of containers) {
  const r = spawnSync('docker', ['logs', c], { encoding: 'utf8' });
  for (const line of (r.stdout + r.stderr).split('\n')) {
    if (!line.includes('call-control: активный для узла') && !line.includes('узел передан резервному'))
      continue;
    try {
      const j = JSON.parse(line);
      events.push({ at: Date.parse(j.time), node: j.node, c, active: j.msg.includes('активный') });
    } catch {
      /* не JSON */
    }
  }
}
const leaderOf = {};
for (const e of events.sort((a, b) => a.at - b.at)) {
  if (e.active) leaderOf[e.node] = e.c;
  else if (leaderOf[e.node] === e.c) delete leaderOf[e.node];
}
const nodesWithCalls = sql(
  `SELECT DISTINCT node FROM call WHERE did = '2000' AND state = 'ivr' AND started_at >= '${since}'`,
)
  .split('\n')
  .filter(Boolean);
const target = leaderOf[nodesWithCalls[0]];
if (!target) {
  console.error('не удалось определить активный call-control', { leaderOf, nodesWithCalls });
  process.exit(1);
}
const switched = Object.entries(leaderOf)
  .filter(([, c]) => c === target)
  .map(([n]) => n);
const t0 = Date.now();
console.log(
  `${mode === 'kill' ? 'аварийная остановка (kill)' : 'штатная остановка (SIGTERM)'} ${target} — активный для ${switched.join(', ')}`,
);
if (mode === 'kill') sh('docker', ['kill', '-s', 'KILL', target]);
else sh('docker', ['stop', '-t', '35', target]);
// Момент передачи узла: штатно — строка «узел передан резервному» в журнале остановленного; аварийно — kill.
let handover = t0;
if (mode === 'graceful') {
  const logs = spawnSync('docker', ['logs', '-t', '--since', new Date(t0 - 1000).toISOString(), target], {
    encoding: 'utf8',
  });
  const line = (logs.stdout + logs.stderr).split('\n').find((l) => l.includes('узел передан резервному'));
  if (line) handover = Date.parse(JSON.parse(line.slice(line.indexOf('{'))).time);
}
sh('docker', ['start', target]); // возвращаем экземпляр: он станет резервным

// Ждём завершения SIPp.
for (;;) {
  const running = sh('docker', ['inspect', '-f', '{{.State.Running}}', name]).trim();
  if (running !== 'true') break;
  await sleep(2000);
}
const out = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
const text = out.stdout + out.stderr;
sh('docker', ['rm', name]);
const num = (label) => Number(new RegExp(`${label}\\s+\\|\\s+\\d+\\s+\\|\\s+(\\d+)`).exec(text)?.[1] ?? -1);
const ok = num('Successful call');
const failed = num('Failed call');

const rows = sql(
  `SELECT c.id, c.node, c.end_reason,
          (SELECT min(extract(epoch FROM e.at) * 1000)::bigint FROM call_event e WHERE e.call_id = c.id AND e.type = 'ivr_resumed'),
          (SELECT count(*) FROM call_event e WHERE e.call_id = c.id AND e.type = 'ivr_dtmf'
             AND e.at > to_timestamp(${t0 / 1000} + 10)),
          (SELECT callback_requested FROM conversation cv WHERE cv.id = c.conversation_id)
     FROM call c WHERE c.did = '2000' AND c.started_at >= '${since}' ORDER BY c.started_at`,
)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [id, node, reason, resumed, dtmfAfter, callback] = l.split('|');
    return {
      id,
      node,
      reason,
      resumed: resumed ? Number(resumed) : null,
      dtmfAfter: Number(dtmfAfter),
      callback: callback === 't',
    };
  });
let bad = 0;
for (const r of rows) {
  const onSwitched = switched.includes(r.node);
  const pause = r.resumed ? r.resumed - handover : null;
  const problems = [];
  if (r.reason !== 'client_hangup') problems.push(`завершён: ${r.reason}`);
  if (onSwitched && pause === null) problems.push('сценарий не продолжен после переключения');
  if (onSwitched && pause !== null && pause > LIMIT_MS) problems.push(`пауза ${pause} мс > ${LIMIT_MS}`);
  if (r.dtmfAfter === 0) problems.push('нажатия после переключения не обработаны');
  if (!r.callback) problems.push('нет задачи «перезвонить» (сценарий не дошёл до голосового сообщения)');
  if (problems.length) bad++;
  console.log(
    `  вызов ${r.id.slice(0, 8)} (${r.node}${onSwitched ? ', переключён' : ''}): ${pause !== null && onSwitched ? `пауза ${pause} мс, ` : ''}нажатий после — ${r.dtmfAfter}${problems.length ? ` — ПРОБЛЕМА: ${problems.join('; ')}` : ''}`,
  );
}
console.log(`SIPp: успешно ${ok}, с ошибкой ${failed}; вызовов в БД ${rows.length}`);
if (ok !== CALLS || failed !== 0 || rows.length !== CALLS || bad) {
  console.error('ПРОВАЛ');
  process.exit(1);
}
console.log(
  `OK: ${CALLS} вызовов в IVR пережили ${mode === 'kill' ? 'аварийное' : 'штатное'} переключение call-control`,
);
