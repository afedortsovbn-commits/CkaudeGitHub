// Проверка DoD Ф0: перезапуск узла NATS (лидера потока) во время публикации не теряет сообщений.
// Использование: node ops/test/nats-failover.mjs [число_сообщений]
// Предусловие: кластер NATS из 3 узлов запущен (порты 4222–4224 на localhost).
import { execSync } from 'node:child_process';
import { AckPolicy, connect, DeliverPolicy, StorageType } from 'nats';

const TOTAL = Number(process.argv[2] ?? 2000);
const STREAM = `FAILOVER_TEST_${Date.now()}`;
const nc = await connect({
  servers: ['nats://127.0.0.1:4222', 'nats://127.0.0.1:4223', 'nats://127.0.0.1:4224'],
  maxReconnectAttempts: -1,
  reconnectTimeWait: 200,
});
const jsm = await nc.jetstreamManager();
await jsm.streams.add({
  name: STREAM,
  subjects: [`${STREAM}.>`],
  num_replicas: 3,
  storage: StorageType.File,
});
const js = nc.jetstream();
const leader = (await jsm.streams.info(STREAM)).cluster?.leader;
console.log(`поток ${STREAM} (R3), лидер: ${leader}`);

let restarted = false;
let retries = 0;
for (let i = 0; i < TOTAL; i++) {
  if (i === Math.floor(TOTAL / 3) && !restarted) {
    restarted = true;
    console.log(`перезапускаю узел-лидер ${leader} (docker restart)…`);
    execSync(`docker restart -t 5 cc-${leader}-1`, { stdio: 'ignore' });
  }
  for (;;) {
    try {
      await js.publish(`${STREAM}.msg`, new TextEncoder().encode(String(i)), {
        msgID: `m-${i}`,
        timeout: 2000,
      });
      break;
    } catch {
      retries++;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
console.log(`опубликовано ${TOTAL}, повторов публикации: ${retries}`);

await new Promise((r) => setTimeout(r, 1000));
const info = await jsm.streams.info(STREAM);
const consumer = await js.consumers.get(
  STREAM,
  (await jsm.consumers.add(STREAM, { ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All }))
    .name,
);
const seen = new Set();
const iter = await consumer.fetch({ max_messages: TOTAL + 100, expires: 5000 });
for await (const m of iter) {
  seen.add(new TextDecoder().decode(m.data));
  m.ack();
  if (seen.size === TOTAL) break;
}
await jsm.streams.delete(STREAM);
await nc.close();
const ok = info.state.messages === TOTAL && seen.size === TOTAL;
console.log(
  JSON.stringify({
    inStream: info.state.messages,
    uniqueConsumed: seen.size,
    expected: TOTAL,
    newLeader: info.cluster?.leader,
  }),
);
console.log(ok ? 'РЕЗУЛЬТАТ: ОК — сообщения не потеряны и не задублированы' : 'РЕЗУЛЬТАТ: ПРОВАЛ');
process.exit(ok ? 0 : 1);
