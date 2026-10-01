// Поток отзывов Rocket Data и ответов на них во время поэтапного обновления connector-rocketdata (Ф13, M-UPD-01):
// каждый отзыв становится ровно одним обращением (без потерь и дублей), каждый ответ оператора доставлен в Rocket
// Data ровно один раз и получил статус «отправлено».
// Использование: node ops/test/reviews-under-rollout.mjs <новый_тег> [секунд]
// Предусловие: стек запущен с SEED_DEMO=true и профилем test (mock-selfservice — мок Rocket Data);
// образ cc/connector-rocketdata:<тег> собран.
import { spawn } from 'node:child_process';
import { ADMIN, apiLogin, dbPool, MVP, req, setStatus, sleep } from './lib/stack.mjs';

const [newTag = 'next', seconds = '60'] = process.argv.slice(2);
const MOCK = process.env.MOCK_SELFSERVICE_URL ?? 'http://127.0.0.1:8082';
const stamp = Date.now().toString(36);
// Своя «учётная запись» мока: отзывы проверки не попадают в демо-канал.
const acc = `rollout-${stamp}`;
const mock = async (method, path, body) => {
  const r = await fetch(`${MOCK}/rocketdata/${acc}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`мок Rocket Data ${path}: ${r.status}`);
  return r.json();
};

const admin = await apiLogin(ADMIN.email, ADMIN.password);
const op = await apiLogin(process.env.OPERATOR_EMAIL ?? 'operator2@demo.local');
// Операторы — «Офлайн», а очередь отзывов проверки — без операторов: router никому их не предлагает (иначе обращения
// проверки заполнили бы лимит чатов в следующих проверках).
for (const email of ['operator1@demo.local', 'operator2@demo.local', 'operator3@demo.local'])
  await setStatus(await apiLogin(email), 'offline');
const q = await req('POST', '/api/v1/dict/queues', {
  token: admin,
  body: { name: `Отзывы rollout ${stamp}`, channels: ['review'], priority: 0 },
});
if (q.status !== 201) throw new Error(`очередь не создана: ${JSON.stringify(q.body)}`);
const ch = await req('POST', '/api/v1/dict/channels', {
  token: admin,
  body: {
    kind: 'review',
    name: `Rollout отзывы ${stamp}`,
    queueId: q.body.id,
    config: {
      api_url: `http://mock-selfservice:3000/rocketdata/${acc}`,
      api_token: 'demo-rocketdata-token',
      poll_interval_s: 10,
      initial_days: 1,
      low_rating_max: 2,
      skip_answered: true,
    },
  },
});
if (ch.status !== 201) throw new Error(`канал не создан: ${JSON.stringify(ch.body)}`);
const channelId = ch.body.id;
for (let i = 0; ; i++) {
  const s = (await req('GET', `/api/v1/channels/${channelId}/log`, { token: admin })).body;
  if (s.status === 'connected') break;
  if (i > 60) throw new Error(`канал не подключился: ${JSON.stringify(s)}`);
  await sleep(1000);
}

const pool = dbPool();
const reviewsSent = new Map(); // id отзыва → текст последней редакции
async function addReview(i) {
  const id = `rv-${stamp}-${i}`;
  const text = `отзыв ${stamp} ${i}`;
  await mock('POST', '/__test/reviews', {
    id,
    text,
    rating: 1 + (i % 5),
    location_id: `rd-azs-${1 + (i % 6)}`,
    author_name: `Автор ${i}`,
  });
  reviewsSent.set(id, text);
}
async function conversationOfReview(id) {
  for (let i = 0; i < 60; i++) {
    const { rows } = await pool.query(
      `SELECT id FROM conversation WHERE channel_id = $1 AND channel_meta #>> '{review,id}' = $2`,
      [channelId, id],
    );
    if (rows[0]) return rows[0].id;
    await sleep(1000);
  }
  throw new Error(`отзыв ${id} не стал обращением`);
}
// Три отзыва, на которые оператор отвечает во время обновления.
for (let i = 0; i < 3; i++) await addReview(i);
const convs = [];
for (let i = 0; i < 3; i++) {
  const id = await conversationOfReview(`rv-${stamp}-${i}`);
  const r = await req('POST', `/api/v1/conversations/${id}/take`, { token: op });
  if (r.status !== 200) throw new Error(`не удалось взять обращение: ${JSON.stringify(r.body)}`);
  convs.push(id);
}

