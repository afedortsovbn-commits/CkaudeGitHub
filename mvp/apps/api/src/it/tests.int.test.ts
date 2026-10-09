/** Интеграционные тесты тестирования сотрудников и рейтингов: тест, назначение, попытки, напоминания, рейтинги. */
import { remindTestDeadlines } from '@cc/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Тестирование сотрудников (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  const one = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0];
  const call = (m: string, path: string, who: string, body?: unknown) =>
    t.call(m, `/api/v1${path}`, tok[who], body);
  const day = (offset: number) => {
    const d = new Date(Date.now() + offset * 86_400_000);
    return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Minsk' });
  };

  beforeAll(async () => {
    t = await createTestApp();
    tok.admin = await t.login('admin@test.local');
    tok.op1 = await t.login('operator1@demo.local');
    tok.op2 = await t.login('operator2@demo.local');
    tok.sup = await t.login('supervisor@demo.local');
    for (const [k, e] of Object.entries({
      op1: 'operator1@demo.local',
      op2: 'operator2@demo.local',
      sup: 'supervisor@demo.local',
    }))
      id[k] = (await one('SELECT id FROM app_user WHERE email = $1', [e])).id;
  }, 120_000);
  afterAll(async () => t?.cleanup());

  let testId = '';
  let q1 = '';
  let q2 = '';
  let right1 = '';
  let right2: string[] = [];

  it('права: оператор не управляет тестами, супервизор — управляет', async () => {
    expect((await call('GET', '/tests', 'op1')).status).toBe(403);
    expect((await call('GET', '/tests', 'sup')).status).toBe(200);
    expect((await call('GET', '/my-tests', 'op1')).status).toBe(200);
    expect((await call('GET', '/ratings/operators', 'op1')).status).toBe(200);
  });

  it('тест с вопросами: проверка вариантов, сохранение, правка и выключение вопроса', async () => {
    const topic = (await one(`SELECT id FROM topic WHERE is_active ORDER BY name LIMIT 1`)).id as string;
    const bad = await call('POST', '/tests', 'sup', {
      title: 'Без правильного',
      questions: [{ text: 'Вопрос', options: [{ text: 'А' }, { text: 'Б' }] }],
    });
    expect(bad.status).toBe(400);
    const r = await call('POST', '/tests', 'sup', {
      title: 'Программа лояльности',
      topicIds: [topic],
      passScore: 50,
      questions: [
        { text: 'Сколько бонусов за литр?', options: [{ text: '1', correct: true }, { text: '5' }] },
        {
          text: 'Что можно оплатить бонусами?',
          options: [{ text: 'Топливо', correct: true }, { text: 'Кофе', correct: true }, { text: 'Штраф' }],
        },
        { text: 'Лишний вопрос', options: [{ text: 'Да', correct: true }, { text: 'Нет' }] },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    testId = r.body.id;
    expect(r.body.questions).toHaveLength(3);
    expect(r.body.topicNames).toHaveLength(1);
    // Третий вопрос убираем — он выключается.
    const qs = r.body.questions as {
      id: string;
      text: string;
      options: { id: string; text: string; correct: boolean }[];
    }[];
    const up = await call('PUT', `/tests/${testId}`, 'sup', {
      title: 'Программа лояльности',
      topicIds: [topic],
      passScore: 50,
      questions: qs.slice(0, 2).map((q) => ({ id: q.id, text: q.text, options: q.options })),
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.questions).toHaveLength(2);
    q1 = qs[0]!.id;
    q2 = qs[1]!.id;
    right1 = qs[0]!.options.find((o) => o.correct)!.id;
    right2 = qs[1]!.options.filter((o) => o.correct).map((o) => o.id);
    expect(qs[0]!.options[0]!.id).toBe(up.body.questions[0].options[0].id);
  });

  it('назначение со сроком: уведомление, без дублей, нельзя пройти не назначенный', async () => {
    expect((await call('POST', `/my-tests/${testId}/start`, 'op2')).status).toBe(403);
    expect(
      (await call('POST', '/tests-assignments', 'sup', { testId, userIds: [id.op1], dueDate: day(-1) }))
        .status,
    ).toBe(400);
    const a = await call('POST', '/tests-assignments', 'sup', {
      testId,
      userIds: [id.op1, id.op2],
      dueDate: day(2),
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toEqual({ created: 2, updated: 0 });
    const again = await call('POST', '/tests-assignments', 'sup', {
      testId,
      userIds: [id.op1],
      dueDate: day(3),
    });
    expect(again.body).toEqual({ created: 0, updated: 1 });
    const bell = await call('GET', '/notifications', 'op1');
    expect(bell.body.items.some((n: { subject: string }) => n.subject.includes('Программа лояльности'))).toBe(
      true,
    );
    const due = await call('GET', '/my-tests/due', 'op1');
    expect(due.body).toMatchObject({ overdue: 0, soon: 1 });
  });

  it('попытки: правильные ответы не передаются, оценка на сервере, «пройдено» в назначении, история', async () => {
    const s1 = await call('POST', `/my-tests/${testId}/start`, 'op1');
    expect(s1.status, JSON.stringify(s1.body)).toBe(201);
    expect(JSON.stringify(s1.body)).not.toContain('correct');
    expect(s1.body.questions.find((q: { id: string }) => q.id === q2).multi).toBe(true);
    // Первая попытка: один ответ неверный (отмечен не весь набор) → 50 % = проходной.
    const f1 = await call('POST', `/my-tests/attempts/${s1.body.attemptId}/finish`, 'op1', {
      answers: [
        { questionId: q1, optionIds: [right1] },
        { questionId: q2, optionIds: [right2[0]] },
      ],
    });
    expect(f1.status, JSON.stringify(f1.body)).toBe(200);
    expect(f1.body).toMatchObject({ correct: 1, total: 2, score: 50, passed: true });
    expect(f1.body.questions[1].correct).toBe(false);
    expect(
      (await call('POST', `/my-tests/attempts/${s1.body.attemptId}/finish`, 'op1', { answers: [] })).status,
    ).toBe(409);
    // Чужую попытку не открыть; вторая попытка — всё верно.
    expect((await call('GET', `/tests-attempts/${s1.body.attemptId}`, 'op2')).status).toBe(403);
    const s2 = await call('POST', `/my-tests/${testId}/start`, 'op1');
    const f2 = await call('POST', `/my-tests/attempts/${s2.body.attemptId}/finish`, 'op1', {
      answers: [
        { questionId: q1, optionIds: [right1] },
        { questionId: q2, optionIds: right2 },
      ],
    });
    expect(f2.body).toMatchObject({ score: 100, passed: true });
    const mine = await call('GET', '/my-tests', 'op1');
    expect(mine.body.assignments[0].status).toBe('passed');
    expect(mine.body.attempts.map((x: { tryNo: number }) => x.tryNo).sort()).toEqual([1, 2]);
    expect(mine.body.topics[0]).toMatchObject({ attempts: 2, bestScore: 100, lastScore: 100, avgScore: 75 });
  });

  it('результаты для супервизора: сотрудник, попытки, темы, рейтинг вопросов с разбивкой по сотрудникам', async () => {
    const res = await call('GET', '/tests-results', 'sup');
    const op1 = res.body.find((r: { id: string }) => r.id === id.op1);
    expect(op1).toMatchObject({ attempts: 2, testsPassed: 1, open: 0 });
    const op2 = res.body.find((r: { id: string }) => r.id === id.op2);
    expect(op2).toMatchObject({ attempts: 0, open: 1 });
    const det = await call('GET', `/tests-results/${id.op1}`, 'sup');
    expect(det.body.attempts).toHaveLength(2);
    expect((await call('GET', `/tests-attempts/${det.body.attempts[0].id}`, 'sup')).status).toBe(200);
    const qr = await call('GET', `/tests-questions?testId=${testId}`, 'sup');
    expect(qr.body[0]).toMatchObject({ id: q2, answers: 2, wrong: 1 });
    const qd = await call('GET', `/tests-questions/${q2}`, 'sup');
    expect(qd.body.users[0]).toMatchObject({ userId: id.op1, answers: 2, wrong: 1 });
    expect(qd.body.options.find((o: { id: string }) => o.id === right2[0]).chosen).toBe(2);
    expect((await call('GET', '/tests-competence', 'sup')).body.length).toBeGreaterThan(0);
  });

  it('напоминания: за 3 дня — один раз, просрочка — каждый день; сотруднику и супервизорам', async () => {
    const a = (
      await one(`SELECT id FROM test_assignment WHERE user_id = $1 AND test_id = $2`, [id.op2, testId])
    ).id as string;
    await t.pool.query(
      `INSERT INTO system_setting (key, value) VALUES ('ticket.daily_notification_time', '"00:00"')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const count = async (key: string) =>
      Number((await one(`SELECT count(*)::int AS n FROM notification WHERE dedupe_key LIKE $1`, [key])).n);
    const r1 = await remindTestDeadlines(t.pool);
    expect(r1.skipped).toBe(false);
    expect(await count(`test:${a}:%`)).toBe(1);
    expect(await count(`test-digest:${id.sup}:%`)).toBe(1);
    // Повтор в тот же день — без дублей.
    await remindTestDeadlines(t.pool);
    expect(await count(`test:${a}:%`)).toBe(1);
    // Срок прошёл: на следующий день — снова (каждый день просрочки).
    await t.pool.query(`UPDATE test_assignment SET due_date = $2::date - 1 WHERE id = $1`, [a, day(1)]);
    await remindTestDeadlines(t.pool, new Date(Date.now() + 86_400_000));
    expect(await count(`test:${a}:%`)).toBe(2);
    const late = await one(
      `SELECT subject FROM notification WHERE dedupe_key LIKE $1 ORDER BY created_at DESC LIMIT 1`,
      [`test:${a}:%`],
    );
    expect(late.subject).toMatch(/просрочен/);
    // Отменённое назначение больше не напоминает.
    expect((await call('POST', `/tests-assignments/${a}/cancel`, 'sup')).status).toBe(200);
    await remindTestDeadlines(t.pool, new Date(Date.now() + 2 * 86_400_000));
    expect(await count(`test:${a}:%`)).toBe(2);
  });

  it('рейтинг операторов: места по оценкам клиентов, статус, обработано; мой рейтинг', async () => {
    const conv = (
      await one(
        `SELECT id FROM conversation c WHERE NOT EXISTS (SELECT 1 FROM csat_rating r WHERE r.conversation_id = c.id) LIMIT 1`,
      )
    )?.id as string | undefined;
    if (conv) {
      await t.pool.query(
        `INSERT INTO csat_rating (id, conversation_id, channel_kind, agent_user_id, score)
         VALUES (gen_random_uuid(), $1, 'webchat', $2, 5)`,
        [conv, id.op1],
      );
    }
    const r = await call('GET', '/ratings/operators?days=30', 'sup');
    expect(r.status).toBe(200);
    const op1 = r.body.items.find((x: { id: string }) => x.id === id.op1);
    expect(op1).toHaveProperty('status');
    expect(op1).toHaveProperty('handled');
    if (conv) expect(op1.place).toBeGreaterThan(0);
    const mine = await call('GET', '/my-rating', 'op1');
    expect(mine.status).toBe(200);
    expect(mine.body.distribution).toHaveLength(5);
  });
});
