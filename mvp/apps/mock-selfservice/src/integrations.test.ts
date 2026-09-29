import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { analyze, verify } from './integrations';

describe('мок внешних систем Ф9', () => {
  it('анализ: тональность по словам клиента', () => {
    expect(analyze(['Очень недоволен обслуживанием']).sentiment).toBe('негативная');
    expect(analyze(['Спасибо!']).sentiment).toBe('позитивная');
    expect(analyze(['Где ближайшая АЗС?'])).toEqual({
      sentiment: 'нейтральная',
      summary: 'Где ближайшая АЗС?',
    });
  });

  it('проверка подписи: верная, чужая, устаревшая', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"id":"1"}';
    const sig = `sha256=${createHmac('sha256', 's1').update(`${ts}.${body}`).digest('hex')}`;
    const req = (t: string, s: string) =>
      ({ headers: { 'x-cc-timestamp': t, 'x-cc-signature': s } }) as unknown as IncomingMessage;
    expect(verify('s1', req(ts, sig), body)).toBe(true);
    expect(verify('s2', req(ts, sig), body)).toBe(false);
    expect(verify('s1', req(String(Number(ts) - 3600), sig), body)).toBe(false);
  });
});
