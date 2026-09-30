// Общие помощники проверок стека (Ф11): REST, вход сотрудников, браузерные операторы (Playwright из mvp/e2e),
// SIPp в сети cc. Используются ops/test/kamailio-restart.mjs и ops/zero-downtime-test.
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
export const MVP = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
export const BASE = process.env.BASE_URL ?? 'https://localhost';
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo12345!';
export const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@cc.local',
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'Admin12345!',
};
export const COMPOSE = [
  'compose',
  '-f',
  join(MVP, process.env.COMPOSE_FILE ?? 'infra/compose/docker-compose.yml'),
];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
export const dc = (...args) => sh('docker', [...COMPOSE, ...args]);

/** REST с повтором сетевых ошибок и 5xx (во время обновления запрос может попасть на закрывающийся экземпляр). */
export async function req(method, path, { token, body, headers = {}, retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          origin: BASE,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      if (r.status >= 500 && attempt < retries) throw new Error(`HTTP ${r.status}`);
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
      return { status: r.status, body: parsed };
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
}

export async function apiLogin(email, password = DEMO_PASSWORD) {
  const r = await req('POST', '/api/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`вход ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

export async function setStatus(token, status) {
  const r = await req('POST', '/api/v1/agent-status', { token, body: { status } });
  if (r.status >= 300) throw new Error(`статус ${status}: ${r.status} ${JSON.stringify(r.body)}`);
}

// ---------------------------------------------------------------- браузер
/** Тон 440 Гц для фейкового микрофона Chromium. */
function toneFile() {
  const rate = 16000;
  const pcm = Buffer.alloc(rate * 2 * 2);
  for (let i = 0; i < rate * 2; i++)
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  const file = join(tmpdir(), 'cc-ops-tone.wav');
  writeFileSync(file, Buffer.concat([h, pcm]));
  return file;
}

export async function launchBrowser() {
  const require = createRequire(join(MVP, 'e2e/package.json'));
  const { chromium } = require('@playwright/test');
  return chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${toneFile()}`,
    ],
  });
}

/** Оператор в браузере: вход, рабочее место, софтфон зарегистрирован. */
export async function browserOperator(browser, email, password = DEMO_PASSWORD) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.getByTestId('current-user').waitFor({ timeout: 30_000 });
  await page.getByRole('navigation').getByRole('link', { name: 'Рабочее место оператора' }).click();
  await waitRegistered(page);
  return page;
}

export async function waitRegistered(page, timeout = 30_000) {
  await page.getByTestId('softphone-status').filter({ hasText: 'Телефон готов' }).waitFor({ timeout });
}

// ---------------------------------------------------------------- SIPp
export const SIPP_IMAGE = process.env.SIPP_IMAGE ?? 'ctaloi/sipp:latest';
const SIPP_DIR = resolve(MVP, 'ops/test/sipp');

const SDP = `v=0
      o=user1 53655765 2353687637 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP 8 0 101
      a=rtpmap:8 PCMA/8000
      a=rtpmap:0 PCMU/8000
      a=rtpmap:101 telephone-event/8000
      a=sendrecv`;

/**
 * Сценарий SIPp «клиент разговаривает с оператором» (Ф11). В отличие от uac-call.xml отвечает на re-INVITE
 * узла Asterisk (при соединении с оператором обновляются номер и медиа; UPDATE отвечает ключ -aa):
 *  - talkMs > 0: клиент сам кладёт трубку, если talkMs прошло без запросов от КЦ (каждый re-INVITE отсчитывает
 *    заново) — BYE от КЦ раньше — провал (обрыв);
 *  - talkMs = 0: клиент ждёт, пока трубку положит оператор (BYE от КЦ до 180 с — успех).
 */
export function talkScenario(talkMs) {
  const dir = resolve(MVP, 'out/sipp');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `uac-talk-${talkMs}.xml`);
  const hdr = (method, cseq) => `${method} [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: "SIPp [call_number]" <sip:+37544[call_number]000@[local_ip]:[local_port]>;tag=[pid]SIPpTag02[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: ${cseq} ${method}
      [routes]
      Contact: <sip:sipp@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Length: 0`;
  const wait =
    talkMs > 0
      ? `<recv request="INVITE" timeout="${talkMs}" ontimeout="bye" next="reinvite"/>`
      : `<recv request="INVITE" optional="true" next="reinvite"/>
  <recv request="BYE" timeout="180000" next="byeok"/>`;
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="cc-uac-talk">
  <send retrans="500"><![CDATA[
      INVITE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: "SIPp [call_number]" <sip:+37544[call_number]000@[local_ip]:[local_port]>;tag=[pid]SIPpTag02[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:sipp@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Type: application/sdp
      Content-Length: [len]

      ${SDP}
  ]]></send>
  <recv response="100" optional="true"/>
  <recv response="180" optional="true"/>
  <recv response="183" optional="true"/>
  <recv response="200" rtd="true" rrs="true"/>
  <send><![CDATA[
      ${hdr('ACK', 1)}
  ]]></send>
  <label id="wait"/>
  ${wait}
  <label id="reinvite"/>
  <send><![CDATA[
      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:sipp@[local_ip]:[local_port]>
      Content-Type: application/sdp
      Content-Length: [len]

      ${SDP}
  ]]></send>
  <recv request="ACK" next="wait"/>
  ${
    talkMs > 0
      ? `<label id="bye"/>
  <send retrans="500"><![CDATA[
      ${hdr('BYE', 2)}
  ]]></send>
  <recv response="200" crlf="true"/>`
      : `<label id="byeok"/>
  <send><![CDATA[
      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Content-Length: 0
  ]]></send>`
  }
</scenario>
`,
  );
  return file;
}

/**
 * Запускает SIPp в сети cc (в фоне), возвращает имя контейнера. scenario — имя файла из ops/test/sipp или
 * абсолютный путь (talkScenario).
 */
export function sipp(name, scenario, extra) {
  const path = scenario.startsWith('/') ? scenario : join(SIPP_DIR, scenario);
  sh('docker', ['rm', '-f', name], { stdio: 'ignore' });
  sh('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'cc',
    '-v',
    `${dirname(path)}:/s:ro`,
    SIPP_IMAGE,
    '-sf',
    `/s/${basename(path)}`,
    'kamailio:5060',
    '-s',
    '1000',
    '-nostdin',
    '-aa',
    '-trace_err',
    '-error_file',
    '/tmp/sipp_err.log',
    ...extra,
  ]);
  return name;
}

/** Ждёт завершения SIPp и возвращает {successful, failed, log}. */
export function sippResult(name) {
  sh('docker', ['wait', name]);
  const out = sh('docker', ['logs', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  const tmp = join(tmpdir(), `${name}-err.log`);
  try {
    sh('docker', ['cp', `${name}:/tmp/sipp_err.log`, tmp], { stdio: 'ignore' });
    err = readFileSync(tmp, 'utf8');
    rmSync(tmp, { force: true });
  } catch {
    /* ошибок не было — файл не создан */
  }
  sh('docker', ['rm', '-f', name], { stdio: 'ignore' });
  const last = (label) => {
    const m = [...out.matchAll(new RegExp(`${label}\\s*\\|\\s*(\\d+)\\s*\\|\\s*(\\d+)`, 'g'))].at(-1);
    return m ? Number(m[2]) : NaN;
  };
  return { successful: last('Successful call'), failed: last('Failed call'), log: out, errors: err };
}
