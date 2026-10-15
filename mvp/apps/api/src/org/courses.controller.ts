import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { newId } from '@cc/contracts';
import { emitNotice, systemTimezone } from '@cc/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, hasPerm, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';

const uuid = z.string().uuid();
const Option = z
  .object({
    id: z.string().max(40),
    text: z.string().trim().min(1).max(500),
    correct: z.boolean(),
    feedback: z.string().max(1000).optional(),
  })
  .strict();
const short = z.string().max(300);
const para = z.string().max(4000);
/**
 * Блоки урока: текст, картинка, подсказка, шаги, цитата, ситуация «как поступить»; Д-040 — урок по слайдам: «slide»
 * начинает новый слайд, «intro» (зачем урок и что даст), «cards» (приёмы карточками), «compare» (так не надо / так
 * лучше), «dialog» (пример разговора), «case» (случай из практики).
 */
const Block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('slide'), title: short.optional() }).strict(),
  z
    .object({
      type: z.literal('intro'),
      why: para,
      gains: z.array(short).max(8).default([]),
      assetId: uuid.optional(),
      url: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('cards'),
      title: short.optional(),
      items: z
        .array(
          z
            .object({
              icon: z.string().max(8).optional(),
              iconAssetId: uuid.optional(),
              title: short,
              text: para,
            })
            .strict(),
        )
        .min(1)
        .max(12),
    })
    .strict(),
  z
    .object({
      type: z.literal('compare'),
      title: short.optional(),
      bad: z.object({ label: short.optional(), items: z.array(para).max(12) }).strict(),
      good: z.object({ label: short.optional(), items: z.array(para).max(12) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('dialog'),
      title: short.optional(),
      lines: z
        .array(z.object({ who: z.enum(['client', 'operator']), text: para }).strict())
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({ type: z.literal('case'), title: short.optional(), situation: para, action: para, result: para })
    .strict(),
  z
    .object({ type: z.literal('text'), title: z.string().max(200).optional(), text: z.string().max(20000) })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      assetId: uuid.optional(),
      url: z.string().max(1000).optional(),
      caption: z.string().max(500).optional(),
    })
    .strict(),
  // Д-089: видеоурок (MP4 в файлах курса) — «рисунок на доске + диктор».
  z
    .object({
      type: z.literal('video'),
      assetId: uuid.optional(),
      url: z.string().max(1000).optional(),
      title: z.string().max(200).optional(),
      caption: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tip'),
      text: z.string().max(4000),
      tone: z.enum(['info', 'warning', 'success']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('steps'),
      title: z.string().max(200).optional(),
      items: z.array(z.string().max(1000)).max(30),
    })
    .strict(),
  z
    .object({ type: z.literal('quote'), text: z.string().max(2000), author: z.string().max(200).optional() })
    .strict(),
  z
    .object({
      type: z.literal('situation'),
      id: z.string().max(40),
      question: z.string().max(4000),
      options: z.array(Option).min(2).max(6),
      explanation: z.string().max(4000).optional(),
    })
    .strict(),
]);
/** В каждой ситуации должен быть верный вариант (проверка после разбора: discriminatedUnion не принимает refine). */
const checkBlocks = (blocks: LessonBlock[]) => {
  for (const b of blocks)
    if (b.type === 'situation' && !b.options.some((o) => o.correct))
      throw badRequest('В ситуации нужен верный вариант');
};
export type LessonBlock = z.infer<typeof Block>;
const CourseBody = z
  .object({
    code: z.string().trim().max(64).nullable().optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).default(''),
    topicIds: z.array(uuid).max(50).default([]),
    coverAssetId: uuid.nullable().optional(),
    color: z.string().max(20).default('green'),
    icon: z.string().max(40).default('school'),
    minutes: z.number().int().min(1).max(600).default(20),
    sortOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
  })
  .strict();
const CoursePatch = CourseBody.partial().strict();
const LessonBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().max(1000).default(''),
    blocks: z.array(Block).max(80).default([]),
    testId: uuid.nullable().optional(),
    sortOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
  })
  .strict();
const LessonPatch = LessonBody.partial().strict();
const AssignBody = z
  .object({
    courseId: uuid,
    userIds: z.array(uuid).min(1).max(500),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    comment: z.string().max(1000).default(''),
    /** Повторное прохождение: новое назначение даже тем, кто уже прошёл курс. */
    repeat: z.boolean().default(false),
  })
  .strict();
