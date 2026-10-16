/** Д-097 синтез речи: настройки движка, выключенный движок, права. Сам edge-tts здесь не вызывается (нужен интернет). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Синтез речи (Д-097)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let op: string;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local');
    op = await t.login('operator1@demo.local');
  }, 60_000);
  afterAll(async () => t?.cleanup());

  it('по умолчанию — edge-tts «Светлана»; выключенный движок не озвучивает; оператору нельзя', async () => {
    const s = await t.call('GET', '/api/v1/tts/settings', admin);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ provider: 'edge', voice: 'ru-RU-SvetlanaNeural', rate: -4 });
    expect((await t.call('GET', '/api/v1/tts/settings', op)).status).toBe(403);
    expect((await t.call('POST', '/api/v1/tts/synthesize', op, { text: 'Проверка' })).status).toBe(403);
    const noUrl = await t.call('PUT', '/api/v1/tts/settings', admin, { provider: 'http' });
    expect(noUrl.status).toBe(400);
    const off = await t.call('PUT', '/api/v1/tts/settings', admin, { provider: 'off' });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const r = await t.call('POST', '/api/v1/tts/synthesize', admin, { text: 'Проверка' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('tts_off');
    expect((await t.call('POST', '/api/v1/tts/synthesize', admin, { text: '' })).status).toBe(400);
  });
});
