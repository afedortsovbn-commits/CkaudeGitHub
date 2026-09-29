import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { newId } from '@cc/contracts';
import { type Principal, scopeFilter } from '@cc/auth';
import { z } from 'zod';
import { CurrentUser, hasPerm, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { type Db, one, rows, toApi, withTx } from '../lib/db';
import { ApiError, forbidden, notFound, parse } from '../lib/errors';
import { type AssistContext, checkProvider, collectSuggestions, type ProviderRow, tsQueryOf } from './assist';

const uuid = z.string().uuid();
const TEXT_KINDS = ['webchat', 'app', 'telegram', 'email', 'api', 'review'] as const;

const TemplateBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10000),
    shortcut: z
      .string()
      .trim()
      .max(40)
      .regex(/^[\p{L}\p{N}_-]*$/u, 'Код быстрого вызова: буквы, цифры, _ и -')
      .nullable()
      .optional(),
    topicId: uuid.nullable().optional(),
    channelKinds: z.array(z.enum(TEXT_KINDS)).max(10).default([]),
    /** Общий шаблон (для всех операторов) — только администратор; иначе личный. */
    shared: z.boolean().default(false),
  })
  .strict();
const TemplatePatch = TemplateBody.omit({ shared: true }).partial().strict();

const ArticleBody = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(50000),
    categoryId: uuid.nullable().optional(),
    topicIds: z.array(uuid).max(50).default([]),
    keywords: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
const ArticlePatch = ArticleBody.partial().strict();

const TEMPLATE_COLS = `t.id, t.title, t.body, t.shortcut, t.owner_user_id, t.topic_id, t.channel_kinds, t.usage_count,
  t.is_active, t.created_at, t.updated_at, (t.owner_user_id IS NULL) AS shared, tp.name AS topic_name`;
const ARTICLE_COLS = `a.id, a.title, a.body, a.category_id, a.topic_ids, a.keywords, a.is_active, a.created_at,
  a.updated_at, c.name AS category_name`;
const SCOPE_COLS = {
  enterprise: 'c.enterprise_id',
  department: 'c.department_id',
  topicPath: 'c.topic_path',
};

/**
 * Шаблоны ответов (M-AUTO-01), база знаний (M-AUTO-05) и подсказки оператору (M-OP-10, M-AI-01).
 * Любое изменение — запись аудита и config.changed; подсказки и списки читаются из БД при каждом запросе,
 * поэтому новый шаблон или статья доступны оператору сразу.
 */
