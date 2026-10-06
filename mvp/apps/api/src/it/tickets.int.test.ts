/** Интеграционные тесты 2-й линии (Ф8) на реальной PostgreSQL: передача, переходы, согласование, рассылка. */
import { newId } from '@cc/contracts';
import { ingestInbound, processEmailQueue, runDailyDigest, type OutgoingMail } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Вторая линия Ф8 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let channelId: string;
  const id: Record<string, string> = {};
  const tok: Record<string, string> = {};
  let seq = 0;

  const one = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0];
  const uid = async (email: string) =>
    (await one('SELECT id FROM app_user WHERE email = $1', [email])).id as string;

  beforeAll(async () => {
    t = await createTestApp();
    channelId = (await one(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`)).id;
    id.e1 = (await one(`SELECT id FROM enterprise WHERE code = 'E1'`)).id;
    id.e2 = (await one(`SELECT id FROM enterprise WHERE code = 'E2'`)).id;
    id.ops = (await one(`SELECT id FROM department WHERE code = 'OPS'`)).id;
    id.client = (await one(`SELECT id FROM department WHERE code = 'CLIENT'`)).id;
    id.fuel = (await one(`SELECT id FROM topic WHERE name = 'Топливо'`)).id;
    id.quality = (await one(`SELECT id FROM topic WHERE name = 'Качество топлива'`)).id;
    id.method = (await one(`SELECT id FROM answer_method WHERE code = 'phone'`)).id;
    for (const [k, e] of Object.entries({
      r1: 'resp1@demo.local',
      r2: 'resp2@demo.local',
      r3: 'resp3@demo.local',
      c1: 'curator1@demo.local',
      op1: 'operator1@demo.local',
      op2: 'operator2@demo.local',
      sup: 'supervisor@demo.local',
    }))
      id[k] = await uid(e);
    tok.admin = await t.login('admin@test.local');
    tok.op1 = await t.login('operator1@demo.local');
    tok.op2 = await t.login('operator2@demo.local');
    tok.sup = await t.login('supervisor@demo.local'); // область — только «Север»
    tok.r1 = await t.login('resp1@demo.local');
    tok.r2 = await t.login('resp2@demo.local');
    tok.r3 = await t.login('resp3@demo.local');
    tok.c1 = await t.login('curator1@demo.local');
  }, 120_000);
  afterAll(async () => t?.cleanup());

  const call = (m: string, path: string, who: string, body?: unknown) =>
    t.call(m, `/api/v1${path}`, tok[who], body);

  /** Обращение, взятое оператором и классифицированное темой (поля «при передаче» заполнены). */
  async function conversation(op: 'op1' | 'op2' = 'op1', topic = id.fuel) {
    const n = ++seq;
    const r = await withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId,
        channelKind: 'webchat',
        externalId: `tk-${n}`,
        identity: { kind: 'webchat', value: `tk-client-${n}` },
        body: `Жалоба ${n}`,
        attachments: [],
        receivedAt: Date.now(),
      }),
    );
    expect((await call('POST', `/conversations/${r.conversationId}/take`, op)).status).toBe(200);
    const p = await call('PATCH', `/conversations/${r.conversationId}`, op, {
      topicId: topic,
      enterpriseId: id.e1,
      departmentId: id.ops,
      fields: { station: '12', fuel_date: '2026-09-01' },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    return r.conversationId;
  }

  async function escalate(convId: string, op: 'op1' | 'op2' = 'op1', extra: Record<string, unknown> = {}) {
    const d = await call(
      'GET',
      `/tickets/defaults?enterpriseId=${id.e1}&departmentId=${id.ops}&topicId=${id.fuel}`,
      op,
    );
    expect(d.status).toBe(200);
    return call('POST', `/conversations/${convId}/escalate`, op, {
      enterpriseId: id.e1,
      departmentId: id.ops,
      topicId: id.fuel,
      summary: 'Клиент жалуется на качество топлива',
      responsibleIds: d.body.responsibleIds,
      curatorIds: d.body.curatorIds,
      dueDate: d.body.dueDate,
      ...extra,
    });
  }

  async function newTicket(op: 'op1' | 'op2' = 'op1', topic = id.fuel) {
    const conv = await conversation(op, topic);
    const r = await call('POST', `/conversations/${conv}/escalate`, op, {
      enterpriseId: id.e1,
      departmentId: id.ops,
      topicId: topic,
      summary: 'Суть жалобы',
      responsibleIds: [topic === id.fuel ? id.r1 : id.r2],
      curatorIds: [id.c1],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { conv, ticket: r.body };
  }

  it('передача: подстановка по матрице, срок, обязательный ответственный, тикет и письма «Важно!»', async () => {
    const conv = await conversation('op1');
    const d = await call(
      'GET',
      `/tickets/defaults?enterpriseId=${id.e1}&departmentId=${id.ops}&topicId=${id.fuel}`,
      'op1',
    );
    expect(d.body).toMatchObject({ responsibleIds: [id.r1], curatorIds: [id.c1] });
    expect(d.body.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // без ответственного тикет не сохраняется
    const none = await call('POST', `/conversations/${conv}/escalate`, 'op1', {
      enterpriseId: id.e1,
      departmentId: id.ops,
      topicId: id.fuel,
      summary: 'x',
      responsibleIds: [],
    });
    expect(none.status).toBe(400);
    // ответственный обязан быть сотрудником 2-й линии
    const badUser = await call('POST', `/conversations/${conv}/escalate`, 'op1', {
      enterpriseId: id.e1,
      departmentId: id.ops,
      topicId: id.fuel,
      summary: 'x',
      responsibleIds: [id.op2],
    });
    expect(badUser.status).toBe(400);
    // отключённое подразделение на предприятии
    const r = await escalate(conv, 'op1');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'new', createdBy: id.op1, dueDate: d.body.dueDate });
    expect(
      r.body.assignees.map((a: { userId: string; kind: string }) => `${a.kind}:${a.userId}`).sort(),
    ).toEqual([`responsible:${id.r1}`, `curator:${id.c1}`].sort());
    // повторная передача того же обращения — отказ
    expect((await escalate(conv, 'op1')).status).toBe(409);

    // обращение ждёт 2-ю линию и не в очереди; клиенту ушло автосообщение; закрыть 1-й линии нельзя
    const c = await call('GET', `/conversations/${conv}`, 'op1');
    expect(c.body).toMatchObject({ status: 'waiting_2nd_line', ticket: { number: r.body.number } });
    const msgs = await call('GET', `/conversations/${conv}/messages`, 'op1');
    expect(
      msgs.body.some(
        (m: { direction: string; body: string }) =>
          m.direction === 'out' && /передано специалисту/.test(m.body),
      ),
    ).toBe(true);
    const disp = await one(`SELECT id FROM disposition WHERE behavior = 'resolved'`);
    expect(
      (await call('POST', `/conversations/${conv}/close`, 'op1', { dispositionId: disp.id })).status,
    ).toBe(409);
    expect(
      (await call('GET', '/conversations?tab=mine', 'op1')).body.map((x: { id: string }) => x.id),
    ).not.toContain(conv);
    expect(
      (await call('GET', '/conversations?tab=queue', 'op1')).body.map((x: { id: string }) => x.id),
    ).not.toContain(conv);

    // письма при назначении: высокий приоритет, «Важно!», ссылка; и уведомления в интерфейсе
    const mails = (
      await t.pool.query(
        `SELECT subject, body, data, user_id FROM notification WHERE ticket_id = $1 AND channel = 'email'`,
        [r.body.id],
      )
    ).rows;
    expect(mails).toHaveLength(2);
    for (const m of mails) {
      expect(m.subject).toMatch(/^Важно! Вам назначено обращение \(2 линия\) №/);
      expect(m.data.priority).toBe('high');
      expect(m.body).toContain('{{link}}');
      expect(m.body).toContain('Клиент жалуется на качество топлива');
    }
    const bell = await call('GET', '/notifications', 'r1');
    expect(bell.body.unread).toBeGreaterThanOrEqual(1);
    // событие в журнале с измерениями для отчётов
    const ev = await one(
      `SELECT data FROM event WHERE type = 'ticket.created' AND data ->> 'ticketId' = $1`,
      [r.body.id],
    );
    expect(ev.data).toMatchObject({
      enterpriseId: id.e1,
      departmentId: id.ops,
      topicId: id.fuel,
      isImportant: false,
    });
  });

  it('полный цикл: открыть → закрыть ответственным → возврат → повторное закрытие → принять; обращение закрывается', async () => {
    const { conv, ticket } = await newTicket('op1');
    const tid = ticket.id as string;
    // оператор не может действовать за ответственного
    expect((await call('POST', `/tickets/${tid}/open`, 'op1', {})).status).toBe(403);
    const opened = await call('POST', `/tickets/${tid}/open`, 'c1', {}); // куратор открыл первым
    expect(opened.body.status).toBe('in_work');
    expect((await call('POST', `/tickets/${tid}/open`, 'r1', {})).body.status).toBe('in_work'); // идемпотентно
    let v = opened.body.version as number;

    // без способа/сути — отказ; с устаревшей версией — «тикет уже изменён»
    expect(
      (
        await call('POST', `/tickets/${tid}/close`, 'r1', {
          version: v,
          answerMethodId: id.method,
          answerSummary: '  ',
          staffGuilty: false,
          measures: ['none'],
        })
      ).status,
    ).toBe(400);
    const stale = await call('POST', `/tickets/${tid}/close`, 'r1', {
      version: v - 1,
      answerMethodId: id.method,
      answerSummary: 'ответ',
      staffGuilty: false,
      measures: ['none'],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('ticket_changed');

    // документ: загрузка и приложение к закрытию
    const up = await t.http().inject({
      method: 'POST',
      url: '/api/v1/tickets/attachments',
      headers: {
        authorization: `Bearer ${tok.r1}`,
        'content-type': 'application/pdf',
        'x-filename': encodeURIComponent('письмо.pdf'),
      },
      payload: Buffer.from('%PDF-1.4 скан'),
    });
    expect(up.statusCode).toBe(201);
    const fileId = JSON.parse(up.body).id as string;
    const closed = await call('POST', `/tickets/${tid}/close`, 'r1', {
      version: v,
      answerMethodId: id.method,
      answerSummary: 'Позвонили клиенту, извинились, проверка проведена',
      staffGuilty: false,
      measures: ['none'],
      attachmentIds: [fileId],
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({
      status: 'approval',
      answerSummary: expect.stringContaining('Позвонили'),
    });
    v = closed.body.version;
    // документ виден участникам; чужому без прав — нет (404 на тикет)
    const file = await t.http().inject({
      method: 'GET',
      url: `/api/v1/tickets/${tid}/files/${fileId}`,
      headers: { authorization: `Bearer ${tok.op1}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('%PDF');
    // согласующему (создателю) письмо и уведомление; в его списках тикет виден
    const list = await call('GET', '/tickets?view=approvals', 'op1');
    expect(list.body.map((x: { id: string }) => x.id)).toContain(tid);
    expect(
      (await call('GET', '/tickets?view=created', 'op1')).body.map((x: { id: string }) => x.id),
    ).toContain(tid);
    const approvalMail = await one(
      `SELECT subject FROM notification WHERE ticket_id = $1 AND kind = 'approval_request' AND channel = 'email' AND user_id = $2`,
      [tid, id.op1],
    );
    expect(approvalMail.subject).toMatch(/ожидает согласования/);
    // ответственный не может принять свой ответ
    expect((await call('POST', `/tickets/${tid}/approve`, 'r1', { version: v })).status).toBe(403);
    // возврат: комментарий обязателен
    expect((await call('POST', `/tickets/${tid}/return`, 'op1', { version: v, comment: ' ' })).status).toBe(
      400,
    );
    const back = await call('POST', `/tickets/${tid}/return`, 'op1', {
      version: v,
      comment: 'Не приложен скан письма',
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ status: 'rework', returnsCount: 1 });
    v = back.body.version;
    // о возврате уведомлены все назначенные (интерфейс + письмо «Важно!»)
    const reworkMails = (
      await t.pool.query(
        `SELECT user_id, subject FROM notification WHERE ticket_id = $1 AND kind = 'rework' AND channel = 'email'`,
        [tid],
      )
    ).rows;
    expect(reworkMails.map((m) => m.user_id).sort()).toEqual([id.r1, id.c1].sort());
    expect(reworkMails[0].subject).toMatch(/^Важно! /);
    // взять в работу и закрыть повторно
    const again = await call('POST', `/tickets/${tid}/open`, 'r1', {});
    expect(again.body.status).toBe('in_work');
    const closed2 = await call('POST', `/tickets/${tid}/close`, 'r1', {
      version: again.body.version,
      answerMethodId: id.method,
      answerSummary: 'Скан письма приложен',
      staffGuilty: false,
      measures: ['none'],
    });
    expect(closed2.body.status).toBe('approval');
    const ok = await call('POST', `/tickets/${tid}/approve`, 'op1', { version: closed2.body.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'closed' });
    const done = await one('SELECT closed_in_time, returns_count FROM ticket WHERE id = $1', [tid]);
    expect(done).toMatchObject({ closed_in_time: true, returns_count: 1 });
    expect((await one('SELECT status FROM conversation WHERE id = $1', [conv])).status).toBe('closed');
    // клиенту система ничего не отправила (кроме автосообщения при передаче)
    const out = await one(
      `SELECT count(*)::int AS n FROM message WHERE conversation_id = $1 AND direction = 'out'`,
      [conv],
    );
    expect(out.n).toBe(1);
    // история: все переходы и возврат
    const hist = (await call('GET', `/tickets/${tid}`, 'op1')).body.history.map(
      (h: { action: string }) => h.action,
    );
    expect(hist).toEqual(['created', 'opened', 'answered', 'returned', 'opened', 'answered', 'approved']);
  });

  it('«Новое» закрывается сразу из списка; продление срока: запрос, отказ, продление', async () => {
    const { ticket } = await newTicket('op1');
    const tid = ticket.id as string;
    // запрос продления: срок не раньше текущего, причина обязательна; решает создатель
    const later = new Date(`${String(ticket.dueDate)}T00:00:00Z`);
    later.setUTCDate(later.getUTCDate() + 5);
    const due = later.toISOString().slice(0, 10);
    const early = await call('POST', `/tickets/${tid}/extension`, 'r1', {
      dueDate: ticket.dueDate,
      reason: 'x',
    });
    expect(early.status, JSON.stringify(early.body)).toBe(400);
    const asked = await call('POST', `/tickets/${tid}/extension`, 'r1', {
      dueDate: due,
      reason: 'ждём ответ АЗС',
    });
    expect(asked.status).toBe(200);
    expect(asked.body.history.map((h: { action: string }) => h.action)).toContain('extension_requested');
    // ответственный сам не отказывает и не продлевает
    expect((await call('POST', `/tickets/${tid}/extension/decline`, 'r1', {})).status).toBe(403);
    const declined = await call('POST', `/tickets/${tid}/extension/decline`, 'op1', { comment: 'нет' });
    expect(declined.status).toBe(200);
    expect(declined.body.dueDate).toBe(ticket.dueDate);
    // без вины работника и принятых мер — отказ; «не применялись» вместе с мерами — тоже
    const noGuilt = await call('POST', `/tickets/${tid}/close`, 'r1', {
      version: declined.body.version,
      answerMethodId: id.method,
      answerSummary: 'ответ',
    });
    expect(noGuilt.status).toBe(400);
    const mixed = await call('POST', `/tickets/${tid}/close`, 'r1', {
      version: declined.body.version,
      answerMethodId: id.method,
      answerSummary: 'ответ',
      staffGuilty: true,
      measures: ['none', 'remark'],
    });
    expect(mixed.status).toBe(400);
    // закрытие «Нового» без открытия: в истории — взято в работу и закрыто ответственным
    const closed = await call('POST', `/tickets/${tid}/close`, 'r1', {
      version: declined.body.version,
      answerMethodId: id.method,
      answerSummary: 'ответ',
      staffGuilty: false,
      measures: ['none'],
    });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('approval');
    expect(closed.body).toMatchObject({ staffGuilty: false, measures: ['none'] });
    const hist = closed.body.history.map((h: { action: string }) => h.action);
    expect(hist.slice(-2)).toEqual(['opened', 'answered']);
  });

  it('конкурентное закрытие двумя ответственными: один успех, второй — «тикет уже изменён»', async () => {
    const { ticket } = await newTicket('op1');
    const tid = ticket.id as string;
    const opened = await call('POST', `/tickets/${tid}/open`, 'r1', {});
    const body = {
      version: opened.body.version,
      answerMethodId: id.method,
      answerSummary: 'ответ',
      staffGuilty: false,
      measures: ['none'],
    };
    const [a, b] = await Promise.all([
      call('POST', `/tickets/${tid}/close`, 'r1', body),
      call('POST', `/tickets/${tid}/close`, 'c1', body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const failed = a.status === 409 ? a : b;
    expect(['ticket_changed', 'bad_status']).toContain(failed.body.error);
    expect(
      (
        await one(`SELECT count(*)::int AS n FROM ticket_comment WHERE ticket_id = $1 AND kind = 'answer'`, [
          tid,
        ])
      ).n,
    ).toBe(1);
  });

  it('переадресация: пересчёт по матрице, ручная правка, комментарий обязателен; замена ответственного оператором', async () => {
    const { ticket } = await newTicket('op1');
    const tid = ticket.id as string;
    let v = (await call('POST', `/tickets/${tid}/open`, 'r1', {})).body.version;
    // комментарий обязателен
    expect(
      (await call('POST', `/tickets/${tid}/redirect`, 'r1', { version: v, comment: '', topicId: id.quality }))
        .status,
    ).toBe(400);
    // смена темы → по матрице ответственный подтемы «Качество топлива» — r2
    const r = await call('POST', `/tickets/${tid}/redirect`, 'r1', {
      version: v,
      comment: 'Это к качеству топлива',
      topicId: id.quality,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const active = r.body.assignees.filter((a: { isActive: boolean }) => a.isActive);
    expect(active.find((a: { kind: string }) => a.kind === 'responsible').userId).toBe(id.r2);
    expect(r.body.dueDate).toBe(ticket.dueDate); // срок при переадресации не меняется
    expect(r.body.status).toBe('in_work');
    v = r.body.version;
    // новому ответственному — письмо «Важно!»
    const m = await one(
      `SELECT subject FROM notification WHERE ticket_id = $1 AND user_id = $2 AND channel = 'email'`,
      [tid, id.r2],
    );
    expect(m.subject).toMatch(/^Важно! Вам назначено обращение/);
    // старый ответственный больше не действует
    expect(
      (
        await call('POST', `/tickets/${tid}/redirect`, 'r1', {
          version: v,
          comment: 'х',
          responsibleIds: [id.r3],
        })
      ).status,
    ).toBe(403);
    // оператор-создатель заменяет ответственного и срок; постороннему оператору нельзя
    expect(
      (await call('POST', `/tickets/${tid}/reassign`, 'op2', { version: v, responsibleIds: [id.r3] })).status,
    ).toBe(403);
    const due = ticket.dueDate.slice(0, 8) + '28';
    const re = await call('POST', `/tickets/${tid}/reassign`, 'op1', {
      version: v,
      responsibleIds: [id.r3],
      dueDate: due,
      comment: 'Заменили ответственного',
    });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(
      re.body.assignees
        .filter((a: { isActive: boolean; kind: string }) => a.isActive && a.kind === 'responsible')
        .map((a: { userId: string }) => a.userId),
    ).toEqual([id.r3]);
    expect(re.body.dueDate).toBe(due);
    // ответственный без тикета не может быть пустым
    expect(
      (
        await call('POST', `/tickets/${tid}/reassign`, 'op1', {
          version: re.body.version,
          responsibleIds: [],
        })
      ).status,
    ).toBe(400);
    // переадресация в другое подразделение без ответственных по матрице — нужен ручной выбор
    const noMatrix = await call('POST', `/tickets/${tid}/redirect`, 'r3', {
      version: re.body.version,
      comment: 'В клиентский отдел',
      departmentId: id.client,
    });
    expect(noMatrix.status).toBe(400);
    const manual = await call('POST', `/tickets/${tid}/redirect`, 'r3', {
      version: re.body.version,
      comment: 'В клиентский отдел',
      departmentId: id.client,
      responsibleIds: [id.r1],
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    expect(manual.body.departmentId).toBe(id.client);
  });

  it('увольнение: пересчёт по матрице; затем кураторы; затем отчёт «требуют переназначения» и уведомление супервизорам', async () => {
    // r2 — ответственный подтемы; при увольнении матрица даёт r1 (тема «Топливо»)
    const a = await newTicket('op1', id.quality);
    const d1 = await call('POST', `/users/${id.r2}/deactivate`, 'admin');
    expect(d1.status, JSON.stringify(d1.body)).toBe(200);
    expect(d1.body.ticketImpact).toMatchObject({
      affected: expect.any(Number),
      reassigned: expect.any(Number),
    });
    const ta = (await call('GET', `/tickets/${a.ticket.id}`, 'op1')).body;
    expect(
      ta.assignees
        .filter((x: { isActive: boolean; kind: string }) => x.isActive && x.kind === 'responsible')
        .map((x: { userId: string }) => x.userId),
    ).toEqual([id.r1]);
    // тикет с ответственным r1 и куратором c1: увольняем r1 — куратор c1 становится ответственным
    const b = await newTicket('op2', id.fuel);
    await call('POST', `/users/${id.r1}/deactivate`, 'admin');
    const tb = (await call('GET', `/tickets/${b.ticket.id}`, 'op2')).body;
    expect(
      tb.assignees
        .filter((x: { isActive: boolean; kind: string }) => x.isActive && x.kind === 'responsible')
        .map((x: { userId: string }) => x.userId),
    ).toEqual([id.c1]);
    // увольняем и куратора — назначать некого: тикеты попадают в отчёт, супервизорам — уведомление и письмо
    const d3 = await call('POST', `/users/${id.c1}/deactivate`, 'admin');
    expect(d3.body.ticketImpact.needsReassign).toBeGreaterThanOrEqual(1);
    const report = await call('GET', '/tickets?view=attention', 'admin');
    expect(report.body.map((x: { id: string }) => x.id)).toContain(b.ticket.id);
    expect(
      (await call('GET', '/tickets/reassignment-report', 'admin')).body.map((x: { id: string }) => x.id),
    ).toContain(b.ticket.id);
    const sup = await one(
      `SELECT count(*)::int AS n FROM notification WHERE ticket_id = $1 AND kind = 'needs_reassign' AND user_id = $2`,
      [b.ticket.id, id.sup],
    );
    expect(sup.n).toBeGreaterThanOrEqual(1);
    // исключённые не получают рассылку
    const digest = await runDailyDigest(t.pool, new Date('2026-10-20T06:00:00Z'));
    expect(digest.skipped).toBe(false);
    const toDead = await one(
      `SELECT count(*)::int AS n FROM notification WHERE kind = 'daily' AND user_id = ANY($1)`,
      [[id.r1, id.r2, id.c1]],
    );
    expect(toDead.n).toBe(0);
    // администратор назначает ответственного вручную и возвращает сотрудников (для следующих тестов)
    const cur = (await call('GET', `/tickets/${b.ticket.id}`, 'admin')).body;
    const fix = await call('POST', `/tickets/${b.ticket.id}/reassign`, 'admin', {
      version: cur.version,
      responsibleIds: [id.r3],
    });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    expect(
      (await call('GET', '/tickets?view=attention', 'admin')).body.map((x: { id: string }) => x.id),
    ).not.toContain(b.ticket.id);
    for (const u of ['r1', 'r2', 'c1']) await call('POST', `/users/${id[u]}/activate`, 'admin');
    tok.r1 = await t.login('resp1@demo.local');
    tok.r2 = await t.login('resp2@demo.local');
    tok.c1 = await t.login('curator1@demo.local');
    await t.pool.query(
      `UPDATE system_setting SET value = '"1970-01-01"' WHERE key = 'ticket.digest_last_date'`,
    );
  });

  it('режим согласования: переключение «создатель ↔ только супервизор» без доработки; заместитель', async () => {
    const { ticket } = await newTicket('op1');
    const tid = ticket.id as string;
    let v = (await call('POST', `/tickets/${tid}/open`, 'r3', {})).body;
    // r3 не назначен на этот тикет (r1 ответственный) — открывает r1
    v = (await call('POST', `/tickets/${tid}/open`, 'r1', {})).body;
    const closed = await call('POST', `/tickets/${tid}/close`, 'r1', {
      version: v.version,
      answerMethodId: id.method,
      answerSummary: 'ответ',
      staffGuilty: false,
      measures: ['none'],
    });
    expect(closed.body.status).toBe('approval');
    // режим «только супервизор»: создатель принять не может, супервизор «Севера» — может
    expect((await call('PATCH', '/settings', 'admin', { 'ticket.approval_mode': 'supervisor' })).status).toBe(
      200,
    );
    expect(
      (await call('POST', `/tickets/${tid}/approve`, 'op1', { version: closed.body.version })).status,
    ).toBe(403);
    expect(
      (await call('GET', '/tickets?view=approvals', 'op1')).body.map((x: { id: string }) => x.id),
    ).not.toContain(tid);
    expect(
      (await call('GET', '/tickets?view=approvals_all', 'sup')).body.map((x: { id: string }) => x.id),
    ).toContain(tid);
    expect((await call('GET', '/tickets?view=approvals_all', 'op1')).status).toBe(403);
    // обратно на «создатель»: заместитель создателя
    expect((await call('PATCH', '/settings', 'admin', { 'ticket.approval_mode': 'creator' })).status).toBe(
      200,
    );
    expect(
      (await call('POST', `/tickets/${tid}/approve`, 'op2', { version: closed.body.version })).status,
    ).toBe(403);
    // op2 — заместитель op1 на период отсутствия (сам оператор назначает)
    expect((await call('POST', '/approval-substitutes', 'op1', { substituteId: id.op2 })).status).toBe(201);
    expect(
      (await call('GET', '/tickets?view=approvals', 'op2')).body.map((x: { id: string }) => x.id),
    ).toContain(tid);
    const ok = await call('POST', `/tickets/${tid}/approve`, 'op2', { version: closed.body.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('closed');
  });

  it('запрещённые переходы и действия вне области отклоняются сервером', async () => {
    const { ticket } = await newTicket('op2');
    const tid = ticket.id as string;
    // нельзя принять/вернуть тикет, который не на согласовании
    expect((await call('POST', `/tickets/${tid}/approve`, 'op2', { version: ticket.version })).status).toBe(
      409,
    );
    expect(
      (await call('POST', `/tickets/${tid}/return`, 'op2', { version: ticket.version, comment: 'х' })).status,
    ).toBe(409);
    // закрыть (и «Новое» тоже) может только назначенный; посторонний ответственный — нет
    expect(
      (
        await call('POST', `/tickets/${tid}/close`, 'r3', {
          version: ticket.version,
          answerMethodId: id.method,
          answerSummary: 'х',
          staffGuilty: false,
          measures: ['none'],
        })
      ).status,
    ).toBe(403);
    // посторонний ответственный (не назначен) не действует; тикет видит по области, но действовать не может
    expect((await call('POST', `/tickets/${tid}/open`, 'r3', {})).status).toBe(403);
    // передача обращения, которое ведёт другой оператор
    const conv = await conversation('op2');
    expect(
      (
        await call('POST', `/conversations/${conv}/escalate`, 'op1', {
          enterpriseId: id.e1,
          departmentId: id.ops,
          topicId: id.fuel,
          summary: 'х',
          responsibleIds: [id.r1],
        })
      ).status,
    ).toBe(409);
    // предприятие «Юг»: супервизор с областью «Север» не видит тикеты этого предприятия — 404 по прямому id
    const north = await conversation('op2');
    const south = await call('POST', `/conversations/${north}/escalate`, 'op2', {
      enterpriseId: id.e2,
      departmentId: id.ops,
      topicId: id.fuel,
      summary: 'Юг',
      responsibleIds: [id.r2],
    });
    expect(south.status, JSON.stringify(south.body)).toBe(200);
    expect((await call('GET', `/tickets/${south.body.id}`, 'sup')).status).toBe(404);
    expect(
      (await call('GET', `/tickets?view=approvals_all`, 'sup')).body.map((x: { id: string }) => x.id),
    ).not.toContain(south.body.id);
    expect((await call('POST', `/tickets/${south.body.id}/comments`, 'sup', { body: 'х' })).status).toBe(404);
    // отключённое подразделение — передать нельзя
    const conv2 = await conversation('op2');
    const link = await one(
      'SELECT id FROM enterprise_department WHERE enterprise_id = $1 AND department_id = $2',
      [id.e1, id.client],
    );
    const off = await call('PATCH', `/enterprise-departments/${link.id}`, 'admin', { isActive: false });
    expect(off.status).toBe(200);
    const denied = await call('POST', `/conversations/${conv2}/escalate`, 'op2', {
      enterpriseId: id.e1,
      departmentId: id.client,
      topicId: id.fuel,
      summary: 'х',
      responsibleIds: [id.r1],
    });
    expect(denied.status).toBe(400);
    await call('PATCH', `/enterprise-departments/${link.id}`, 'admin', { isActive: true });
  });

  it('новое сообщение клиента по обращению с тикетом: добавляется в обращение, назначенным — уведомление, в очередь не идёт', async () => {
    const { conv, ticket } = await newTicket('op1');
    const before = await one(
      `SELECT count(*)::int AS n FROM notification WHERE ticket_id = $1 AND kind = 'client_message'`,
      [ticket.id],
    );
    const again = await withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId,
        channelKind: 'webchat',
        externalId: `tk-late-${seq}`,
        identity: { kind: 'webchat', value: `tk-client-${seq}` },
        body: 'А что с моим вопросом?',
        attachments: [],
        receivedAt: Date.now(),
      }),
    );
    expect(again).toMatchObject({ conversationId: conv, created: false });
    const st = await one('SELECT status FROM conversation WHERE id = $1', [conv]);
    expect(st.status).toBe('waiting_2nd_line');
    const after = await one(
      `SELECT count(*)::int AS n FROM notification WHERE ticket_id = $1 AND kind = 'client_message'`,
      [ticket.id],
    );
    expect(after.n - before.n).toBe(2); // ответственный и куратор
    const msgs = (await call('GET', `/tickets/${ticket.id}/messages`, 'r1')).body;
    expect(msgs.some((m: { body: string }) => m.body === 'А что с моим вопросом?')).toBe(true);
  });

  it('важность по теме, некорректная дата, уведомления участникам, отчёт по области, письма уволенному не уходят', async () => {
    const staff = (await one(`SELECT id FROM topic WHERE name = 'Жалобы на персонал АЗС'`)).id as string;
    const base = { enterpriseId: id.e1, departmentId: id.ops, summary: 'Суть', responsibleIds: [id.r1] };
    // Обращение по особо важной теме (отметка автоматическая), тикет — по обычной: отметка не переносится.
    const c1 = await conversation('op1', staff);
    const plain = await call('POST', `/conversations/${c1}/escalate`, 'op1', { ...base, topicId: id.fuel });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.isImportant).toBe(false);
    // Ручная отметка обращения переносится в тикет; некорректная дата срока — 400, а не ошибка базы.
    const c2 = await conversation('op1');
    await call('PATCH', `/conversations/${c2}`, 'op1', { isImportant: true });
    const bad = await call('POST', `/conversations/${c2}/escalate`, 'op1', {
      ...base,
      topicId: id.fuel,
      dueDate: '2026-02-31',
    });
    expect(bad.status).toBe(400);
    const marked = await call('POST', `/conversations/${c2}/escalate`, 'op1', {
      ...base,
      topicId: id.fuel,
      curatorIds: [id.c1],
    });
    expect(marked.body.isImportant).toBe(true);
    // Автоматическую отметку особо важной темы не снять.
    const c3 = await conversation('op1', staff);
    const imp = await call('POST', `/conversations/${c3}/escalate`, 'op1', {
      ...base,
      departmentId: id.client,
      topicId: staff,
    });
    expect(imp.body.isImportant).toBe(true);
    const off = await call('POST', `/tickets/${imp.body.id}/reassign`, 'op1', {
      version: imp.body.version,
      isImportant: false,
    });
    expect(off.status).toBe(400);
    expect((await one('SELECT is_important FROM ticket WHERE id = $1', [imp.body.id])).is_important).toBe(
      true,
    );

    // Уведомления участникам (M-TKT-12): взят в работу — создателю; снят с тикета — снятому.
    const tid = marked.body.id as string;
    const opened = await call('POST', `/tickets/${tid}/open`, 'r1', {});
    const count = async (user: string, kind: string) =>
      (
        await one(
          `SELECT count(*)::int AS n FROM notification WHERE ticket_id = $1 AND user_id = $2 AND kind = $3 AND channel = 'ui'`,
          [tid, user, kind],
        )
      ).n as number;
    expect(await count(id.op1!, 'opened')).toBe(1);
    const re = await call('POST', `/tickets/${tid}/reassign`, 'op1', {
      version: opened.body.version,
      curatorIds: [],
    });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(await count(id.c1!, 'unassigned')).toBe(1);

    // Отчёт «требуют переназначения» — только в области видимости (супервизор «Севера» не видит «Юг»).
    const c4 = await conversation('op1');
    const south = await call('POST', `/conversations/${c4}/escalate`, 'op1', {
      ...base,
      enterpriseId: id.e2,
      topicId: id.fuel,
      responsibleIds: [id.r2],
    });
    await t.pool.query('UPDATE ticket_assignee SET is_active = false WHERE ticket_id = ANY($1)', [
      [south.body.id, tid],
    ]);
    const supReport = (await call('GET', '/tickets/reassignment-report', 'sup')).body.map(
      (x: { id: string }) => x.id,
    );
    expect(supReport).toContain(tid);
    expect(supReport).not.toContain(south.body.id);
    const adminReport = (await call('GET', '/tickets/reassignment-report', 'admin')).body.map(
      (x: { id: string }) => x.id,
    );
    expect(adminReport).toEqual(expect.arrayContaining([tid, south.body.id]));

    // Уволенному не уходят письма, уже стоящие в очереди.
    const u = await call('POST', '/users', 'admin', {
      fullName: 'Временный ответственный',
      email: `tmp-${seq}@demo.local`,
      password: 'Demo12345!',
      roles: ['responsible'],
    });
    expect(u.status, JSON.stringify(u.body)).toBe(201);
    const c5 = await conversation('op1');
    await call('POST', `/conversations/${c5}/escalate`, 'op1', {
      ...base,
      topicId: id.fuel,
      curatorIds: [u.body.id],
    });
    const pending = async () =>
      (await one(
        `SELECT count(*) FILTER (WHERE status = 'pending')::int AS p, count(*) FILTER (WHERE status = 'skipped')::int AS s
             FROM notification WHERE user_id = $1 AND channel = 'email'`,
        [u.body.id],
      )) as { p: number; s: number };
    expect((await pending()).p).toBe(1);
    expect((await call('POST', `/users/${u.body.id}/deactivate`, 'admin')).status).toBe(200);
    expect(await pending()).toEqual({ p: 0, s: 1 });
  });

  it('«применить матрицу к открытым тикетам»: состав пересчитывается по текущей матрице', async () => {
    const { ticket } = await newTicket('op1');
    // изменяем матрицу: на «Топливо» в E1/OPS — ответственный r3 вместо r1
    const ed = (
      await one('SELECT id FROM enterprise_department WHERE enterprise_id = $1 AND department_id = $2', [
        id.e1,
        id.ops,
      ])
    ).id;
    const rid = (
      await one(
        'SELECT id FROM responsibility WHERE enterprise_department_id = $1 AND topic_id = $2 AND user_id = $3',
        [ed, id.fuel, id.r1],
      )
    ).id;
    await call('POST', '/responsibilities/deactivate', 'admin', { ids: [rid] });
    await call('POST', '/responsibilities/bulk', 'admin', {
      enterpriseDepartmentIds: [ed],
      topicIds: [id.fuel],
      userIds: [id.r3],
      kind: 'responsible',
    });
    // открытые тикеты матрица не переназначает сама
    const same = (await call('GET', `/tickets/${ticket.id}`, 'r1')).body;
    expect(same.assignees.find((a: { userId: string }) => a.userId === id.r1).isActive).toBe(true);
    expect((await call('POST', '/tickets/apply-matrix', 'op1')).status).toBe(403);
    const r = await call('POST', '/tickets/apply-matrix', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.changed).toBeGreaterThanOrEqual(1);
    const after = (await call('GET', `/tickets/${ticket.id}`, 'r3')).body;
    expect(
      after.assignees.find((a: { userId: string; isActive: boolean }) => a.userId === id.r3 && a.isActive),
    ).toBeTruthy();
  });
});

describe.skipIf(!ADMIN_URL)('Ежедневная рассылка Ф8 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let tid: string;
  let r1: string;
  let c1: string;
  const sql = async (q: string, p: unknown[] = []) => (await t.pool.query(q, p)).rows;

  /** Сообщения рассылки ответственным за «день»: тема письма по тикету и получателю. */
  const mails = async () =>
    sql(
      `SELECT n.subject, n.user_id, n.dedupe_key, n.data FROM notification n WHERE n.ticket_id = $1 AND n.kind = 'daily' ORDER BY n.dedupe_key, n.user_id`,
      [tid],
    );

  beforeAll(async () => {
    t = await createTestApp();
    const admin = await t.login('admin@test.local');
    const op = await t.login('operator1@demo.local');
    const ch = (await sql(`SELECT id FROM channel WHERE config ->> 'public_key' = 'demo-webchat'`))[0].id;
    const ent = (await sql(`SELECT id FROM enterprise WHERE code = 'E1'`))[0].id;
    const dep = (await sql(`SELECT id FROM department WHERE code = 'OPS'`))[0].id;
    const topic = (await sql(`SELECT id FROM topic WHERE name = 'Топливо'`))[0].id;
    r1 = (await sql(`SELECT id FROM app_user WHERE email = 'resp1@demo.local'`))[0].id;
    c1 = (await sql(`SELECT id FROM app_user WHERE email = 'curator1@demo.local'`))[0].id;
    const c = await withTx(t.pool, (tx) =>
      ingestInbound(tx, {
        id: newId(),
        channelId: ch,
        channelKind: 'webchat',
        externalId: 'dg-1',
        identity: { kind: 'webchat', value: 'dg-client' },
        body: 'Жалоба',
        attachments: [],
        receivedAt: Date.now(),
      }),
    );
    await t.call('POST', `/api/v1/conversations/${c.conversationId}/take`, op);
    await t.call('PATCH', `/api/v1/conversations/${c.conversationId}`, op, {
      topicId: topic,
      fields: { station: '1', fuel_date: '2026-09-01' },
    });
    const r = await t.call('POST', `/api/v1/conversations/${c.conversationId}/escalate`, op, {
      enterpriseId: ent,
      departmentId: dep,
      topicId: topic,
      summary: 'Суть для рассылки',
      responsibleIds: [r1],
      curatorIds: [c1],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    tid = r.body.id;
    // срок — понедельник 05.10.2026 (конец дня по Минску)
    await t.pool.query(`UPDATE ticket SET due_date = '2026-10-05' WHERE id = $1`, [tid]);
    void admin;
  }, 120_000);
  afterAll(async () => t?.cleanup());

  it('08:00 по Минску включая выходные: «осталось 2 дня» (сб), «осталось 1 день» (вс), «просрочено на 1 день» (вт); раньше 08:00 — ничего', async () => {
    // Минск = UTC+3, без перехода на летнее время. 03.10.2026 — суббота.
    const early = await runDailyDigest(t.pool, new Date('2026-10-03T04:59:00Z')); // 07:59
    expect(early.skipped).toBe(true);
    expect(await mails()).toHaveLength(0);

    const sat = await runDailyDigest(t.pool, new Date('2026-10-03T05:00:00Z')); // 08:00, суббота
    expect(sat).toMatchObject({ skipped: false, date: '2026-10-03', daily: 2 });
    const m1 = await mails();
    expect(m1).toHaveLength(2);
    expect(new Set(m1.map((m) => m.user_id))).toEqual(new Set([r1, c1]));
    for (const m of m1) {
      expect(m.subject).toMatch(/^Важно! Обращение \(2 линия\) №\d+: осталось 2 дня$/);
      expect(m.data.priority).toBe('high');
    }
    // повторный запуск в тот же день (второй экземпляр, повтор задачи) — без дублей
    expect((await runDailyDigest(t.pool, new Date('2026-10-03T09:00:00Z'))).skipped).toBe(true);
    expect(await mails()).toHaveLength(2);

    await runDailyDigest(t.pool, new Date('2026-10-04T05:00:00Z')); // воскресенье
    const sun = (await mails()).filter((m) => m.dedupe_key.includes('2026-10-04'));
    expect(sun).toHaveLength(2);
    expect(sun[0]!.subject).toMatch(/осталось 1 день$/);

    await runDailyDigest(t.pool, new Date('2026-10-06T05:00:00Z')); // вторник — уже просрочен
    const tue = (await mails()).filter((m) => m.dedupe_key.includes('2026-10-06'));
    expect(tue[0]!.subject).toMatch(/просрочено на 1 день$/);
  });

  it('два экземпляра одновременно и перезапуск: записи в очередь без дублей', async () => {
    const [a, b] = await Promise.all([
      runDailyDigest(t.pool, new Date('2026-10-07T05:00:00Z')),
      runDailyDigest(t.pool, new Date('2026-10-07T05:00:01Z')),
    ]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
    const day = (await mails()).filter((m) => m.dedupe_key.includes('2026-10-07'));
    expect(day).toHaveLength(2);
    // «перезапуск» посреди рассылки: отметка дня не поставлена, повтор дописывает недостающее и не дублирует
    await t.pool.query(
      `UPDATE system_setting SET value = '"2026-10-06"' WHERE key = 'ticket.digest_last_date'`,
    );
    await t.pool.query(
      `DELETE FROM notification WHERE ticket_id = $1 AND dedupe_key LIKE '%2026-10-07%' AND user_id = $2`,
      [tid, c1],
    );
    const again = await runDailyDigest(t.pool, new Date('2026-10-07T06:00:00Z'));
    expect(again.daily).toBe(1);
    expect((await mails()).filter((m) => m.dedupe_key.includes('2026-10-07'))).toHaveLength(2);
  });

  it('письма отправляются один раз: два обработчика делят очередь; остановка отдаёт неотправленное; сбой SMTP — повтор', async () => {
    const sent: OutgoingMail[] = [];
    let stop = false;
    const firstSend = async (m: OutgoingMail) => {
      sent.push(m);
      stop = true; // обработчик получил сигнал остановки после первого письма
    };
    const total = (
      await sql(`SELECT count(*)::int AS n FROM notification WHERE channel = 'email' AND status = 'pending'`)
    )[0].n as number;
    expect(total).toBeGreaterThan(4);
    const a = processEmailQueue(t.pool, { send: firstSend, batch: 3, shouldStop: () => stop });
    const n1 = await a;
    expect(n1).toBe(1);
    // неотправленная часть аренды возвращена в очередь сразу — второй экземпляр забирает всё оставшееся
    const rest: OutgoingMail[] = [];
    const [n2, n3] = await Promise.all([
      processEmailQueue(t.pool, { send: async (m) => void rest.push(m), batch: 2 }),
      processEmailQueue(t.pool, { send: async (m) => void rest.push(m), batch: 2 }),
    ]);
    expect(n2 + n3).toBe(total - 1);
    const ids = [...sent, ...rest].map((m) => m.id);
    expect(new Set(ids).size).toBe(total); // ни одного дубля и ни одного пропуска
    expect(ids).toHaveLength(total);
    expect([...sent, ...rest].some((m) => m.high)).toBe(true);

    // сбой SMTP: письмо остаётся в очереди с задержкой, после исчерпания попыток — failed
    await t.pool.query(
      `INSERT INTO notification (id, user_id, ticket_id, kind, channel, dedupe_key, subject, body, data)
      VALUES ($1, $2, $3, 'assigned', 'email', 'test-fail', 'Тест', 'тело', '{}')`,
      [newId(), r1, tid],
    );
    const failed = await processEmailQueue(t.pool, {
      send: async () => Promise.reject(new Error('SMTP недоступен')),
      maxAttempts: 1,
    });
    expect(failed).toBe(0);
    const row = (
      await sql(`SELECT status, last_error, attempts FROM notification WHERE dedupe_key = 'test-fail'`)
    )[0];
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.last_error).toContain('SMTP недоступен');

    // Ежедневное письмо, не ушедшее за сутки, устарело и не отправляется.
    await t.pool.query(
      `INSERT INTO notification (id, user_id, ticket_id, kind, channel, dedupe_key, subject, body, data, created_at)
       VALUES ($1, $2, $3, 'daily', 'email', 'test-stale', 'Вчерашнее', 'тело', '{}', now() - interval '1 day')`,
      [newId(), r1, tid],
    );
    const late: OutgoingMail[] = [];
    await processEmailQueue(t.pool, { send: async (m) => void late.push(m) });
    expect(late.map((m) => m.subject)).not.toContain('Вчерашнее');
    expect((await sql(`SELECT status FROM notification WHERE dedupe_key = 'test-stale'`))[0].status).toBe(
      'skipped',
    );
  });

  it('после закрытия ответственным рассылка прекращается (остаётся напоминание согласующему), после возврата — возобновляется', async () => {
    const op = await t.login('operator1@demo.local');
    const resp = await t.login('resp1@demo.local');
    const api = (m: string, p: string, tk: string, b?: unknown) => t.call(m, `/api/v1${p}`, tk, b);
    const method = (await sql(`SELECT id FROM answer_method WHERE code = 'email'`))[0].id;
    let v = (await api('POST', `/tickets/${tid}/open`, resp, {})).body.version;
    const closed = await api('POST', `/tickets/${tid}/close`, resp, {
      version: v,
      answerMethodId: method,
      answerSummary: 'ответ',
      staffGuilty: false,
      measures: ['none'],
    });
    expect(closed.status).toBe(200);
    v = closed.body.version;
    await runDailyDigest(t.pool, new Date('2026-10-08T05:00:00Z'));
    expect((await mails()).filter((m) => m.dedupe_key.includes('2026-10-08'))).toHaveLength(0);
    const reminder = await sql(
      `SELECT subject FROM notification WHERE ticket_id = $1 AND kind = 'approval_reminder' AND dedupe_key LIKE '%2026-10-08%'`,
      [tid],
    );
    expect(reminder.length).toBeGreaterThanOrEqual(1);
    expect(reminder[0].subject).toMatch(/^Напоминание: обращение \(2 линия\) №\d+ ожидает согласования$/);
    const back = await api('POST', `/tickets/${tid}/return`, op, { version: v, comment: 'Доработать' });
    expect(back.status).toBe(200);
    await runDailyDigest(t.pool, new Date('2026-10-09T05:00:00Z'));
    const resumed = (await mails()).filter((m) => m.dedupe_key.includes('2026-10-09'));
    expect(resumed).toHaveLength(2);
    expect(resumed[0]!.subject).toMatch(/просрочено на 4 дня$/);
  });
});
