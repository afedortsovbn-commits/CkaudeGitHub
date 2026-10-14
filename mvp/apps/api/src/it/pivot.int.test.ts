/**
 * Д-041. Конструктор отчётов на реальной PostgreSQL: каждое поле и каждый показатель каталога строятся без ошибок
 * SQL; цифры, итоги (средние в итогах считает база), перекрёстная таблица, период сравнения со сдвигом дат,
 * фильтры значений и условие по показателю, предупреждение о сложном отчёте, сохранённые отчёты и Excel.
 */
import { newId } from '@cc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

interface Row {
  g: number;
  k: (string | null)[];
  l: (string | null)[];
  v: (number | null)[];
  c?: (number | null)[];
}
interface Result {
  needConfirm: boolean;
  rows: Row[];
  warnings: string[];
  dims: { id: string }[];
  estimate: { seconds: number; heavy: boolean };
}

describe.skipIf(!ADMIN_URL)('Конструктор отчётов (Д-041)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  const id: Record<string, string> = {};
  const run = async (query: Record<string, unknown>, confirm = true) => {
    const r = await t.call('POST', '/api/v1/reports/pivot/run', admin, {
      query: { from: '2026-03-10', to: '2026-03-11', grain: 'day', ...query },
      confirm,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Result;
  };
  const total = (r: Result) =>
    r.rows.find((x) => x.k.every((k) => k === null) && x.g === 2 ** x.k.length - 1);

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin@test.local');
    const one = async (sql: string) => (await t.pool.query(sql)).rows[0];
    const ch = await one(`SELECT id FROM channel WHERE kind = 'webchat' LIMIT 1`);
    const ed = await one(`SELECT id, enterprise_id, department_id FROM enterprise_department LIMIT 1`);
    const tp = await one(`SELECT id, path FROM topic WHERE level = 2 LIMIT 1`);
    const op = await one(`SELECT id FROM app_user WHERE email = 'operator1@demo.local'`);
    id.op = op.id;
    id.ent = ed.enterprise_id;
    id.contact = newId();
    await t.pool.query(`INSERT INTO contact (id, display_name) VALUES ($1, 'Клиент')`, [id.contact]);
    // 10.03 10:00 Минск: чат принят через 10 с, закрыт через 5 мин, оценка 5; чат пропущен; звонок принят через 30 с.
    // 11.03: чат принят через 50 с, оценка 3. 03.03 (период сравнения): один чат.
    const conv = async (o: {
      at: string;
      kind?: string;
      assignedS?: number | null;
      closedS?: number | null;
      score?: number;
    }) => {
      const cid = newId();
      const at = Date.parse(o.at);
      const s = (x: number | null | undefined) =>
        x === null || x === undefined ? null : new Date(at + x * 1000);
      await t.pool.query(
        `INSERT INTO conversation (id, channel_id, channel_kind, contact_id, status, assignee_id, enterprise_id,
           department_id, topic_id, topic_path, created_at, queued_at, assigned_at, closed_at, fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, '{"issue_type": "Жалоба"}')`,
        [
          cid,
          ch.id,
          o.kind ?? 'webchat',
          id.contact,
          o.closedS === null ? 'queued' : 'closed',
          o.assignedS === null ? null : id.op,
          ed.enterprise_id,
          ed.department_id,
          tp.id,
          tp.path,
          new Date(at),
          s(o.assignedS),
          s(o.closedS),
        ],
      );
      if (o.score)
        await t.pool.query(
          `INSERT INTO csat_rating (id, conversation_id, channel_kind, score) VALUES ($1, $2, 'webchat', $3)`,
          [newId(), cid, o.score],
        );
      return cid;
    };
    id.c1 = await conv({ at: '2026-03-10T07:00:00Z', assignedS: 10, closedS: 310, score: 5 });
    await conv({ at: '2026-03-10T08:00:00Z', assignedS: null, closedS: 60 });
    const voice = await conv({ at: '2026-03-10T09:00:00Z', kind: 'voice', assignedS: 30, closedS: 200 });
    await conv({ at: '2026-03-11T07:00:00Z', assignedS: 50, closedS: 400, score: 3 });
    await conv({ at: '2026-03-03T07:00:00Z', assignedS: 20, closedS: 100 });
    await t.pool.query(
      `INSERT INTO call (id, conversation_id, direction, node, state, client_channel, agent_user_id, started_at,
         connected_at, ended_at)
       VALUES ($1, $2, 'in', 'a1', 'ended', 'c1', $3, '2026-03-10T09:00:00Z', '2026-03-10T09:00:30Z', '2026-03-10T09:03:20Z')`,
      [newId(), voice, id.op],
    );
    await t.pool.query(
      `INSERT INTO ticket (id, number, conversation_id, enterprise_department_id, enterprise_id, department_id,
         topic_id, topic_path, summary, due_date, created_by, status, created_at)
       VALUES ($1, 990001, $2, $3, $4, $5, $6, $7, 'суть', '2026-03-12', $8, 'new', '2026-03-10T07:10:00Z')`,
      [newId(), id.c1, ed.id, ed.enterprise_id, ed.department_id, tp.id, tp.path, id.op],
    );
    await t.pool.query(
      `INSERT INTO agent_status_log (id, user_id, status, started_at, ended_at)
       VALUES ($1, $2, 'ready', '2026-03-10T06:00:00Z', '2026-03-10T08:00:00Z')`,
      [newId(), id.op],
    );
  }, 90_000);
  afterAll(async () => t?.cleanup());

  it('каталог: разделы, поля, показатели; без права «Отчёты» — 403', async () => {
    const m = await t.call('GET', '/api/v1/reports/pivot/model', admin);
    expect(m.status).toBe(200);
    expect(m.body.sections.length).toBeGreaterThan(8);
    expect(m.body.measures.length).toBeGreaterThan(40);
    const op = await t.login('operator1@demo.local');
    expect((await t.call('GET', '/api/v1/reports/pivot/model', op)).status).toBe(403);
    const v = await t.call('GET', '/api/v1/reports/pivot/values?field=conv.channel&q=чат', admin);
    expect(v.body.map((x: { id: string }) => x.id)).toContain('webchat');
  });

  it('каждый показатель и каждое поле строятся без ошибок SQL', async () => {
    const m = (await t.call('GET', '/api/v1/reports/pivot/model', admin)).body as {
      dims: { id: string; facts: string[] }[];
      measures: { id: string; fact: string }[];
    };
    const ids = m.measures.map((x) => x.id);
    for (let i = 0; i < ids.length; i += 20) await run({ values: ids.slice(i, i + 20) });
    for (const d of m.dims) {
      const values = d.facts.map((f) => m.measures.find((x) => x.fact === f)!.id);
      const r = await run({
        rows: [d.id],
        values,
        filters: [{ field: d.id, mode: 'out', values: ['__nothing__'] }],
        compare: { from: '2026-03-03', to: '2026-03-04' },
      });
      expect(r.warnings, d.id).toEqual([]);
    }
  });

  it('цифры, итоги и средние в итогах, перекрёстная таблица', async () => {
    const r = await run({
      rows: ['conv.channel'],
      cols: ['time.period'],
      values: ['conv.count', 'conv.missed', 'conv.waitAvg', 'csat.avg', 'call.count'],
    });
    const cell = (ch: string | null, day: string | null) =>
      r.rows.find(
        (x) => x.k[0] === ch && x.k[1] === day && x.g === (ch === null ? 2 : 0) + (day === null ? 1 : 0),
      );
    expect(cell('webchat', '2026-03-10')!.v.slice(0, 2)).toEqual([2, 1]);
    expect(cell('webchat', null)!.v[0]).toBe(3);
    // Среднее ожидание в итоге — по всем принятым (10, 30, 50), а не среднее средних.
    expect(cell(null, null)!.v[2]).toBe(30);
    expect(cell(null, null)!.v[3]).toBe(4);
    expect(cell('voice', null)!.v[4]).toBe(1);
    expect(cell('webchat', '2026-03-10')!.l).toEqual(['Чат на сайте', '10.03.2026']);
  });

  it('период сравнения сдвигается к основному; фильтр и условие по показателю', async () => {
    const r = await run({
      rows: ['time.period'],
      values: ['conv.count'],
      compare: { from: '2026-03-03', to: '2026-03-04' },
    });
    const d10 = r.rows.find((x) => x.k[0] === '2026-03-10')!;
    expect(d10.v[0]).toBe(3);
    expect(d10.c![0]).toBe(1);
    const f = await run({
      rows: ['staff.operator'],
      values: ['conv.count', 'staff.worked'],
      filters: [{ field: 'conv.channel', values: ['voice'] }],
    });
    const opRow = f.rows.find((x) => x.k[0] === id.op)!;
    expect(opRow.v).toEqual([1, 7200]);
    expect(f.warnings.join(' ')).toContain('Канал');
    const cond = await run({
      rows: ['time.period'],
      values: ['conv.count'],
      filters: [{ field: 'time.period', measure: 'conv.count', op: '>', value: 1 }],
    });
    expect(cond.rows.filter((x) => x.g === 0).map((x) => x.k[0])).toEqual(['2026-03-10']);
    const bad = await run({ rows: ['ticket.responsible'], values: ['conv.count', 'ticket.count'] });
    expect(bad.warnings.join(' ')).toContain('Обращений');
    expect(total(bad)!.v).toEqual([null, 1]);
  });

  it('сложный отчёт — сначала оценка и вопрос, по подтверждению — строится', async () => {
    await t.pool.query(
      `INSERT INTO system_setting (key, value) VALUES ('report.pivot_warn_s', '0.0000001')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const q = { rows: ['conv.channel'], values: ['conv.count'] };
    const r = await run(q, false);
    expect(r.needConfirm).toBe(true);
    expect(r.estimate.heavy).toBe(true);
    expect((await run(q, true)).needConfirm).toBe(false);
    await t.pool.query(`DELETE FROM system_setting WHERE key = 'report.pivot_warn_s'`);
  });

  it('сохранённые отчёты и выгрузка в Excel', async () => {
    const c = await t.call('POST', '/api/v1/reports/pivot/views', admin, {
      name: 'Мой',
      isShared: true,
      config: { rows: ['conv.channel'] },
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const sup = await t.login('supervisor@demo.local');
    const list = await t.call('GET', '/api/v1/reports/pivot/views', sup);
    expect(list.body.find((v: { id: string }) => v.id === c.body.id)).toMatchObject({
      mine: false,
      name: 'Мой',
    });
    expect((await t.call('DELETE', `/api/v1/reports/pivot/views/${c.body.id}`, sup)).status).toBe(403);
    expect((await t.call('DELETE', `/api/v1/reports/pivot/views/${c.body.id}`, admin)).status).toBe(204);
    const x = await t.http().inject({
      method: 'POST',
      url: '/api/v1/reports/pivot/xlsx',
      headers: { authorization: `Bearer ${admin}` },
      payload: {
        title: 'Тест',
        header: ['Канал', 'Обращений'],
        rows: [
          ['Чат', 3],
          ['Итого', 4],
        ],
      },
    });
    expect(x.statusCode, x.body.slice(0, 300)).toBe(200);
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});
