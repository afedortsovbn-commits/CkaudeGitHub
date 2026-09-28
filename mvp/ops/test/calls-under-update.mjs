// Разговоры во время обновления медиа или call-control (DoD Ф5, M-UPD-02): SIPp держит ~10 одновременных
// вызовов (клиенты ждут в очереди с музыкой — установленные разговоры на узлах Asterisk) и непрерывно
// звонит новые; в это время выполняется обновление. Критерий — ни один вызов SIPp не оборван и не отклонён.
// Использование:
//   node ops/test/calls-under-update.mjs media            — ops/update-media.sh (осушение обоих узлов)
//   node ops/test/calls-under-update.mjs call-control v2  — ops/rollout.sh call-control (активный → резервный)
// Предусловие: стек запущен с SEED_DEMO=true (голосовой канал с номером 1000).
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const [mode = 'media', newTag = 'next'] = process.argv.slice(2);
const BASE = process.env.BASE_URL ?? 'https://localhost';
const CALL_S = Number(process.env.CALL_S ?? 40);
const EVERY_S = Number(process.env.EVERY_S ?? 4);
const TOTAL = Number(process.env.CALLS ?? (mode === 'media' ? 45 : 30));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

async function req(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}

// Операторы — «Офлайн»: вызовы остаются в очереди с музыкой и не уходят в браузеры, которых здесь нет.
for (const email of ['operator1@demo.local', 'operator2@demo.local', 'operator3@demo.local']) {
  const t = (
    await req('POST', '/api/v1/auth/login', undefined, {
      email,
      password: process.env.DEMO_PASSWORD ?? 'Demo12345!',
    })
  ).body.accessToken;
  await req('POST', '/api/v1/agent-status', t, { status: 'offline' });
}

const name = `sipp-load-${Date.now()}`;
const scen = resolve('ops/test/sipp');
sh('docker', [
  'run',
  '-d',
  '--name',
  name,
  '--network',
  'cc',
  '-v',
  `${scen}:/s:ro`,
  process.env.SIPP_IMAGE ?? 'ctaloi/sipp:latest',
  '-sf',
  '/s/uac-call.xml',
  'kamailio:5060',
  '-s',
  '1000',
  '-r',
  '1',
  '-rp',
  String(EVERY_S * 1000),
  '-d',
  String(CALL_S * 1000),
  '-m',
  String(TOTAL),
  '-l',
  '20',
  '-timeout_error',
  '-nostdin',
]);
const started = Date.now();
console.log(
  `SIPp: ${TOTAL} вызовов по ${CALL_S} с, новый каждые ${EVERY_S} с (~${Math.round(CALL_S / EVERY_S)} одновременно)`,
);
await sleep((CALL_S + 5) * 1000); // набираем ~10 одновременных разговоров

const cmd = mode === 'media' ? ['ops/update-media.sh', []] : ['ops/rollout.sh', ['call-control']];
const env = mode === 'media' ? { ...process.env } : { ...process.env, CALL_CONTROL_TAG: newTag };
const code = await new Promise((r) => spawn(cmd[0], cmd[1], { stdio: 'inherit', env }).on('exit', r));

const waitMs = (TOTAL * EVERY_S + CALL_S + 60) * 1000 - (Date.now() - started);
sh('docker', ['wait', name]).trim();
void waitMs;
const out = sh('docker', ['logs', name]);
sh('docker', ['rm', '-f', name]);
const last = (label) => {
  const m = [...out.matchAll(new RegExp(`${label}\\s*\\|\\s*(\\d+)\\s*\\|\\s*(\\d+)`, 'g'))].at(-1);
  return m ? Number(m[2]) : NaN;
};
const summary = {
  updateExitCode: code,
  successful: last('Successful call'),
  failed: last('Failed call'),
  expected: TOTAL,
};
console.log(JSON.stringify(summary, null, 2));
const ok = code === 0 && summary.failed === 0 && summary.successful === TOTAL;
console.log(ok ? `РЕЗУЛЬТАТ: ОК — обновление (${mode}) без обрыва разговоров` : 'РЕЗУЛЬТАТ: ПРОВАЛ');
process.exit(ok ? 0 : 1);