const ProgressBody = z
  .object({
    assignmentId: uuid.nullable().optional(),
    read: z.boolean().optional(),
    /** Ответы на ситуации: id ситуации → id варианта. */
    answers: z.record(z.string().max(40), z.string().max(40)).optional(),
  })
  .strict();

interface LessonRow {
  [k: string]: unknown;
  id: string;
  course_id: string;
  title: string;
  summary: string;
  blocks: LessonBlock[];
  test_id: string | null;
  sort_order: number;
  is_active: boolean;
}

/**
 * Система обучения (Д-014): курсы и уроки с блоками (текст, картинки, подсказки, шаги, ситуации «как поступить»),
 * тест после урока (тесты сотрудников, Ф16), назначение и повторное прохождение, отметки прохождения. Управление —
 * право «тесты сотрудников» (администратор, супервизор); проходить курсы может любой сотрудник.
 */
@Controller('api/v1')
export class CoursesController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  private async today(): Promise<string> {
    const tz = await systemTimezone(this.ctx.pool);
    const r = await one<{ d: string }>(
      this.ctx.pool,
      `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`,
      [tz],
    );
    return r!.d;
  }

  // ---------------------------------------------------------------- картинки курсов

  /** Картинка, PDF или видео курса (raw-тело, имя — заголовок x-filename). Доступен всем сотрудникам по id. */
  @Post('courses/assets')
  @RequirePerm('tests.manage')
  async uploadAsset(@CurrentUser() p: Principal, @Req() req: FastifyRequest) {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Пустой файл');
    const maxMb = this.ctx.config.MAX_UPLOAD_MB;
    if (body.length > maxMb * 1024 * 1024) throw new ApiError(413, 'too_large', `Файл больше ${maxMb} МБ`);
    const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'image'))
      .slice(0, 200)
      .replace(/[\\/]/g, '_');
    const contentType = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!;
    if (!/^(image\/|application\/pdf|video\/(webm|mp4)$)/.test(contentType))
      throw badRequest('Допустимы картинки, PDF и видео (WebM, MP4)');
    const id = newId();
    const key = `courses/${id}`;
    await this.ctx.storage.put(key, body, contentType);
    await this.ctx.pool.query(
      `INSERT INTO course_asset (id, filename, content_type, size_bytes, storage_key, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, filename, contentType, body.length, key, p.id],
    );
    return { id, filename, contentType, size: body.length, url: `/api/v1/courses/assets/${id}` };
  }

  @Get('courses/assets/:id')
  async asset(@Param('id') id: string, @Res() reply: FastifyReply) {
    parse(uuid, id);
    const a = await one<{ storage_key: string; filename: string; content_type: string }>(
      this.ctx.pool,
      `SELECT storage_key, filename, content_type FROM course_asset WHERE id = $1`,
      [id],
    );
    if (!a) throw notFound('Файл');
    const obj = await this.ctx.storage.get(a.storage_key);
    return reply
      .header('content-type', a.content_type)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=86400')
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
      .send(obj.body);
  }

  // ---------------------------------------------------------------- курсы и уроки (управление)

  @Get('courses')
  async list(@CurrentUser() p: Principal) {
    const manage = hasPerm(p, 'tests.manage');
    const list = await rows(
      this.ctx.pool,
      `SELECT c.*, (SELECT count(*)::int FROM course_lesson l WHERE l.course_id = c.id AND l.is_active) AS lessons,
              (SELECT count(*)::int FROM course_assignment a WHERE a.course_id = c.id AND a.cancelled_at IS NULL) AS assigned,
              (SELECT count(*)::int FROM course_assignment a WHERE a.course_id = c.id AND a.cancelled_at IS NULL AND a.completed_at IS NOT NULL) AS completed
         FROM course c ${manage ? '' : 'WHERE c.is_active'} ORDER BY c.sort_order, c.title`,
    );
    return list.map((r) => toApi(r));
  }

  @Get('courses/:id')
  async get(@CurrentUser() p: Principal, @Param('id') id: string) {
    parse(uuid, id);
    const c = await one(this.ctx.pool, `SELECT * FROM course WHERE id = $1`, [id]);
    if (!c || (!c.is_active && !hasPerm(p, 'tests.manage'))) throw notFound('Курс');
    const lessons = await rows<LessonRow>(
      this.ctx.pool,
      `SELECT l.*, t.title AS test_title FROM course_lesson l LEFT JOIN knowledge_test t ON t.id = l.test_id
        WHERE l.course_id = $1 ${hasPerm(p, 'tests.manage') ? '' : 'AND l.is_active'} ORDER BY l.sort_order, l.created_at`,
      [id],
    );
    return { ...toApi(c), lessons: lessons.map((l) => toApi(l)) };
  }

  @Post('courses')
  @RequirePerm('tests.manage')
  async create(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(CourseBody, body);
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      const row = await one(
        tx,
        `INSERT INTO course (id, code, title, description, topic_ids, cover_asset_id, color, icon, minutes, sort_order, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          id,
          b.code ?? null,
          b.title,
          b.description,
          b.topicIds,
          b.coverAssetId ?? null,
          b.color,
          b.icon,
          b.minutes,
          b.sortOrder,
          b.isActive,
          p.id,
        ],
      );
      await audit(tx, p, 'create', 'course', id, null, row);
      return toApi(row!);
    });
  }

  @Patch('courses/:id')
  @RequirePerm('tests.manage')
  async patch(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(CoursePatch, body);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, `SELECT * FROM course WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Курс');
      const n = {
        code: b.code === undefined ? before.code : b.code,
        title: b.title ?? before.title,
        description: b.description ?? before.description,
        topic_ids: b.topicIds ?? before.topic_ids,
        cover_asset_id: b.coverAssetId === undefined ? before.cover_asset_id : b.coverAssetId,
        color: b.color ?? before.color,
        icon: b.icon ?? before.icon,
        minutes: b.minutes ?? before.minutes,
        sort_order: b.sortOrder ?? before.sort_order,
        is_active: b.isActive ?? before.is_active,
      };
      const row = await one(
        tx,
        `UPDATE course SET code = $2, title = $3, description = $4, topic_ids = $5, cover_asset_id = $6, color = $7, icon = $8,
                minutes = $9, sort_order = $10, is_active = $11, updated_at = now() WHERE id = $1 RETURNING *`,
        [
          id,
          n.code,
          n.title,
          n.description,
          n.topic_ids,
          n.cover_asset_id,
          n.color,
          n.icon,
          n.minutes,
          n.sort_order,
          n.is_active,
        ],
      );
      await audit(tx, p, 'update', 'course', id, before, row);
      return toApi(row!);
    });
  }

  @Post('courses/:id/lessons')
  @RequirePerm('tests.manage')
  async createLesson(@CurrentUser() p: Principal, @Param('id') courseId: string, @Body() body: unknown) {
    const b = parse(LessonBody, body);
    checkBlocks(b.blocks);
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      if (!(await one(tx, `SELECT 1 FROM course WHERE id = $1`, [courseId]))) throw notFound('Курс');
      const row = await one(
        tx,
        `INSERT INTO course_lesson (id, course_id, title, summary, blocks, test_id, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          id,
          courseId,
          b.title,
          b.summary,
          JSON.stringify(b.blocks),
          b.testId ?? null,
          b.sortOrder,
          b.isActive,
        ],
      );
      await audit(tx, p, 'create', 'course_lesson', id, null, { courseId, title: b.title });
      return toApi(row!);
    });
  }

  @Patch('courses/lessons/:id')
  @RequirePerm('tests.manage')
  async patchLesson(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(LessonPatch, body);
    if (b.blocks) checkBlocks(b.blocks);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one<LessonRow>(tx, `SELECT * FROM course_lesson WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Урок');
      const row = await one(
        tx,
        `UPDATE course_lesson SET title = $2, summary = $3, blocks = $4, test_id = $5, sort_order = $6, is_active = $7, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [
          id,
          b.title ?? before.title,
          b.summary ?? before.summary,
          JSON.stringify(b.blocks ?? before.blocks),
          b.testId === undefined ? before.test_id : b.testId,
          b.sortOrder ?? before.sort_order,
          b.isActive ?? before.is_active,
        ],
      );
      await audit(tx, p, 'update', 'course_lesson', id, { title: before.title }, { title: row!.title });
      return toApi(row!);
    });
  }

  @Delete('courses/lessons/:id')
  @RequirePerm('tests.manage')
  @HttpCode(200)
  async deleteLesson(@CurrentUser() p: Principal, @Param('id') id: string) {
    return withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        `UPDATE course_lesson SET is_active = false, updated_at = now() WHERE id = $1`,
        [id],
      );
      if (!r.rowCount) throw notFound('Урок');
      await audit(tx, p, 'delete', 'course_lesson', id, null, null);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- назначения и результаты

  @Post('courses-assignments')
  @RequirePerm('tests.manage')
  async assign(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(AssignBody, body);
    if (b.dueDate < (await this.today())) throw badRequest('Срок не может быть в прошлом');
    return withTx(this.ctx.pool, async (tx) => {
      const c = await one<{ title: string; is_active: boolean; lessons: number }>(
        tx,
        `SELECT title, is_active, (SELECT count(*)::int FROM course_lesson l WHERE l.course_id = c.id AND l.is_active) AS lessons
           FROM course c WHERE id = $1`,
        [b.courseId],
      );
      if (!c) throw notFound('Курс');
      if (!c.is_active) throw badRequest('Курс выключен — включите его перед назначением');
      if (!c.lessons) throw badRequest('В курсе нет уроков');
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
          `SELECT id FROM course_assignment WHERE course_id = $1 AND user_id = $2 AND cancelled_at IS NULL AND completed_at IS NULL`,
          [b.courseId, u.id],
        );
        let aid: string;
        if (open) {
          aid = open.id;
          await tx.query('UPDATE course_assignment SET due_date = $2, comment = $3 WHERE id = $1', [
            aid,
            b.dueDate,
            b.comment,
          ]);
          updated++;
        } else {
          const passedBefore = await one(
            tx,
            `SELECT 1 FROM course_assignment WHERE course_id = $1 AND user_id = $2 AND completed_at IS NOT NULL`,
            [b.courseId, u.id],
          );
          aid = newId();
          await tx.query(
            `INSERT INTO course_assignment (id, course_id, user_id, due_date, assigned_by, comment, is_repeat) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [aid, b.courseId, u.id, b.dueDate, p.id, b.comment, !!passedBefore || b.repeat],
          );
          created++;
        }
        const subject = `Вам назначен курс «${c.title}» — пройти до ${ddmmyyyy}`;
        await tx.query(
          `INSERT INTO notification (id, user_id, kind, channel, dedupe_key, subject, body, data, status, sent_at)
           VALUES ($1, $2, 'course', 'ui', $3, $4, $5, $6, 'sent', now()) ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            newId(),
            u.id,
            `course-assigned:${aid}:${b.dueDate}`,
            subject,
            b.comment,
            JSON.stringify({ path: `/my-courses/${b.courseId}` }),
          ],
        );
        await emitNotice(tx, {
          event: 'my.test',
          subject,
          body: b.comment,
          data: { path: `/my-courses/${b.courseId}` },
          dedupe: `course-assigned:${aid}:${b.dueDate}:pref`,
          targetUserIds: [u.id],
        });
      }
      await audit(tx, p, 'create', 'course_assignment', b.courseId, null, { ...b, created, updated });
      return { created, updated };
    });
  }

  @Get('courses-assignments')
  @RequirePerm('tests.manage')
  async assignments(@Query() q: Record<string, string>) {
    const list = await rows(
      this.ctx.pool,
      `SELECT a.id, a.course_id, c.title AS course_title, a.user_id, u.full_name AS user_name, to_char(a.due_date, 'YYYY-MM-DD') AS due_date,
              a.comment, a.is_repeat, a.completed_at, a.cancelled_at, a.created_at, ab.full_name AS assigned_by_name,
              (SELECT count(*)::int FROM course_lesson l WHERE l.course_id = a.course_id AND l.is_active) AS lessons,
              (SELECT count(*)::int FROM course_progress pr JOIN course_lesson l ON l.id = pr.lesson_id
                WHERE pr.user_id = a.user_id AND pr.scope = a.id::text AND l.is_active AND pr.completed_at IS NOT NULL) AS done
         FROM course_assignment a JOIN course c ON c.id = a.course_id JOIN app_user u ON u.id = a.user_id
         LEFT JOIN app_user ab ON ab.id = a.assigned_by
        WHERE ($1::uuid IS NULL OR a.course_id = $1) AND ($2::uuid IS NULL OR a.user_id = $2)
        ORDER BY (a.cancelled_at IS NULL AND a.completed_at IS NULL) DESC, a.due_date, u.full_name`,
      [q.courseId || null, q.userId || null],
    );
    const today = await this.today();
    return list.map((r) => ({
      ...toApi(r),
      status: r.cancelled_at
        ? 'cancelled'
        : r.completed_at
          ? 'completed'
          : String(r.due_date) < today
            ? 'overdue'
            : 'open',
      progressPct: Number(r.lessons) ? Math.round((100 * Number(r.done)) / Number(r.lessons)) : 0,
    }));
  }

  @Post('courses-assignments/:id/cancel')
  @RequirePerm('tests.manage')
  @HttpCode(200)
  async cancel(@CurrentUser() p: Principal, @Param('id') id: string) {
    return withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        `UPDATE course_assignment SET cancelled_at = now() WHERE id = $1 AND cancelled_at IS NULL AND completed_at IS NULL`,
        [id],
      );
      if (!r.rowCount) throw notFound('Назначение');
      await audit(tx, p, 'cancel', 'course_assignment', id, null, null);
      return { ok: true };
    });
  }

  /** Сводка по сотрудникам: курсы назначены / пройдены / просрочены, средний результат ситуаций. */
  @Get('courses-results')
  @RequirePerm('tests.manage')
  async results() {
    const today = await this.today();
    const list = await rows(
      this.ctx.pool,
      `SELECT u.id AS user_id, u.full_name,
              count(a.id) FILTER (WHERE a.cancelled_at IS NULL)::int AS assigned,
              count(a.id) FILTER (WHERE a.cancelled_at IS NULL AND a.completed_at IS NOT NULL)::int AS completed,
              count(a.id) FILTER (WHERE a.cancelled_at IS NULL AND a.completed_at IS NULL AND a.due_date < $1::date)::int AS overdue,
              (SELECT round(100.0 * sum(pr.situations_correct) / NULLIF(sum(pr.situations_total), 0))::int
                 FROM course_progress pr WHERE pr.user_id = u.id) AS situations_pct,
              (SELECT max(pr.completed_at) FROM course_progress pr WHERE pr.user_id = u.id) AS last_activity
         FROM app_user u LEFT JOIN course_assignment a ON a.user_id = u.id
        WHERE u.is_active AND u.can_login AND EXISTS (
          SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
           WHERE ur.user_id = u.id AND r.permissions && '{conversations.work,tickets.work}'::text[])
        GROUP BY u.id ORDER BY u.full_name`,
      [today],
    );
    return list.map((r) => toApi(r));
  }

  // ---------------------------------------------------------------- сотрудник: моё обучение

  @Get('my-courses')
  async my(@CurrentUser() p: Principal) {
    const today = await this.today();
    const courses = await rows(
      this.ctx.pool,
      `SELECT c.id, c.code, c.title, c.description, c.cover_asset_id, c.color, c.icon, c.minutes, c.sort_order,
              (SELECT count(*)::int FROM course_lesson l WHERE l.course_id = c.id AND l.is_active) AS lessons,
              a.id AS assignment_id, to_char(a.due_date, 'YYYY-MM-DD') AS due_date, a.completed_at, a.is_repeat, a.comment,
              (SELECT count(*)::int FROM course_progress pr JOIN course_lesson l ON l.id = pr.lesson_id
                WHERE pr.user_id = $1 AND pr.scope = COALESCE(a.id::text, 'self') AND l.course_id = c.id AND l.is_active AND pr.completed_at IS NOT NULL) AS done,
              (SELECT max(a2.completed_at) FROM course_assignment a2 WHERE a2.course_id = c.id AND a2.user_id = $1 AND a2.cancelled_at IS NULL) AS last_completed_at
         FROM course c
         LEFT JOIN LATERAL (SELECT * FROM course_assignment x WHERE x.course_id = c.id AND x.user_id = $1 AND x.cancelled_at IS NULL
                             ORDER BY (x.completed_at IS NULL) DESC, x.created_at DESC LIMIT 1) a ON TRUE
        WHERE c.is_active ORDER BY (a.id IS NOT NULL AND a.completed_at IS NULL) DESC, a.due_date, c.sort_order, c.title`,
      [p.id],
    );
    return courses.map((r) => ({
      ...toApi(r),
      progressPct: Number(r.lessons) ? Math.round((100 * Number(r.done)) / Number(r.lessons)) : 0,
      status: !r.assignment_id
        ? 'available'
        : r.completed_at
          ? 'completed'
          : String(r.due_date) < today
            ? 'overdue'
            : 'assigned',
    }));
  }

  /** Для значка в шапке: просроченные и с близким сроком (≤ 3 дней) назначенные курсы. */
  @Get('my-courses/due')
  async myDue(@CurrentUser() p: Principal) {
    const today = await this.today();
    const r = await one<{ overdue: number; soon: number }>(
      this.ctx.pool,
      `SELECT count(*) FILTER (WHERE a.due_date < $2::date)::int AS overdue,
              count(*) FILTER (WHERE a.due_date >= $2::date AND a.due_date - $2::date <= 3)::int AS soon
         FROM course_assignment a WHERE a.user_id = $1 AND a.cancelled_at IS NULL AND a.completed_at IS NULL`,
      [p.id, today],
    );
    return toApi(r ?? { overdue: 0, soon: 0 });
  }

  /** Курс с уроками и моим прохождением (в рамках открытого назначения или самостоятельно). */
  @Get('my-courses/:id')
  async myCourse(@CurrentUser() p: Principal, @Param('id') id: string) {
    parse(uuid, id);
    const c = await one(this.ctx.pool, `SELECT * FROM course WHERE id = $1 AND is_active`, [id]);
    if (!c) throw notFound('Курс');
    const a = await one<{ id: string; due_date: string; completed_at: string | null; created_at: string }>(
      this.ctx.pool,
      `SELECT id, to_char(due_date, 'YYYY-MM-DD') AS due_date, completed_at, created_at FROM course_assignment
        WHERE course_id = $1 AND user_id = $2 AND cancelled_at IS NULL ORDER BY (completed_at IS NULL) DESC, created_at DESC LIMIT 1`,
      [id, p.id],
    );
    const scope = a && !a.completed_at ? a.id : (a?.id ?? 'self');
    const lessons = await rows<LessonRow & { test_title: string | null; pass_score: number | null }>(
      this.ctx.pool,
      `SELECT l.*, t.title AS test_title, t.pass_score FROM course_lesson l LEFT JOIN knowledge_test t ON t.id = l.test_id
        WHERE l.course_id = $1 AND l.is_active ORDER BY l.sort_order, l.created_at`,
      [id],
    );
    const progress = await rows<{
      lesson_id: string;
      read_at: string | null;
      answers: Record<string, string>;
      situations_total: number;
      situations_correct: number;
      test_passed_at: string | null;
      completed_at: string | null;
    }>(
      this.ctx.pool,
      `SELECT lesson_id, read_at, answers, situations_total, situations_correct, test_passed_at, completed_at
         FROM course_progress WHERE user_id = $1 AND scope = $2 AND lesson_id = ANY($3::uuid[])`,
      [p.id, scope, lessons.map((l) => l.id)],
    );
    const pm = new Map(progress.map((x) => [x.lesson_id, x]));
    return {
      ...toApi(c),
      assignment: a ? { id: a.id, dueDate: a.due_date, completedAt: a.completed_at } : null,
      scope,
      lessons: lessons.map((l) => {
        const pr = pm.get(l.id);
        return {
          ...toApi(l),
          progress: pr
            ? {
                readAt: pr.read_at,
                answers: pr.answers,
                situationsTotal: pr.situations_total,
                situationsCorrect: pr.situations_correct,
                testPassedAt: pr.test_passed_at,
                completedAt: pr.completed_at,
              }
            : null,
        };
      }),
    };
  }

  /**
   * Отметка прохождения урока: прочитан, ответы на ситуации (проверяются здесь), тест — по последней успешной попытке
   * после начала прохождения. Урок пройден, когда прочитан, все ситуации отвечены и тест (если есть) сдан; курс по
   * назначению — когда пройдены все уроки.
   */
  @Post('my-courses/lessons/:id/progress')
  @HttpCode(200)
  async progress(@CurrentUser() p: Principal, @Param('id') lessonId: string, @Body() body: unknown) {
    const b = parse(ProgressBody, body);
    return withTx(this.ctx.pool, async (tx) => {
      const l = await one<LessonRow>(tx, `SELECT * FROM course_lesson WHERE id = $1 AND is_active`, [
        lessonId,
      ]);
      if (!l) throw notFound('Урок');
      let scope = 'self';
      let assignment: { id: string; created_at: string } | null = null;
      if (b.assignmentId) {
        assignment =
          (await one<{ id: string; created_at: string }>(
            tx,
            `SELECT id, created_at FROM course_assignment WHERE id = $1 AND user_id = $2 AND course_id = $3 AND cancelled_at IS NULL AND completed_at IS NULL`,
            [b.assignmentId, p.id, l.course_id],
          )) ?? null;
        if (!assignment) throw notFound('Назначение');
        scope = assignment.id;
      }
      const cur = await one<{
        read_at: string | null;
        answers: Record<string, string>;
        test_passed_at: string | null;
      }>(
        tx,
        `SELECT read_at, answers, test_passed_at FROM course_progress WHERE user_id = $1 AND lesson_id = $2 AND scope = $3 FOR UPDATE`,
        [p.id, lessonId, scope],
      );
      const answers = { ...(cur?.answers ?? {}), ...(b.answers ?? {}) };
      const situations = l.blocks.filter(
        (x): x is Extract<LessonBlock, { type: 'situation' }> => x.type === 'situation',
      );
      const results = situations.map((s) => ({
        id: s.id,
        answered: answers[s.id] !== undefined,
        correct: !!s.options.find((o) => o.id === answers[s.id])?.correct,
      }));
      const total = situations.length;
      const correct = results.filter((r) => r.correct).length;
      const allAnswered = results.every((r) => r.answered);
      const readAt = cur?.read_at ?? (b.read ? new Date().toISOString() : null);
      // Тест после урока: успешная попытка после начала прохождения (у повторного назначения — после его создания).
      let testPassedAt = cur?.test_passed_at ?? null;
      if (l.test_id && !testPassedAt) {
        const since = assignment?.created_at ?? null;
        const ok = await one<{ at: string }>(
          tx,
          `SELECT finished_at AS at FROM test_attempt WHERE test_id = $1 AND user_id = $2 AND passed
            AND ($3::timestamptz IS NULL OR started_at >= $3) ORDER BY finished_at DESC LIMIT 1`,
          [l.test_id, p.id, since],
        );
        testPassedAt = ok?.at ?? null;
      }
      const completed = !!readAt && allAnswered && (!l.test_id || !!testPassedAt);
      await tx.query(
        `INSERT INTO course_progress (user_id, lesson_id, scope, read_at, answers, situations_total, situations_correct, test_passed_at, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (user_id, lesson_id, scope) DO UPDATE SET read_at = EXCLUDED.read_at, answers = EXCLUDED.answers,
           situations_total = EXCLUDED.situations_total, situations_correct = EXCLUDED.situations_correct,
           test_passed_at = EXCLUDED.test_passed_at,
           completed_at = COALESCE(course_progress.completed_at, EXCLUDED.completed_at), updated_at = now()`,
        [
          p.id,
          lessonId,
          scope,
          readAt,
          JSON.stringify(answers),
          total,
          correct,
          testPassedAt,
          completed ? new Date() : null,
        ],
      );
      let courseCompleted = false;
      if (assignment) {
        const left = await one<{ n: number }>(
          tx,
          `SELECT count(*)::int AS n FROM course_lesson l WHERE l.course_id = $1 AND l.is_active AND NOT EXISTS (
             SELECT 1 FROM course_progress pr WHERE pr.lesson_id = l.id AND pr.user_id = $2 AND pr.scope = $3 AND pr.completed_at IS NOT NULL)`,
          [l.course_id, p.id, scope],
        );
        if ((left?.n ?? 1) === 0) {
          await tx.query(
            `UPDATE course_assignment SET completed_at = COALESCE(completed_at, now()) WHERE id = $1`,
            [assignment.id],
          );
          courseCompleted = true;
        }
      }
      return {
        lessonId,
        scope,
        readAt,
        situations: results.map((r) => ({
          ...r,
          feedback:
            situations.find((s) => s.id === r.id)?.options.find((o) => o.id === answers[r.id])?.feedback ??
            null,
          explanation: situations.find((s) => s.id === r.id)?.explanation ?? null,
        })),
        situationsTotal: total,
        situationsCorrect: correct,
        testPassedAt,
        completed,
        courseCompleted,
      };
    });
  }
}

/** Тест урока курса может проходить любой сотрудник (без назначения теста) — используется в /my-tests/:id/start. */
export async function isLessonTest(tx: PoolClient, testId: string): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM course_lesson l JOIN course c ON c.id = l.course_id WHERE l.test_id = $1 AND l.is_active AND c.is_active LIMIT 1`,
    [testId],
  );
  return (r.rowCount ?? 0) > 0;
}
