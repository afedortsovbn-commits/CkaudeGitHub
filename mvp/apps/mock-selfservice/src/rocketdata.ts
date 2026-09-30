/**
 * Ф13 — мок API Rocket Data и источника справочника объектов (профили test и demo; контракт-заглушка —
 * mvp/docs/интеграции-rocketdata-и-объекты.md). Состояние — в памяти процесса.
 *
 * Rocket Data (авторизация Bearer ROCKETDATA_TOKEN); <акк> — независимая «учётная запись» (демо-канал — demo, проверки —
 * свои, чтобы не смешивать отзывы), адрес API канала — http://mock-selfservice:3000/rocketdata/<акк>:
 *   GET  /rocketdata/<акк>/v1/reviews?updated_since=<ISO>&cursor=<n>&limit=<n> → {items, next_cursor}
 *   POST /rocketdata/<акк>/v1/reviews/<id>/answer {text}, Idempotency-Key → {id, status: published|rejected, error?}
 *        (текст со словом «ОТКЛОНИТЬ» — площадка отклоняет ответ; неизвестный отзыв — 404)
 * Управление из тестов и демо:
 *   POST /rocketdata/<акк>/__test/reviews {id?, location_id?, location_code?, platform?, rating?, text?,
 *        author_name?, answer_text?} — добавить или изменить отзыв (updated_at = сейчас); без id — новый id
 *   GET  /rocketdata/<акк>/__test/reviews — отзывы; GET …/__test/answers — полученные ответы (ключ идемпотентности,
 *        число запросов с этим ключом)
 *   POST /rocketdata/<акк>/__test/control {down: true|false} — «API недоступно» (503)
 *   POST /rocketdata/<акк>/__test/reset — очистить отзывы и ответы
 *
 * Справочник объектов (авторизация Bearer OBJECTS_TOKEN):
 *   GET  /objects/feed.json — выгрузка JSON; GET /objects/feed.csv — то же в CSV
 *   POST /objects/__test/feed {items: [...]} — заменить выгрузку; POST /objects/__test/feed {reset: true} — исходная
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const RD_TOKEN = process.env.ROCKETDATA_TOKEN ?? 'demo-rocketdata-token';
const OBJECTS_TOKEN = process.env.OBJECTS_TOKEN ?? 'demo-objects-token';

type Send = (s: number, b: unknown) => void;
type SendRaw = (s: number, body: string, contentType: string) => void;

interface Review {
  id: string;
  location_id: string | null;
  location_code: string | null;
  platform: string;
  rating: number | null;
  text: string | null;
  author_name: string | null;
  published_at: string;
  updated_at: string;
  url: string;
  answer: { text: string; status: string; published_at: string } | null;
}
interface Answer {
  reviewId: string;
  text: string;
  key: string | null;
  at: string;
  requests: number;
  status: string;
}

interface Account {
  reviews: Map<string, Review>;
  answers: Answer[];
  down: boolean;
}
const accounts = new Map<string, Account>();
const account = (name: string): Account => {
  let a = accounts.get(name);
  if (!a) accounts.set(name, (a = { reviews: new Map(), answers: [], down: false }));
  return a;
};
/** Метка времени строго возрастает — отзывы одного запроса различимы по updated_at. */
let lastTs = 0;
const nowIso = () => {
  lastTs = Math.max(Date.now(), lastTs + 1);
  return new Date(lastTs).toISOString();
};

interface FeedItem {
  code: string;
  name: string;
  address: string | null;
  enterprise_code: string;
  external_ids: Record<string, string>;
  is_active?: boolean;
}
/** Исходная выгрузка — объекты демо-стенда (коды предприятий E1–E3) и одна новая АЗС. */
const INITIAL_FEED: FeedItem[] = [
  ...['E1', 'E1', 'E2', 'E2', 'E3', 'E3'].map((e, i) => ({
    code: `AZS-${i + 1}`,
    name: `АЗС №${i + 1}`,
    address: `г. Минск, ул. Условная, ${i + 1}`,
    enterprise_code: e,
    external_ids: { rocketdata: `rd-azs-${i + 1}` },
  })),
  {
    code: 'EV-1',
    name: 'ЭЗС-1',
    address: 'г. Минск, пр. Условный, 10',
    enterprise_code: 'E1',
    external_ids: { rocketdata: 'rd-ev-1' },
  },
  {
    code: 'AZS-7',
    name: 'АЗС №7',
    address: 'г. Гродно, ул. Новая, 7',
    enterprise_code: 'E2',
    external_ids: { rocketdata: 'rd-azs-7' },
  },
];
let feed: FeedItem[] = structuredClone(INITIAL_FEED);

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));

