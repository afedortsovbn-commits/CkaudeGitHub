/**
 * Интеграционные тесты отчётов Ф10 на реальной PostgreSQL. Основной тест — «эталон»: в журнал `event`
 * записывается сгенерированная история обращений, статусов операторов и тикетов за два прошлых дня
 * (формат — как у доменных событий), цифры каждого отчёта сверяются с посчитанными вручную.
 * Далее — область видимости (демо-сценарий 9), CSV, реестр просроченных, панель супервизора и сквозная
 * проверка, что настоящие действия через API попадают в отчёты (полнота журнала).
 */
import { newId } from '@cc/contracts';
import { ingestInbound } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp } from './setup';

type Row = Record<string, unknown>;

describe.skipIf(!ADMIN_URL)('Отчёты Ф10 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const id: Record<string, string> = {};
  const tok: Record<string, string> = {};
  const path: Record<string, string[]> = {};

  const one = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0];
  const report = async (kind: string, qs: string, who = 'admin') => {
    const r = await t.call('GET', `/api/v1/reports/${kind}?${qs}`, tok[who]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { rows: Row[]; totals: Row | null; columns: { key: string }[]; notes: string[] };
  };
  const byLabel = (rows: Row[], label: string) => {
    const r = rows.find((x) => x.label === label);
    expect(r, `строка «${label}» в ${JSON.stringify(rows.map((x) => x.label))}`).toBeTruthy();
    return r!;
  };
  const PERIOD = 'from=2026-03-10&to=2026-03-11';
  const csv = (url: string) =>
    t.http().inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok.admin}` } });

  // ---------------------------------------------------------------- генератор журнала

  const T = Date.parse('2026-03-10T07:00:00Z'); // 10:00 по Минску
  const at = (s: number) => new Date(T + s * 1000).toISOString();
  const ev = (type: string, when: string, data: Row) =>
    t.pool.query(
      `INSERT INTO event (id, type, version, occurred_at, source, data) VALUES ($1, $2, 1, $3, 'test', $4)`,
      [newId(), type, when, JSON.stringify(data)],
    );

  interface Conv {
    cid: string;
    channel: string;
    ent: string | undefined;
    topic: string;
    important?: boolean;
  }
  const refOf = (c: Conv, status: string, assignee: string | null | undefined = null, extra: Row = {}) => ({
    conversationId: c.cid,
    contactId: id.contact,
    channelKind: c.channel,
    status,
    queueId: id.queue,
    assigneeId: assignee ?? null,
    enterpriseId: c.ent,
    departmentId: id.ops,
    topicPath: path[c.topic],
    topicId: path[c.topic]!.at(-1),
    objectId: null,
    isImportant: !!c.important,
    ...extra,
  });
  const upd = (c: Conv, s: number, status: string, assignee: string | null | undefined, extra: Row = {}) =>
    ev('conversation.updated', at(s), refOf(c, status, assignee, extra));
  const created = (c: Conv, s: number, status: string) => ev('conversation.created', at(s), refOf(c, status));
  const msg = (c: Conv, s: number, status: string, assignee: string | null | undefined, m: Row) =>
    ev('conversation.message_created', at(s), {
      ...refOf(c, status, assignee),
      message: { id: newId(), direction: 'out', body: 'x', authorUserId: null, attachments: [], ...m },
    });
  const conv = (channel: string, ent: string | undefined, topic: string, important = false): Conv => ({
    cid: newId(),
    channel,
    ent,
    topic,
    important,
  });
  const ticket = (tid: string, cid: string, when: string, type: string, data: Row) =>
    ev(type, when, {
      ticketId: tid,
      number: 1,
      conversationId: cid,
      departmentId: id.ops,
      topicId: path.fuel!.at(-1),
      topicPath: path.fuel,
      isImportant: false,
      createdBy: id.op1,
      notifyUserIds: [],
      objectId: null,
      channelKind: 'webchat',
      ...data,
    });

  async function generate() {
    const agent = (user: string | undefined, when: string, status: string) =>
      ev('agent.status_changed', when, { userId: user, status, prevStatus: null, reasonId: null });
    // Операторы: op1 — готов 06:00–07:30Z, перерыв до 08:00Z, готов до 15:00Z; op2 — готов с вечера накануне до 01:00Z.
    await agent(id.op1, '2026-03-10T06:00:00Z', 'ready');
    await agent(id.op1, '2026-03-10T07:30:00Z', 'break');
    await agent(id.op1, '2026-03-10T08:00:00Z', 'ready');
    await agent(id.op1, '2026-03-10T15:00:00Z', 'offline');
    await agent(id.op2, '2026-03-09T20:00:00Z', 'ready');
    await agent(id.op2, '2026-03-10T01:00:00Z', 'offline');

    // C1 — звонок: IVR → очередь 15 с → op1 → разговор и закрытие «Решено» (обработка 300 с) → оценка 5.
    const c1 = conv('voice', id.e1, 'quality', true);
    await created(c1, 0, 'bot');
    await upd(c1, 30, 'queued', null, { action: 'queued' });
    await upd(c1, 40, 'offered', id.op1, { action: 'offered' });
    await upd(c1, 45, 'active', id.op1, { action: 'accepted' });
    await upd(c1, 345, 'closed', id.op1, {
      action: 'closed',
      disposition: 'Решено на 1-й линии',
      dispositionKind: 'resolved',
    });
    await upd(c1, 400, 'closed', id.op1, { action: 'csat', score: 5, agentUserId: id.op1 });
    // C2 — звонок, клиент ушёл из очереди через 40 с (пропущенный).
    const c2 = conv('voice', id.e1, 'fuel');
    await created(c2, 100, 'bot');
    await upd(c2, 110, 'queued', null, { action: 'queued' });
    await upd(c2, 150, 'closed', null, {
      action: 'closed',
      disposition: 'Пропущенный звонок',
      dispositionKind: 'abandoned',
    });
    // C3 — короткий сброс (3 с): в SL не учитывается.
    const c3 = conv('voice', id.e1, 'fuel');
    await created(c3, 200, 'bot');
    await upd(c3, 210, 'queued', null, { action: 'queued' });
    await upd(c3, 213, 'closed', null, {
      action: 'closed',
      disposition: 'Пропущенный звонок',
      dispositionKind: 'abandoned',
    });
    // C4 — чат: автоответ, предложение op1 → отказ, op2 принял через 70 с, первый ответ через 100 с, обработка 630 с.
    const c4 = conv('webchat', id.e1, 'fuel');
    await created(c4, 1000, 'queued');
    await msg(c4, 1010, 'queued', null, { meta: { auto: 'greeting' } });
    await upd(c4, 1020, 'offered', id.op1, { action: 'offered' });
    await upd(c4, 1040, 'queued', null, { action: 'declined', userId: id.op1 });
    await upd(c4, 1050, 'offered', id.op2, { action: 'offered' });
    await upd(c4, 1070, 'active', id.op2, { action: 'accepted' });
    await msg(c4, 1100, 'active', id.op2, { authorUserId: id.op2 });
    await upd(c4, 1700, 'closed', id.op2, {
      action: 'closed',
      disposition: 'Решено на 1-й линии',
      dispositionKind: 'resolved',
    });
    await upd(c4, 1750, 'closed', id.op2, { action: 'csat', score: 4, agentUserId: id.op2 });
    // C5 — чат предприятия «Юг»: ожидание 20 с, ответ через 30 с, передача на 2-ю линию (тикет T1).
    const c5 = conv('webchat', id.e2, 'bonus');
    await created(c5, 2000, 'queued');
    await upd(c5, 2020, 'active', id.op1, { action: 'accepted' });
    await msg(c5, 2030, 'active', id.op1, { authorUserId: id.op1 });
    await upd(c5, 2330, 'waiting_2nd_line', id.op1, { action: 'escalated' });
    // C6 — Telegram, особо важное: ожидание 5 с, ответ через 10 с, передача на 2-ю линию (тикет T2, просрочен).
    const c6 = conv('telegram', id.e1, 'fuel', true);
    await created(c6, 3000, 'queued');
    await upd(c6, 3005, 'active', id.op1, { action: 'accepted' });
    await msg(c6, 3010, 'active', id.op1, { authorUserId: id.op1 });
    await upd(c6, 3100, 'waiting_2nd_line', id.op1, { action: 'escalated' });
    // C7 — бот сам закрыл диалог (в очередь не попадало).
    const c7 = conv('webchat', id.e1, 'fuel');
    await created(c7, 4000, 'bot');
    await upd(c7, 4100, 'closed', null, { action: 'closed', auto: true, dispositionKind: 'auto_closed' });
    // C8 — чат ещё ждёт в очереди.
    const c8 = conv('webchat', id.e1, 'fuel');
    await created(c8, 5000, 'queued');
    // C9 — звонок: ответ через 2 с, прямой перевод на «Север / Лояльность» (очередь), op2 ответил через 30 с.
    const c9 = conv('voice', id.e1, 'fuel');
    await created(c9, 6000, 'bot');
    await upd(c9, 6010, 'queued', null, { action: 'queued' });
    await upd(c9, 6012, 'active', id.op1, { action: 'accepted' });
    await upd(c9, 6100, 'queued', null, {
      action: 'transferred',
      transferKind: 'direct',
      direct: true,
      directEnterpriseId: id.e1,
      directDepartmentId: id.loy,
      byUserId: id.op1,
    });
    await upd(c9, 6130, 'active', id.op2, { action: 'accepted' });
    await upd(c9, 6230, 'closed', id.op2, {
      action: 'closed',
      disposition: 'Решено на 1-й линии',
      dispositionKind: 'resolved',
    });

    // Тикет T1 («Юг»): создан, открыт, закрыт, возвращён (ожидание 1 ч), закрыт снова, принят (ожидание 2 ч) — в срок.
    const t1 = newId();
    const base1 = {
      enterpriseId: id.e2,
      dueDate: '2026-03-12',
      responsibleIds: [id.r2],
      curatorIds: [id.c1],
    };
    await ticket(t1, c5.cid, at(2330), 'ticket.created', { ...base1, status: 'new' });
    await ticket(t1, c5.cid, at(3000), 'ticket.status_changed', {
      ...base1,
      status: 'in_work',
      action: 'opened',
    });
    await ticket(t1, c5.cid, '2026-03-11T08:00:00Z', 'ticket.status_changed', {
      ...base1,
      status: 'approval',
      action: 'answered',
      answeredAt: '2026-03-11T08:00:00Z',
      answerMethodId: id.phone,
    });
    await ticket(t1, c5.cid, '2026-03-11T09:00:00Z', 'ticket.status_changed', {
      ...base1,
      status: 'rework',
      action: 'returned',
    });
    await ticket(t1, c5.cid, '2026-03-11T10:00:00Z', 'ticket.status_changed', {
      ...base1,
      status: 'approval',
      action: 'answered',
      answeredAt: '2026-03-11T10:00:00Z',
      answerMethodId: id.phone,
    });
    await ticket(t1, c5.cid, '2026-03-11T12:00:00Z', 'ticket.status_changed', {
      ...base1,
      status: 'closed',
      action: 'approved',
      closedInTime: true,
      answeredAt: '2026-03-11T10:00:00Z',
      answerMethodId: id.phone,
    });
    await ev('conversation.updated', '2026-03-11T12:00:00Z', {
      ...refOf(c5, 'closed', id.op1),
      action: 'closed',
      disposition: 'Передать на 2-ю линию',
      dispositionKind: 'escalate',
    });
    // Тикет T2 («Север»): срок 10.03, в работе — на конец периода (11.03) просрочен на 1 день.
    const t2 = newId();
    const base2 = {
      enterpriseId: id.e1,
      dueDate: '2026-03-10',
      responsibleIds: [id.r1],
      curatorIds: [id.c1],
    };
    await ticket(t2, c6.cid, at(3100), 'ticket.created', { ...base2, status: 'new', isImportant: true });
    await ticket(t2, c6.cid, at(3200), 'ticket.status_changed', {
      ...base2,
      status: 'in_work',
      action: 'opened',
      isImportant: true,
    });
  }

  beforeAll(async () => {
    t = await createTestApp();
    id.e1 = (await one(`SELECT id FROM enterprise WHERE code = 'E1'`)).id;
    id.e2 = (await one(`SELECT id FROM enterprise WHERE code = 'E2'`)).id;
    id.ops = (await one(`SELECT id FROM department WHERE code = 'OPS'`)).id;
    id.loy = (await one(`SELECT id FROM department WHERE code = 'LOY'`)).id;
    id.queue = (await one(`SELECT id FROM queue WHERE name = 'Общая'`)).id;
    id.phone = (await one(`SELECT id FROM answer_method WHERE code = 'phone'`)).id;
    id.contact = newId();
    for (const [k, name] of Object.entries({
      fuel: 'Топливо',
      quality: 'Качество топлива',
      bonus: 'Бонусная программа',
    }))
      path[k] = (await one(`SELECT path FROM topic WHERE name = $1`, [name])).path;
    for (const [k, e] of Object.entries({
      op1: 'operator1@demo.local',
      op2: 'operator2@demo.local',
      r1: 'resp1@demo.local',
      r2: 'resp2@demo.local',
      c1: 'curator1@demo.local',
    }))
      id[k] = (await one(`SELECT id FROM app_user WHERE email = $1`, [e])).id;
    tok.admin = await t.login('admin@test.local');
    tok.sup = await t.login('supervisor@demo.local'); // область — только «Север»
    tok.op1 = await t.login('operator1@demo.local');
    await generate();
  }, 120_000);
  afterAll(async () => t?.cleanup());

  // ---------------------------------------------------------------- эталон

  it('обращения по каналам, результатам и предприятиям', async () => {
    const r = await report('conversations', `${PERIOD}&groupBy=channel`);
    expect(r.totals).toMatchObject({
      received: 9,
      closed: 7,
      resolved: 3,
      escalated: 2,
      abandoned: 2,
      auto_closed: 1,
      open: 1,
      important: 2,
    });
    expect(byLabel(r.rows, 'Телефон')).toMatchObject({ received: 4, closed: 4, resolved: 2, abandoned: 2 });
    expect(byLabel(r.rows, 'Чат на сайте')).toMatchObject({
      received: 4,
      resolved: 1,
      escalated: 1,
      open: 1,
    });
    expect(byLabel(r.rows, 'Telegram')).toMatchObject({ received: 1, escalated: 1, important: 1 });
    const res = await report('conversations', `${PERIOD}&groupBy=result`);
    expect(byLabel(res.rows, 'Решено на 1-й линии').received).toBe(3);
    expect(byLabel(res.rows, 'Пропущенный звонок').received).toBe(2);
    expect(byLabel(res.rows, 'На 2-й линии').received).toBe(1);
    expect(byLabel(res.rows, 'Не закрыто').received).toBe(1);
    const ent = await report('conversations', `${PERIOD}&groupBy=enterprise`);
    expect(byLabel(ent.rows, 'Предприятие «Север»').received).toBe(8);
    expect(byLabel(ent.rows, 'Предприятие «Юг»').received).toBe(1);
    const topic = await report('conversations', `${PERIOD}&groupBy=subtopic`);
    expect(byLabel(topic.rows, 'Топливо / Качество топлива').received).toBe(1);
    // Фильтры: тема (поддерево), «особо важные», канал, день вне периода.
    expect((await report('conversations', `${PERIOD}&topicId=${path.fuel![0]}`)).totals!.received).toBe(8);
    expect((await report('conversations', `${PERIOD}&important=true`)).totals!.received).toBe(2);
    expect((await report('conversations', `${PERIOD}&channel=voice`)).totals!.received).toBe(4);
    expect((await report('conversations', 'from=2026-03-11&to=2026-03-11')).totals!.received).toBe(0);
  });

  it('SL и доля пропущенных', async () => {
    const r = await report('service-level', `${PERIOD}&groupBy=channel`);
    expect(r.totals).toMatchObject({
      entered: 8,
      answered: 6,
      within_sl: 4,
      abandoned: 1,
      short_abandoned: 1,
      other: 0,
      sl_pct: 57.1,
      missed_pct: 14.3,
      max_wait: 70,
    });
    expect(r.totals!.asa).toBeCloseTo(142 / 6, 3);
    expect(byLabel(r.rows, 'Телефон')).toMatchObject({
      entered: 5,
      answered: 3,
      within_sl: 2,
      abandoned: 1,
      sl_pct: 50,
      missed_pct: 25,
    });
    expect(byLabel(r.rows, 'Чат на сайте')).toMatchObject({ answered: 2, within_sl: 1, sl_pct: 50 });
    expect(byLabel(r.rows, 'Telegram')).toMatchObject({ answered: 1, sl_pct: 100 });
    const days = await report('service-level', `${PERIOD}&groupBy=day`);
    expect(days.rows.map((x) => x.label)).toEqual(['2026-03-10']);
  });

  it('ASA/AHT по операторам', async () => {
    const r = await report('handling', `${PERIOD}&groupBy=operator`);
    const op1 = byLabel(r.rows, 'Иванов Пётр (оператор)');
    expect(op1).toMatchObject({ answered: 4, max_wait: 20, handled: 4, handle_total: 793 });
    expect(op1.asa).toBeCloseTo(10.5, 3);
    expect(op1.aht).toBeCloseTo(198.25, 3);
    const op2 = byLabel(r.rows, 'Кузнецова Ольга (оператор)');
    expect(op2).toMatchObject({
      answered: 2,
      asa: 50,
      max_wait: 70,
      handled: 2,
      aht: 365,
      handle_total: 730,
    });
    expect(r.totals).toMatchObject({ answered: 6, handled: 6, handle_total: 1523 });
    // Фильтр по оператору.
    const only = await report('handling', `${PERIOD}&groupBy=channel&operatorId=${id.op2}`);
    expect(only.totals).toMatchObject({ answered: 2, handled: 2 });
  });

  it('время первого ответа в чатах', async () => {
    const r = await report('first-response', `${PERIOD}&groupBy=channel`);
    expect(r.totals).toMatchObject({ total: 4, replied: 3, no_reply: 1, median_frt: 30, within_pct: 100 });
    expect(r.totals!.avg_frt).toBeCloseTo(140 / 3, 3);
    expect(r.totals!.p90_frt).toBeCloseTo(86, 3);
    expect(byLabel(r.rows, 'Чат на сайте')).toMatchObject({ total: 3, replied: 2, no_reply: 1 });
    const ops = await report('first-response', `${PERIOD}&groupBy=operator`);
    expect(byLabel(ops.rows, 'Кузнецова Ольга (оператор)')).toMatchObject({ replied: 1, avg_frt: 100 });
  });

  it('загрузка и статусы операторов', async () => {
    const r = await report('agents', PERIOD);
    expect(byLabel(r.rows, 'Иванов Пётр (оператор)')).toMatchObject({
      ready_s: 30600,
      break_s: 1800,
      wrap_s: 0,
      online_s: 32400,
      answered: 4,
      declined: 1,
      handled: 4,
      aht: 198.25,
      csat_avg: 5,
    });
    expect(byLabel(r.rows, 'Кузнецова Ольга (оператор)')).toMatchObject({
      ready_s: 14400,
      answered: 2,
      declined: 0,
      handled: 2,
      aht: 365,
      csat_avg: 4,
    });
    expect(byLabel(r.rows, 'Попов Сергей (оператор)')).toMatchObject({ online_s: 0, answered: 0 });
  });

  it('CSAT', async () => {
    const r = await report('csat', `${PERIOD}&groupBy=operator`);
    expect(r.totals).toMatchObject({ n: 2, avg_score: 4.5, csat_pct: 100, s5: 1, s4: 1, s1: 0 });
    expect(byLabel(r.rows, 'Иванов Пётр (оператор)')).toMatchObject({ n: 1, avg_score: 5 });
  });

  it('2-я линия: поступило, в срок, просрочка, возвраты, согласование, способы ответа, прямые переводы', async () => {
    const r = await report('second-line', PERIOD);
    const south = byLabel(r.rows, 'Предприятие «Юг» / Служба эксплуатации АЗС');
    expect(south).toMatchObject({
      received: 1,
      closed: 1,
      closed_in_time: 1,
      closed_late: 0,
      returns: 1,
      resolve_days_avg: 1.2,
      approval_wait_h: 1.5,
      answer_methods: 'Телефон: 1',
      overdue_open: 0,
      awaiting: 0,
    });
    const north = byLabel(r.rows, 'Предприятие «Север» / Служба эксплуатации АЗС');
    expect(north).toMatchObject({ received: 1, closed: 0, overdue_open: 1, overdue_max_days: 1 });
    expect(byLabel(r.rows, 'Предприятие «Север» / Отдел программы лояльности')).toMatchObject({
      received: 0,
      direct_transfers: 1,
    });
    expect(r.totals).toMatchObject({
      received: 2,
      closed: 1,
      returns: 1,
      overdue_open: 1,
      direct_transfers: 1,
    });
    // На конец 10.03 тикет T1 ещё в работе, T2 — срок сегодня, не просрочен.
    const d1 = await report('second-line', 'from=2026-03-10&to=2026-03-10');
    expect(d1.totals).toMatchObject({ received: 2, closed: 0, overdue_open: 0, awaiting: 0 });
    // Разрез по ответственным и кураторам.
    const a = await report('second-line', `${PERIOD}&groupBy=assignee`);
    expect(byLabel(a.rows, 'Козлов Дмитрий (куратор) (куратор)')).toMatchObject({ received: 2 });
    expect(byLabel(a.rows, 'Морозова Елена (ответственный) (ответственный)')).toMatchObject({ closed: 1 });
    expect(a.totals).toBeNull();
    // Фильтр «ответственный/куратор» и «особо важные».
    expect((await report('second-line', `${PERIOD}&assigneeId=${id.r1}`)).totals).toMatchObject({
      received: 1,
    });
    expect((await report('second-line', `${PERIOD}&important=true`)).totals).toMatchObject({ received: 1 });
  });

  // ---------------------------------------------------------------- права (демо-сценарий 9)

  it('область видимости: супервизор «Севера» не видит данных «Юга» в отчётах', async () => {
    const c = await report('conversations', `${PERIOD}&groupBy=enterprise`, 'sup');
    expect(c.totals!.received).toBe(8);
    expect(c.rows.map((x) => x.label)).not.toContain('Предприятие «Юг»');
    const sl = await report('service-level', PERIOD, 'sup');
    expect(sl.totals!.entered).toBe(7);
    const tl = await report('second-line', PERIOD, 'sup');
    expect(tl.rows.map((x) => x.label).join()).not.toContain('Юг');
    expect(tl.totals!.received).toBe(1);
    // Явный фильтр по чужому предприятию — пусто, а не ошибка и не чужие данные.
    const other = await report('conversations', `${PERIOD}&enterpriseId=${id.e2}`, 'sup');
    expect(other.totals!.received).toBe(0);
    // Оператору отчёты недоступны.
    expect((await t.call('GET', `/api/v1/reports/conversations?${PERIOD}`, tok.op1)).status).toBe(403);
  });

  it('CSV: разделитель «;», BOM, десятичная запятая, выгрузка в аудите', async () => {
    const r = await csv(`/api/v1/reports/service-level?${PERIOD}&groupBy=channel&format=csv`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('report-service-level-2026-03-10-2026-03-11.csv');
    const text = r.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(
      'Канал;Поступило в очередь;Отвечено;Отвечено в пределах SL;Пропущено;Короткие сбросы;Возврат в IVR/бот;SL, %;Доля пропущенных, %;Среднее ожидание (ASA);Макс. ожидание',
    );
    expect(lines.at(-1)).toBe('Итого;8;6;4;1;1;0;57,1;14,3;24;70');
    const a = await one(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'report' AND action = 'export'`,
    );
    expect(a.n).toBeGreaterThan(0);
  });

  it('проверка параметров: неизвестный отчёт, чужой разрез, слишком длинный период', async () => {
    expect((await t.call('GET', '/api/v1/reports/nope', tok.admin)).status).toBe(404);
    expect((await t.call('GET', '/api/v1/reports/agents?groupBy=channel', tok.admin)).status).toBe(400);
    expect(
      (await t.call('GET', '/api/v1/reports/csat?from=2025-01-01&to=2026-03-01', tok.admin)).status,
    ).toBe(400);
    expect(
      (await t.call('GET', '/api/v1/reports/csat?from=2026-03-05&to=2026-03-01', tok.admin)).status,
    ).toBe(400);
    const cat = await t.call('GET', '/api/v1/reports', tok.sup);
    expect(cat.body.map((x: Row) => x.kind)).toContain('overdue');
  });

  // ---------------------------------------------------------------- реестр, панель, живой журнал

  async function liveConversation(ext: string) {
    const channelId = (await one(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`)).id;
    const r = await withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId,
        channelKind: 'webchat',
        externalId: ext,
        identity: { kind: 'webchat', value: `rep-${ext}` },
        body: 'Вопрос',
        attachments: [],
        receivedAt: Date.now(),
      }),
    );
    return r.conversationId;
  }

  it('реестр просроченных — текущие открытые тикеты с истёкшим сроком, в области видимости', async () => {
    const mk = async (ent: string | undefined, dueShift: number, status: string, ext: string) => {
      const cid = await liveConversation(ext);
      const ed = (
        await one(`SELECT id FROM enterprise_department WHERE enterprise_id = $1 AND department_id = $2`, [
          ent,
          id.ops,
        ])
      ).id;
      const tid = newId();
      await t.pool.query(
        `INSERT INTO ticket (id, conversation_id, enterprise_department_id, enterprise_id, department_id, topic_id,
                             topic_path, status, summary, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Суть', (now() AT TIME ZONE 'Europe/Minsk')::date + $9::int, $10)`,
        [tid, cid, ed, ent, id.ops, path.fuel!.at(-1), path.fuel, status, dueShift, id.op1],
      );
      await t.pool.query(
        `INSERT INTO ticket_assignee (ticket_id, user_id, kind) VALUES ($1, $2, 'responsible')`,
        [tid, id.r1],
      );
      return tid;
    };
    await mk(id.e1, -3, 'in_work', 'ov-1'); // просрочен на 3 дня
    await mk(id.e2, -1, 'rework', 'ov-2'); // «Юг», просрочен на 1 день
    await mk(id.e1, 0, 'new', 'ov-3'); // срок сегодня — не просрочен
    await mk(id.e1, -5, 'approval', 'ov-4'); // на согласовании — не просрочка ответственного
    const all = await report('overdue', '');
    expect(all.rows.map((x) => x.overdue_days)).toEqual([3, 1]);
    expect(all.rows[0]).toMatchObject({
      status: 'В работе',
      responsibles: 'Васильев Андрей (ответственный)',
    });
    const sup = await report('overdue', '', 'sup');
    expect(sup.rows.map((x) => x.overdue_days)).toEqual([3]);
    const file = await csv('/api/v1/reports/overdue?format=csv');
    expect(file.body.split('\r\n')[0]).toContain('№ тикета;Создан;Предприятие');
  });

  it('панель супервизора: пороги из настроек, очереди в области видимости, SL за сегодня', async () => {
    const a = await liveConversation('pn-1');
    const b = await liveConversation('pn-2');
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [a, id.e1]);
    await t.pool.query(`UPDATE conversation SET enterprise_id = $2 WHERE id = $1`, [b, id.e2]);
    await t.call('PATCH', '/api/v1/settings', tok.admin, {
      'supervisor.thresholds': {
        waitWarnS: 30,
        waitCritS: 90,
        queueWarn: 2,
        queueCrit: 4,
        breakWarnS: 600,
        slTargetPct: 90,
      },
    });
    const adm = (await t.call('GET', '/api/v1/supervisor/overview', tok.admin)).body;
    const sup = (await t.call('GET', '/api/v1/supervisor/overview', tok.sup)).body;
    const q = (o: { queues: Row[] }) => o.queues.find((x) => x.name === 'Общая')!;
    const exp = await one(
      `SELECT count(*)::int AS all, count(*) FILTER (WHERE enterprise_id = $1)::int AS north
         FROM conversation WHERE status = 'queued' AND queue_id = $2`,
      [id.e1, id.queue],
    );
    expect(q(adm).waiting).toBe(exp.all);
    expect(q(sup).waiting).toBe(exp.north);
    expect(exp.all - exp.north).toBeGreaterThan(0);
    expect(sup.thresholds).toMatchObject({ waitWarnS: 30, queueCrit: 4, slTargetPct: 90 });
    expect(sup.active.some((x: Row) => x.status === 'queued')).toBe(true);
    expect(q(adm)).toHaveProperty('todaySlPct');
    const bad = await t.call('PATCH', '/api/v1/settings', tok.admin, {
      'supervisor.thresholds': { waitWarnS: -1 },
    });
    expect(bad.status).toBe(400);
  });

  it('живой журнал: действия через API попадают в отчёты за сегодня (статусы, обработка, 2-я линия)', async () => {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Minsk' });
    const P = `from=${today}&to=${today}`;
    const op = tok.op1!;
    expect((await t.call('POST', '/api/v1/agent-status', op, { status: 'ready' })).status).toBe(200);
    const cid = await liveConversation('live-1');
    expect((await t.call('POST', `/api/v1/conversations/${cid}/take`, op)).status).toBe(200);
    await t.call('POST', `/api/v1/conversations/${cid}/messages`, op, { body: 'Здравствуйте' });
    await t.call('PATCH', `/api/v1/conversations/${cid}`, op, {
      topicId: path.fuel!.at(-1),
      enterpriseId: id.e1,
      departmentId: id.ops,
      fields: { station: '12', fuel_date: '2026-09-01' },
    });
    const disp = (await one(`SELECT id FROM disposition WHERE code = 'resolved'`)).id;
    const close = await t.call('POST', `/api/v1/conversations/${cid}/close`, op, { dispositionId: disp });
    expect(close.status, JSON.stringify(close.body)).toBe(200);

    const conv = await report('conversations', `${P}&groupBy=result`);
    expect(byLabel(conv.rows, 'Решено на 1-й линии').received).toBeGreaterThanOrEqual(1);
    const closedEv = await one(
      `SELECT data FROM event WHERE type = 'conversation.updated' AND data ->> 'conversationId' = $1
          AND data ->> 'action' = 'closed'`,
      [cid],
    );
    expect(closedEv.data).toMatchObject({
      dispositionKind: 'resolved',
      dispositionId: disp,
      topicId: expect.any(String),
    });
    const h = await report('handling', `${P}&groupBy=operator`);
    expect(byLabel(h.rows, 'Иванов Пётр (оператор)').handled).toBeGreaterThanOrEqual(1);
    const fr = await report('first-response', `${P}&groupBy=operator`);
    expect(byLabel(fr.rows, 'Иванов Пётр (оператор)').replied).toBeGreaterThanOrEqual(1);
    const ag = await report('agents', P);
    expect(Number(byLabel(ag.rows, 'Иванов Пётр (оператор)').online_s)).toBeGreaterThan(0);

    // Передача на 2-ю линию: событие тикета несёт назначенных и канал.
    const cid2 = await liveConversation('live-2');
    await t.call('POST', `/api/v1/conversations/${cid2}/take`, op);
    await t.call('PATCH', `/api/v1/conversations/${cid2}`, op, {
      topicId: path.fuel!.at(-1),
      enterpriseId: id.e1,
      departmentId: id.ops,
      fields: { station: '12', fuel_date: '2026-09-01' },
    });
    const d = await t.call(
      'GET',
      `/api/v1/tickets/defaults?enterpriseId=${id.e1}&departmentId=${id.ops}&topicId=${path.fuel!.at(-1)}`,
      op,
    );
    const esc = await t.call('POST', `/api/v1/conversations/${cid2}/escalate`, op, {
      enterpriseId: id.e1,
      departmentId: id.ops,
      topicId: path.fuel!.at(-1),
      summary: 'Суть',
      responsibleIds: d.body.responsibleIds,
      curatorIds: d.body.curatorIds,
      dueDate: d.body.dueDate,
    });
    expect(esc.status, JSON.stringify(esc.body)).toBe(200);
    const tev = await one(
      `SELECT data FROM event WHERE type = 'ticket.created' AND data ->> 'conversationId' = $1`,
      [cid2],
    );
    expect(tev.data).toMatchObject({ channelKind: 'webchat', responsibleIds: [id.r1], curatorIds: [id.c1] });
    const sl = await report('second-line', `${P}&assigneeId=${id.r1}`);
    expect(Number(sl.totals!.received)).toBeGreaterThanOrEqual(1);
  });
});
