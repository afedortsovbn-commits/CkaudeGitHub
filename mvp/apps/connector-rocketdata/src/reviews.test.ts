import { PermanentError } from '@cc/connector-kit';
import { InboundMessageSchema, RocketDataChannelConfigSchema } from '@cc/contracts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RocketDataApi, RocketDataError, type RdReview } from './rocketdata-api';
import { reviewToInbound } from './reviews';

const channel = {
  id: '0190a000-0000-7000-8000-000000000001',
  config: RocketDataChannelConfigSchema.parse({ api_url: 'http://rd', api_token: 't' }),
};
const review: RdReview = {
  id: 'r-1',
  location_id: 'loc-7',
  location_code: 'AZS-7',
  platform: 'yandex',
  rating: 2,
  text: '  Долго ждал на кассе  ',
  author_name: 'Иван',
  published_at: '2026-09-29T10:00:00Z',
  updated_at: '2026-09-29T10:00:00Z',
  url: 'https://yandex.by/maps/org/1/reviews',
  answer: null,
};

describe('отзыв Rocket Data → входящее сообщение (Ф13)', () => {
  it('поля отзыва, объект, срочность низкой оценки; сообщение проходит схему контракта', () => {
    const m = reviewToInbound(review, channel);
    expect(
      InboundMessageSchema.parse({ ...m, id: '0190a000-0000-7000-8000-0000000000aa', receivedAt: 1 }),
    ).toBeTruthy();
    expect(m).toMatchObject({
      channelKind: 'review',
      identity: { kind: 'other', value: `review:${channel.id}:r-1` },
      contact: { displayName: 'Иван (Яндекс Карты)' },
      body: 'Долго ждал на кассе',
      meta: {
        review: {
          id: 'r-1',
          platform: 'yandex',
          rating: 2,
          locationId: 'loc-7',
          locationCode: 'AZS-7',
          answered: false,
          urgent: true,
          skipAnswered: true,
        },
      },
    });
  });

  it('ключ идемпотентности: тот же отзыв — тот же ключ; изменён текст или оценка — новый; ответ и updated_at — не влияют', () => {
    const k = (r: RdReview) => reviewToInbound(r, channel).externalId;
    expect(k(review)).toBe(k({ ...review, updated_at: '2026-09-30T00:00:00Z', answer: { text: 'Спасибо' } }));
    expect(k(review)).not.toBe(k({ ...review, text: 'Исправили, спасибо' }));
    expect(k(review)).not.toBe(k({ ...review, rating: 4 }));
  });

  it('оценка без текста, без автора; высокая оценка не срочная; уже отвеченный отмечен', () => {
    const m = reviewToInbound(
      { ...review, text: null, author_name: null, rating: 5, answer: { text: 'Спасибо!' } },
      channel,
    );
    expect(m.body).toBe('Оценка 5 из 5 без текста');
    expect(m.contact?.displayName).toBe('Автор отзыва (Яндекс Карты)');
    expect(m.meta?.review).toMatchObject({ urgent: false, answered: true });
  });
});

describe('клиент API Rocket Data (контракт-заглушка)', () => {
  let server: Server;
  let base = '';
  const seen: { method: string; url: string; auth?: string; key?: string; body?: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({
          method: req.method!,
          url: req.url!,
          auth: req.headers.authorization,
          key: req.headers['idempotency-key'] as string | undefined,
          body,
        });
        const send = (s: number, b: unknown) =>
          res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(b));
        if (req.url!.startsWith('/v1/reviews?'))
          return send(200, { items: [review, { id: 'bad', rating: 9 }], next_cursor: 'c2' });
        if (req.url === '/v1/reviews/gone/answer') return send(404, { error: 'review not found' });
        if (req.url === '/v1/reviews/busy/answer') return send(503, { error: 'try later' });
        if (req.url === '/v1/reviews/banned/answer') return send(200, { status: 'rejected', error: 'мат' });
        return send(200, { id: 'a-1', status: 'pending' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('страница отзывов: параметры, токен, некорректные записи отдельно', async () => {
    const api = new RocketDataApi(base, 'secret-token');
    const p = await api.reviews('2026-09-01T00:00:00.000Z', 'c1');
    expect(p.items.map((i) => i.id)).toEqual(['r-1']);
    expect(p.invalid).toHaveLength(1);
    expect(p.nextCursor).toBe('c2');
    const q = new URL(seen.at(-1)!.url, 'http://x').searchParams;
    expect(q.get('updated_since')).toBe('2026-09-01T00:00:00.000Z');
    expect(q.get('cursor')).toBe('c1');
    expect(seen.at(-1)!.auth).toBe('Bearer secret-token');
  });

  it('ответ: ключ идемпотентности; 404 и «отклонён» — без повторов, 503 — повтор', async () => {
    const api = new RocketDataApi(base, 't');
    await expect(api.answer('r-1', 'Спасибо', 'msg-1')).resolves.toMatchObject({
      id: 'a-1',
      status: 'pending',
    });
    expect(seen.at(-1)).toMatchObject({ method: 'POST', key: 'msg-1', body: '{"text":"Спасибо"}' });
    await expect(api.answer('gone', 'x', 'm')).rejects.toBeInstanceOf(PermanentError);
    await expect(api.answer('banned', 'x', 'm')).rejects.toThrow(/отклонила ответ: мат/);
    const busy = api.answer('busy', 'x', 'm');
    await expect(busy).rejects.toBeInstanceOf(RocketDataError);
    await expect(busy).rejects.not.toBeInstanceOf(PermanentError);
  });
});