@Controller('api/v1')
export class AutomationController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  // ------------------------------------------------------------------ шаблоны ответов

  /** Общие шаблоны и личные шаблоны сотрудника; q — поиск (по коду, названию, тексту), для «/» и панели. */
  @Get('templates')
  @RequirePerm('conversations.work', 'admin.directories')
  async templates(@CurrentUser() p: Principal, @Query() q: Record<string, string | undefined>) {
    const params: unknown[] = [p.id];
    const where = ['(t.owner_user_id IS NULL OR t.owner_user_id = $1)'];
    if (q.active !== 'all') where.push('t.is_active');
    if (q.scope === 'shared') where.push('t.owner_user_id IS NULL');
    if (q.scope === 'mine') where.push('t.owner_user_id = $1');
    if (q.channel) {
      params.push(q.channel);
      where.push(`(cardinality(t.channel_kinds) = 0 OR $${params.length} = ANY (t.channel_kinds))`);
    }
    if (q.topicId) {
      params.push(q.topicId);
      where.push(`t.topic_id = $${params.length}`);
    }
    let order = 't.owner_user_id NULLS FIRST, t.title';
    if (q.q?.trim()) {
      params.push(`%${q.q.trim()}%`, tsQueryOf(q.q));
      const like = `$${params.length - 1}`;
      const ts = `$${params.length}`;
      where.push(
        `(t.shortcut ILIKE ${like} OR t.title ILIKE ${like} OR (${ts} <> '' AND t.search @@ to_tsquery('russian', ${ts})))`,
      );
      order = `(t.shortcut ILIKE ${like}) DESC, CASE WHEN ${ts} = '' THEN 0 ELSE ts_rank(t.search, to_tsquery('russian', ${ts})) END DESC, t.usage_count DESC`;
    }
    const list = await rows(
      this.ctx.pool,
      `SELECT ${TEMPLATE_COLS} FROM reply_template t LEFT JOIN topic tp ON tp.id = t.topic_id
        WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`,
      params,
    );
    return list.map((r) => toApi(r));
  }

  @Post('templates')
  @RequirePerm('conversations.work', 'admin.directories')
  async createTemplate(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(TemplateBody, body);
    if (b.shared && !hasPerm(p, 'admin.directories')) throw forbidden();
    if (!b.shared && !hasPerm(p, 'conversations.work')) throw forbidden();
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      await tx.query(
        `INSERT INTO reply_template (id, title, body, shortcut, owner_user_id, topic_id, channel_kinds, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          b.title,
          b.body,
          b.shortcut || null,
          b.shared ? null : p.id,
          b.topicId ?? null,
          b.channelKinds,
          p.id,
        ],
      );
      const row = await this.template(tx, id);
      await audit(tx, p, 'create', 'reply_template', id, null, row);
      return row;
    });
  }

  private async template(db: Db, id: string) {
    const r = await one(
      db,
      `SELECT ${TEMPLATE_COLS} FROM reply_template t LEFT JOIN topic tp ON tp.id = t.topic_id WHERE t.id = $1`,
      [id],
    );
    if (!r) throw notFound('Шаблон');
    return toApi(r);
  }

  /** Личный шаблон меняет только владелец; общий — администратор. Чужой личный — как несуществующий. */
  private async editable(p: Principal, db: Db, id: string) {
    const t = await one<{ owner_user_id: string | null }>(
      db,
      `SELECT owner_user_id FROM reply_template WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!t || (t.owner_user_id && t.owner_user_id !== p.id)) throw notFound('Шаблон');
    if (!t.owner_user_id && !hasPerm(p, 'admin.directories')) throw forbidden();
  }

  @Patch('templates/:id')
  @RequirePerm('conversations.work', 'admin.directories')
  async patchTemplate(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(TemplatePatch, body);
    return withTx(this.ctx.pool, async (tx) => {
      await this.editable(p, tx, id);
      const before = await this.template(tx, id);
      await tx.query(
        `UPDATE reply_template SET title = COALESCE($2, title), body = COALESCE($3, body),
           shortcut = CASE WHEN $4::boolean THEN $5 ELSE shortcut END,
           topic_id = CASE WHEN $6::boolean THEN $7::uuid ELSE topic_id END,
           channel_kinds = COALESCE($8, channel_kinds), updated_at = now()
         WHERE id = $1`,
        [
          id,
          b.title ?? null,
          b.body ?? null,
          b.shortcut !== undefined,
          b.shortcut || null,
          b.topicId !== undefined,
          b.topicId ?? null,
          b.channelKinds ?? null,
        ],
      );
      const after = await this.template(tx, id);
      await audit(tx, p, 'update', 'reply_template', id, before, after);
      return after;
    });
  }

  @Post('templates/:id/:op')
  @HttpCode(200)
  @RequirePerm('conversations.work', 'admin.directories')
  async templateOp(@CurrentUser() p: Principal, @Param('id') id: string, @Param('op') op: string) {
    if (op === 'used') {
      // Счётчик использования — для порядка подсказок; без аудита.
      await this.ctx.pool.query(
        `UPDATE reply_template SET usage_count = usage_count + 1 WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2)`,
        [id, p.id],
      );
      return { ok: true };
    }
    if (op !== 'activate' && op !== 'deactivate') throw notFound('Действие');
    return withTx(this.ctx.pool, async (tx) => {
      await this.editable(p, tx, id);
      await tx.query(`UPDATE reply_template SET is_active = $2, updated_at = now() WHERE id = $1`, [
        id,
        op === 'activate',
      ]);
      await audit(tx, p, op, 'reply_template', id, null, null);
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ база знаний

  @Get('kb/articles')
  @RequirePerm('conversations.work', 'admin.directories', 'supervisor.monitor')
  async articles(@Query() q: Record<string, string | undefined>) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.active !== 'all') where.push('a.is_active');
    if (q.categoryId) {
      params.push(q.categoryId);
      where.push(`a.category_id = $${params.length}`);
    }
    let order = 'c.sort_order NULLS LAST, c.name NULLS LAST, a.title';
    if (q.q?.trim()) {
      params.push(`%${q.q.trim()}%`, tsQueryOf(q.q));
      const like = `$${params.length - 1}`;
      const ts = `$${params.length}`;
      where.push(`(a.title ILIKE ${like} OR (${ts} <> '' AND a.search @@ to_tsquery('russian', ${ts})))`);
      order = `CASE WHEN ${ts} = '' THEN 0 ELSE ts_rank(a.search, to_tsquery('russian', ${ts})) END DESC, a.title`;
    }
    const list = await rows(
      this.ctx.pool,
      `SELECT ${ARTICLE_COLS} FROM kb_article a LEFT JOIN kb_category c ON c.id = a.category_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 300`,
      params,
    );
    return list.map((r) => toApi(r));
  }

  private async article(db: Db, id: string) {
    const r = await one(
      db,
      `SELECT ${ARTICLE_COLS} FROM kb_article a LEFT JOIN kb_category c ON c.id = a.category_id WHERE a.id = $1`,
      [id],
    );
    if (!r) throw notFound('Статья');
    return toApi(r);
  }

  @Get('kb/articles/:id')
  @RequirePerm('conversations.work', 'admin.directories', 'supervisor.monitor')
  getArticle(@Param('id') id: string) {
    return this.article(this.ctx.pool, id);
  }

  @Post('kb/articles')
  @RequirePerm('admin.directories')
  async createArticle(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(ArticleBody, body);
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      await tx.query(
        `INSERT INTO kb_article (id, title, body, category_id, topic_ids, keywords, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [id, b.title, b.body, b.categoryId ?? null, b.topicIds, b.keywords ?? null, p.id],
      );
      const row = await this.article(tx, id);
      await audit(tx, p, 'create', 'kb_article', id, null, { title: b.title });
      return row;
    });
  }

  @Patch('kb/articles/:id')
  @RequirePerm('admin.directories')
  async patchArticle(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ArticlePatch, body);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await this.article(tx, id);
      await tx.query(
        `UPDATE kb_article SET title = COALESCE($2, title), body = COALESCE($3, body),
           category_id = CASE WHEN $4::boolean THEN $5::uuid ELSE category_id END,
           topic_ids = COALESCE($6, topic_ids),
           keywords = CASE WHEN $7::boolean THEN $8 ELSE keywords END,
           updated_by = $9, updated_at = now()
         WHERE id = $1`,
        [
          id,
          b.title ?? null,
          b.body ?? null,
          b.categoryId !== undefined,
          b.categoryId ?? null,
          b.topicIds ?? null,
          b.keywords !== undefined,
          b.keywords ?? null,
          p.id,
        ],
      );
      const after = await this.article(tx, id);
      await audit(tx, p, 'update', 'kb_article', id, { title: before.title }, { title: after.title });
      return after;
    });
  }

  @Post('kb/articles/:id/:op')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  async articleOp(@CurrentUser() p: Principal, @Param('id') id: string, @Param('op') op: string) {
    if (op !== 'activate' && op !== 'deactivate') throw notFound('Действие');
    return withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(`UPDATE kb_article SET is_active = $2, updated_at = now() WHERE id = $1`, [
        id,
        op === 'activate',
      ]);
      if (!r.rowCount) throw notFound('Статья');
      await audit(tx, p, op, 'kb_article', id, null, null);
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ подсказки

  /** Контекст обращения для провайдеров; обращение вне области видимости — 404. */
  private async assistContext(p: Principal, id: string): Promise<AssistContext> {
    const sc = scopeFilter(p.scope, SCOPE_COLS, 2);
    const c = await one<{
      id: string;
      channel_kind: string;
      topic_name: string | null;
      topic_path: string[];
      contact_name: string | null;
      phone: string | null;
    }>(
      this.ctx.pool,
      `SELECT c.id, c.channel_kind, c.topic_path, t.name AS topic_name, ct.display_name AS contact_name, ct.phone
         FROM conversation c JOIN contact ct ON ct.id = c.contact_id LEFT JOIN topic t ON t.id = c.topic_id
        WHERE c.id = $1 AND (${sc.sql} OR c.assignee_id = '${p.id}')`,
      [id, ...sc.params],
    );
    if (!c) throw notFound('Обращение');
    const msgs = await rows<{ direction: 'in' | 'out'; body: string; sent_at: Date }>(
      this.ctx.pool,
      `SELECT direction, body, sent_at FROM (
         SELECT direction, body, sent_at, seq FROM message
          WHERE conversation_id = $1 AND direction IN ('in', 'out') AND body <> ''
          ORDER BY sent_at DESC, seq DESC LIMIT 12) m ORDER BY sent_at, seq`,
      [id],
    );
    return {
      conversationId: c.id,
      channel: c.channel_kind,
      topic: c.topic_name,
      topicPath: c.topic_path ?? [],
      lastMessages: msgs.map((m) => ({
        direction: m.direction,
        text: m.body.slice(0, 4000),
        at: new Date(m.sent_at).toISOString(),
      })),
      contact: { name: c.contact_name, phone: c.phone },
      function: 'suggest',
      userId: p.id,
      operatorName: p.fullName,
    };
  }

  /** Панель подсказок (M-OP-10): шаблоны, статьи БЗ и ответы подключённых провайдеров по score. */
  @Get('conversations/:id/suggestions')
  @RequirePerm('conversations.work')
  async suggestions(@CurrentUser() p: Principal, @Param('id') id: string) {
    const c = await this.assistContext(p, id);
    return collectSuggestions(
      { pool: this.ctx.pool, secretsKey: this.ctx.config.SECRETS_KEY, logger: this.ctx.logger },
      c,
      'suggest',
    );
  }

  /** Черновик ответа от LLM (кнопка «Черновик»): первый ответивший провайдер с функцией draft. */
  @Post('conversations/:id/draft')
  @HttpCode(200)
  @RequirePerm('conversations.work')
  async draft(@CurrentUser() p: Principal, @Param('id') id: string) {
    const c = await this.assistContext(p, id);
    const r = await collectSuggestions(
      { pool: this.ctx.pool, secretsKey: this.ctx.config.SECRETS_KEY, logger: this.ctx.logger },
      { ...c, function: 'draft' },
      'draft',
    );
    const draft = r.suggestions.find((s) => s.type === 'draft') ?? r.suggestions[0];
    if (!draft)
      throw new ApiError(
        503,
        'no_draft',
        r.providers.length
          ? `Черновик недоступен: ${r.providers.map((x) => `${x.name} — ${x.error ?? 'нет ответа'}`).join('; ')}`
          : 'Не подключено ни одного провайдера черновиков',
        r.providers,
      );
    return { draft, providers: r.providers };
  }

  @Post('assist/providers/:id/test')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  async testProvider(@Param('id') id: string) {
    const p = await one<ProviderRow>(
      this.ctx.pool,
      `SELECT id, name, kind, config, functions, timeout_ms, is_active FROM assist_provider WHERE id = $1`,
      [id],
    );
    if (!p) throw notFound('Провайдер');
    return checkProvider({ pool: this.ctx.pool, secretsKey: this.ctx.config.SECRETS_KEY }, p);
  }
}
