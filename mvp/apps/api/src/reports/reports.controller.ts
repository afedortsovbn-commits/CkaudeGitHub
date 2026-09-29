import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import {
  REPORT_CATALOG,
  REPORT_KINDS,
  type ReportKind,
  ReportFilterSchema,
  reportToCsv,
} from '@cc/contracts';
import type { FastifyReply } from 'fastify';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { notFound, parse } from '../lib/errors';
import { channelName } from './query';
import { buildReport } from './reports';

/**
 * Отчёты M-REP-03 (Ф10): `GET /api/v1/reports/<вид>?from&to&…&groupBy` — JSON для таблицы в интерфейсе,
 * `format=csv` — выгрузка (выгрузка пишется в журнал аудита: в реестре есть ФИО сотрудников).
 */
@Controller('api/v1/reports')
@RequirePerm('reports.view')
export class ReportsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get()
  catalog() {
    return REPORT_KINDS.map((kind) => ({ kind, ...REPORT_CATALOG[kind] }));
  }

  /** Значения фильтров: справочники и сотрудники (операторы, ответственные и кураторы). */
  @Get('options')
  async options() {
    const q = async (sql: string) => (await this.ctx.pool.query(sql)).rows;
    const [enterprises, departments, topics, objects, queues, operators, assignees] = await Promise.all([
      q(`SELECT id, name FROM enterprise WHERE is_active ORDER BY name`),
      q(`SELECT id, name FROM department WHERE is_active ORDER BY name`),
      q(`SELECT t.id, string_agg(p.name, ' / ' ORDER BY array_position(t.path, p.id)) AS name
           FROM topic t JOIN topic p ON p.id = ANY(t.path) WHERE t.is_active GROUP BY t.id ORDER BY 2`),
      q(`SELECT id, name FROM service_object WHERE is_active ORDER BY name LIMIT 5000`),
      q(`SELECT id, name FROM queue WHERE is_active ORDER BY name`),
      q(`SELECT u.id, u.full_name AS name FROM app_user u WHERE EXISTS (
           SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
            WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions)) ORDER BY u.full_name`),
      q(`SELECT u.id, u.full_name AS name FROM app_user u WHERE EXISTS (
           SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
            WHERE ur.user_id = u.id AND 'tickets.work' = ANY(r.permissions)) ORDER BY u.full_name`),
    ]);
    const channels = ['voice', 'webchat', 'app', 'telegram', 'email', 'api', 'review'].map((id) => ({
      id,
      name: channelName(id),
    }));
    return { channels, enterprises, departments, topics, objects, queues, operators, assignees };
  }

  @Get(':kind')
  async report(
    @CurrentUser() p: Principal,
    @Param('kind') kind: string,
    @Query() query: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw notFound('Отчёт');
    const filter = parse(ReportFilterSchema, query);
    const client = await this.ctx.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      // Отчёт не должен занимать соединение бесконечно (журнал растёт; партиционирование — позже).
      await client.query(`SET LOCAL statement_timeout = '60s'`);
      const r = await buildReport(kind as ReportKind, { db: client, principal: p, filter });
      await client.query('COMMIT');
      if (filter.format === 'csv') {
        await audit(client, p, 'export', 'report', null, null, { kind, ...filter }, { configChanged: false });
        reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="report-${kind}-${r.from}-${r.to}.csv"`);
        return reply.send(reportToCsv(r));
      }
      return reply.header('content-type', 'application/json; charset=utf-8').send(JSON.stringify(r));
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
