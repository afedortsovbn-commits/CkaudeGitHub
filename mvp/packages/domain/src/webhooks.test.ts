import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attempt, backoffSec, signBody } from './webhooks';

describe('webhooks: подпись и повторы', () => {
  it('задержка растёт экспоненциально до потолка', () => {
    expect([1, 2, 3, 4, 10].map((n) => backoffSec(n, 300))).toEqual([2, 4, 8, 16, 300]);
  });

  it('подпись — HMAC-SHA256 от «timestamp.тело», заголовки события', async () => {
    const seen: { headers: Record<string, string>; body: string; url: string }[] = [];
    const r = await attempt(
      {
        id: 's',
        url: 'http://x/hook',
        secret: 'whsec_test',
        headers: { 'X-Tenant': 'demo' },
        timeout_ms: 1000,
        failures: 0,
      },
      {
        id: 'd1',
        event_type: 'conversation.bot_turn',
        payload: { id: 'e', type: 't', occurredAt: '', data: { replyUrl: '{{base}}/api' } },
      },
      {
        baseUrl: 'https://cc.example/',
        maxBackoffS: 60,
        maxAgeH: 1,
        now: () => new Date(1_700_000_000_000),
        send: async (req) => {
          seen.push(req);
          return { status: 204 };
        },
      },
    );
    expect(r.ok).toBe(true);
    const h = seen[0]!.headers;
    expect(seen[0]!.body).toContain('https://cc.example/api');
    expect(h['x-cc-timestamp']).toBe('1700000000');
    expect(h['x-tenant']).toBe('demo');
    expect(h['x-cc-delivery']).toBe('d1');
    const expected = createHmac('sha256', 'whsec_test').update(`1700000000.${seen[0]!.body}`).digest('hex');
    expect(h['x-cc-signature']).toBe(`sha256=${expected}`);
    expect(signBody('whsec_test', 1700000000, seen[0]!.body)).toBe(h['x-cc-signature']);
  });

  it('ошибка соединения и не-2xx — неудача с понятной причиной', async () => {
    const sub = { id: 's', url: 'http://x', secret: 'k', headers: {}, timeout_ms: 1000, failures: 0 };
    const d = { id: 'd', event_type: 't', payload: { id: 'e', type: 't', occurredAt: '', data: {} } };
    const o = { baseUrl: 'https://x', maxBackoffS: 1, maxAgeH: 1 };
    expect((await attempt(sub, d, { ...o, send: async () => ({ status: 500 }) })).error).toBe('HTTP 500');
    const e = await attempt(sub, d, {
      ...o,
      send: async () => {
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
    });
    expect(e).toMatchObject({ ok: false, error: 'Ошибка соединения: ECONNREFUSED' });
  });
});
