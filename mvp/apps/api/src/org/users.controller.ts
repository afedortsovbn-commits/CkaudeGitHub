import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { newId } from '@cc/contracts';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../auth/passwords';
import type { Principal } from '@cc/auth';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { handleUserDeactivated } from '@cc/domain';
import { badRequest, notFound, parse } from '../lib/errors';
import { assertAdminRemains } from './roles.controller';

const uuid = z.string().uuid();
const password = z.string().min(PASSWORD_MIN_LENGTH, `Пароль — не короче ${PASSWORD_MIN_LENGTH} символов`);

const UserCreate = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(200),
    phone: z.string().trim().max(64).nullable().optional(),
    password: password.optional(),
    canLogin: z.boolean().default(true),
    primaryEnterpriseId: uuid.nullable().optional(),
    primaryDepartmentId: uuid.nullable().optional(),
    /** Видит неклассифицированные обращения (В-52): null — как в ролях. */
    seesUnclassified: z.boolean().nullable().optional(),
    roles: z.array(z.string()).default([]),
  })
  .strict();
const UserPatch = UserCreate.omit({ password: true, roles: true }).partial().strict();
const ScopeRules = z.array(
  z
    .object({
      enterpriseIds: z.array(uuid).min(1).nullable(),
      departmentIds: z.array(uuid).min(1).nullable(),
      topicIds: z.array(uuid).min(1).nullable(),
    })
    .strict(),
);

const USER_COLS = `u.id, u.full_name, u.email, u.phone, u.can_login, u.is_active, u.primary_enterprise_id,
  u.primary_department_id, u.locked_until, u.created_at, u.updated_at, u.sees_unclassified,
  u.totp_enabled_at IS NOT NULL AS totp_enabled, u.anonymized_at,
  COALESCE((SELECT array_agg(role_code ORDER BY role_code) FROM user_role WHERE user_id = u.id), '{}') AS roles`;

