// Резервное копирование и восстановление (M-NFR-06, Ф12) на поднятом стеке:
//  1) ops/backup.sh на работающей системе (во время копирования идёт переписка — запись не блокируется);
//  2) ops/restore.sh --verify — копия восстанавливается во временную БД и бакет, строки и sha256 совпадают;
//  3) после копии данные меняются, затем полное восстановление ops/restore.sh: состояние — как в копии,
//     файлы хранилища на месте, система снова принимает обращения и вход сотрудников.
// Запуск: node ops/test/backup-restore.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ADMIN, apiLogin, MVP, req, sleep } from './lib/stack.mjs';

const ok = (cond, msg) => {
  if (!cond) throw new Error(`ПРОВАЛ: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const run = (script, args, env = {}) =>
  execFileSync(`${MVP}/ops/${script}`, args, {
    cwd: MVP,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const lastJson = (out) => JSON.parse(out.trim().split('\n').at(-1));

const admin = await apiLogin(ADMIN.email, ADMIN.password);
const mark = `backup-${Date.now()}`;
const before = await req('POST', '/api/v1/dict/tags', { token: admin, body: { name: `Метка ${mark}` } });
ok(before.status === 201 || before.status === 200, `создана метка до копии (${before.status})`);

// Переписка во время копирования: клиент виджета пишет сообщения.
const s = await req('POST', '/api/v1/client/session', {
  body: { publicKey: 'demo-webchat', consentVersion: '1', consentAccepted: true, name: mark },
});
// Первое сообщение — до копии: обращение (создаётся асинхронно worker'ом) должно попасть в копию.
await req('POST', '/api/v1/client/messages', {
  token: s.body.token,
  body: { clientMessageId: randomUUID(), body: 'первое сообщение' },
});
const findConv = async (token) =>
  (await req('GET', `/api/v1/conversations?tab=active&q=${encodeURIComponent(mark)}`, { token })).body ?? [];
for (let i = 0; i < 60 && !(await findConv(admin)).length; i++) await sleep(500);
ok((await findConv(admin)).length === 1, 'обращение клиента создано до копии');
let chatting = true;
let sent = 0;
const chat = (async () => {
  while (chatting) {
    const r = await req('POST', '/api/v1/client/messages', {
      token: s.body.token,
      body: { clientMessageId: randomUUID(), body: `сообщение ${sent}` },
    });
    if (r.status < 300) sent++;
    await sleep(200);
  }
})();

console.log('1) резервная копия на работающей системе');
const dir = `out/backups/test-${mark}`;
const b = lastJson(run('backup.sh', [dir]));
chatting = false;
await chat;
ok(b.db.rows > 0 && b.db.tables > 20, `БД: ${b.db.tables} таблиц, ${b.db.rows} строк, ${b.db.bytes} байт`);
ok(b.s3.objects > 0, `хранилище: ${b.s3.objects} объектов, ${b.s3.bytes} байт`);
ok(sent > 0, `во время копирования клиент отправил ${sent} сообщений без ошибок`);
ok(b.migrations.length >= 13, `в копии ${b.migrations.length} миграций`);

console.log('2) проверка копии без влияния на работу (--verify)');
const v = lastJson(run('restore.sh', ['--verify', dir]));
ok(v.ok === true && v.tablesMismatched === 0, `строки всех ${v.tables} таблиц совпали`);
ok(
  v.s3.ok === true && v.s3.checked === b.s3.objects,
  `объекты хранилища совпали по sha256 (${v.s3.checked})`,
);

console.log('3) изменения после копии и полное восстановление');
const after = await req('POST', '/api/v1/dict/tags', { token: admin, body: { name: `После ${mark}` } });
ok(after.status < 300, 'создана метка после копии');
const t0 = Date.now();
const f = lastJson(run('restore.sh', [dir], { CONFIRM: 'yes' }));
ok(f.ok === true, `восстановление завершено за ${Math.round((Date.now() - t0) / 1000)} с`);

const admin2 = await apiLogin(ADMIN.email, ADMIN.password);
const tags = (await req('GET', '/api/v1/dict/tags?active=all', { token: admin2 })).body.map((t) => t.name);
ok(tags.includes(`Метка ${mark}`), 'данные на момент копии на месте');
ok(!tags.includes(`После ${mark}`), 'изменения после копии откатились');
ok((await findConv(admin2)).length === 1, 'обращение клиента, писавшего во время копирования, восстановлено');
const audio = await req('GET', '/api/v1/ivr/audio', { token: admin2 });
ok(audio.status === 200, 'аудиобиблиотека доступна');
const s2 = await req('POST', '/api/v1/client/session', {
  body: { publicKey: 'demo-webchat', consentVersion: '1', consentAccepted: true },
});
const m2 = await req('POST', '/api/v1/client/messages', {
  token: s2.body.token,
  body: { clientMessageId: randomUUID(), body: 'после восстановления' },
});
ok(m2.status < 300, 'система принимает новые обращения');
const report = JSON.parse(readFileSync(`${MVP}/${dir}/backup.json`, 'utf8'));
console.log(JSON.stringify({ backup: report, verify: v, restore: f }));
console.log('резервное копирование и восстановление — успешно');
