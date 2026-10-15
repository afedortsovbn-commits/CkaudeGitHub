/** Д-065: обновление системы из файла — загрузка частями, проверка описания, подтверждение, очередь службы. */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

/** Минимальный tar (ustar) из файлов. */
function tar(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257, 'latin1');
    h.write('00', 263);
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

describe.skipIf(!ADMIN_URL)('Обновление системы из файла (Д-065)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  beforeAll(async () => {
    t = await createTestApp();
    t.ctx.config.UPDATES_DIR = mkdtempSync(join(tmpdir(), 'cc-updates-'));
    admin = await t.login('admin@test.local');
  }, 60_000);
  afterAll(async () => t?.cleanup());

  const upload = async (file: Buffer, name = 'cc-update-2.ccupd', chunk = 1000) => {
    const c = await t.call('POST', '/api/v1/system-update', admin, { fileName: name, size: file.length });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    for (let off = 0; off < file.length; off += chunk) {
      const r = await t.http().inject({
        method: 'PUT',
        url: `/api/v1/system-update/${c.body.id}/chunk?offset=${off}`,
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/octet-stream' },
        payload: file.subarray(off, off + chunk),
      });
      expect(r.statusCode, r.body).toBe(200);
    }
    return (await t.call('GET', `/api/v1/system-update/${c.body.id}`, admin)).body;
  };

  it('не файл обновления — «файл не подходит» с объяснением', async () => {
    const u = await upload(Buffer.from('просто текст, а не tar'.repeat(10)));
    expect(u.status).toBe('invalid');
    expect(u.error).toMatch(/описания обновления|не файл обновления/);
  });

  it('файл с описанием: готов к установке; старт — только при работающей службе обновления', async () => {
    const images = Buffer.from('образы');
    const manifest = {
      format: 'cc-update/1',
      version: '2.0',
      title: 'Тестовое обновление',
      stopsIntake: true,
      intakeStopMinutes: 2,
      changes: [{ id: 'Д-065', title: 'Обновление из файла', important: true }],
      blocks: [{ name: 'api', title: 'API', effect: 'rolling' }],
      warnings: [{ level: 'critical', text: 'Прерывается приём обращений' }],
      release: { services: ['api'] },
      images: {
        file: 'images.tar.gz',
        sha256: createHash('sha256').update(images).digest('hex'),
        size: images.length,
      },
    };
    const u = await upload(
      tar({ 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'images.tar.gz': images }),
    );
    expect(u.status, u.error).toBe('ready');
    expect(u.manifest).toMatchObject({ version: '2.0', stopsIntake: true, deploy: null });
    expect(u.compatible).toBe(true);
    // Без подтверждения — нельзя; без службы обновления — понятный отказ.
    expect((await t.call('POST', `/api/v1/system-update/${u.id}/start`, admin, {})).status).toBe(400);
    const down = await t.call('POST', `/api/v1/system-update/${u.id}/start`, admin, { confirmed: true });
    expect(down.status).toBe(409);
    expect(down.body.error).toBe('updater_down');
    await t.pool.query(`INSERT INTO system_updater (id, seen_at) VALUES (1, now())`);
    const ok = await t.call('POST', `/api/v1/system-update/${u.id}/start`, admin, { confirmed: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('queued');
    const st = await t.call('GET', '/api/v1/system-update', admin);
    expect(st.body.updater.alive).toBe(true);
    expect(st.body.items[0]).toMatchObject({ status: 'queued', version: '2.0' });
  });

  it('без права «Обновление системы» — отказ', async () => {
    const op = await t.login('operator1@demo.local');
    expect((await t.call('GET', '/api/v1/system-update', op)).status).toBe(403);
  });
});