@Controller('api/v1/users')
@RequirePerm('admin.users')
export class UsersController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('roles')
  async roles() {
    return (await rows(this.ctx.pool, 'SELECT * FROM role ORDER BY is_system DESC, name')).map((r) =>
      toApi(r),
    );
  }

  /**
   * Право роли «видит неклассифицированные обращения» (`scope.unclassified`, В-52). Остальные права системных
   * ролей не меняются; у сотрудника отметка может переопределить роль.
   */
  @Patch('roles/:code')
  async updateRole(@CurrentUser() p: Principal, @Param('code') code: string, @Body() body: unknown) {
    const b = parse(z.object({ seesUnclassified: z.boolean() }).strict(), body);
    await withTx(this.ctx.pool, async (tx) => {
      const before = await one<{ permissions: string[] }>(
        tx,
        'SELECT permissions FROM role WHERE code = $1 FOR UPDATE',
        [code],
      );
      if (!before) throw notFound('Роль');
      const perms = before.permissions.filter((x) => x !== 'scope.unclassified');
      if (b.seesUnclassified) perms.push('scope.unclassified');
      await tx.query('UPDATE role SET permissions = $2 WHERE code = $1', [code, perms]);
      await audit(tx, p, 'update', 'role', code, before.permissions, perms);
    });
    this.ctx.principals.invalidate();
    return this.roles();
  }

  @Get()
  async list(@Query() q: Record<string, string>) {
    const params: unknown[] = [];
    const where = [q.active === 'all' ? 'TRUE' : q.active === 'false' ? 'NOT u.is_active' : 'u.is_active'];
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(u.full_name ILIKE $1 OR u.email ILIKE $1)`);
    }
    if (q.role) {
      params.push(q.role);
      where.push(
        `EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = u.id AND r.role_code = $${params.length})`,
      );
    }
    const list = await rows(
      this.ctx.pool,
      `SELECT ${USER_COLS} FROM app_user u WHERE ${where.join(' AND ')} ORDER BY u.full_name LIMIT 1000`,
      params,
    );
    return list.map((r) => toApi(r));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const u = await one(this.ctx.pool, `SELECT ${USER_COLS} FROM app_user u WHERE u.id = $1`, [id]);
    if (!u) throw notFound('Сотрудник');
    const [scopes, skills, queues] = await Promise.all([
      rows(
        this.ctx.pool,
        'SELECT enterprise_ids, department_ids, topic_ids FROM access_scope WHERE user_id = $1 ORDER BY created_at',
        [id],
      ),
      rows(this.ctx.pool, 'SELECT skill_id, level FROM user_skill WHERE user_id = $1', [id]),
      rows(this.ctx.pool, 'SELECT queue_id FROM user_queue WHERE user_id = $1', [id]),
    ]);
    return {
      ...toApi(u),
      scopes: scopes.map((r) => toApi(r)),
      skills: skills.map((r) => toApi(r)),
      queueIds: queues.map((r) => r.queue_id as string),
    };
  }

  @Post()
  async create(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(UserCreate, body);
    const id = newId();
    const hash = b.password ? await hashPassword(b.password) : null;
    await withTx(this.ctx.pool, async (tx) => {
      const row = await one(
        tx,
        `INSERT INTO app_user (id, full_name, email, phone, password_hash, can_login, primary_enterprise_id, primary_department_id,
                               sees_unclassified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, full_name, email`,
        [
          id,
          b.fullName,
          b.email,
          b.phone ?? null,
          hash,
          b.canLogin,
          b.primaryEnterpriseId ?? null,
          b.primaryDepartmentId ?? null,
          b.seesUnclassified ?? null,
        ],
      );
      await this.writeRoles(tx, id, b.roles);
      // По умолчанию область «всё» — ограничение задаёт администратор (В-34).
      await tx.query('INSERT INTO access_scope (id, user_id) VALUES ($1, $2)', [newId(), id]);
      await audit(tx, p, 'create', 'app_user', id, null, { ...row, roles: b.roles });
    });
    return this.get(id);
  }

  @Patch(':id')
  async update(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(UserPatch, body) as Record<string, unknown>;
    const cols = Object.keys(data).map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    await withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, `SELECT ${USER_COLS} FROM app_user u WHERE u.id = $1 FOR UPDATE OF u`, [
        id,
      ]);
      if (!before) throw notFound('Сотрудник');
      if (cols.length) {
        const after = await one(
          tx,
          `UPDATE app_user SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
          [id, ...Object.values(data)],
        );
        if (data.canLogin === false) {
          await this.revokeSessions(tx, id);
          await handleUserDeactivated(tx, id);
        }
        await audit(tx, p, 'update', 'app_user', id, before, { ...after, password_hash: undefined });
      }
    });
    this.ctx.principals.invalidate();
    return this.get(id);
  }

  @Put(':id/roles')
  async setRoles(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { roles } = parse(z.object({ roles: z.array(z.string()) }).strict(), body);
    if (id === p.id && !roles.includes('admin') && p.roles.includes('admin')) {
      throw badRequest('Нельзя снять с себя роль администратора');
    }
    await withTx(this.ctx.pool, async (tx) => {
      const before = await rows(tx, 'SELECT role_code FROM user_role WHERE user_id = $1', [id]);
      await tx.query('DELETE FROM user_role WHERE user_id = $1', [id]);
      await this.writeRoles(tx, id, roles);
      await assertAdminRemains(tx);
      await audit(
        tx,
        p,
        'set_roles',
        'app_user',
        id,
        before.map((r) => r.role_code),
        roles,
      );
    });
    this.ctx.principals.invalidate();
    return this.get(id);
  }

  /** Области видимости: правила объединяются по ИЛИ; null в измерении — «все». Пустой список — ничего не видит. */
  @Put(':id/scopes')
  async setScopes(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { rules } = parse(z.object({ rules: ScopeRules }).strict(), body);
    await withTx(this.ctx.pool, async (tx) => {
      const before = await rows(
        tx,
        'SELECT enterprise_ids, department_ids, topic_ids FROM access_scope WHERE user_id = $1',
        [id],
      );
      await tx.query('DELETE FROM access_scope WHERE user_id = $1', [id]);
      for (const r of rules) {
        await tx.query(
          'INSERT INTO access_scope (id, user_id, enterprise_ids, department_ids, topic_ids) VALUES ($1,$2,$3,$4,$5)',
          [newId(), id, r.enterpriseIds, r.departmentIds, r.topicIds],
        );
      }
      await audit(tx, p, 'set_scopes', 'app_user', id, before, rules);
    });
    this.ctx.principals.invalidate();
    return this.get(id);
  }

  /** Применить шаблон области (правила копируются; дальнейшие изменения шаблона сотрудника не меняют). */
  @Post(':id/scopes/apply-template')
  @HttpCode(200)
  async applyTemplate(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { templateId } = parse(z.object({ templateId: uuid }).strict(), body);
    const t = await one<{ rules: unknown }>(
      this.ctx.pool,
      'SELECT rules FROM scope_template WHERE id = $1 AND is_active',
      [templateId],
    );
    if (!t) throw notFound('Шаблон области');
    return this.setScopes(p, id, { rules: t.rules });
  }

  @Put(':id/skills')
  async setSkills(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { skills } = parse(
      z
        .object({ skills: z.array(z.object({ skillId: uuid, level: z.number().int().min(0).max(100) })) })
        .strict(),
      body,
    );
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('DELETE FROM user_skill WHERE user_id = $1', [id]);
      for (const s of skills) {
        await tx.query('INSERT INTO user_skill (user_id, skill_id, level) VALUES ($1,$2,$3)', [
          id,
          s.skillId,
          s.level,
        ]);
      }
      await audit(tx, p, 'set_skills', 'app_user', id, null, skills);
    });
    return this.get(id);
  }

  @Put(':id/queues')
  async setQueues(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { queueIds } = parse(z.object({ queueIds: z.array(uuid) }).strict(), body);
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('DELETE FROM user_queue WHERE user_id = $1', [id]);
      for (const q of queueIds)
        await tx.query('INSERT INTO user_queue (user_id, queue_id) VALUES ($1,$2)', [id, q]);
      await audit(tx, p, 'set_queues', 'app_user', id, null, queueIds);
    });
    return this.get(id);
  }

  @Post(':id/password')
  @HttpCode(204)
  async resetPassword(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ password }).strict(), body);
    const hash = await hashPassword(b.password);
    await withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        'UPDATE app_user SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1',
        [id, hash],
      );
      if (!r.rowCount) throw notFound('Сотрудник');
      await this.revokeSessions(tx, id);
      await audit(tx, p, 'password.reset', 'app_user', id, null, null, { configChanged: false });
    });
    this.ctx.principals.invalidate();
  }

  /** Сброс 2FA (сотрудник потерял телефон): при следующем входе администратор настроит её заново. */
  @Post(':id/totp/reset')
  @HttpCode(204)
  async resetTotp(@CurrentUser() p: Principal, @Param('id') id: string) {
    await withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        `UPDATE app_user SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL,
                totp_last_step = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      if (!r.rowCount) throw notFound('Сотрудник');
      await this.revokeSessions(tx, id);
      await audit(tx, p, 'totp.reset', 'app_user', id, null, null, { configChanged: false });
    });
    this.ctx.principals.invalidate();
  }

  @Post(':id/unlock')
  @HttpCode(204)
  async unlock(@CurrentUser() p: Principal, @Param('id') id: string) {
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('UPDATE app_user SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [
        id,
      ]);
      await audit(tx, p, 'unlock', 'app_user', id, null, null, { configChanged: false });
    });
  }

  /**
   * Увольнение/отключение: сотрудник не может войти, сессии завершаются; открытые тикеты пересчитываются
   * (M-TKT-12a): исключение из назначений и рассылки, пересчёт по матрице, кураторы, отчёт «требуют переназначения».
   */
  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate(@CurrentUser() p: Principal, @Param('id') id: string) {
    if (id === p.id) throw badRequest('Нельзя отключить собственную учётную запись');
    const tickets = await withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        'UPDATE app_user SET is_active = false, updated_at = now() WHERE id = $1 AND is_active',
        [id],
      );
      if (!r.rowCount) throw notFound('Активный сотрудник');
      await assertAdminRemains(tx);
      await this.revokeSessions(tx, id);
      const impact = await handleUserDeactivated(tx, id);
      await audit(tx, p, 'deactivate', 'app_user', id, null, { tickets: impact });
      return impact;
    });
    this.ctx.principals.invalidate();
    return { ...(await this.get(id)), ticketImpact: tickets };
  }

  @Post(':id/activate')
  @HttpCode(200)
  async activate(@CurrentUser() p: Principal, @Param('id') id: string) {
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('UPDATE app_user SET is_active = true, updated_at = now() WHERE id = $1', [id]);
      await audit(tx, p, 'activate', 'app_user', id, null, null);
    });
    return this.get(id);
  }

  private async writeRoles(tx: import('pg').PoolClient, id: string, roles: string[]) {
    if (!roles.length) return;
    const known = await rows<{ code: string }>(tx, 'SELECT code FROM role WHERE code = ANY($1)', [roles]);
    if (known.length !== new Set(roles).size) throw badRequest('Указана неизвестная роль');
    for (const r of new Set(roles))
      await tx.query('INSERT INTO user_role (user_id, role_code) VALUES ($1, $2)', [id, r]);
  }

  private async revokeSessions(tx: import('pg').PoolClient, id: string) {
    await tx.query('UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
      id,
    ]);
  }
}
