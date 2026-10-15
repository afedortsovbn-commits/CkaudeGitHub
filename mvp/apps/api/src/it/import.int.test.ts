/** Д-064: загрузка обращений из Excel — шаблон, проверка, загрузка, повтор (дубли), правка по ID, ошибки по ячейкам. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildXlsx, readXlsx } from '../lib/xlsx';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Загрузка обращений из Excel (Д-064)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let topic: string;
  let sub: string;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local');
    const r = await t.pool.query(
      `SELECT p.name AS topic, s.name AS sub FROM topic s JOIN topic p ON p.id = s.parent_id
        WHERE s.is_active AND p.is_active ORDER BY p.sort_order, s.sort_order LIMIT 1`,
    );
    topic = r.rows[0].topic;
    sub = r.rows[0].sub;
    // Поле «Суть обращения», как в справочнике заказчика (в демо-справочнике тестовой базы его нет).
    await t.pool.query(
      `INSERT INTO field_def (id, topic_id, key, label, type)
       SELECT gen_random_uuid(), p.id, 'issue_summary', 'Суть обращения (описание вопроса клиента)', 'text'
         FROM topic p WHERE p.name = $1 AND p.parent_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM field_def f WHERE f.key = 'issue_summary')`,
      [topic],
    );
  }, 60_000);
  afterAll(async () => t?.cleanup());

  const raw = async (method: string, url: string, payload?: Buffer, query = '') =>
    t.http().inject({
      method: method as 'GET',
      url: url + query,
      headers: {
        authorization: `Bearer ${admin}`,
        ...(payload ? { 'content-type': 'application/octet-stream', 'x-filename': 'test.xlsx' } : {}),
      },
      payload,
    });
  const check = async (file: Buffer, query = '') => {
    const r = await raw('POST', '/api/v1/import/conversations/check', file, query);
    expect(r.statusCode, r.body).toBe(200);
    return JSON.parse(r.body);
  };
  const header = ['Код во внешней системе', 'Канал', 'Дата и время поступления', 'Тема', 'Подтема', 'Суть обращения'];

  it('шаблон — лист «Обращения» с колонками и лист «Описание полей»', async () => {
    const r = await raw('GET', '/api/v1/import/conversations/template');
    expect(r.statusCode).toBe(200);
    const sheets = readXlsx(r.rawPayload);
    expect(sheets.map((s) => s.name)).toEqual(['Обращения', 'Описание полей']);
    expect(sheets[0]!.rows[0]).toEqual(expect.arrayContaining(['ID обращения', 'Канал', 'Тема', 'Подтема']));
  });

  it('проверка: новые, ошибки по ячейкам, дубль строки файла; загрузка; повтор — без изменений', async () => {
    const file = buildXlsx('Обращения', header, [
      ['IT-1', 'Телефон', '15.09.2026 10:00', topic, sub, 'Первое обращение'],
      ['IT-2', 'Чат на сайте', '15.09.2026 11:30:15', topic, sub, 'Второе обращение'],
      ['IT-3', 'Голубиная почта', '31.02.2026 10:00', 'Нет такой темы', '', 'С ошибками'],
      ['', 'Телефон', '16.09.2026 09:00', topic, sub, 'Повтор'],
      ['', 'Телефон', '16.09.2026 09:00', topic, sub, 'Повтор'],
    ]);
    const c = await check(file);
    expect(c.summary).toMatchObject({ rows: 5, create: 3, error: 1, duplicate: 1, update: 0 });
    const bad = c.problems.find((p: { row: number }) => p.row === 4);
    expect(bad.errors.map((e: { column: string }) => e.column)).toEqual(
      expect.arrayContaining(['Канал', 'Дата и время поступления', 'Тема']),
    );
    // Файл с отметками: колонка результата и красные ячейки ошибок.
    const marked = await raw('GET', `/api/v1/import/batches/${c.id}/file`);
    expect(marked.statusCode).toBe(200);
    expect(readXlsx(marked.rawPayload)[0]!.rows[3]![1]).toContain('Ошибка');

    const a = await t.call('POST', `/api/v1/import/batches/${c.id}/apply`, admin, {});
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ created: 3, updated: 0 });
    const again = await t.call('POST', `/api/v1/import/batches/${c.id}/apply`, admin, {});
    expect(again.status).toBe(409);

    const conv = await t.pool.query(
      `SELECT c.status, c.channel_kind, c.fields, to_char(c.created_at AT TIME ZONE 'Europe/Minsk', 'HH24:MI:SS') AS t,
              (SELECT count(*)::int FROM message m WHERE m.conversation_id = c.id) AS msgs
         FROM conversation c WHERE external_code = 'IT-2'`,
    );
    expect(conv.rows[0]).toMatchObject({ status: 'closed', channel_kind: 'webchat', t: '11:30:15', msgs: 1 });
    expect(conv.rows[0].fields.issue_summary).toBe('Второе обращение');

    // Тот же файл ещё раз: по кодам — без изменений, без кода — дубль обращения в базе.
    const c2 = await check(file);
    expect(c2.summary).toMatchObject({ create: 0, same: 2, duplicate: 2, error: 1 });
  });

  it('правка по ID: меняется только изменённое поле, пустая ячейка не трогает значение', async () => {
    const id = (await t.pool.query(`SELECT id FROM conversation WHERE external_code = 'IT-1'`)).rows[0].id;
    const file = buildXlsx('Обращения', ['ID обращения', 'Суть обращения', 'Тема'], [[id, 'Исправленная суть', '']]);
    const c = await check(file);
    expect(c.summary).toMatchObject({ update: 1, create: 0, error: 0 });
    expect(c.summary.changes).toEqual([{ column: 'Суть обращения', count: 1 }]);
    const a = await t.call('POST', `/api/v1/import/batches/${c.id}/apply`, admin, {});
    expect(a.body).toMatchObject({ updated: 1 });
    const r = await t.pool.query(`SELECT fields, topic_id FROM conversation WHERE id = $1`, [id]);
    expect(r.rows[0].fields.issue_summary).toBe('Исправленная суть');
    expect(r.rows[0].topic_id).not.toBeNull();
  });

  it('без права «Загрузка обращений» — отказ', async () => {
    const op = await t.login('operator1@demo.local');
    const r = await t.call('GET', '/api/v1/import/batches', op);
    expect(r.status).toBe(403);
  });
});
