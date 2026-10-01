/**
 * Ф13 — мок Rocket Data и источников справочника объектов (профили test и demo). Обмен с Rocket Data — по описанию
 * заказчика (mvp/docs/интеграции-rocketdata-и-объекты.md): отзывы Rocket Data присылает в КЦ сама (в проверках их
 * отправляет тест: POST <адрес КЦ>/rd/<id канала>), мок принимает только ответы. Состояние — в памяти процесса.
 *
 * Rocket Data; <акк> — независимая «учётная запись» (демо-канал — demo, проверки — свои, чтобы не смешивать ответы),
 * адрес сервиса ответов канала — http://mock-selfservice:3000/rocketdata/<акк>/answer:
 *   POST /rocketdata/<акк>/answer {Review_id, DateAnswer, Text} → 200 {result: "ok"}
 *        (нет Review_id/Text или DateAnswer не «ГГГГ-ММ-ДДTчч:мм:сс» — 400; текст со словом «ОТКЛОНИТЬ» — 422)
 * Управление из тестов и демо:
 *   GET  /rocketdata/<акк>/__test/answers — полученные ответы (ключ идемпотентности, число запросов с ним)
 *   POST /rocketdata/<акк>/__test/control {down: true|false} — «сервис недоступен» (503)
 *   POST /rocketdata/<акк>/__test/reset — очистить ответы
 *
 * Справочник объектов:
 *   GET  /objects/asu — выгрузка АЗС в формате АСУ НПО ЭК (Приложение 2 заказчика; без авторизации, как источник);
 *   POST /objects/__test/asu {items: [...]} — заменить; {reset: true} — исходная
 *   GET  /objects/feed.json, /objects/feed.csv — общий формат (Bearer OBJECTS_TOKEN);
 *   POST /objects/__test/feed {items: [...]} — заменить; {reset: true} — исходная
 */
import type { IncomingMessage } from 'node:http';

const OBJECTS_TOKEN = process.env.OBJECTS_TOKEN ?? 'demo-objects-token';

type Send = (s: number, b: unknown) => void;
type SendRaw = (s: number, body: string, contentType: string) => void;

interface Answer {
  reviewId: string;
  text: string;
  dateAnswer: string;
  key: string | null;
  at: string;
  requests: number;
}
interface Account {
  answers: Answer[];
  down: boolean;
}
const accounts = new Map<string, Account>();
const account = (name: string): Account => {
  let a = accounts.get(name);
  if (!a) accounts.set(name, (a = { answers: [], down: false }));
  return a;
};

interface FeedItem {
  code: string;
  name: string;
  address: string | null;
  enterprise_code: string;
  external_ids: Record<string, string>;
  is_active?: boolean;
}
/** Исходная выгрузка общего формата — объекты демо-стенда (коды предприятий E1–E3) и одна новая АЗС. */
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

/** GUID демо-АЗС (как у демо-объектов, см. reviews-demo-seed): DE00…0001 … DE00…0007. */
export const demoGuid = (n: number) => `DE${'0'.repeat(26)}${String(n).padStart(4, '0')}`;

/** Исходная выгрузка АСУ НПО ЭК — демо-АЗС 1–6 (предприятия выгрузки 10/20/30) и новая АЗС №7 (вымышленные данные). */
const INITIAL_ASU: Record<string, unknown>[] = [
  ...['10', '10', '20', '20', '30', '30'].map((unit, i) => asuItem(i + 1, unit, '')),
  asuItem(7, '20', 'Гродно'),
];
function asuItem(n: number, unitcode: string, town: string): Record<string, unknown> {
  return {
    objguid: demoGuid(n),
    azsnum: String(n),
    complex: String(500 + n),
    complexdesc: `АЗС ${n}`,
    typeshortname: 'АЗС',
    name1: `АЗС №${n}`,
    status: 'действующий',
    latitude: '53.9',
    longitude: '27.56',
    unit: `РУП «Условнефтепродукт-${unitcode}»`,
    unitshort: `УНП-${unitcode}`,
    unitcode,
    country: { iso: 'BY', digital: 112 },
    mailaddress: town ? `г. ${town}, ул. Новая, ${n}` : `г. Минск, ул. Условная, ${n}`,
    area: 'Минская',
    district: '',
    towntype: 'Город',
    town,
    phone: '+375 (17) 000-00-00',
    fuels: [{ id: 1, name: 'АИ-95', code: 3, price: 2.6 }],
    mode: 'круглосуточно',
    paymentmethods: [],
    services: [],
    roads: [],
    actions: [],
    photo: '',
    fuelid: [1],
  };
}
let asu: Record<string, unknown>[] = structuredClone(INITIAL_ASU);

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

export function handleRocketData(req: IncomingMessage, url: URL, send: Send, sendRaw: SendRaw): boolean {
  const rd = /^\/rocketdata\/([A-Za-z0-9_-]{1,64})(\/.*)$/.exec(url.pathname);
  if (rd) return rocketData(req, account(rd[1]!), rd[2]!, send);
  return objects(req, url.pathname, send, sendRaw);
}

function rocketData(req: IncomingMessage, acc: Account, p: string, send: Send): boolean {
  void (async () => {
    const b = req.method === 'POST' ? await readJson(req) : {};
    if (p === '/__test/answers') return send(200, acc.answers);
    if (p === '/__test/control') {
      acc.down = !!b.down;
      return send(200, { down: acc.down });
    }
    if (p === '/__test/reset') {
      acc.answers.length = 0;
      acc.down = false;
      return send(200, { ok: true });
    }
    if (p === '/answer' && req.method === 'POST') {
      if (acc.down) return send(503, { error: 'service unavailable' });
      const reviewId = str(b.Review_id);
      const text = String(b.Text ?? '').trim();
      const date = String(b.DateAnswer ?? '');
      if (!reviewId || !text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date))
        return send(400, { error: 'Review_id, DateAnswer (ГГГГ-ММ-ДДTчч:мм:сс) и Text обязательны' });
      if (/ОТКЛОНИТЬ/i.test(text)) return send(422, { error: 'ответ не прошёл модерацию площадки' });
      const key = str(req.headers['idempotency-key']);
      const prev = key ? acc.answers.find((a) => a.key === key) : undefined;
      if (prev) prev.requests++;
      else
        acc.answers.push({
          reviewId,
          text,
          dateAnswer: date,
          key,
          at: new Date().toISOString(),
          requests: 1,
        });
      return send(200, { result: 'ok' });
    }
    return send(404, { error: 'not found' });
  })();
  return true;
}

function objects(req: IncomingMessage, p: string, send: Send, sendRaw: SendRaw): boolean {
  if (p === '/objects/__test/asu' && req.method === 'POST') {
    void (async () => {
      const b = await readJson(req);
      asu = b.reset ? structuredClone(INITIAL_ASU) : ((b.items as Record<string, unknown>[]) ?? []);
      send(200, { items: asu.length });
    })();
    return true;
  }
  if (p === '/objects/asu') {
    send(200, asu);
    return true;
  }
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
