import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { newId } from '@cc/contracts';
import { scopeFilter } from '@cc/auth';
import { CurrentUser, hasPerm } from '../auth/guard';
import type { Principal } from '@cc/auth';
import { APP_CONTEXT, type AppContext } from '../context';
import { openTicketsAffectedBy } from '@cc/domain';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { forbidden, notFound, parse } from '../lib/errors';
import { createSchema, DICTIONARIES, type DictSpec, updateSchema } from './dictionaries';

function spec(kind: string): DictSpec {
  const s = DICTIONARIES[kind];
  if (!s) throw notFound('Справочник');
  return s;
}

function values(s: DictSpec, data: Record<string, unknown>) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const fld of s.fields) {
    if (data[fld.api] === undefined) continue;
    cols.push(fld.col);
    vals.push(fld.json ? JSON.stringify(data[fld.api]) : data[fld.api]);
  }
  return { cols, vals };
}

const show = <T extends Record<string, unknown> | null>(s: DictSpec, row: T): T =>
  s.present ? s.present(row) : row;

/**
 * Единый CRUD простых справочников: /api/v1/dict/:kind.
 * Чтение — любой вошедший сотрудник (с учётом области видимости), изменение — по праву справочника.
 */
@Controller('api/v1/dict')
export class DictController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get()
  kinds() {
    return Object.entries(DICTIONARIES).map(([kind, s]) => ({ kind, title: s.title }));
  }

  @Get(':kind')
  async list(@CurrentUser() p: Principal, @Param('kind') kind: string, @Query() q: Record<string, string>) {
    const s = spec(kind);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.active !== 'all') where.push(q.active === 'false' ? 'NOT t.is_active' : 't.is_active');
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(${s.search.map((c) => `t.${c} ILIKE $${params.length}`).join(' OR ')})`);
    }
    for (const fld of s.fields.filter((x) => x.filter)) {
      if (q[fld.api]) {
        params.push(q[fld.api]);
        where.push(`t.${fld.col} = $${params.length}`);
      }
    }
    if (s.scope) {
      const sc = scopeFilter(p.scope, s.scope, params.length + 1);
      where.push(sc.sql);
      params.push(...sc.params);
    }
    const limit = Math.min(Number(q.limit) || 500, 2000);
    const list = await rows(
      this.ctx.pool,
      `SELECT t.* FROM ${s.table} t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${s.orderBy} LIMIT ${limit}`,
      params,
    );
    return list.map((r) => toApi(show(s, r)));
  }

  @Get(':kind/:id')
  async get(@CurrentUser() p: Principal, @Param('kind') kind: string, @Param('id') id: string) {
    const s = spec(kind);
    const sc = s.scope ? scopeFilter(p.scope, s.scope, 2) : { sql: 'TRUE', params: [] };
    const row = await one(this.ctx.pool, `SELECT t.* FROM ${s.table} t WHERE t.id = $1 AND ${sc.sql}`, [
      id,
      ...sc.params,
    ]);
    if (!row) throw notFound(s.title); // вне области — такой же ответ, как «не существует»
    return toApi(show(s, row ?? null));
  }

  @Post(':kind')
  async create(@CurrentUser() p: Principal, @Param('kind') kind: string, @Body() body: unknown) {
    const s = spec(kind);
    if (!hasPerm(p, ...[s.writePerm].flat())) throw forbidden();
    let data = parse(createSchema(s), body) as Record<string, unknown>;
    if (s.prepare) data = s.prepare(data, null, this.ctx.config.SECRETS_KEY);
    const { cols, vals } = values(s, data);
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      const row = await one(
        tx,
        `INSERT INTO ${s.table} (id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [id, ...vals],
      );
      await audit(tx, p, 'create', s.table, id, null, show(s, row ?? null));
      return toApi(show(s, row!));
    });
  }

  @Patch(':kind/:id')
  async update(
    @CurrentUser() p: Principal,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const s = spec(kind);
    if (!hasPerm(p, ...[s.writePerm].flat())) throw forbidden();
    const data = parse(updateSchema(s), body) as Record<string, unknown>;
    return this.change(p, s, id, data, 'update');
  }

  @Post(':kind/:id/deactivate')
  @HttpCode(200)
  async deactivate(@CurrentUser() p: Principal, @Param('kind') kind: string, @Param('id') id: string) {
    const s = spec(kind);
    if (!hasPerm(p, ...[s.writePerm].flat())) throw forbidden();
    // Предупреждение об открытых тикетах при отключении предприятия или подразделения (M-TKT-12a).
    const openTickets =
      s.table === 'enterprise'
        ? await openTicketsAffectedBy(this.ctx.pool, { enterpriseId: id })
        : s.table === 'department'
          ? await openTicketsAffectedBy(this.ctx.pool, { departmentId: id })
          : [];
    const changed = await this.change(p, s, id, { isActive: false }, 'deactivate');
    return openTickets.length ? { ...changed, openTickets } : changed;
  }

  @Post(':kind/:id/activate')
  @HttpCode(200)
  async activate(@CurrentUser() p: Principal, @Param('kind') kind: string, @Param('id') id: string) {
    const s = spec(kind);
    if (!hasPerm(p, ...[s.writePerm].flat())) throw forbidden();
    return this.change(p, s, id, { isActive: true }, 'activate');
  }

  private async change(p: Principal, s: DictSpec, id: string, data: Record<string, unknown>, action: string) {
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, `SELECT * FROM ${s.table} WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound(s.title);
      const { isActive, ...rest } = data;
      const prepared =
        s.prepare && action === 'update' ? s.prepare(rest, before, this.ctx.config.SECRETS_KEY) : rest;
      const { cols, vals } = values(s, prepared);
      if (isActive !== undefined) {
        cols.push('is_active');
        vals.push(isActive);
      }
      if (!cols.length) return toApi(show(s, before));
      const row = await one(
        tx,
        `UPDATE ${s.table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, ...vals],
      );
      await audit(tx, p, action, s.table, id, show(s, before), show(s, row ?? null));
      return toApi(show(s, row!));
    });
  }
}
