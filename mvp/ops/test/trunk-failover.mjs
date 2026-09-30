// Несколько SIP-транков с приоритетом и резервом (M-TEL-01, Ф12b): исходящий вызов с узла Asterisk уходит через
// Kamailio в транк с наивысшим приоритетом; при отказе транка — в следующий.
//   A) основной транк отвечает 503 → вызов уходит в резервный и соединяется (порядок в TRUNKS обратный
//      приоритету — выбор по приоритету, а не по порядку);
//   B) основной транк молчит (нет ответа) → по таймеру (408) вызов уходит в резервный;
//   C) основной отвечает «занято» (486) → ответ абонента, в резервный вызов НЕ уходит;
//   D) адрес основного не разрешается (DNS) → сразу резервный.
// Транки — SIPp UAS в сети cc; Kamailio пересоздаётся с TRUNKS (класс C, окно ~7 с), в конце — с прежними
// настройками. Использование: node ops/test/trunk-failover.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dc, MVP, SIPP_IMAGE, sh, sleep } from './lib/stack.mjs';

const SIPP_DIR = `${MVP}/out/sipp`;
const results = [];

/** Сценарий SIPp «транк отвечает отказом»: INVITE → окончательный ответ code → ACK. */
function replyScenario(code) {
  mkdirSync(SIPP_DIR, { recursive: true });
  const file = `uas-reply-${code}.xml`;
  writeFileSync(
    `${SIPP_DIR}/${file}`,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="cc-uas-reply-${code}">
  <recv request="INVITE"/>
  <send><![CDATA[
      SIP/2.0 ${code} Trunk Reply
      [last_Via:]
      [last_From:]
      [last_To:];tag=[pid]SIPpTag01[call_number]
      [last_Call-ID:]
      [last_CSeq:]
      Content-Length: 0
  ]]></send>
  <recv request="ACK"/>
</scenario>
`,
  );
  return ['-sf', `/s/${file}`];
}
/** Сценарий «транк молчит»: INVITE принимается, ответа нет. */
function silentScenario() {
  mkdirSync(SIPP_DIR, { recursive: true });
  writeFileSync(
    `${SIPP_DIR}/uas-silent.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="cc-uas-silent">
  <recv request="INVITE"/>
  <pause milliseconds="15000"/>
</scenario>
`,
  );
  return ['-sf', '/s/uas-silent.xml'];
}

/**
 * Сценарий «транк отвечает на вызов»: 180 → 200 (с Record-Route — запросы внутри диалога идут через Kamailio, как у
 * настоящего транка; встроенный сценарий SIPp uas его не возвращает) → ACK → BYE от КЦ → 200.
 */
function answerScenario() {
  mkdirSync(SIPP_DIR, { recursive: true });
  const reply = (code, sdp) => `<send><![CDATA[
      SIP/2.0 ${code}
      [last_Via:]
      [last_From:]
      [last_To:];tag=[pid]SIPpTag01[call_number]
      [last_Call-ID:]
      [last_CSeq:]
      [last_Record-Route:]
      Contact: <sip:[local_ip]:[local_port];transport=[transport]>
      ${
        sdp
          ? `Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=user1 53655765 2353687637 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP 8
      a=rtpmap:8 PCMA/8000`
          : 'Content-Length: 0'
      }
  ]]></send>`;
  writeFileSync(
    `${SIPP_DIR}/uas-answer.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="cc-uas-answer">
  <recv request="INVITE" rrs="true"/>
  ${reply('180 Ringing', false)}
  ${reply('200 OK', true)}
  <recv request="ACK"/>
  <recv request="BYE"/>
  <send><![CDATA[
      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Content-Length: 0
  ]]></send>
</scenario>
`,
  );
  return ['-sf', '/s/uas-answer.xml'];
}

function uas(name, args) {
  sh('docker', ['rm', '-f', name], { stdio: 'ignore' });
  sh('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'cc',
    '-v',
    `${SIPP_DIR}:/s:ro`,
    SIPP_IMAGE,
    ...args,
    '-p',
    '5060',
    '-m',
    '1',
    '-nostdin',
    '-trace_err',
  ]);
}
const state = (name) => {
  try {
    return JSON.parse(sh('docker', ['inspect', '-f', '{{json .State}}', name]));
  } catch {
    return null;
  }
};
/** Ждёт завершения SIPp (-m 1: один вызов) до timeoutMs; возвращает код выхода или null (не завершился). */
async function exited(name, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = state(name);
    if (s && !s.Running) return s.ExitCode;
    await sleep(500);
  }
  return null;
}
function kamailio(trunks) {
  const env = { ...process.env };
  if (trunks === null) delete env.TRUNKS;
  else env.TRUNKS = trunks;
  const t0 = Date.now();
  sh(
    'docker',
    [
      'compose',
      '-f',
      `${MVP}/infra/compose/docker-compose.yml`,
      'up',
      '-d',
      '--wait',
      '--no-deps',
      '--force-recreate',
      'kamailio',
    ],
    {
      env,
      stdio: 'inherit',
    },
  );
  // dispatcher узлов Asterisk: первые пробы OPTIONS.
  return sleep(3000).then(() => Date.now() - t0);
}
function originate(number) {
  dc(
    'exec',
    '-T',
    'asterisk-1',
    'asterisk',
    '-rx',
    `channel originate PJSIP/trunk/sip:${number}@kamailio:5060 application Wait 3`,
  );
}

async function scenario(name, primaryArgs, expectBackup) {
  const t0 = Date.now();
  try {
    if (primaryArgs) uas('trunk-primary', primaryArgs);
    uas('trunk-backup', answerScenario());
    // Резервный указан первым в списке, но приоритет у него ниже.
    await kamailio('trunk-backup:5060;2,trunk-primary:5060;1');
    originate('+375291234567');
    // Без основного (D) его адрес не разрешается — проверяется только резервный.
    const p = primaryArgs ? await exited('trunk-primary', 30_000) : 0;
    const b = await exited('trunk-backup', expectBackup ? 30_000 : 8_000);
    const ok = p === 0 && (expectBackup ? b === 0 : b === null);
    results.push({ name, ok, primary: { exit: p }, backup: { exit: b }, ms: Date.now() - t0 });
    if (!ok) {
      for (const n of ['trunk-primary', 'trunk-backup'])
        console.log(
          `--- ${n}\n${sh('docker', ['logs', '--tail', '40', n], { stdio: ['ignore', 'pipe', 'pipe'] })}`,
        );
      console.log(dc('logs', '--tail', '40', 'kamailio'));
    }
  } catch (e) {
    results.push({ name, ok: false, error: String(e), ms: Date.now() - t0 });
  } finally {
    for (const n of ['trunk-primary', 'trunk-backup']) sh('docker', ['rm', '-f', n], { stdio: 'ignore' });
  }
}

await scenario('A: основной отвечает 503 → резервный', replyScenario(503), true);
await scenario('B: основной молчит → по таймеру резервный', silentScenario(), true);
await scenario('C: основной отвечает 486 (занято) → резервный не вызывается', replyScenario(486), false);
await scenario('D: адрес основного не разрешается → резервный', null, true);

// Прежние настройки Kamailio (TRUNK_HOST из окружения стека).
await kamailio(process.env.TRUNKS ?? null);

console.log(JSON.stringify({ results }, null, 2));
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`ПРОВАЛ: ${failed.map((r) => r.name).join('; ')}`);
  process.exit(1);
}
console.log(
  'OK: резервный транк принимает вызов при отказе и молчании основного; «занято» не переадресуется',
);
