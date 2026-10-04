import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import {
  CATALOG_CODES,
  compressPermissions,
  expandPermissions,
  PERMISSION_GROUPS,
  type Principal,
  UMBRELLA_PERMISSIONS,
} from '@cc/auth';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';

const KNOWN = new Set([...CATALOG_CODES, ...Object.keys(UMBRELLA_PERMISSIONS)]);
const perm = z.string().refine(
  (c) => KNOWN.has(c),
  (c) => ({ message: `Неизвестное право: ${c}` }),
);
const path = z
  .string()
  .regex(/^\/[a-z0-9-]*$/)
  .max(60);

/** Интерфейс роли по умолчанию (п.1 требований): меню, стартовая страница, вкладки рабочего места. */
export const RoleUiSchema = z
  .object({
    v: z.literal(1).default(1),
    home: path.nullable().optional(),
    menu: z
      .array(z.object({ to: path, visible: z.boolean() }).strict())
      .max(100)
      .optional(),
    workspace: z
      .object({
        listTabs: z.array(z.string().max(20)).max(10).optional(),
        rightTabs: z.array(z.string().max(20)).max(10).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RoleUi = z.infer<typeof RoleUiSchema>;

const RoleBody = z
  .object({
    name: z.string().trim().min(1, 'Укажите название роли').max(100),
    description: z.string().trim().max(1000).nullable().optional(),
    permissions: z.array(perm).max(100),
    ui: RoleUiSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
const RoleCreate = RoleBody.extend({
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,31}$/, 'Код роли — латиница, цифры и «_», 2–32 символа')
    .optional(),
}).strict();

interface RoleRow {
  code: string;
  name: string;
  permissions: string[];
  is_system: boolean;
  description: string | null;
  ui: unknown;
  sort_order: number;
}

/**
 * Роли и права (п.1 требований заказчика): администратор создаёт роли, отмечает права из каталога и задаёт
 * интерфейс по умолчанию. Системные роли (admin, supervisor, operator, responsible) не удаляются и не меняют код;
 * у роли «Администратор» нельзя снять управление сотрудниками и видимость всех обращений. В системе всегда
 * остаётся хотя бы один активный сотрудник с правом «Сотрудники и роли».
 */
@Controller('api/v1/roles')
@RequirePerm('admin.users')
export class RolesController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get()
  async list() {
    const list = await rows<RoleRow & { users: number }>(
      this.ctx.pool,
      `SELECT r.*, (SELECT count(*)::int FROM user_role ur JOIN app_user u ON u.id = ur.user_id
                     WHERE ur.role_code = r.code AND u.is_active) AS users
         FROM role r ORDER BY r.sort_order, r.name`,
    );
    // Права в ответе — раскрытые: общее право показывается отмеченными разделами.
    return list.map((r) => ({
      ...toApi(r as unknown as Record<string, unknown>),
      code: r.code,
      permissions: [...expandPermissions(r.permissions)].sort(),
    }));
  }

  /** Каталог прав для редактора роли: группы, названия, описания. */
  @Get('catalog')
  catalog() {
    return { groups: PERMISSION_GROUPS, umbrellas: UMBRELLA_PERMISSIONS };
  }

  @Post()
  async create(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(RoleCreate, body);
    const code = b.code ?? `role_${randomBytes(4).toString('hex')}`;
    const permissions = compressPermissions(b.permissions);
    await withTx(this.ctx.pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM role WHERE code = $1', [code]))
        throw new ApiError(409, 'role_exists', 'Роль с таким кодом уже есть');
      if (await one(tx, 'SELECT 1 FROM role WHERE lower(name) = lower($1)', [b.name]))
        throw new ApiError(409, 'role_name_exists', 'Роль с таким названием уже есть');
      await tx.query(
        `INSERT INTO role (code, name, description, permissions, ui, sort_order, is_system)
         VALUES ($1, $2, $3, $4, $5, $6, false)`,
        [
          code,
          b.name,
          b.description ?? null,
          permissions,
          b.ui ? JSON.stringify(b.ui) : null,
          b.sortOrder ?? 100,
        ],
      );
      await audit(tx, p, 'create', 'role', code, null, { name: b.name, permissions, ui: b.ui ?? null });
    });
    this.ctx.principals.invalidate();
    return this.get(code);
  }

  @Put(':code')
  async update(@CurrentUser() p: Principal, @Param('code') code: string, @Body() body: unknown) {
    const b = parse(RoleBody, body);
    const permissions = compressPermissions(b.permissions);
    await withTx(this.ctx.pool, async (tx) => {
      const before = await one<RoleRow>(tx, 'SELECT * FROM role WHERE code = $1 FOR UPDATE', [code]);
      if (!before) throw notFound('Роль');
      if (await one(tx, 'SELECT 1 FROM role WHERE lower(name) = lower($1) AND code <> $2', [b.name, code]))
        throw new ApiError(409, 'role_name_exists', 'Роль с таким названием уже есть');
      if (code === 'admin' && !['admin.users', 'scope.all'].every((x) => permissions.includes(x)))
        throw badRequest('У роли «Администратор» нельзя снять права «Сотрудники и роли» и «Все обращения»');
      await tx.query(
        `UPDATE role SET name = $2, description = $3, permissions = $4, ui = $5,
                sort_order = COALESCE($6, sort_order), updated_at = now() WHERE code = $1`,
        [
          code,
          b.name,
          b.description ?? null,
          permissions,
          b.ui ? JSON.stringify(b.ui) : null,
          b.sortOrder ?? null,
        ],
      );
      await assertAdminRemains(tx);
      await audit(
        tx,
        p,
        'update',
        'role',
        code,
        { name: before.name, permissions: before.permissions, ui: before.ui },
        { name: b.name, permissions, ui: b.ui ?? null },
      );
    });
    this.ctx.principals.invalidate();
    return this.get(code);
  }

  @Delete(':code')
  @HttpCode(200)
  async remove(@CurrentUser() p: Principal, @Param('code') code: string) {
    await withTx(this.ctx.pool, async (tx) => {
      const r = await one<RoleRow>(tx, 'SELECT * FROM role WHERE code = $1 FOR UPDATE', [code]);
      if (!r) throw notFound('Роль');
      if (r.is_system) throw badRequest('Системную роль удалить нельзя');
      const used = await one<{ n: number }>(
        tx,
        'SELECT count(*)::int AS n FROM user_role WHERE role_code = $1',
        [code],
      );
      if (used && used.n > 0)
        throw new ApiError(409, 'role_in_use', `Роль назначена сотрудникам (${used.n}) — сначала снимите её`);
      await tx.query('DELETE FROM role WHERE code = $1', [code]);
      await audit(tx, p, 'delete', 'role', code, { name: r.name, permissions: r.permissions }, null);
    });
    this.ctx.principals.invalidate();
    return { ok: true };
  }

  private async get(code: string) {
    const r = (await this.list()).find((x) => x.code === code);
    if (!r) throw notFound('Роль');
    return r;
  }
}

/** В системе должен остаться хотя бы один активный сотрудник, который может управлять сотрудниками и ролями. */
export async function assertAdminRemains(tx: PoolClient): Promise<void> {
  const r = await one<{ n: number }>(
    tx,
    `SELECT count(DISTINCT u.id)::int AS n FROM app_user u JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.code = ur.role_code
      WHERE u.is_active AND u.can_login AND 'admin.users' = ANY (r.permissions)`,
  );
  if (!r?.n)
    throw badRequest(
      'Нельзя оставить систему без администратора: нужен хотя бы один сотрудник с правом «Сотрудники и роли»',
    );
}

/**
 * Интерфейс сотрудника по ролям: берётся у первой по порядку роли, где задан соответствующий раздел (меню,
 * стартовая страница, вкладки). Ни у одной роли не задан — null (стандартный интерфейс).
 */
export function mergeRoleUi(list: { ui: unknown }[]): RoleUi | null {
  const uis = list.map((r) => RoleUiSchema.safeParse(r.ui)).flatMap((r) => (r.success ? [r.data] : []));
  if (!uis.length) return null;
  return {
    v: 1,
    home: uis.find((u) => u.home)?.home ?? null,
    menu: uis.find((u) => u.menu?.length)?.menu,
    workspace: uis.find((u) => u.workspace)?.workspace,
  };
}
