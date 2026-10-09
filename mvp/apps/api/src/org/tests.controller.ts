import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { newId } from '@cc/contracts';
import {
  assignmentState,
  gradeAttempt,
  isAnswerCorrect,
  localDate,
  systemTimezone,
  type TestOption,
} from '@cc/domain';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, hasPerm, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, forbidden, notFound, parse } from '../lib/errors';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата ГГГГ-ММ-ДД');

const OptionBody = z
  .object({
    id: z.string().max(64).optional(),
    text: z.string().trim().min(1, 'Пустой вариант ответа').max(1000),
    correct: z.boolean().default(false),
  })
  .strict();
const QuestionBody = z
  .object({
    id: uuid.optional(),
    text: z.string().trim().min(1, 'Пустой вопрос').max(4000),
    options: z.array(OptionBody).min(2, 'У вопроса нужно не меньше двух вариантов').max(12),
  })
  .strict()
  .refine((q) => q.options.some((o) => o.correct), 'У каждого вопроса отметьте правильный вариант');
const TestBody = z
  .object({
    title: z.string().trim().min(1, 'Укажите название теста').max(300),
    description: z.string().trim().max(5000).default(''),
    topicIds: z.array(uuid).max(200).default([]),
    passScore: z.number().int().min(1).max(100).default(80),
    isActive: z.boolean().default(true),
    questions: z.array(QuestionBody).max(300).default([]),
  })
  .strict();
const AssignBody = z
  .object({
    testId: uuid,
    userIds: z.array(uuid).min(1, 'Выберите сотрудников').max(2000),
    dueDate: date,
    comment: z.string().trim().max(1000).default(''),
  })
  .strict();
const FinishBody = z
  .object({
    answers: z
      .array(z.object({ questionId: uuid, optionIds: z.array(z.string().max(64)).max(12) }).strict())
      .max(300),
  })
  .strict();

/** Название темы для показа: «Тема › Подтема». */
const TOPIC_LABEL = `COALESCE(pp.name || ' › ', '') || tp.name`;
const TOPIC_NAMES = (ids: string) =>
  `(SELECT COALESCE(array_agg(${TOPIC_LABEL} ORDER BY ${TOPIC_LABEL}), '{}') FROM topic tp
      LEFT JOIN topic pp ON pp.id = tp.parent_id WHERE tp.id = ANY(${ids}))`;

interface QuestionRow {
  id: string;
  text: string;
  options: TestOption[];
}

/**
 * Тестирование сотрудников (доработки 09.10.2026): тесты с вопросами по темам, назначения со сроком, все попытки
 * и ответы хранятся. Управление — право «Тестирование сотрудников» (tests.manage); пройти назначенный тест и
 * увидеть свои результаты и рейтинг по оценкам клиентов может любой сотрудник. Панель рейтинга операторов —
 * право «Рейтинг операторов» (rating.view).
 */