// --- поток во время обновления ---
const opSent = [];
let running = true;
const loops = [
  (async () => {
    for (let i = 3; running; i++) {
      await addReview(i);
      await sleep(300);
    }
  })(),
  (async () => {
    for (let i = 1; running; i++) {
      for (const conv of convs) {
        const body = `ответ ${stamp} ${conv.slice(-6)} ${i}`;
        const r = await req('POST', `/api/v1/conversations/${conv}/messages`, { token: op, body: { body } });
        if (r.status === 201) opSent.push(body);
      }
      await sleep(700);
    }
  })(),
];
const rollout = () =>
  new Promise((resolve) => {
    const p = spawn('ops/rollout.sh', ['connector-rocketdata'], {
      cwd: MVP,
      stdio: 'inherit',
      env: { ...process.env, CONNECTOR_ROCKETDATA_TAG: newTag },
    });
    p.on('exit', resolve);
  });
const started = Date.now();
await sleep(3000);
const code = await rollout();
while (Date.now() - started < Number(seconds) * 1000) await sleep(500);
running = false;
await Promise.all(loops);

// --- проверка: ждём хвост (следующий опрос, повторы доставки), затем сверяем ---
let result;
for (let attempt = 0; attempt < 30; attempt++) {
  await sleep(2000);
  const { rows } = await pool.query(
    `SELECT c.channel_meta #>> '{review,id}' AS rid, m.body
       FROM conversation c JOIN message m ON m.conversation_id = c.id AND m.direction = 'in'
      WHERE c.channel_id = $1`,
    [channelId],
  );
  const perReview = new Map();
  for (const r of rows) perReview.set(r.rid, [...(perReview.get(r.rid) ?? []), r.body]);
  const status = await pool.query(
    `SELECT m.delivery_status AS s, count(*)::int AS n FROM message m
       WHERE m.conversation_id = ANY($1::uuid[]) AND m.direction = 'out' GROUP BY 1`,
    [convs],
  );
  const st = Object.fromEntries(status.rows.map((r) => [r.s, r.n]));
  const answers = await mock('GET', '/__test/answers');
  const delivered = (b) => answers.filter((a) => a.text === b).length;
  result = {
    rolloutExitCode: code,
    reviews: {
      sent: reviewsSent.size,
      lost: [...reviewsSent.keys()].filter((id) => !perReview.has(id)).length,
      duplicates: [...perReview.values()].filter((list) => list.length > 1).length,
      conversations: (
        await pool.query(`SELECT count(*)::int AS n FROM conversation WHERE channel_id = $1`, [channelId])
      ).rows[0].n,
    },
    answers: {
      operatorSent: opSent.length,
      notDelivered: opSent.filter((b) => delivered(b) === 0).length,
      deliveredTwice: opSent.filter((b) => delivered(b) > 1).length,
      retriedWithSameKey: answers.filter((a) => a.requests > 1).length,
    },
    deliveryStatus: { sent: st.sent ?? 0, pending: st.pending ?? 0, failed: st.failed ?? 0 },
  };
  if (!result.reviews.lost && !result.answers.notDelivered && !result.deliveryStatus.pending) break;
}
await pool.end();
// Канал проверки выключается — отзывы учётной записи проверки больше не опрашиваются.
await req('POST', `/api/v1/dict/channels/${channelId}/deactivate`, { token: admin });
console.log(JSON.stringify(result, null, 2));
const { reviews: r, answers: a, deliveryStatus: d } = result;
const ok =
  code === 0 &&
  r.sent > 0 &&
  !r.lost &&
  !r.duplicates &&
  r.conversations === r.sent &&
  a.operatorSent > 0 &&
  !a.notDelivered &&
  !a.deliveredTwice &&
  !d.pending &&
  !d.failed;
console.log(ok ? 'РЕЗУЛЬТАТ: ОК — обновление connector-rocketdata без потерь и дублей' : 'РЕЗУЛЬТАТ: ПРОВАЛ');
process.exit(ok ? 0 : 1);
