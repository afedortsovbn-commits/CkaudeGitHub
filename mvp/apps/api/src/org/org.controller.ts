import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { newId } from '@cc/contracts';
import Papa from 'papaparse';
import { z } from 'zod';
import { scopeFilter } from '../access/scope';
import { CurrentUser, RequirePerm } from '../auth/guard';
import type { Principal } from '../auth/principal';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { badRequest, notFound, parse } from '../lib/errors';

const uuid = z.string().uuid();

const SetEnterprisesBody = z.object({ enterpriseIds: z.array(uuid) }).strict();
const LinkPatch = z
  .object({
    transferNumber: z.string().trim().max(64).nullable().optional(),
    transferQueueId: uuid.nullable().optional(),
    email: z.string().trim().email().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const TopicCreate = z
  .object({
    parentId: uuid.nullable().optional(),
    code: z.string().trim().max(64).nullable().optional(),
    name: z.string().trim().min(1).max(300),
    isImportant: z.boolean().default(false),
    defaultResponseDays: z.number().int().min(1).max(365).nullable().optional(),
    sortOrder: z.number().int().default(0),
  })
  .strict();
const TopicPatch = TopicCreate.omit({ parentId: true }).partial().strict();

const FieldCreate = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'латиница, цифры и _'),
    label: z.string().trim().min(1).max(200),
    type: z.enum(['text', 'number', 'date', 'select', 'phone', 'email']),
    mask: z.string().max(100).nullable().optional(),
    options: z.array(z.string().min(1)).nullable().optional(),
    requiredOnClose: z.boolean().default(false),
    requiredOnEscalate: z.boolean().default(false),
    sortOrder: z.number().int().default(0),
  })
  .strict();
