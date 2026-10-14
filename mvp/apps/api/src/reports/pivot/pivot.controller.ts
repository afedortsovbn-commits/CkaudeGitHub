import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { newId } from '@cc/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, hasPerm, RequirePerm } from '../../auth/guard';
import { APP_CONTEXT, type AppContext } from '../../context';
import { audit } from '../../lib/audit';
import { one, rows, toApi } from '../../lib/db';
import { ApiError, forbidden, notFound, parse } from '../../lib/errors';
import { HEAVY_SESSION_SQL, heavy } from '../../lib/heavy';
import { buildXlsx } from '../../lib/xlsx';
import { catalog, dimValues, loadModel, PivotQuerySchema, runPivot } from './engine';

const RunBody = z.object({ query: PivotQuerySchema, confirm: z.boolean().default(false) }).strict();
const XlsxBody = z
  .object({
    title: z.string().trim().max(120).default(''),
    header: z.array(z.string().max(500)).min(1).max(500),
    rows: z.array(z.array(z.union([z.string().max(2000), z.number(), z.null()])).max(500)).max(200_000),
  })
  .strict();
const ViewBody = z
  .object({
    name: z.string().trim().min(1, 'Укажите название').max(200),
    isShared: z.boolean().default(false),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * Д-041. Конструктор отчётов: каталог полей и показателей, значения для фильтров, построение (с оценкой
 * сложности и отменой, если пользователь ушёл со страницы или поменял отчёт), выгрузка в Excel, сохранённые
 * отчёты. Все пути — под `/api/v1/reports`, их обслуживает отдельный экземпляр `api-reports`.
 */
@Controller('api/v1/reports/pivot')
@RequirePerm('reports.view')
export class PivotController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('model')
  async model() {
    return catalog(await loadModel(this.ctx.pool));
  }

  @Get('values')
  async values(@Query('field') field: string, @Query('q') q = '') {
    return dimValues(this.ctx.pool, String(field ?? ''), String(q ?? ''));
  }

  @Post('run')
  @HttpCode(200)
  async run(
    @CurrentUser() p: Principal,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const b = parse(RunBody, body);
    return heavy.run(async () => {
      const client = await this.ctx.pool.connect();
      let done = false;
      let cancelled = false;
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      // Пользователь поменял отчёт или ушёл со страницы — запрос в базе останавливается, ресурсы не тратятся.
      const onClose = () => {
        if (done || reply.raw.writableFinished) return;
        cancelled = true;
        void this.ctx.pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
      };
      reply.raw.on('close', onClose);
      try {
        const t = await one<{ v: string | null }>(
          client,
          `SELECT value #>> '{}' AS v FROM system_setting WHERE key = 'report.pivot_timeout_s'`,
        );
        const timeout = Math.min(600, Math.max(5, Number(t?.v) || 60));
        await client.query('BEGIN READ ONLY');
        await client.query(HEAVY_SESSION_SQL);
        await client.query(`SET LOCAL statement_timeout = '${timeout}s'; SET LOCAL work_mem = '32MB'`);
        const r = await runPivot(client, p, b.query, { confirm: b.confirm });
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        if ((e as { code?: string }).code === '57014')
          throw new ApiError(
            503,
            cancelled ? 'cancelled' : 'timeout',
            'Отчёт строился слишком долго и остановлен, чтобы не мешать работе с клиентами. Сузьте период, добавьте фильтр или уберите часть показателей',
          );
        throw e;
      } finally {
        done = true;
        reply.raw.off('close', onClose);
        client.release();
      }
    });
  }

  @Post('xlsx')
  @HttpCode(200)
  async xlsx(@CurrentUser() p: Principal, @Body() body: unknown, @Res() reply: FastifyReply) {
    const b = parse(XlsxBody, body);
    const file = buildXlsx(b.title.slice(0, 31) || 'Отчёт', b.header, b.rows);
    const client = await this.ctx.pool.connect();
    try {
      await audit(
        client,
        p,
        'export',
        'report',
        null,
        null,
        { kind: 'pivot', title: b.title, rows: b.rows.length },
        {
          configChanged: false,
        },
      );
    } finally {
      client.release();
    }
    reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'content-disposition',
        `attachment; filename="report-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      );
    return reply.send(file);
  }

  // ---------------------------------------------------------------- сохранённые отчёты

  @Get('views')
  async views(@CurrentUser() p: Principal) {
    const list = await rows(
      this.ctx.pool,
      `SELECT v.id, v.name, v.is_shared, v.config, v.owner_id, u.full_name AS owner_name, v.updated_at
         FROM report_view v LEFT JOIN app_user u ON u.id = v.owner_id
        WHERE v.owner_id = $1 OR v.is_shared ORDER BY v.owner_id = $1 DESC, v.name`,
      [p.id],
    );
    return list.map((r) => ({ ...toApi(r), mine: r.owner_id === p.id }));
  }

  @Post('views')
  async createView(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(ViewBody, body);
    const id = newId();
    await this.ctx.pool.query(
      `INSERT INTO report_view (id, owner_id, name, is_shared, config) VALUES ($1, $2, $3, $4, $5)`,
      [id, p.id, b.name, b.isShared, JSON.stringify(b.config)],
    );
    return { id };
  }

  @Put('views/:id')
  async updateView(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ViewBody, body);
    await this.own(p, id);
    await this.ctx.pool.query(
      `UPDATE report_view SET name = $2, is_shared = $3, config = $4, updated_at = now() WHERE id = $1`,
      [id, b.name, b.isShared, JSON.stringify(b.config)],
    );
    return { id };
  }

  @Delete('views/:id')
  @HttpCode(204)
  async deleteView(@CurrentUser() p: Principal, @Param('id') id: string) {
    await this.own(p, id);
    await this.ctx.pool.query(`DELETE FROM report_view WHERE id = $1`, [id]);
  }

  /** Менять и удалять отчёт может автор; общий — ещё и администратор. */
  private async own(p: Principal, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound('Отчёт');
    const v = await one<{ owner_id: string; is_shared: boolean }>(
      this.ctx.pool,
      `SELECT owner_id, is_shared FROM report_view WHERE id = $1`,
      [id],
    );
    if (!v || (v.owner_id !== p.id && !v.is_shared)) throw notFound('Отчёт');
    if (v.owner_id !== p.id && !hasPerm(p, 'admin.users')) throw forbidden();
  }
}
