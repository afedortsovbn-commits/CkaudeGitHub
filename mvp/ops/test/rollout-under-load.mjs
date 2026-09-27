// Проверка DoD Ф0: поэтапное обновление api под нагрузкой не даёт ни одной ошибки.
// Использование: node ops/test/rollout-under-load.mjs <новый_тег> [rps] [сек]
// Предусловие: стек запущен (docker compose up), образ cc/api:<новый_тег> собран.
import { spawn } from 'node:child_process';
import autocannon from 'autocannon';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // самоподписанный сертификат Traefik
const [newTag = 'v2', rps = '50', seconds = '60'] = process.argv.slice(2);
const url = process.env.TARGET_URL ?? 'https://localhost/api/v1/ping?delayMs=200';

const versions = new Map();
const instance = autocannon({
  url,
  connections: 20,
  overallRate: Number(rps),
  duration: Number(seconds),
  setupClient: (client) =>
    client.on('body', (buf) => {
      try {
        const v = JSON.parse(buf.toString()).version;
        versions.set(v, (versions.get(v) ?? 0) + 1);
      } catch {
        /* не JSON — будет учтено как non2xx */
      }
    }),
});

await new Promise((r) => setTimeout(r, 5000));
console.log(`нагрузка ${rps} rps идёт; запускаю rollout на ${newTag}`);
const code = await new Promise((resolve) => {
  const p = spawn('ops/rollout.sh', ['api'], { stdio: 'inherit', env: { ...process.env, API_TAG: newTag } });
  p.on('exit', resolve);
});

const result = await instance;
const summary = {
  rolloutExitCode: code,
  requests: result.requests.total,
  ok2xx: result['2xx'],
  non2xx: result.non2xx,
  errors: result.errors,
  timeouts: result.timeouts,
  latencyP99ms: result.latency.p99,
  versions: Object.fromEntries(versions),
};
console.log(JSON.stringify(summary, null, 2));
const pass =
  code === 0 && result.non2xx === 0 && result.errors === 0 && result.timeouts === 0 && versions.has(newTag);
console.log(pass ? 'РЕЗУЛЬТАТ: ОК — обновление без ошибок' : 'РЕЗУЛЬТАТ: ПРОВАЛ');
process.exit(pass ? 0 : 1);
