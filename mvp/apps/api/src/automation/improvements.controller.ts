import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { newId } from '@cc/contracts';
import { analyzeImprovements } from '@cc/domain';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, notFound, parse } from '../lib/errors';

const uuid = z.string().uuid();
const CATEGORY = z.enum(['software', 'process', 'knowledge', 'staff', 'automation']);
const STATUS = z.enum(['new', 'important', 'in_work', 'done', 'rejected']);
const Patch_ = z.object({ status: STATUS.optional(), note: z.string().trim().max(2000).optional() }).strict();
const Manual = z
  .object({
    title: z.string().trim().min(3, 'Опишите предложение').max(300),
    details: z.string().trim().max(4000).default(''),
    category: CATEGORY,
    topicId: uuid.nullable().optional(),
    rating: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const Accept = z
  .object({
    title: z.string().trim().min(1, 'Название шаблона').max(200),
    body: z.string().trim().min(1).max(4000),
    topicId: uuid.nullable().optional(),
  })
  .strict();

/**
 * Предложения по улучшению (Д-098) и кандидаты в шаблоны ответов (Д-099): список с рейтингом, ручные статусы и
 * заметки, ручные предложения, запуск анализа по кнопке; кандидат в шаблон — «Сохранить шаблоном» (общий шаблон
 * 1-й линии) или «Не нужно».
 */
@Controller('api/v1/improvements')
@RequirePerm('improvements.manage')
export class ImprovementsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get()
  async list(@Query('all') all?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT p.*, t.name AS topic_name, u.full_name AS status_by_name
         FROM improvement_proposal p LEFT JOIN topic t ON t.id = p.topic_id
         LEFT JOIN app_user u ON u.id = p.status_by
        WHERE ($1::boolean OR p.is_current OR p.rule = 'manual' OR p.status IN ('important', 'in_work'))
        ORDER BY (p.status = 'rejected'), (p.status = 'done'), (p.status = 'important') DESC, p.rating DESC, p.last_seen_at DESC
        LIMIT 500`,
      [all === 'true'],
    );
    const last = await one<{ value: string }>(
      this.ctx.pool,
      `SELECT value #>> '{}' AS value FROM system_setting WHERE key = 'improvements.last_run'`,
    );
    return { lastRun: last?.value ?? null, items: list.map((r) => toApi(r)) };
  }

  @Post('analyze')
  @HttpCode(200)
  async analyze(@CurrentUser() p: Principal) {
    const r = await analyzeImprovements(this.ctx.pool);
    if (!r) throw new ApiError(409, 'busy', 'Анализ уже выполняется — повторите через минуту');
    await withTx(this.ctx.pool, (tx) =>
      audit(tx, p, 'analyze', 'improvement_proposal', null, null, r, { configChanged: false }),
    );
    return r;
  }

  @Post()
  async create(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(Manual, body);
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      const row = await one(
        tx,
        `INSERT INTO improvement_proposal (id, rule, subject_key, title, details, category, topic_id, frequency, rating,
                                           created_by, status_by, status_at)
         VALUES ($1::uuid, 'manual', $1::text, $2, $3, $4, $5, 1, $6, $7, $7, now()) RETURNING *`,
        [id, b.title, b.details, b.category, b.topicId ?? null, b.rating, p.id],
      );
      await audit(tx, p, 'create', 'improvement_proposal', id, null, row);
      return toApi(row!);
    });
  }

  @Patch(':id')
  async patch(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    parse(uuid, id);
    const b = parse(Patch_, body);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, `SELECT status, note FROM improvement_proposal WHERE id = $1 FOR UPDATE`, [
        id,
      ]);
      if (!before) throw notFound('Предложение');
      const row = await one(
        tx,
        `UPDATE improvement_proposal SET status = COALESCE($2, status), note = COALESCE($3, note),
                status_by = $4, status_at = now() WHERE id = $1 RETURNING *`,
        [id, b.status ?? null, b.note ?? null, p.id],
      );
      await audit(tx, p, 'update', 'improvement_proposal', id, before, {
        status: row!.status,
        note: row!.note,
      });
      return toApi(row!);
    });
  }

  // ---------- кандидаты в шаблоны (Д-099)

  @Get('templates')
  async templates(@Query('status') status?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT s.*, t.name AS topic_name FROM template_suggestion s LEFT JOIN topic t ON t.id = s.topic_id
        WHERE s.status = $1 ORDER BY s.uses DESC, s.operators DESC LIMIT 200`,
      [status === 'accepted' || status === 'rejected' ? status : 'new'],
    );
    return list.map((r) => toApi(r));
  }

  @Post('templates/:id/accept')
  @HttpCode(200)
  async accept(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    parse(uuid, id);
    const b = parse(Accept, body);
    return withTx(this.ctx.pool, async (tx) => {
      const s = await one<{ status: string }>(
        tx,
        `SELECT status FROM template_suggestion WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!s) throw notFound('Кандидат в шаблон');
      if (s.status !== 'new') throw new ApiError(409, 'decided', 'По этому ответу уже принято решение');
      const tid = newId();
      await tx.query(
        `INSERT INTO reply_template (id, title, body, owner_user_id, topic_id, channel_kinds, created_by, line)
         VALUES ($1, $2, $3, NULL, $4, '{}', $5, 'first')`,
        [tid, b.title, b.body, b.topicId ?? null, p.id],
      );
      await tx.query(
        `UPDATE template_suggestion SET status = 'accepted', template_id = $2, decided_by = $3, decided_at = now()
          WHERE id = $1`,
        [id, tid, p.id],
      );
      await audit(tx, p, 'create', 'reply_template', tid, null, { title: b.title, fromSuggestion: id });
      return { ok: true, templateId: tid };
    });
  }

  @Post('templates/:id/reject')
  @HttpCode(200)
  async reject(@CurrentUser() p: Principal, @Param('id') id: string) {
    parse(uuid, id);
    const r = await this.ctx.pool.query(
      `UPDATE template_suggestion SET status = 'rejected', decided_by = $2, decided_at = now()
        WHERE id = $1 AND status = 'new'`,
      [id, p.id],
    );
    if (!r.rowCount) throw notFound('Кандидат в шаблон');
    return { ok: true };
  }
}
