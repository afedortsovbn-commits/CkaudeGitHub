import { PermanentError } from '@cc/connector-kit';
import { InboundMessageSchema, RocketDataChannelConfigSchema } from '@cc/contracts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseRdDate,
  parseRdReview,
  rdDate,
  RdFormatError,
  RocketDataError,
  sendRdAnswer,
} from './rocketdata-api';
import { reviewToInbound } from './reviews';

const channel = {
  id: '0190a000-0000-7000-8000-000000000001',
  config: RocketDataChannelConfigSchema.parse({}),
};

/** Отзыв в формате описания заказчика (данные вымышленные). */
const body = {
  TicketMapId: 100,
  DateReceipt: '2016-11-23T10:08:05',
  StationGuid: '5EB806F7-5AD4-1DD3-E053-BF0BA8C05F2F',
  StationType: 'АЗС',
  StationNum: '62',
  EmitentName: 'РУП «Условнефтепродукт»',
  Message: '  Не смог расплатиться картой.  ',
  ClientName: 'Иван',
  Link: 'https://yandex.by/maps/org/1/reviews',
  Site: 'yandex.ru',
};

const without = (o: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

describe('отзыв Rocket Data по описанию заказчика (Ф13)', () => {
  it('разбор: поля, номер числом, дата по Минску, площадка по сайту, GUID без дефисов', () => {
    const r = parseRdReview(JSON.stringify(body));
    expect(r).toMatchObject({ TicketMapId: '100', StationNum: '62', Site: 'yandex.ru' });
    const m = reviewToInbound(r, channel);
    expect(
      InboundMessageSchema.parse({ ...m, id: '0190a000-0000-7000-8000-0000000000aa', receivedAt: 1 }),
    ).toBeTruthy();
    expect(m).toMatchObject({
      channelKind: 'review',
      identity: { kind: 'other', value: `review:${channel.id}:100` },
      contact: { displayName: 'Иван (Яндекс Карты)' },
      body: 'Не смог расплатиться картой.',
      meta: {
        review: {
          id: '100',
          platform: 'yandex',
          rating: null,
          url: 'https://yandex.by/maps/org/1/reviews',
          publishedAt: '2016-11-23T07:08:05.000Z',
          locationId: '5EB806F75AD41DD3E053BF0BA8C05F2F',
          locationCode: '62',
          stationType: 'АЗС',
          emitent: 'РУП «Условнефтепродукт»',
          urgent: false,
          skipAnswered: false,
        },
      },
    });
  });

  it('пример из описания (не строгий JSON: «типографские» кавычки, нет запятых, SITE заглавными) принимается', () => {
    const sample = `{
    "TicketMapId": "100"
    "DateReceipt": "2016-11-23T10:08:05",
    "StationGuid": "5EB806F7-5AD4-1DD3-E053-BF0BA8C05F2F",
        "StationType": "АЗС",
        "StationNum": "62",
    "EmitentName": "РУП ‘Условнефтепродукт’"
    "Message":"Не смог расплатиться картой. ",
    "ClientName": "Иван"
    "Link" : "https://yandex.by/maps/org/1/reviews",
    “SITE”:”yandex.ru”
  }`;
    expect(parseRdReview(sample)).toMatchObject({
      TicketMapId: '100',
      Site: 'yandex.ru',
      ClientName: 'Иван',
    });
  });

  it('ошибки формата — с перечнем полей: нет обязательных, не дата, не объект, не JSON', () => {
    const fail = (b: string) => {
      try {
        parseRdReview(b);
      } catch (e) {
        expect(e).toBeInstanceOf(RdFormatError);
        return e as RdFormatError;
      }
      throw new Error('ожидалась ошибка формата');
    };
    const rest = without(body, 'Message', 'StationGuid');
    expect(
      fail(JSON.stringify(rest))
        .details.map((d) => d.field)
        .sort(),
    ).toEqual(['Message', 'StationGuid']);
    expect(fail(JSON.stringify({ ...body, DateReceipt: 'вчера' })).details[0]?.field).toBe('DateReceipt');
    expect(fail('[1]').message).toMatch(/объект/);
    expect(fail('<xml/>').message).toMatch(/не JSON/);
    // ClientName необязателен.
    const noName = without(body, 'ClientName');
    expect(reviewToInbound(parseRdReview(JSON.stringify(noName)), channel).contact?.displayName).toBe(
      'Автор отзыва (Яндекс Карты)',
    );
  });

  it('ключ идемпотентности: тот же отзыв — тот же ключ; изменён текст — новый', () => {
    const k = (b: object) => reviewToInbound(parseRdReview(JSON.stringify(b)), channel).externalId;
    expect(k(body)).toBe(k({ ...body, DateReceipt: '2016-11-24T00:00:00', Link: 'https://x' }));
    expect(k(body)).not.toBe(k({ ...body, Message: 'Разобрались, спасибо' }));
  });

  it('даты: без пояса — Минск, с поясом — как есть, русский формат; ответ — время Минска без пояса', () => {
    expect(parseRdDate('2026-10-01T12:00:00')).toBe('2026-10-01T09:00:00.000Z');
    expect(parseRdDate('2026-10-01T12:00:00Z')).toBe('2026-10-01T12:00:00.000Z');
    expect(parseRdDate('01.10.2026 12:00')).toBe('2026-10-01T09:00:00.000Z');
    expect(parseRdDate('не дата')).toBeNull();
    expect(rdDate(new Date('2026-10-01T21:30:05Z'))).toBe('2026-10-02T00:30:05');
  });
});

describe('ответ на отзыв в Rocket Data', () => {
  let server: Server;
  let base = '';
  const seen: { method: string; url: string; type?: string; key?: string; body: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString()));
      req.on('end', () => {
        seen.push({
          method: req.method!,
          url: req.url!,
          type: req.headers['content-type'],
          key: req.headers['idempotency-key'] as string | undefined,
          body: b,
        });
        const status = req.url === '/gone' ? 404 : req.url === '/busy' ? 503 : 200;
        res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('POST {Review_id, DateAnswer, Text} в UTF-8; 404 — без повторов, 503 — повтор', async () => {
    const at = new Date('2016-11-23T07:08:05Z');
    await sendRdAnswer(`${base}/answer`, { reviewId: '100', text: 'Спасибо', at, idempotencyKey: 'm-1' });
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/answer', key: 'm-1' });
    expect(seen.at(-1)!.type).toMatch(/application\/json; charset=utf-8/);
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      Review_id: '100',
      DateAnswer: '2016-11-23T10:08:05',
      Text: 'Спасибо',
    });
    const a = { reviewId: '1', text: 'x', at, idempotencyKey: 'm' };
    await expect(sendRdAnswer(`${base}/gone`, a)).rejects.toBeInstanceOf(PermanentError);
    const busy = sendRdAnswer(`${base}/busy`, a);
    await expect(busy).rejects.toBeInstanceOf(RocketDataError);
    await expect(busy).rejects.not.toBeInstanceOf(PermanentError);
  });
});
