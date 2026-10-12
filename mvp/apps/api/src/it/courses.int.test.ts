/** Д-014 система обучения: курс с уроками и тестом, назначение, прохождение (ситуации, тест), отметки, повтор. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Обучение сотрудников (Д-014)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let sup: string;
  let op: string;
  let opId: string;
  let courseId: string;
  let lesson1: string;
  let lesson2: string;
  let testId: string;
  let assignmentId: string;
  const today = () => new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  beforeAll(async () => {
    t = await createTestApp();
    sup = await t.login('supervisor@demo.local');
    op = await t.login('operator1@demo.local');
    opId = (await t.pool.query(`SELECT id FROM app_user WHERE email = 'operator1@demo.local'`)).rows[0].id;
  }, 60_000);
  afterAll(async () => t?.cleanup());

  it('супервизор создаёт курс, уроки с блоками и ситуациями, тест после урока', async () => {
    const c = await t.call('POST', '/api/v1/courses', sup, {
      code: 'it',
      title: 'Курс ИТ',
      description: 'описание',
      minutes: 10,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    courseId = c.body.id;
    const test = await t.call('POST', '/api/v1/tests', sup, {
      title: 'Тест урока ИТ',
      description: '',
      topicIds: [],
      passScore: 50,
      isActive: true,
      questions: [
        {
          text: '2+2?',
          options: [
            { text: '4', correct: true },
            { text: '5', correct: false },
          ],
        },
      ],
    });
    expect(test.status, JSON.stringify(test.body)).toBe(201);
    testId = test.body.id;
    const l1 = await t.call('POST', `/api/v1/courses/${courseId}/lessons`, sup, {
      title: 'Урок 1',
      summary: 'о',
      blocks: [
        { type: 'text', title: 'Текст', text: 'Абзац **жирный**\n\n- пункт' },
        { type: 'tip', text: 'Совет', tone: 'info' },
        {
          type: 'situation',
          id: 's1',
          question: 'Как поступить?',
          options: [
            { id: 'a', text: 'Верно', correct: true, feedback: 'да' },
            { id: 'b', text: 'Неверно', correct: false },
          ],
          explanation: 'разбор',
        },
      ],
      testId,
    });
    expect(l1.status, JSON.stringify(l1.body)).toBe(201);
    lesson1 = l1.body.id;
    const bad = await t.call('POST', `/api/v1/courses/${courseId}/lessons`, sup, {
      title: 'Плохой',
      blocks: [
        {
          type: 'situation',
          id: 'x',
          question: 'q',
          options: [
            { id: 'a', text: 'a', correct: false },
            { id: 'b', text: 'b', correct: false },
          ],
        },
      ],
    });
    expect(bad.status).toBe(400);
    const l2 = await t.call('POST', `/api/v1/courses/${courseId}/lessons`, sup, {
      title: 'Урок 2',
      blocks: [{ type: 'text', text: 'конец' }],
    });
    lesson2 = l2.body.id;
    expect((await t.call('POST', '/api/v1/courses', op, { title: 'x' })).status).toBe(403);
    const full = await t.call('GET', `/api/v1/courses/${courseId}`, sup);
    expect(full.body.lessons).toHaveLength(2);
    expect(full.body.lessons[0].testTitle).toBe('Тест урока ИТ');
  });

  it('назначение: сотрудник видит курс, проходит ситуации, читает, сдаёт тест — курс пройден', async () => {
    const a = await t.call('POST', '/api/v1/courses-assignments', sup, {
      courseId,
      userIds: [opId],
      dueDate: today(),
      comment: 'к сроку',
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toEqual({ created: 1, updated: 0 });
    const my = await t.call('GET', '/api/v1/my-courses', op);
    const mine = my.body.find((c: { id: string }) => c.id === courseId);
    expect(mine).toMatchObject({ status: 'assigned', progressPct: 0, lessons: 2 });
    assignmentId = mine.assignmentId;
    const bell = await t.pool.query(
      `SELECT subject FROM notification WHERE user_id = $1 AND kind = 'course'`,
      [opId],
    );
    expect(bell.rows[0].subject).toMatch(/назначен курс «Курс ИТ»/);
    // Урок 1: неверный ответ на ситуацию — отмечено, но не верно; прочитано; тест не сдан → урок не пройден.
    const p1 = await t.call('POST', `/api/v1/my-courses/lessons/${lesson1}/progress`, op, {
      assignmentId,
      read: true,
      answers: { s1: 'b' },
    });
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    expect(p1.body).toMatchObject({ completed: false, situationsTotal: 1, situationsCorrect: 0 });
    expect(p1.body.situations[0]).toMatchObject({
      id: 's1',
      answered: true,
      correct: false,
      explanation: 'разбор',
    });
    // Тест урока доступен сотруднику без назначения теста.
    const started = await t.call('POST', `/api/v1/my-tests/${testId}/start`, op);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const q = started.body.questions[0];
    const correctOption = (
      await t.pool.query(`SELECT options FROM knowledge_question WHERE id = $1`, [q.id])
    ).rows[0].options.find((o: { correct: boolean }) => o.correct).id;
    const fin = await t.call('POST', `/api/v1/my-tests/attempts/${started.body.attemptId}/finish`, op, {
      answers: [{ questionId: q.id, optionIds: [correctOption] }],
    });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.passed).toBe(true);
    const p1b = await t.call('POST', `/api/v1/my-courses/lessons/${lesson1}/progress`, op, { assignmentId });
    expect(p1b.body.completed).toBe(true);
    expect(p1b.body.courseCompleted).toBe(false);
    const p2 = await t.call('POST', `/api/v1/my-courses/lessons/${lesson2}/progress`, op, {
      assignmentId,
      read: true,
    });
    expect(p2.body).toMatchObject({ completed: true, courseCompleted: true });
    const course = await t.call('GET', `/api/v1/my-courses/${courseId}`, op);
    expect(course.body.assignment.completedAt).not.toBeNull();
    expect(
      course.body.lessons.map((l: { progress: { completedAt: string | null } }) => !!l.progress?.completedAt),
    ).toEqual([true, true]);
    const list = await t.call('GET', '/api/v1/courses-assignments', sup);
    expect(list.body.find((x: { id: string }) => x.id === assignmentId)).toMatchObject({
      status: 'completed',
      progressPct: 100,
    });
    const res = await t.call('GET', '/api/v1/courses-results', sup);
    expect(res.body.find((r: { userId: string }) => r.userId === opId)).toMatchObject({
      assigned: 1,
      completed: 1,
      situationsPct: 0,
    });
  });

  it('повторное назначение после прохождения — новое назначение с нулевым прогрессом; отмена', async () => {
    const a = await t.call('POST', '/api/v1/courses-assignments', sup, {
      courseId,
      userIds: [opId],
      dueDate: today(),
    });
    expect(a.body).toEqual({ created: 1, updated: 0 });
    const my = (await t.call('GET', '/api/v1/my-courses', op)).body.find(
      (c: { id: string }) => c.id === courseId,
    );
    expect(my).toMatchObject({ status: 'assigned', progressPct: 0, isRepeat: true });
    expect(my.assignmentId).not.toBe(assignmentId);
    const cancel = await t.call('POST', `/api/v1/courses-assignments/${my.assignmentId}/cancel`, sup);
    expect(cancel.status).toBe(200);
    const after = (await t.call('GET', '/api/v1/my-courses', op)).body.find(
      (c: { id: string }) => c.id === courseId,
    );
    expect(after.status).toBe('completed');
  });
});
