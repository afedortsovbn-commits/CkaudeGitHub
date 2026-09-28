import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { newId } from '@cc/contracts';
import { z } from 'zod';
import { scopeFilter } from '@cc/auth';
import { CurrentUser, RequirePerm } from '../auth/guard';
import type { Principal } from '@cc/auth';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { badRequest, notFound, parse } from '../lib/errors';
import { dueDate, type MatrixRow, resolveDefaults, resolveResponseDays } from './matrix';

const uuid = z.string().uuid();
const kind = z.enum(['responsible', 'curator']);

const BulkAssign = z
  .object({
    enterpriseDepartmentIds: z.array(uuid).min(1),
    topicIds: z.array(uuid).min(1),
    userIds: z.array(uuid).min(1),
    kind,
  })
  .strict();

const CopyBody = z
  .object({ fromEnterpriseId: uuid, toEnterpriseId: uuid, departmentIds: z.array(uuid).optional() })
  .strict()
  .refine((b) => b.fromEnterpriseId !== b.toEnterpriseId, 'Предприятия должны различаться');

@Controller('api/v1/responsibilities')
export class MatrixController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get()
  @RequirePerm('admin.matrix', 'matrix.view')
  async list(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const params: unknown[] = [];
    const where = [q.active === 'all' ? 'TRUE' : 'r.is_active'];
    const add = (col: string, v?: string) => {
      if (!v) return;
      params.push(v);
      where.push(`${col} = $${params.length}`);
    };
    add('ed.enterprise_id', q.enterpriseId);
    add('ed.department_id', q.departmentId);
    add('r.user_id', q.userId);
    add('r.kind', q.kind);
    if (q.topicId) {
      params.push(q.topicId);
      where.push(`$${params.length}::uuid = ANY(t.path)`);
    }
    const sc = scopeFilter(
      p.scope,
      { enterprise: 'ed.enterprise_id', department: 'ed.department_id', topicPath: 't.path' },
      params.length + 1,
    );
    where.push(sc.sql);
    params.push(...sc.params);
    const list = await rows(
      this.ctx.pool,
      `SELECT r.id, r.kind, r.is_active, r.topic_id, r.user_id, r.enterprise_department_id,
              ed.enterprise_id, ed.department_id, e.name AS enterprise_name, d.name AS department_name,
              t.name AS topic_name, t.level AS topic_level, t.path AS topic_path,
              u.full_name AS user_name, u.email AS user_email, u.is_active AS user_active
         FROM responsibility r
         JOIN enterprise_department ed ON ed.id = r.enterprise_department_id
         JOIN enterprise e ON e.id = ed.enterprise_id
         JOIN department d ON d.id = ed.department_id
         JOIN topic t ON t.id = r.topic_id
         JOIN app_user u ON u.id = r.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.name, d.name, t.path, r.kind DESC, u.full_name
        LIMIT 5000`,
      params,
    );
    return list.map((r) => toApi(r));
  }

  /** Массовое назначение: все сочетания подразделений × тем × сотрудников. */
  @Post('bulk')
  @HttpCode(200)
  @RequirePerm('admin.matrix')
  async bulk(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(BulkAssign, body);
    const eligible = await rows<{ id: string }>(
      this.ctx.pool,
      `SELECT u.id FROM app_user u
        WHERE u.id = ANY($1) AND u.is_active AND u.can_login AND u.email <> ''
          AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                       WHERE ur.user_id = u.id AND 'tickets.work' = ANY(r.permissions))`,
      [b.userIds],
    );
    if (eligible.length !== new Set(b.userIds).size) {
      throw badRequest(
        'Ответственными и кураторами могут быть только активные сотрудники с входом в систему, email и ролью 2-й линии',
      );
    }
    let affected = 0;
    await withTx(this.ctx.pool, async (tx) => {
      for (const ed of b.enterpriseDepartmentIds)
        for (const t of b.topicIds)
          for (const u of b.userIds) {
            await tx.query(
              `INSERT INTO responsibility (id, enterprise_department_id, topic_id, user_id, kind) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (enterprise_department_id, topic_id, user_id, kind) DO UPDATE SET is_active = true, updated_at = now()`,
              [newId(), ed, t, u, b.kind],
            );
            affected++;
          }
      await audit(tx, p, 'bulk_assign', 'responsibility', null, null, b);
    });
    return { affected };
  }

  @Post('deactivate')
  @HttpCode(200)
  @RequirePerm('admin.matrix')
  async deactivate(@CurrentUser() p: Principal, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: z.array(uuid).min(1) }).strict(), body);
    return withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        'UPDATE responsibility SET is_active = false, updated_at = now() WHERE id = ANY($1) AND is_active',
        [ids],
      );
      await audit(tx, p, 'deactivate', 'responsibility', null, null, { ids });
      return { affected: r.rowCount };
    });
  }

  /** Копирование назначений с предприятия на предприятие — по совпадающим подразделениям. */
  @Post('copy')
  @HttpCode(200)
  @RequirePerm('admin.matrix')
  async copy(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(CopyBody, body);
    return withTx(this.ctx.pool, async (tx) => {
      const src = await rows<{ department_id: string; topic_id: string; user_id: string; kind: string }>(
        tx,
        `SELECT ed.department_id, r.topic_id, r.user_id, r.kind FROM responsibility r
           JOIN enterprise_department ed ON ed.id = r.enterprise_department_id
          WHERE ed.enterprise_id = $1 AND r.is_active AND ed.is_active
            AND ($2::uuid[] IS NULL OR ed.department_id = ANY($2))`,
        [b.fromEnterpriseId, b.departmentIds ?? null],
      );
      const targets = await rows<{ id: string; department_id: string }>(
        tx,
        'SELECT id, department_id FROM enterprise_department WHERE enterprise_id = $1 AND is_active',
        [b.toEnterpriseId],
      );
      const byDep = new Map(targets.map((t) => [t.department_id, t.id]));
      let copied = 0;
      const missing = new Set<string>();
      for (const r of src) {
        const ed = byDep.get(r.department_id);
        if (!ed) {
          missing.add(r.department_id);
          continue;
        }
        await tx.query(
          `INSERT INTO responsibility (id, enterprise_department_id, topic_id, user_id, kind) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (enterprise_department_id, topic_id, user_id, kind) DO UPDATE SET is_active = true, updated_at = now()`,
          [newId(), ed, r.topic_id, r.user_id, r.kind],
        );
        copied++;
      }
      await audit(tx, p, 'copy', 'responsibility', null, null, {
        ...b,
        copied,
        missingDepartments: [...missing],
      });
      return { copied, missingDepartmentIds: [...missing] };
    });
  }

  /**
   * «Комбинации без ответственного»: подразделения на предприятиях без назначений вовсе, и конечные
   * подтемы используемых веток, для которых подстановка не находит активного ответственного.
   */
  @Get('gaps')
  @RequirePerm('admin.matrix', 'matrix.view')
  async gaps(@CurrentUser() p: Principal, @Query('enterpriseId') enterpriseId?: string) {
    const sc = scopeFilter(p.scope, { enterprise: 'ed.enterprise_id', department: 'ed.department_id' }, 2);
    const base = `FROM enterprise_department ed
         JOIN enterprise e ON e.id = ed.enterprise_id AND e.is_active
         JOIN department d ON d.id = ed.department_id AND d.is_active
        WHERE ed.is_active AND ($1::uuid IS NULL OR ed.enterprise_id = $1) AND ${sc.sql}`;
    const params = [enterpriseId ?? null, ...sc.params];
    const empty = await rows(
      this.ctx.pool,
      `SELECT ed.id AS enterprise_department_id, e.name AS enterprise_name, d.name AS department_name ${base}
         AND NOT EXISTS (SELECT 1 FROM responsibility r WHERE r.enterprise_department_id = ed.id AND r.is_active)
        ORDER BY e.name, d.name`,
      params,
    );
    const uncovered = await rows(
      this.ctx.pool,
      `SELECT ed.id AS enterprise_department_id, e.name AS enterprise_name, d.name AS department_name,
              t.id AS topic_id, t.name AS topic_name, t.path AS topic_path ${base.replace('WHERE', ', topic t WHERE')}
         AND t.is_active
         AND NOT EXISTS (SELECT 1 FROM topic c WHERE c.parent_id = t.id AND c.is_active)
         AND EXISTS (SELECT 1 FROM responsibility r WHERE r.enterprise_department_id = ed.id AND r.is_active
                      AND r.topic_id = ANY(t.path))
         AND NOT EXISTS (SELECT 1 FROM responsibility r JOIN app_user u ON u.id = r.user_id AND u.is_active
                          WHERE r.enterprise_department_id = ed.id AND r.is_active AND r.kind = 'responsible'
                            AND r.topic_id = ANY(t.path))
        ORDER BY e.name, d.name, t.path`,
      params,
    );
    return {
      withoutAssignments: empty.map((r) => toApi(r)),
      topicsWithoutResponsible: uncovered.map((r) => toApi(r)),
    };
  }

  /** Подстановка по умолчанию для формы передачи на 2-ю линию (используется в Ф8). */
  @Get('defaults')
  async defaults(@Query() q: Record<string, string>) {
    const { enterpriseId, departmentId, topicId } = parse(
      z.object({ enterpriseId: uuid, departmentId: uuid, topicId: uuid }),
      q,
    );
    const ed = await one<{ id: string }>(
      this.ctx.pool,
      'SELECT id FROM enterprise_department WHERE enterprise_id = $1 AND department_id = $2 AND is_active',
      [enterpriseId, departmentId],
    );
    if (!ed) throw notFound('Подразделение на предприятии');
    const topic = await one<{ path: string[] }>(
      this.ctx.pool,
      'SELECT path FROM topic WHERE id = $1 AND is_active',
      [topicId],
    );
    if (!topic) throw notFound('Тема');
    const pathTopics = await rows<{ id: string; default_response_days: number | null }>(
      this.ctx.pool,
      'SELECT id, default_response_days FROM topic WHERE id = ANY($1)',
      [topic.path],
    );
    const daysById = new Map(pathTopics.map((t) => [t.id, t.default_response_days]));
    const matrix = await rows<{ topic_id: string; user_id: string; kind: 'responsible' | 'curator' }>(
      this.ctx.pool,
      `SELECT r.topic_id, r.user_id, r.kind FROM responsibility r JOIN app_user u ON u.id = r.user_id AND u.is_active
        WHERE r.enterprise_department_id = $1 AND r.is_active AND r.topic_id = ANY($2)`,
      [ed.id, topic.path],
    );
    const d = resolveDefaults(
      topic.path,
      matrix.map<MatrixRow>((r) => ({ topicId: r.topic_id, userId: r.user_id, kind: r.kind })),
    );
    const settings = await rows<{ key: string; value: unknown }>(
      this.ctx.pool,
      `SELECT key, value FROM system_setting WHERE key IN ('ticket.default_response_days', 'system.timezone')`,
    );
    const s = Object.fromEntries(settings.map((r) => [r.key, r.value]));
    const days = resolveResponseDays(
      topic.path.map((id) => daysById.get(id) ?? null),
      Number(s['ticket.default_response_days'] ?? 15),
    );
    const people = await rows(this.ctx.pool, 'SELECT id, full_name, email FROM app_user WHERE id = ANY($1)', [
      [...d.responsibles, ...d.curators],
    ]);
    const byId = new Map(people.map((u) => [u.id as string, toApi(u)]));
    return {
      enterpriseDepartmentId: ed.id,
      responsibles: d.responsibles.map((id) => byId.get(id)),
      curators: d.curators.map((id) => byId.get(id)),
      responsibleFromTopicId: d.responsibleFromTopicId,
      curatorFromTopicId: d.curatorFromTopicId,
      responseDays: days,
      dueDate: dueDate(new Date(), days, String(s['system.timezone'] ?? 'Europe/Minsk')),
    };
  }
}