function upsertReview(reviews: Map<string, Review>, b: Record<string, unknown>): Review {
  const id = str(b.id) ?? `rv-${randomUUID().slice(0, 8)}`;
  const prev = reviews.get(id);
  const at = nowIso();
  const platform = str(b.platform) ?? prev?.platform ?? 'google';
  const r: Review = {
    id,
    location_id: b.location_id !== undefined ? str(b.location_id) : (prev?.location_id ?? null),
    location_code: b.location_code !== undefined ? str(b.location_code) : (prev?.location_code ?? null),
    platform,
    rating: b.rating !== undefined ? (b.rating === null ? null : Number(b.rating)) : (prev?.rating ?? 5),
    text: b.text !== undefined ? str(b.text) : (prev?.text ?? null),
    author_name: b.author_name !== undefined ? str(b.author_name) : (prev?.author_name ?? 'Посетитель'),
    published_at: prev?.published_at ?? str(b.published_at) ?? at,
    updated_at: at,
    url: prev?.url ?? `https://${platform === 'yandex' ? 'yandex.by/maps' : 'maps.google.com'}/reviews/${id}`,
    answer: b.answer_text
      ? { text: String(b.answer_text), status: 'published', published_at: at }
      : (prev?.answer ?? null),
  };
  reviews.set(id, r);
  return r;
}

export function handleRocketData(req: IncomingMessage, url: URL, send: Send, sendRaw: SendRaw): boolean {
  const rd = /^\/rocketdata\/([A-Za-z0-9_-]{1,64})(\/.*)$/.exec(url.pathname);
  if (rd) return rocketData(req, url, account(rd[1]!), rd[2]!, send);
  return objects(req, url.pathname, send, sendRaw);
}

function rocketData(req: IncomingMessage, url: URL, acc: Account, p: string, send: Send): boolean {
  const { reviews, answers } = acc;
  if (p.startsWith('/__test/')) {
    void (async () => {
      const b = req.method === 'POST' ? await readJson(req) : {};
      if (p === '/__test/reviews' && req.method === 'POST') return send(200, upsertReview(reviews, b));
      if (p === '/__test/reviews' && req.method === 'GET') return send(200, [...reviews.values()]);
      if (p === '/__test/answers') return send(200, answers);
      if (p === '/__test/control') {
        acc.down = !!b.down;
        return send(200, { down: acc.down });
      }
      if (p === '/__test/reset') {
        reviews.clear();
        answers.length = 0;
        acc.down = false;
        return send(200, { ok: true });
      }
      return send(404, { error: 'not found' });
    })();
    return true;
  }
  if (p.startsWith('/v1/')) {
    if (req.headers.authorization !== `Bearer ${RD_TOKEN}`) {
      send(401, { error: 'invalid token' });
      return true;
    }
    if (acc.down) {
      send(503, { error: 'service unavailable' });
      return true;
    }
    if (p === '/v1/reviews' && req.method === 'GET') {
      const since = Date.parse(url.searchParams.get('updated_since') ?? '1970-01-01T00:00:00Z');
      if (Number.isNaN(since)) {
        send(400, { error: 'updated_since' });
        return true;
      }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 100);
      const offset = Number(url.searchParams.get('cursor') ?? 0) || 0;
      const all = [...reviews.values()]
        .filter((r) => Date.parse(r.updated_at) >= since)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
      const items = all.slice(offset, offset + limit);
      send(200, { items, next_cursor: offset + limit < all.length ? String(offset + limit) : null });
      return true;
    }
    const m = /^\/v1\/reviews\/([^/]+)\/answer$/.exec(p);
    if (m && req.method === 'POST') {
      void (async () => {
        const b = await readJson(req);
        const r = reviews.get(decodeURIComponent(m[1]!));
        if (!r) return send(404, { error: 'review not found' });
        const text = String(b.text ?? '').trim();
        if (!text) return send(422, { error: 'text is required' });
        const key = str(req.headers['idempotency-key']);
        const prev = key ? answers.find((a) => a.key === key) : undefined;
        if (prev) {
          prev.requests++;
          return send(200, { id: `ans-${prev.key}`, status: prev.status });
        }
        const status = /ОТКЛОНИТЬ/i.test(text) ? 'rejected' : 'published';
        answers.push({ reviewId: r.id, text, key, at: nowIso(), requests: 1, status });
        if (status === 'rejected') return send(200, { status, error: 'ответ не прошёл модерацию площадки' });
        r.answer = { text, status, published_at: nowIso() };
        r.updated_at = nowIso();
        return send(200, { id: `ans-${key ?? answers.length}`, status });
      })();
      return true;
    }
    send(404, { error: 'not found' });
    return true;
  }
  send(404, { error: 'not found' });
  return true;
}

function objects(req: IncomingMessage, p: string, send: Send, sendRaw: SendRaw): boolean {
  if (p === '/objects/__test/feed' && req.method === 'POST') {
    void (async () => {
      const b = await readJson(req);
      feed = b.reset ? structuredClone(INITIAL_FEED) : ((b.items as FeedItem[]) ?? []);
      send(200, { items: feed.length });
    })();
    return true;
  }
  if (p === '/objects/feed.json' || p === '/objects/feed.csv') {
    if (req.headers.authorization !== `Bearer ${OBJECTS_TOKEN}`) {
      send(401, { error: 'invalid token' });
      return true;
    }
    if (p.endsWith('.json')) send(200, feed);
    else {
      const cell = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = ['code;name;address;enterprise_code;rocketdata;is_active'];
      for (const f of feed)
        lines.push(
          [
            f.code,
            f.name,
            f.address,
            f.enterprise_code,
            f.external_ids.rocketdata,
            f.is_active === false ? 0 : 1,
          ]
            .map(cell)
            .join(';'),
        );
      sendRaw(200, `${lines.join('\n')}\n`, 'text/csv; charset=utf-8');
    }
    return true;
  }
  return false;
}
