/** Интеграционные тесты графика работы: пожелания, составление, ручная правка, публикация, контроль перерывов. */
import { checkBreaks } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('График работы (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  const MONTH = '2027-02';

  const one = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0];

  beforeAll(async () => {
    t = await createTestApp();
    tok.admin = await t.login('admin@test.local');
    tok.op1 = await t.login('operator1@demo.local');
    tok.sup = await t.login('supervisor@demo.local');
    for (const [k, e] of Object.entries({
      op1: 'operator1@demo.local',
      op2: 'operator2@demo.local',
      sup: 'supervisor@demo.local',
    }))
      id[k] = (await one('SELECT id FROM app_user WHERE email = $1', [e])).id;
  }, 120_000);
  afterAll(async () => t?.cleanup());

  const call = (m: string, path: string, who: string, body?: unknown) =>
    t.call(m, `/api/v1${path}`, tok[who], body);

  it('права: оператор не управляет графиком, но видит свой', async () => {
    expect((await call('GET', `/schedule/month?month=${MONTH}`, 'op1')).status).toBe(403);
    expect((await call('GET', '/schedule/me', 'op1')).status).toBe(200);
    expect((await call('GET', `/schedule/month?month=${MONTH}`, 'sup')).status).toBe(200);
  });

  it('пожелания на месяц и постоянные, правила, составление, правка ячейки и публикация', async () => {
    const staff = await call('GET', `/schedule/staff?month=${MONTH}`, 'admin');
    expect(staff.status).toBe(200);
    const ids = (staff.body as { userId: string }[]).map((s) => s.userId);
    expect(ids).toContain(id.op1);
    expect(ids).not.toContain(id.sup);

    // op1 — только на февраль без ночных; op2 — не может 10–12 февраля (только на месяц).
    const pr = await call('PUT', `/schedule/staff/${id.op1}/prefs`, 'admin', {
      shiftLengths: [12],
      night: 'no',
      weekdays: {},
      month: MONTH,
    });
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);
    const rule = await call('POST', `/schedule/staff/${id.op2}/rules`, 'admin', {
      kind: 'unavailable',
      dateFrom: `${MONTH}-10`,
      dateTo: `${MONTH}-12`,
      month: MONTH,
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const s2 = (await call('GET', `/schedule/staff?month=${MONTH}`, 'admin')).body as {
      userId: string;
      prefsForMonth: boolean;
      prefs: { night: string };
      rules: { id: string; month: string | null }[];
    }[];
    const o1 = s2.find((s) => s.userId === id.op1)!;
    expect(o1.prefsForMonth).toBe(true);
    expect(o1.prefs.night).toBe('no');
    // в другом месяце — постоянные пожелания (по умолчанию)
    const march = (await call('GET', `/schedule/staff?month=2027-03`, 'admin')).body as typeof s2;
    expect(march.find((s) => s.userId === id.op1)!.prefs.night).toBe('ok');
    expect(march.find((s) => s.userId === id.op2)!.rules).toHaveLength(0);

    const g = await call('POST', '/schedule/month/generate', 'admin', { month: MONTH });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const m = g.body as {
      status: string;
      shifts: {
        id: string;
        userId: string;
        date: string;
        isNight: boolean;
        manual: boolean;
        breaks: { startAt: string; endAt: string }[];
      }[];
    };
    expect(m.status).toBe('draft');
    expect(m.shifts.length).toBeGreaterThan(0);
    expect(m.shifts.some((s) => s.userId === id.op1 && s.isNight)).toBe(false);
    expect(
      m.shifts.some((s) => s.userId === id.op2 && s.date >= `${MONTH}-10` && s.date <= `${MONTH}-12`),
    ).toBe(false);
    // перерывы не пересекаются
    const br = m.shifts.flatMap((s) => s.breaks).sort((a, b) => a.startAt.localeCompare(b.startAt));
    expect(br.length).toBeGreaterThan(0);
    for (let k = 1; k < br.length; k++) expect(br[k]!.startAt >= br[k - 1]!.endAt).toBe(true);

    // ручная правка: op2 ночью 10-го — сохраняется при повторном составлении
    const tpl = (await call('GET', '/schedule/templates', 'admin')).body as { id: string; code: string }[];
    const night = tpl.find((x) => x.code === 'Н12')!;
    const put = await call('PUT', '/schedule/month/shift', 'admin', {
      month: MONTH,
      userId: id.op2,
      date: `${MONTH}-10`,
      templateId: night.id,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const again = (await call('POST', '/schedule/month/generate', 'admin', { month: MONTH }))
      .body as typeof m;
    const manual = again.shifts.find((s) => s.userId === id.op2 && s.date === `${MONTH}-10`)!;
    expect(manual.manual).toBe(true);
    expect(manual.breaks.length).toBe(4);

    // «Мой график» — только после публикации
    expect(((await call('GET', '/schedule/me', 'op1')).body as unknown[]).length).toBe(0);
    expect((await call('POST', '/schedule/month/publish', 'admin', { month: MONTH })).status).toBe(200);

    // правило на месяц — сделать постоянным; пожелания — сохранить постоянно
    const r2 = s2.find((s) => s.userId === id.op2)!.rules[0]!;
    expect((await call('POST', `/schedule/rules/${r2.id}/permanent`, 'admin')).status).toBe(200);
    expect(
      (
        await call('PUT', `/schedule/staff/${id.op1}/prefs`, 'admin', {
          shiftLengths: [12],
          night: 'no',
          weekdays: {},
          permanentFrom: MONTH,
        })
      ).status,
    ).toBe(200);
    const after = (await call('GET', `/schedule/staff?month=2027-03`, 'admin')).body as typeof s2;
    expect(after.find((s) => s.userId === id.op1)!.prefs.night).toBe('no');
    expect(after.find((s) => s.userId === id.op1)!.prefsForMonth).toBe(false);
    expect(after.find((s) => s.userId === id.op2)!.rules[0]!.month).toBeNull();
  });

  it('контроль перерывов: не ушёл — уведомление супервизору один раз; «мой график» видит смену', async () => {
    // Текущая опубликованная смена op1 с перерывом, начавшимся 10 минут назад.
    const now = new Date();
    const month = new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 7);
    await t.pool.query(
      `INSERT INTO schedule_month (month, status) VALUES ($1, 'published') ON CONFLICT (month) DO UPDATE SET status = 'published'`,
      [`${month}-01`],
    );
    const date = new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
    await t.pool.query(
      'DELETE FROM schedule_break WHERE shift_id IN (SELECT id FROM schedule_shift WHERE user_id = $1 AND on_date = $2)',
      [id.op1, date],
    );
    await t.pool.query('DELETE FROM schedule_shift WHERE user_id = $1 AND on_date = $2', [id.op1, date]);
    const shift = await one(
      `INSERT INTO schedule_shift (id, month, user_id, on_date, template_id, start_at, end_at, manual)
       VALUES (gen_random_uuid(), $1, $2, $3, '01a11800-0000-7000-8000-000000000001', now() - interval '3 hours', now() + interval '5 hours', true)
       RETURNING id`,
      [`${month}-01`, id.op1, date],
    );
    await t.pool.query(
      `INSERT INTO schedule_break (id, shift_id, kind, start_at, end_at)
       VALUES (gen_random_uuid(), $1, 'short', now() - interval '10 minutes', now() + interval '5 minutes'),
              (gen_random_uuid(), $1, 'short', now() - interval '40 minutes', now() - interval '25 minutes')`,
      [shift.id],
    );
    await t.pool.query(
      `INSERT INTO agent_status (user_id, status, since) VALUES ($1, 'ready', now() - interval '1 hour')
       ON CONFLICT (user_id) DO UPDATE SET status = 'ready', since = now() - interval '1 hour'`,
      [id.op1],
    );
    const before = Number(
      (await one(`SELECT count(*) AS n FROM notification WHERE kind = 'break' AND user_id = $1`, [id.sup])).n,
    );
    const r = await checkBreaks(t.pool);
    expect(r.lateStart).toBeGreaterThanOrEqual(1);
    // второй перерыв (закончился) — оператор в работе, значит вернулся: уведомления нет
    const again = await checkBreaks(t.pool);
    expect(again).toEqual({ lateStart: 0, lateEnd: 0 });
    const n = Number(
      (await one(`SELECT count(*) AS n FROM notification WHERE kind = 'break' AND user_id = $1`, [id.sup])).n,
    );
    expect(n - before).toBe(r.lateStart);
    const me = (await call('GET', '/schedule/me', 'op1')).body as { id: string; breaks: unknown[] }[];
    expect(me.find((s) => s.id === shift.id)?.breaks).toHaveLength(2);
  });
});
