import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { newId } from '@cc/contracts';
import { systemTimezone } from '@cc/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';
import { heavy } from '../lib/heavy';
import { buildWorkbook, readXlsx } from '../lib/xlsx';
import {
  analyze,
  applyPlan,
  columns,
  exportRows,
  loadDicts,
  markedSheets,
  type PlanRow,
  type Summary,
  templateSheets,
} from './conv-import';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата вида ГГГГ-ММ-ДД');

/**
 * Загрузка обращений из Excel (Д-064): шаблон, выгрузка существующих для правки, проверка файла (без записи),
 * файл с отметками, применение проверенной загрузки, журнал загрузок. Право «Загрузка обращений» (data.import).
 * Маршрут /api/v1/import обслуживает экземпляр api-reports — разбор больших файлов не мешает чатам и звонкам.
 */
@Controller('api/v1/import')
@RequirePerm('data.import')
export class ImportController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  private async dicts() {
    return loadDicts(this.ctx.pool, await systemTimezone(this.ctx.pool));
  }

  private send(reply: FastifyReply, file: Buffer, name: string) {
    reply
      .header('content-type', XLSX_TYPE)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('content-length', file.length);
    return reply.send(file);
  }

  /** Пустой шаблон с листом «Описание полей». */
  @Get('conversations/template')
  async template(@Res() reply: FastifyReply) {
    const d = await this.dicts();
    return this.send(reply, buildWorkbook(templateSheets(columns(d))), 'Шаблон загрузки обращений.xlsx');
  }

  /** Существующие обращения за период строками шаблона (с ID) — поправить и загрузить обратно. */
  @Get('conversations/export')
  async export(@CurrentUser() p: Principal, @Query() q: Record<string, string>, @Res() reply: FastifyReply) {
    const from = parse(day, q.from);
    const to = parse(day, q.to);
    if (to < from) throw badRequest('Дата «по» раньше даты «с»');
    const limit = Math.min(Math.max(Number(q.limit) || 20000, 1), 20000);
    const d = await this.dicts();
    const data = await heavy.run(() => exportRows(this.ctx.pool, d, from, to, limit));
    await withTx(this.ctx.pool, (tx) =>
      audit(
        tx,
        p,
        'export',
        'conversation',
        null,
        null,
        { rows: data.length, from, to },
        { configChanged: false },
      ),
    );
    return this.send(
      reply,
      buildWorkbook(templateSheets(columns(d), data)),
      `Обращения ${from} — ${to}.xlsx`,
    );
  }

  /** Проверить файл: сводка (новые, изменения по полям, дубли, ошибки). В базу пишется только сама проверка. */
  @Post('conversations/check')
  @HttpCode(200)
  async check(@CurrentUser() p: Principal, @Req() req: FastifyRequest, @Query('onlyNew') onlyNew?: string) {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Пустой файл');
    const fileName = decodeURIComponent(String(req.headers['x-filename'] ?? 'file.xlsx')).slice(0, 200);
    if (!/\.xlsx$/i.test(fileName))
      throw badRequest('Нужен файл Excel (.xlsx) — сохраните таблицу в этом формате');
    let sheets;
    try {
      sheets = readXlsx(body);
    } catch {
      throw badRequest('Файл не читается как Excel (.xlsx)');
    }
    // Лист с обращениями: «Обращения» из шаблона или первый непустой.
    const sheet =
      sheets.find((s) => s.name === 'Обращения') ??
      sheets.find((s) => s.rows.some((r) => r.some((v) => v.trim())));
    if (!sheet) throw badRequest('В файле нет данных');
    const d = await this.dicts();
    const r = await heavy.run(async () => {
      try {
        return await analyze(this.ctx.pool, d, sheet.rows, fileName, onlyNew === 'true');
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('too_many:'))
          throw badRequest(`В файле больше ${e.message.slice(9)} строк — разделите его на части`);
        throw e;
      }
    });
    if (r.summary.missingRequired.length && !r.summary.rows)
      throw badRequest(`Не найдены колонки: ${r.summary.missingRequired.join(', ')}`);
    const id = newId();
    await this.ctx.pool.query(
      `INSERT INTO import_batch (id, file_name, created_by, summary, plan, header) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, fileName, p.id, JSON.stringify(r.summary), JSON.stringify(r.plan), JSON.stringify(r.header)],
    );
    return { id, summary: r.summary, problems: problems(r.plan, r.header) };
  }

  /** Журнал загрузок. */
  @Get('batches')
  async batches() {
    const list = await rows(
      this.ctx.pool,
      `SELECT b.id, b.file_name, b.created_at, u.full_name AS created_by_name, b.summary, b.applied_at,
              a.full_name AS applied_by_name, b.result
         FROM import_batch b LEFT JOIN app_user u ON u.id = b.created_by LEFT JOIN app_user a ON a.id = b.applied_by
        ORDER BY b.created_at DESC LIMIT 50`,
    );
    return list.map((r) => toApi(r));
  }

  @Get('batches/:id')
  async batch(@Param('id') id: string) {
    const b = await this.load(id);
    return {
      id: b.id,
      summary: b.summary,
      appliedAt: b.applied_at,
      result: b.result,
      problems: problems(b.plan, b.header),
    };
  }

  /** Загружаемый файл с отметками: ошибки — красным, изменения — жёлтым, новые — зелёным. */
  @Get('batches/:id/file')
  async file(@Param('id') id: string, @Res() reply: FastifyReply) {
    const b = await this.load(id);
    const name = `Проверка — ${b.file_name.replace(/\.xlsx$/i, '')}.xlsx`;
    return this.send(reply, buildWorkbook(markedSheets(b.header, b.plan)), name);
  }

  /** Применить проверенную загрузку: создаются и меняются строки без ошибок; дубли пропускаются. */
  @Post('batches/:id/apply')
  @HttpCode(200)
  async apply(@CurrentUser() p: Principal, @Param('id') id: string) {
    // Отметка «применяется» — сразу: повторное нажатие не загрузит то же второй раз.
    const lock = await this.ctx.pool.query(
      `UPDATE import_batch SET applied_at = now(), applied_by = $2 WHERE id = $1 AND applied_at IS NULL
         AND created_at > now() - interval '1 day' RETURNING id`,
      [parse(z.string().uuid(), id), p.id],
    );
    if (!lock.rowCount) {
      const b = await one(this.ctx.pool, 'SELECT applied_at FROM import_batch WHERE id = $1', [id]);
      if (!b) throw notFound('Загрузка');
      throw new ApiError(
        409,
        'bad_status',
        b.applied_at
          ? 'Эта загрузка уже применена'
          : 'Проверка устарела (больше суток) — загрузите файл заново',
      );
    }
    const b = await this.load(id);
    const d = await this.dicts();
    let result;
    try {
      // Записываются значения, показанные при проверке (проверка действует сутки).
      result = await heavy.run(() => applyPlan(d, b.plan, p.id, id, (fn) => withTx(this.ctx.pool, fn)));
    } catch (e) {
      await this.ctx.pool.query(
        'UPDATE import_batch SET applied_at = NULL, applied_by = NULL WHERE id = $1',
        [id],
      );
      throw e;
    }
    const full = { ...result, skipped: b.summary.error + b.summary.duplicate + b.summary.same };
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('UPDATE import_batch SET result = $2 WHERE id = $1', [id, JSON.stringify(full)]);
      await audit(
        tx,
        p,
        'import',
        'conversation',
        id,
        null,
        { file: b.file_name, ...full },
        { configChanged: false },
      );
    });
    return full;
  }

  private async load(id: string) {
    const b = await one<{
      id: string;
      file_name: string;
      summary: Summary;
      plan: PlanRow[];
      header: string[];
      applied_at: Date | null;
      result: unknown;
    }>(this.ctx.pool, 'SELECT * FROM import_batch WHERE id = $1', [parse(z.string().uuid(), id)]);
    if (!b) throw notFound('Загрузка');
    return b;
  }
}

/** Строки с ошибками и дублями для показа на экране (первые 500). */
function problems(plan: PlanRow[], header: string[]) {
  return plan
    .filter((p) => p.action === 'error' || p.action === 'duplicate' || p.action === 'same')
    .slice(0, 500)
    .map((p) => ({
      row: p.row,
      action: p.action,
      id: p.id ?? null,
      dupOfRow: p.dupOfRow ?? null,
      errors: p.errors.map((e) => ({ column: header[e.col] ?? '', message: e.msg })),
    }));
}