@Controller('api/v1')
export class TestsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  private async today(): Promise<string> {
    return localDate(new Date(), await systemTimezone(this.ctx.pool));
  }

  // ---------------------------------------------------------------- тесты и вопросы

  @Get('tests')
  @RequirePerm('tests.manage')
  async list() {
    const today = await this.today();
    const list = await rows(
      this.ctx.pool,
      `SELECT t.id, t.title, t.description, t.topic_ids, t.pass_score, t.is_active, t.created_at, t.updated_at,
              ${TOPIC_NAMES('t.topic_ids')} AS topic_names,
              (SELECT count(*)::int FROM knowledge_question q WHERE q.test_id = t.id AND q.is_active) AS questions,
              (SELECT count(*)::int FROM test_assignment a WHERE a.test_id = t.id AND a.cancelled_at IS NULL) AS assigned,
              (SELECT count(*)::int FROM test_assignment a WHERE a.test_id = t.id AND a.cancelled_at IS NULL
                  AND a.passed_at IS NOT NULL) AS passed,
              (SELECT count(*)::int FROM test_assignment a WHERE a.test_id = t.id AND a.cancelled_at IS NULL
                  AND a.passed_at IS NULL AND a.due_date < $1::date) AS overdue,
              (SELECT count(*)::int FROM test_attempt x WHERE x.test_id = t.id AND x.finished_at IS NOT NULL) AS attempts,
              (SELECT round(avg(x.score))::int FROM test_attempt x WHERE x.test_id = t.id AND x.finished_at IS NOT NULL) AS avg_score
         FROM knowledge_test t ORDER BY t.is_active DESC, t.title`,
      [today],
    );
    return list.map((r) => toApi(r));
  }

  @Get('tests/:id')
  @RequirePerm('tests.manage')
  async get(@Param('id') id: string) {
    const t = await one(
      this.ctx.pool,
      `SELECT t.id, t.title, t.description, t.topic_ids, t.pass_score, t.is_active, ${TOPIC_NAMES('t.topic_ids')} AS topic_names
         FROM knowledge_test t WHERE t.id = $1`,
      [parse(uuid, id)],
    );
    if (!t) throw notFound('Тест');
    const questions = await rows(
      this.ctx.pool,
      `SELECT id, text, options, sort_order FROM knowledge_question WHERE test_id = $1 AND is_active ORDER BY sort_order, created_at`,
      [id],
    );
    return { ...toApi(t), questions: questions.map((r) => toApi(r)) };
  }

  @Post('tests')
  @RequirePerm('tests.manage')
  async create(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(TestBody, body);
    const id = newId();
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query(
        `INSERT INTO knowledge_test (id, title, description, topic_ids, pass_score, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, b.title, b.description, b.topicIds, b.passScore, b.isActive, p.id],
      );
      await this.saveQuestions(tx, id, b.questions);
      await audit(tx, p, 'create', 'knowledge_test', id, null, {
        title: b.title,
        questions: b.questions.length,
      });
    });
    return this.get(id);
  }

  /** Сохранить тест целиком: поля и вопросы (новые — добавить, изменённые — обновить, убранные — выключить). */
  @Put('tests/:id')
  @RequirePerm('tests.manage')
  async update(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(TestBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, 'SELECT title FROM knowledge_test WHERE id = $1 FOR UPDATE', [
        parse(uuid, id),
      ]);
      if (!before) throw notFound('Тест');
      await tx.query(
        `UPDATE knowledge_test SET title = $2, description = $3, topic_ids = $4, pass_score = $5, is_active = $6,
                updated_at = now() WHERE id = $1`,
        [id, b.title, b.description, b.topicIds, b.passScore, b.isActive],
      );
      await this.saveQuestions(tx, id, b.questions);
      await audit(tx, p, 'update', 'knowledge_test', id, before, {
        title: b.title,
        questions: b.questions.length,
      });
    });
    return this.get(id);
  }

  private async saveQuestions(tx: PoolClient, testId: string, qs: z.infer<typeof QuestionBody>[]) {
    const keep: string[] = [];
    for (const [i, q] of qs.entries()) {
      const options = q.options.map((o) => ({ id: o.id || newId(), text: o.text, correct: o.correct }));
      const exists =
        q.id &&
        (await one(tx, 'SELECT id FROM knowledge_question WHERE id = $1 AND test_id = $2', [q.id, testId]));
      if (exists) {
        await tx.query(
          `UPDATE knowledge_question SET text = $2, options = $3, sort_order = $4, is_active = true, updated_at = now()
            WHERE id = $1`,
          [q.id, q.text, JSON.stringify(options), i],
        );
        keep.push(q.id!);
      } else {
        const qid = newId();
        await tx.query(
          `INSERT INTO knowledge_question (id, test_id, text, options, sort_order) VALUES ($1, $2, $3, $4, $5)`,
          [qid, testId, q.text, JSON.stringify(options), i],
        );
        keep.push(qid);
      }
    }
    // Убранные вопросы выключаются (их ответы остаются в истории и рейтинге вопросов).
    await tx.query(
      `UPDATE knowledge_question SET is_active = false, updated_at = now()
        WHERE test_id = $1 AND is_active AND NOT (id = ANY($2::uuid[]))`,
      [testId, keep],
    );
  }

  // ---------------------------------------------------------------- назначения

  /** Сотрудники для назначения (справочник сотрудников) и их роли. */
  @Get('tests-people')
  @RequirePerm('tests.manage')
  async people() {
    const users = await rows(
      this.ctx.pool,
      `SELECT u.id, u.full_name, COALESCE(array_agg(ur.role_code ORDER BY ur.role_code)
                FILTER (WHERE ur.role_code IS NOT NULL), '{}') AS roles
         FROM app_user u LEFT JOIN user_role ur ON ur.user_id = u.id
        WHERE u.is_active AND u.can_login GROUP BY u.id ORDER BY u.full_name`,
    );
    const roles = await rows(this.ctx.pool, 'SELECT code, name FROM role ORDER BY name');
    return { users: users.map((r) => toApi(r)), roles: roles.map((r) => toApi(r)) };
  }

  @Get('tests-assignments')
  @RequirePerm('tests.manage')
  async assignments(@Query() q: Record<string, string>) {
    return this.assignmentRows({
      testId: q.testId ? parse(uuid, q.testId) : null,
      userId: q.userId ? parse(uuid, q.userId) : null,
    });
  }

  private async assignmentRows(f: { testId?: string | null; userId?: string | null }) {
    const today = await this.today();
    const list = await rows(
      this.ctx.pool,
      `SELECT a.id, a.test_id, t.title AS test_title, a.user_id, u.full_name, to_char(a.due_date, 'YYYY-MM-DD') AS due_date,
              a.passed_at, a.cancelled_at, a.created_at, a.comment, ab.full_name AS assigned_by_name,
              t.pass_score, ${TOPIC_NAMES('t.topic_ids')} AS topic_names,
              (SELECT count(*)::int FROM knowledge_question kq WHERE kq.test_id = t.id AND kq.is_active) AS questions,
              (SELECT count(*)::int FROM test_attempt x WHERE x.user_id = a.user_id AND x.test_id = a.test_id
                  AND x.finished_at IS NOT NULL AND x.started_at >= a.created_at) AS attempts,
              (SELECT max(x.score) FROM test_attempt x WHERE x.user_id = a.user_id AND x.test_id = a.test_id
                  AND x.finished_at IS NOT NULL AND x.started_at >= a.created_at) AS best_score
         FROM test_assignment a JOIN knowledge_test t ON t.id = a.test_id JOIN app_user u ON u.id = a.user_id
         LEFT JOIN app_user ab ON ab.id = a.assigned_by
        WHERE ($1::uuid IS NULL OR a.test_id = $1) AND ($2::uuid IS NULL OR a.user_id = $2)
        ORDER BY (a.cancelled_at IS NULL) DESC, (a.passed_at IS NULL) DESC, a.due_date, u.full_name LIMIT 2000`,
      [f.testId ?? null, f.userId ?? null],
    );
    return list.map((r) => {
      const a = toApi(r) as Record<string, unknown>;
      const s = assignmentState(
        { passedAt: a.passedAt, cancelledAt: a.cancelledAt, dueDate: String(a.dueDate) },
        today,
      );
      return { ...a, status: s.status, daysLeft: s.daysLeft };
    });
  }

  /**
   * Назначить тест сотрудникам со сроком. У кого этот тест уже назначен и не пройден — срок и комментарий
   * обновляются (без дублей). Каждому — уведомление в колокольчик.
   */
  @Post('tests-assignments')
  @RequirePerm('tests.manage')
  async assign(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(AssignBody, body);
    if (b.dueDate < (await this.today())) throw badRequest('Срок не может быть в прошлом');
    return withTx(this.ctx.pool, async (tx) => {
      const t = await one<{ title: string; is_active: boolean; questions: number }>(
        tx,
        `SELECT title, is_active, (SELECT count(*)::int FROM knowledge_question q WHERE q.test_id = t.id AND q.is_active) AS questions
           FROM knowledge_test t WHERE id = $1`,
        [b.testId],
      );
      if (!t) throw notFound('Тест');
      if (!t.is_active) throw badRequest('Тест выключен — включите его перед назначением');
      if (!t.questions) throw badRequest('В тесте нет вопросов');
      const users = await rows<{ id: string }>(
        tx,
        'SELECT id FROM app_user WHERE id = ANY($1::uuid[]) AND is_active AND can_login',
        [b.userIds],
      );
      if (!users.length) throw badRequest('Выберите действующих сотрудников');
      let created = 0;
      let updated = 0;
      const ddmmyyyy = `${b.dueDate.slice(8, 10)}.${b.dueDate.slice(5, 7)}.${b.dueDate.slice(0, 4)}`;
      for (const u of users) {
        const open = await one<{ id: string }>(
          tx,
          `SELECT id FROM test_assignment WHERE test_id = $1 AND user_id = $2 AND cancelled_at IS NULL AND passed_at IS NULL`,
          [b.testId, u.id],
        );
        let aid: string;
        if (open) {
          aid = open.id;
          await tx.query('UPDATE test_assignment SET due_date = $2, comment = $3 WHERE id = $1', [
            aid,
            b.dueDate,
            b.comment,
          ]);
          // Новый срок — напоминания начинаются заново.
          await tx.query('DELETE FROM test_reminder WHERE assignment_id = $1', [aid]);
          updated++;
        } else {
          aid = newId();
          await tx.query(
            `INSERT INTO test_assignment (id, test_id, user_id, due_date, assigned_by, comment) VALUES ($1, $2, $3, $4, $5, $6)`,
            [aid, b.testId, u.id, b.dueDate, p.id, b.comment],
          );
          created++;
        }
        await tx.query(
          `INSERT INTO notification (id, user_id, kind, channel, dedupe_key, subject, body, data, status, sent_at)
           VALUES ($1, $2, 'test', 'ui', $3, $4, $5, $6, 'sent', now()) ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            newId(),
            u.id,
            `test-assigned:${aid}:${b.dueDate}`,
            `Вам назначен тест «${t.title}» — пройти до ${ddmmyyyy}`,
            b.comment,
            JSON.stringify({ path: '/my-tests' }),
          ],
        );
      }
      await audit(tx, p, 'create', 'test_assignment', b.testId, null, { ...b, created, updated });
      return { created, updated };
    });
  }

  @Post('tests-assignments/:id/cancel')
  @HttpCode(200)
  @RequirePerm('tests.manage')
  async cancel(@CurrentUser() p: Principal, @Param('id') id: string) {
    return withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        `UPDATE test_assignment SET cancelled_at = now() WHERE id = $1 AND cancelled_at IS NULL AND passed_at IS NULL`,
        [parse(uuid, id)],
      );
      if (!r.rowCount) throw new ApiError(409, 'bad_status', 'Назначение уже пройдено или отменено');
      await audit(tx, p, 'delete', 'test_assignment', id, null, null);
      return { cancelled: 1 };
    });
  }

  // ---------------------------------------------------------------- результаты

  /** Сводка по сотрудникам: попытки, пройденные тесты, средний балл, открытые и просроченные назначения. */
  @Get('tests-results')
  @RequirePerm('tests.manage')
  async results() {
    const today = await this.today();
    const list = await rows(
      this.ctx.pool,
      `SELECT u.id, u.full_name,
              count(x.id)::int AS attempts,
              count(DISTINCT x.test_id) FILTER (WHERE x.passed)::int AS tests_passed,
              count(DISTINCT x.test_id)::int AS tests_tried,
              round(avg(x.score))::int AS avg_score,
              max(x.finished_at) AS last_at,
              (SELECT count(*)::int FROM test_assignment a WHERE a.user_id = u.id AND a.cancelled_at IS NULL
                  AND a.passed_at IS NULL AND a.due_date >= $1::date) AS open,
              (SELECT count(*)::int FROM test_assignment a WHERE a.user_id = u.id AND a.cancelled_at IS NULL
                  AND a.passed_at IS NULL AND a.due_date < $1::date) AS overdue,
              (SELECT COALESCE(array_agg(r.name ORDER BY r.name), '{}') FROM user_role ur JOIN role r ON r.code = ur.role_code
                WHERE ur.user_id = u.id) AS roles
         FROM app_user u LEFT JOIN test_attempt x ON x.user_id = u.id AND x.finished_at IS NOT NULL
        WHERE u.is_active AND (EXISTS (SELECT 1 FROM test_attempt y WHERE y.user_id = u.id AND y.finished_at IS NOT NULL)
               OR EXISTS (SELECT 1 FROM test_assignment a WHERE a.user_id = u.id AND a.cancelled_at IS NULL))
        GROUP BY u.id ORDER BY u.full_name`,
      [today],
    );
    return list.map((r) => toApi(r));
  }

  /** Компетентность по темам: сотрудник × тема — попытки, средний, лучший и последний балл. */
  @Get('tests-competence')
  @RequirePerm('tests.manage')
  async competence() {
    return this.topicStats(null);
  }

  private async topicStats(userId: string | null) {
    const list = await rows(
      this.ctx.pool,
      `SELECT x.user_id, u.full_name, tp.id AS topic_id, ${TOPIC_LABEL} AS topic_name,
              count(*)::int AS attempts, round(avg(x.score))::int AS avg_score, max(x.score)::int AS best_score,
              (array_agg(x.score ORDER BY x.finished_at DESC))[1]::int AS last_score, max(x.finished_at) AS last_at
         FROM test_attempt x JOIN knowledge_test t ON t.id = x.test_id JOIN app_user u ON u.id = x.user_id
         CROSS JOIN LATERAL unnest(t.topic_ids) AS tid
         JOIN topic tp ON tp.id = tid LEFT JOIN topic pp ON pp.id = tp.parent_id
        WHERE x.finished_at IS NOT NULL AND ($1::uuid IS NULL OR x.user_id = $1)
        GROUP BY x.user_id, u.full_name, tp.id, pp.name, tp.name
        ORDER BY u.full_name, topic_name`,
      [userId],
    );
    return list.map((r) => toApi(r));
  }

  private async attemptRows(userId: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT x.id, x.test_id, t.title AS test_title, x.started_at, x.finished_at, x.correct, x.total, x.score, x.passed,
              ${TOPIC_NAMES('t.topic_ids')} AS topic_names,
              row_number() OVER (PARTITION BY x.test_id ORDER BY x.started_at)::int AS try_no
         FROM test_attempt x JOIN knowledge_test t ON t.id = x.test_id
        WHERE x.user_id = $1 AND x.finished_at IS NOT NULL ORDER BY x.finished_at DESC LIMIT 500`,
      [userId],
    );
    return list.map((r) => toApi(r));
  }

  /** Сотрудник: все попытки (дата, тест, какая по счёту, балл), темы, назначения. */
  @Get('tests-results/:userId')
  @RequirePerm('tests.manage')
  async userResults(@Param('userId') userId: string) {
    const u = await one(this.ctx.pool, 'SELECT id, full_name FROM app_user WHERE id = $1', [
      parse(uuid, userId),
    ]);
    if (!u) throw notFound('Сотрудник');
    return {
      user: toApi(u),
      attempts: await this.attemptRows(userId),
      topics: await this.topicStats(userId),
      assignments: await this.assignmentRows({ userId }),
    };
  }

  /** Попытка с ответами: вопрос, варианты (правильные отмечены), что выбрано. Владельцу и с правом тестирования. */
  @Get('tests-attempts/:id')
  async attempt(@CurrentUser() p: Principal, @Param('id') id: string) {
    const a = await one<{ user_id: string }>(
      this.ctx.pool,
      `SELECT x.id, x.user_id, u.full_name, x.test_id, t.title AS test_title, t.pass_score, x.started_at, x.finished_at,
              x.correct, x.total, x.score, x.passed, x.question_ids
         FROM test_attempt x JOIN knowledge_test t ON t.id = x.test_id JOIN app_user u ON u.id = x.user_id
        WHERE x.id = $1`,
      [parse(uuid, id)],
    );
    if (!a) throw notFound('Попытка');
    if (a.user_id !== p.id && !hasPerm(p, 'tests.manage')) throw forbidden();
    const qs = await rows(
      this.ctx.pool,
      `SELECT q.id, q.text, q.options, ans.chosen, ans.correct
         FROM unnest((SELECT question_ids FROM test_attempt WHERE id = $1)) WITH ORDINALITY AS o(qid, n)
         JOIN knowledge_question q ON q.id = o.qid
         LEFT JOIN test_answer ans ON ans.attempt_id = $1 AND ans.question_id = q.id
        ORDER BY o.n`,
      [id],
    );
    const rest = toApi(a) as Record<string, unknown>;
    delete rest.questionIds;
    return { ...rest, questions: qs.map((r) => toApi(r)) };
  }

  // ---------------------------------------------------------------- рейтинг вопросов

  /** Вопросы: сколько раз отвечали и как часто ошибаются (по тесту и/или сотруднику). Сначала — самые «трудные». */
  @Get('tests-questions')
  @RequirePerm('tests.manage')
  async questions(@Query() q: Record<string, string>) {
    const list = await rows(
      this.ctx.pool,
      `SELECT q.id, q.text, q.is_active, t.id AS test_id, t.title AS test_title,
              count(a.question_id)::int AS answers, count(a.question_id) FILTER (WHERE NOT a.correct)::int AS wrong,
              count(DISTINCT a.user_id)::int AS people
         FROM knowledge_question q JOIN knowledge_test t ON t.id = q.test_id
         LEFT JOIN test_answer a ON a.question_id = q.id AND ($2::uuid IS NULL OR a.user_id = $2)
        WHERE ($1::uuid IS NULL OR q.test_id = $1)
        GROUP BY q.id, t.id
        ORDER BY (count(a.question_id) FILTER (WHERE NOT a.correct))::float / NULLIF(count(a.question_id), 0) DESC NULLS LAST,
                 wrong DESC, t.title, q.sort_order`,
      [q.testId ? parse(uuid, q.testId) : null, q.userId ? parse(uuid, q.userId) : null],
    );
    return list.map((r) => toApi(r));
  }

  /** Вопрос: какие варианты выбирают и кто из сотрудников ошибается. */
  @Get('tests-questions/:id')
  @RequirePerm('tests.manage')
  async question(@Param('id') id: string) {
    const qq = await one<{ options: TestOption[] }>(
      this.ctx.pool,
      `SELECT q.id, q.text, q.options, t.title AS test_title FROM knowledge_question q JOIN knowledge_test t ON t.id = q.test_id
        WHERE q.id = $1`,
      [parse(uuid, id)],
    );
    if (!qq) throw notFound('Вопрос');
    const picks = await rows<{ option_id: string; n: number }>(
      this.ctx.pool,
      `SELECT o AS option_id, count(*)::int AS n FROM test_answer a CROSS JOIN LATERAL jsonb_array_elements_text(a.chosen) AS o
        WHERE a.question_id = $1 GROUP BY o`,
      [id],
    );
    const byUser = await rows(
      this.ctx.pool,
      `SELECT a.user_id, u.full_name, count(*)::int AS answers, count(*) FILTER (WHERE NOT a.correct)::int AS wrong,
              max(a.answered_at) AS last_at
         FROM test_answer a JOIN app_user u ON u.id = a.user_id WHERE a.question_id = $1
        GROUP BY a.user_id, u.full_name ORDER BY wrong DESC, u.full_name`,
      [id],
    );
    const count = new Map(picks.map((r) => [r.option_id, r.n]));
    return {
      ...toApi(qq),
      options: qq.options.map((o) => ({ ...o, chosen: count.get(o.id) ?? 0 })),
      users: byUser.map((r) => toApi(r)),
    };
  }

  // ---------------------------------------------------------------- сотрудник: свои тесты

  @Get('my-tests')
  async myTests(@CurrentUser() p: Principal) {
    return {
      assignments: (await this.assignmentRows({ userId: p.id })).filter((a) => a.status !== 'cancelled'),
      attempts: await this.attemptRows(p.id),
      topics: await this.topicStats(p.id),
    };
  }

  /** Для значка в шапке: просроченные и с близким сроком (≤ 3 дней) назначения. */
  @Get('my-tests/due')
  async myDue(@CurrentUser() p: Principal) {
    const today = await this.today();
    const r = await one<{
      overdue: number;
      soon: number;
      nearest: string | null;
      nearest_title: string | null;
    }>(
      this.ctx.pool,
      `SELECT count(*) FILTER (WHERE a.due_date < $2::date)::int AS overdue,
              count(*) FILTER (WHERE a.due_date >= $2::date AND a.due_date - $2::date <= 3)::int AS soon,
              to_char(min(a.due_date), 'YYYY-MM-DD') AS nearest,
              (array_agg(t.title ORDER BY a.due_date))[1] AS nearest_title
         FROM test_assignment a JOIN knowledge_test t ON t.id = a.test_id
        WHERE a.user_id = $1 AND a.cancelled_at IS NULL AND a.passed_at IS NULL`,
      [p.id, today],
    );
    return toApi(r ?? {});
  }

  /** Начать попытку: назначенный тест (или любой — с правом тестирования, чтобы проверить свой тест). */
  @Post('my-tests/:testId/start')
  async start(@CurrentUser() p: Principal, @Param('testId') testId: string) {
    parse(uuid, testId);
    return withTx(this.ctx.pool, async (tx) => {
      const t = await one<{ title: string; description: string; pass_score: number; is_active: boolean }>(
        tx,
        'SELECT title, description, pass_score, is_active FROM knowledge_test WHERE id = $1',
        [testId],
      );
      if (!t) throw notFound('Тест');
      if (!t.is_active) throw badRequest('Тест выключен');
      const assignment = await one<{ id: string }>(
        tx,
        `SELECT id FROM test_assignment WHERE test_id = $1 AND user_id = $2 AND cancelled_at IS NULL
          ORDER BY (passed_at IS NULL) DESC, created_at DESC LIMIT 1`,
        [testId, p.id],
      );
      if (!assignment && !hasPerm(p, 'tests.manage'))
        throw new ApiError(403, 'forbidden', 'Этот тест вам не назначен');
      const qs = await rows<QuestionRow>(
        tx,
        `SELECT id, text, options FROM knowledge_question WHERE test_id = $1 AND is_active ORDER BY sort_order, created_at`,
        [testId],
      );
      if (!qs.length) throw badRequest('В тесте нет вопросов');
      const id = newId();
      await tx.query(
        `INSERT INTO test_attempt (id, test_id, user_id, assignment_id, question_ids, total) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, testId, p.id, assignment?.id ?? null, qs.map((q) => q.id), qs.length],
      );
      return {
        attemptId: id,
        title: t.title,
        description: t.description,
        passScore: t.pass_score,
        // Правильные ответы не передаются; «multi» — нужно отметить несколько вариантов.
        questions: qs.map((q) => ({
          id: q.id,
          text: q.text,
          multi: q.options.filter((o) => o.correct).length > 1,
          options: q.options.map((o) => ({ id: o.id, text: o.text })),
        })),
      };
    });
  }

  /** Завершить попытку: проверка ответов на сервере, сохранение каждого ответа, отметка «пройдено» в назначении. */
  @Post('my-tests/attempts/:id/finish')
  @HttpCode(200)
  async finish(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(FinishBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const a = await one<{
        user_id: string;
        test_id: string;
        question_ids: string[];
        finished_at: Date | null;
      }>(
        tx,
        'SELECT user_id, test_id, question_ids, finished_at FROM test_attempt WHERE id = $1 FOR UPDATE',
        [parse(uuid, id)],
      );
      if (!a) throw notFound('Попытка');
      if (a.user_id !== p.id) throw forbidden();
      if (a.finished_at) throw new ApiError(409, 'bad_status', 'Тест уже завершён');
      const pass = await one<{ pass_score: number }>(
        tx,
        'SELECT pass_score FROM knowledge_test WHERE id = $1',
        [a.test_id],
      );
      const qs = await rows<QuestionRow>(
        tx,
        'SELECT id, text, options FROM knowledge_question WHERE id = ANY($1)',
        [a.question_ids],
      );
      const chosen = new Map(b.answers.map((x) => [x.questionId, x.optionIds]));
      let correct = 0;
      for (const q of qs) {
        const picked = [...new Set(chosen.get(q.id) ?? [])];
        const ok = isAnswerCorrect(q.options, picked);
        if (ok) correct++;
        await tx.query(
          `INSERT INTO test_answer (attempt_id, question_id, user_id, chosen, correct) VALUES ($1, $2, $3, $4, $5)`,
          [id, q.id, p.id, JSON.stringify(picked), ok],
        );
      }
      const g = gradeAttempt(correct, a.question_ids.length, pass?.pass_score ?? 80);
      await tx.query(
        `UPDATE test_attempt SET finished_at = now(), correct = $2, total = $3, score = $4, passed = $5 WHERE id = $1`,
        [id, correct, a.question_ids.length, g.score, g.passed],
      );
      if (g.passed)
        await tx.query(
          `UPDATE test_assignment SET passed_at = now()
            WHERE test_id = $1 AND user_id = $2 AND cancelled_at IS NULL AND passed_at IS NULL`,
          [a.test_id, p.id],
        );
    });
    return this.attempt(p, id);
  }

  // ---------------------------------------------------------------- рейтинги

  /**
   * Рейтинг операторов: место по средней оценке клиентов за период (при равенстве — по числу оценок и
   * обработанных), статус на линии, работа с обращением сейчас, обработано за период и с начала смены,
   * компетентность по тестам. Обработано — закрыто сотрудником или передано им на 2-ю линию.
   */
  @Get('ratings/operators')
  @RequirePerm('rating.view')
  async operators(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    return this.operatorRating(p, Math.min(Math.max(Number(q.days) || 30, 1), 3650));
  }

  private async operatorRating(p: Principal, days: number) {
    const tz = await systemTimezone(this.ctx.pool);
    const list = await rows<
      Record<string, unknown> & { csat_n: number; csat_avg: string | null; handled: number }
    >(
      this.ctx.pool,
      `WITH ops AS (
         SELECT u.id, u.full_name FROM app_user u
          WHERE u.is_active AND u.can_login AND EXISTS (
            SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
             WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))
            AND NOT EXISTS (
            SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
             WHERE ur.user_id = u.id AND r.permissions && ARRAY['admin.users', 'supervisor.monitor']::text[])),
       since AS (SELECT now() - make_interval(days => $1) AS t0,
                        (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS d0),
       shift AS (SELECT l.user_id, min(l.started_at) AS start FROM agent_status_log l, since
                  WHERE l.status <> 'offline' AND l.started_at >= since.d0 GROUP BY 1)
       SELECT o.id, o.full_name,
              COALESCE(ag.status, 'offline') AS status, br.name AS reason_name,
              extract(epoch FROM now() - ag.since)::int AS since_s,
              (SELECT round(avg(c.score), 2) FROM csat_rating c, since WHERE c.agent_user_id = o.id AND c.created_at >= since.t0) AS csat_avg,
              (SELECT count(*)::int FROM csat_rating c, since WHERE c.agent_user_id = o.id AND c.created_at >= since.t0) AS csat_n,
              ((SELECT count(*)::int FROM conversation c, since WHERE c.closed_by = o.id AND c.status = 'closed' AND c.closed_at >= since.t0)
               + (SELECT count(*)::int FROM ticket t, since WHERE t.created_by = o.id AND t.created_at >= since.t0)) AS handled,
              s.start AS shift_start,
              CASE WHEN s.start IS NULL THEN NULL ELSE
                (SELECT count(*)::int FROM conversation c WHERE c.closed_by = o.id AND c.status = 'closed' AND c.closed_at >= s.start)
                + (SELECT count(*)::int FROM ticket t WHERE t.created_by = o.id AND t.created_at >= s.start) END AS handled_shift,
              (SELECT count(*)::int FROM conversation c WHERE c.assignee_id = o.id AND c.status IN ('active', 'hold')) AS active_now,
              EXISTS (SELECT 1 FROM call cl WHERE cl.agent_user_id = o.id AND cl.state = 'talking') AS on_call,
              (SELECT round(avg(b.best))::int FROM (SELECT max(x.score) AS best FROM test_attempt x
                  WHERE x.user_id = o.id AND x.finished_at IS NOT NULL GROUP BY x.test_id) b) AS competence
         FROM ops o LEFT JOIN agent_status ag ON ag.user_id = o.id LEFT JOIN break_reason br ON br.id = ag.reason_id
         LEFT JOIN shift s ON s.user_id = o.id`,
      [days, tz],
    );
    // Места — только у тех, кому ставили оценки; остальные — ниже, по числу обработанных.
    const rated = list
      .filter((r) => r.csat_n > 0)
      .sort(
        (a, b) => Number(b.csat_avg) - Number(a.csat_avg) || b.csat_n - a.csat_n || b.handled - a.handled,
      );
    const unrated = list.filter((r) => !r.csat_n).sort((a, b) => b.handled - a.handled);
    return {
      days,
      items: [
        ...rated.map((r, i) => ({
          ...toApi(r),
          csatAvg: Number(r.csat_avg),
          place: i + 1,
          me: r.id === p.id,
        })),
        ...unrated.map((r) => ({ ...toApi(r), csatAvg: null, place: null, me: r.id === p.id })),
      ],
      rated: rated.length,
    };
  }

  /** Мой рейтинг по оценкам клиентов: за 30 дней и всё время, распределение оценок, место среди операторов. */
  @Get('my-rating')
  async myRating(@CurrentUser() p: Principal) {
    const stats = async (days: number | null) =>
      one<{ avg: string | null; n: number }>(
        this.ctx.pool,
        `SELECT round(avg(score), 2) AS avg, count(*)::int AS n FROM csat_rating
          WHERE agent_user_id = $1 AND ($2::int IS NULL OR created_at >= now() - make_interval(days => $2))`,
        [p.id, days],
      );
    const dist = await rows<{ score: number; n: number }>(
      this.ctx.pool,
      `SELECT score, count(*)::int AS n FROM csat_rating WHERE agent_user_id = $1 GROUP BY score`,
      [p.id],
    );
    const month = await stats(30);
    const all = await stats(null);
    const rating = await this.operatorRating(p, 30);
    const mine = rating.items.find((r) => r.me);
    return {
      month: { avg: month?.avg ? Number(month.avg) : null, count: month?.n ?? 0 },
      all: { avg: all?.avg ? Number(all.avg) : null, count: all?.n ?? 0 },
      distribution: [1, 2, 3, 4, 5].map((s) => ({
        score: s,
        count: dist.find((d) => d.score === s)?.n ?? 0,
      })),
      place: mine?.place ?? null,
      of: rating.rated,
      handledMonth: Number((mine as Record<string, unknown> | undefined)?.handled ?? 0),
    };
  }
}