const FieldPatch = FieldCreate.omit({ key: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict();

const SETTINGS: Record<string, z.ZodTypeAny> = {
  'ticket.default_response_days': z.number().int().min(1).max(365),
  'ticket.daily_notification_time': z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  'ticket.approval_mode': z.enum(['creator', 'supervisor']),
  'system.timezone': z.string().min(1),
};

const toCols = (data: Record<string, unknown>) => {
  const cols = Object.keys(data).map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  return { cols, vals: Object.values(data) };
};

@Controller('api/v1')
export class OrgController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  // ---------- «Подразделение на предприятии» ----------

  @Get('enterprise-departments')
  async links(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const params: unknown[] = [];
    const where = [q.active === 'all' ? 'TRUE' : 'ed.is_active AND e.is_active AND d.is_active'];
    if (q.enterpriseId) {
      params.push(q.enterpriseId);
      where.push(`ed.enterprise_id = $${params.length}`);
    }
    if (q.departmentId) {
      params.push(q.departmentId);
      where.push(`ed.department_id = $${params.length}`);
    }
    const sc = scopeFilter(
      p.scope,
      { enterprise: 'ed.enterprise_id', department: 'ed.department_id' },
      params.length + 1,
    );
    where.push(sc.sql);
    params.push(...sc.params);
    const list = await rows(
      this.ctx.pool,
      `SELECT ed.*, e.name AS enterprise_name, e.code AS enterprise_code, d.name AS department_name
         FROM enterprise_department ed
         JOIN enterprise e ON e.id = ed.enterprise_id
         JOIN department d ON d.id = ed.department_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.name, d.name`,
      params,
    );
    return list.map((r) => toApi(r));
  }

  /** Мультивыбор предприятий для подразделения: одно подразделение сразу в нескольких предприятиях. */
  @Put('departments/:id/enterprises')
  @RequirePerm('admin.directories')
  async setEnterprises(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { enterpriseIds } = parse(SetEnterprisesBody, body);
    return withTx(this.ctx.pool, async (tx) => {
      const dep = await one(tx, 'SELECT id FROM department WHERE id = $1', [id]);
      if (!dep) throw notFound('Подразделение');
      const before = await rows(
        tx,
        'SELECT enterprise_id, is_active FROM enterprise_department WHERE department_id = $1',
        [id],
      );
      for (const eid of enterpriseIds) {
        await tx.query(
          `INSERT INTO enterprise_department (id, enterprise_id, department_id) VALUES ($1, $2, $3)
           ON CONFLICT (enterprise_id, department_id) DO UPDATE SET is_active = true, updated_at = now()`,
          [newId(), eid, id],
        );
      }
      await tx.query(
        `UPDATE enterprise_department SET is_active = false, updated_at = now()
          WHERE department_id = $1 AND NOT (enterprise_id = ANY($2::uuid[])) AND is_active`,
        [id, enterpriseIds],
      );
      const after = await rows(
        tx,
        'SELECT enterprise_id, is_active FROM enterprise_department WHERE department_id = $1',
        [id],
      );
      await audit(tx, p, 'set_enterprises', 'department', id, before, after);
      return after.map((r) => toApi(r));
    });
  }

  @Patch('enterprise-departments/:id')
  @RequirePerm('admin.directories')
  async patchLink(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(LinkPatch, body) as Record<string, unknown>;
    const { cols, vals } = toCols(data);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, 'SELECT * FROM enterprise_department WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Связь');
      if (!cols.length) return toApi(before);
      const row = await one(
        tx,
        `UPDATE enterprise_department SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, ...vals],
      );
      await audit(tx, p, 'update', 'enterprise_department', id, before, row);
      return toApi(row!);
    });
  }

  // ---------- Темы и поля ----------

  @Get('topics')
  async topics(@Query('active') active?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT t.*, (SELECT count(*)::int FROM field_def f WHERE f.topic_id = t.id AND f.is_active) AS field_count
         FROM topic t ${active === 'all' ? '' : 'WHERE t.is_active'}
        ORDER BY t.level, t.sort_order, t.name`,
    );
    return list.map((r) => toApi(r));
  }

  @Post('topics')
  @RequirePerm('admin.directories')
  async createTopic(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(TopicCreate, body);
    return withTx(this.ctx.pool, async (tx) => {
      if (b.parentId) {
        const parent = await one<{ level: number }>(
          tx,
          'SELECT level FROM topic WHERE id = $1 AND is_active',
          [b.parentId],
        );
        if (!parent) throw notFound('Родительская тема');
        if (parent.level >= 3) throw badRequest('Допускается не более 3 уровней тем');
      }
      const id = newId();
      const row = await one(
        tx,
        `INSERT INTO topic (id, parent_id, level, path, code, name, is_important, default_response_days, sort_order)
         VALUES ($1, $2, 1, '{}', $3, $4, $5, $6, $7) RETURNING *`,
        [
          id,
          b.parentId ?? null,
          b.code ?? null,
          b.name,
          b.isImportant,
          b.defaultResponseDays ?? null,
          b.sortOrder,
        ],
      );
      await audit(tx, p, 'create', 'topic', id, null, row);
      return toApi(row!);
    });
  }

  @Patch('topics/:id')
  @RequirePerm('admin.directories')
  async patchTopic(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(TopicPatch, body) as Record<string, unknown>;
    const { cols, vals } = toCols(data);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, 'SELECT * FROM topic WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Тема');
      if (!cols.length) return toApi(before);
      const row = await one(
        tx,
        `UPDATE topic SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...vals],
      );
      await audit(tx, p, 'update', 'topic', id, before, row);
      return toApi(row!);
    });
  }

  /** Деактивация темы вместе с поддеревом; активация — только самой темы (родитель должен быть активен). */
  @Post('topics/:id/deactivate')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  deactivateTopic(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.toggleTopic(p, id, 'deactivate');
  }

  @Post('topics/:id/activate')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  activateTopic(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.toggleTopic(p, id, 'activate');
  }

  private async toggleTopic(p: Principal, id: string, action: 'activate' | 'deactivate') {
    return withTx(this.ctx.pool, async (tx) => {
      const t = await one<{ parent_id: string | null }>(tx, 'SELECT parent_id FROM topic WHERE id = $1', [
        id,
      ]);
      if (!t) throw notFound('Тема');
      if (action === 'deactivate') {
        const r = await tx.query(
          'UPDATE topic SET is_active = false, updated_at = now() WHERE $1 = ANY(path) AND is_active',
          [id],
        );
        await audit(tx, p, 'deactivate', 'topic', id, null, { affected: r.rowCount });
        return { affected: r.rowCount };
      }
      if (t.parent_id) {
        const parent = await one<{ is_active: boolean }>(tx, 'SELECT is_active FROM topic WHERE id = $1', [
          t.parent_id,
        ]);
        if (!parent?.is_active) throw badRequest('Сначала активируйте родительскую тему');
      }
      await tx.query('UPDATE topic SET is_active = true, updated_at = now() WHERE id = $1', [id]);
      await audit(tx, p, 'activate', 'topic', id, null, null);
      return { affected: 1 };
    });
  }

  @Get('topics/:id/fields')
  async fields(@Param('id') id: string, @Query('active') active?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT * FROM field_def WHERE topic_id = $1 ${active === 'all' ? '' : 'AND is_active'} ORDER BY sort_order, label`,
      [id],
    );
    return list.map((r) => toApi(r));
  }

  /** Поля карточки для темы с учётом наследования от родительских тем. */
  @Get('topics/:id/effective-fields')
  async effectiveFields(@Param('id') id: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT f.* FROM topic t JOIN field_def f ON f.topic_id = ANY(t.path) AND f.is_active
        WHERE t.id = $1 ORDER BY array_position(t.path, f.topic_id), f.sort_order`,
      [id],
    );
    return list.map((r) => toApi(r));
  }

  @Post('topics/:id/fields')
  @RequirePerm('admin.directories')
  async createField(@CurrentUser() p: Principal, @Param('id') topicId: string, @Body() body: unknown) {
    const b = parse(FieldCreate, body);
    if (b.type === 'select' && !b.options?.length) throw badRequest('Для списка нужны варианты значений');
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      const row = await one(
        tx,
        `INSERT INTO field_def (id, topic_id, key, label, type, mask, options, required_on_close, required_on_escalate, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          id,
          topicId,
          b.key,
          b.label,
          b.type,
          b.mask ?? null,
          b.options ? JSON.stringify(b.options) : null,
          b.requiredOnClose,
          b.requiredOnEscalate,
          b.sortOrder,
        ],
      );
      await audit(tx, p, 'create', 'field_def', id, null, row);
      return toApi(row!);
    });
  }

  @Patch('fields/:id')
  @RequirePerm('admin.directories')
  async patchField(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(FieldPatch, body) as Record<string, unknown>;
    if (data.options) data.options = JSON.stringify(data.options);
    const { cols, vals } = toCols(data);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, 'SELECT * FROM field_def WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Поле');
      if (!cols.length) return toApi(before);
      const row = await one(
        tx,
        `UPDATE field_def SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...vals],
      );
      await audit(tx, p, 'update', 'field_def', id, before, row);
      return toApi(row!);
    });
  }

  // ---------- Импорт объектов (до интеграции Ф13) ----------

  /** CSV (разделитель ; или ,): code, name, address, enterprise_code. Обновление по коду объекта. */
  @Post('objects/import')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  async importObjects(@CurrentUser() p: Principal, @Body() body: unknown) {
    const { csv } = parse(z.object({ csv: z.string().min(1).max(5_000_000) }), body);
    const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
      header: true,
      skipEmptyLines: true,
      delimitersToGuess: [';', ',', '\t'],
      transformHeader: (h) => h.trim().toLowerCase(),
    });
    const ents = await rows<{ id: string; code: string }>(this.ctx.pool, 'SELECT id, code FROM enterprise');
    const byCode = new Map(ents.map((e) => [e.code.toLowerCase(), e.id]));
    const errors: { line: number; message: string }[] = [];
    let created = 0;
    let updated = 0;
    await withTx(this.ctx.pool, async (tx) => {
      for (const [i, r] of parsed.data.entries()) {
        const line = i + 2;
        const enterpriseId = byCode.get((r.enterprise_code ?? '').trim().toLowerCase());
        if (!r.code?.trim() || !r.name?.trim()) {
          errors.push({ line, message: 'нужны code и name' });
          continue;
        }
        if (!enterpriseId) {
          errors.push({ line, message: `предприятие «${r.enterprise_code ?? ''}» не найдено` });
          continue;
        }
        const res = await one<{ inserted: boolean }>(
          tx,
          `INSERT INTO service_object (id, enterprise_id, code, name, address, source)
           VALUES ($1, $2, $3, $4, $5, 'import')
           ON CONFLICT (code) DO UPDATE SET enterprise_id = EXCLUDED.enterprise_id, name = EXCLUDED.name,
             address = EXCLUDED.address, is_active = true, updated_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [newId(), enterpriseId, r.code.trim(), r.name.trim(), r.address?.trim() || null],
        );
        if (res?.inserted) created++;
        else updated++;
      }
      await audit(tx, p, 'import', 'service_object', null, null, { created, updated, errors: errors.length });
    });
    return { created, updated, errors };
  }

  // ---------- Настройки ----------

  @Get('settings')
  async settings() {
    const list = await rows<{ key: string; value: unknown }>(
      this.ctx.pool,
      'SELECT key, value FROM system_setting ORDER BY key',
    );
    return Object.fromEntries(list.map((r) => [r.key, r.value]));
  }

  @Patch('settings')
  @RequirePerm('admin.settings')
  async patchSettings(@CurrentUser() p: Principal, @Body() body: unknown) {
    const data = parse(z.record(z.unknown()), body);
    for (const [k, v] of Object.entries(data)) {
      const s = SETTINGS[k];
      if (!s) throw badRequest(`Неизвестная настройка ${k}`);
      parse(s, v);
    }
    await withTx(this.ctx.pool, async (tx) => {
      for (const [k, v] of Object.entries(data)) {
        const before = await one(tx, 'SELECT value FROM system_setting WHERE key = $1', [k]);
        await tx.query(
          `INSERT INTO system_setting (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [k, JSON.stringify(v)],
        );
        await audit(tx, p, 'update', 'system_setting', k, before, { value: v });
      }
    });
    return this.settings();
  }

  // ---------- Аудит ----------

  @Get('audit')
  @RequirePerm('admin.audit')
  async auditLog(@Query() q: Record<string, string>) {
    const params: unknown[] = [];
    const where: string[] = [];
    for (const [key, col] of [
      ['entity', 'a.entity'],
      ['entityId', 'a.entity_id'],
      ['actorId', 'a.actor_id'],
    ] as const) {
      if (q[key]) {
        params.push(q[key]);
        where.push(`${col} = $${params.length}`);
      }
    }
    if (q.before) {
      params.push(q.before);
      where.push(`a.at < $${params.length}`);
    }
    const list = await rows(
      this.ctx.pool,
      `SELECT a.*, u.full_name AS actor_name FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.at DESC LIMIT ${Math.min(Number(q.limit) || 100, 500)}`,
      params,
    );
    return list.map((r) => toApi(r));
  }
}
