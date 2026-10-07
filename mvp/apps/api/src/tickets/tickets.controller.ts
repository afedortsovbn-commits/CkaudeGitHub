import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { inScope, scopeFilter, type Principal } from '@cc/auth';
import { newId } from '@cc/contracts';
import {
  applyMatrixToOpenTickets,
  approveTicket,
  canApprove,
  closeTicketByResponsible,
  commentTicket,
  createTicket,
  declineExtension,
  loadApprovalContext,
  localDate,
  matrixDefaults,
  defaultDueDate,
  openTicket,
  redirectTicket,
  reassignTicket,
  requestExtension,
  returnTicket,
  setAgentStatus,
  systemTimezone,
  ticketsNeedingReassignment,
  TICKET_COLS,
  TICKET_MEASURES,
  type AttachmentRef,
  type TicketRow,
} from '@cc/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, hasPerm, RequirePerm } from '../auth/guard';
import { ensureRequiredTag } from '../chat/required-tag';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { saveUpload, sendAttachment } from '../lib/attachments';
import { buildXlsx } from '../lib/xlsx';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, forbidden, notFound, parse } from '../lib/errors';

const uuid = z.string().uuid();
/** Календарная дата ГГГГ-ММ-ДД (31.02 и подобные отклоняются здесь, а не ошибкой базы). */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата вида ГГГГ-ММ-ДД')
  .refine((v) => new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Такой даты нет');
const version = z.number().int().positive();
const ids = z.array(uuid).max(20).default([]);

const EscalateBody = z
  .object({
    enterpriseId: uuid,
    departmentId: uuid,
    topicId: uuid,
    summary: z.string().trim().min(1, 'Опишите суть обращения для ответственных').max(5000),
    responsibleIds: z.array(uuid).max(20).default([]),
    curatorIds: ids,
    dueDate: day.optional(),
    isImportant: z.boolean().optional(),
  })
  .strict();
const OpenBody = z.object({}).strict();
const CloseBody = z
  .object({
    version,
    answerMethodId: uuid,
    answerSummary: z.string().trim().min(1, 'Опишите суть ответа').max(10000),
    attachmentIds: z.array(uuid).max(20).default([]),
    staffGuilty: z.boolean({ required_error: 'Укажите, есть ли вина работника' }),
    measures: z
      .array(z.enum(TICKET_MEASURES))
      .min(1, 'Укажите принятые меры (или «не применялись»)')
      .max(5)
      .refine((m) => !m.includes('none') || m.length === 1, '«Не применялись» нельзя сочетать с мерами'),
  })
  .strict();
const ApproveBody = z.object({ version, comment: z.string().max(5000).optional() }).strict();
const ReturnBody = z
  .object({
    version,
    comment: z.string().trim().min(1, 'Укажите, что нужно доработать').max(5000),
    attachmentIds: z.array(uuid).max(20).default([]),
  })
  .strict();
const RedirectBody = z
  .object({
    version,
    comment: z.string().trim().min(1, 'Комментарий к переадресации обязателен').max(5000),
    enterpriseId: uuid.optional(),
    departmentId: uuid.optional(),
    topicId: uuid.optional(),
    responsibleIds: z.array(uuid).max(20).optional(),
    curatorIds: z.array(uuid).max(20).optional(),
  })
  .strict();
const ReassignBody = z
  .object({
    version,
    responsibleIds: z.array(uuid).max(20).optional(),
    curatorIds: z.array(uuid).max(20).optional(),
    dueDate: day.optional(),
    isImportant: z.boolean().optional(),
    comment: z.string().max(5000).optional(),
  })
  .strict();
/** Список идентификаторов из строки «a,b,c»: только корректные UUID; `me` — текущий сотрудник. */
function idList(raw: string | undefined, me?: string): string[] {
  return (raw ?? '')
    .split(',')
    .map((v) => (v === 'me' && me ? me : v))
    .filter((v) => uuid.safeParse(v).success);
}

const ExtensionBody = z
  .object({ dueDate: day, reason: z.string().trim().min(1, 'Укажите причину продления').max(5000) })
  .strict();
const DeclineBody = z.object({ comment: z.string().max(5000).default('') }).strict();
const EditBody = z
  .object({ version, summary: z.string().trim().min(1, 'Суть не может быть пустой').max(5000) })
  .strict();
const CommentBody = z
  .object({ body: z.string().max(10000).default(''), attachmentIds: z.array(uuid).max(20).default([]) })
  .strict();

const TICKET_SCOPE = {
  enterprise: 't.enterprise_id',
  department: 't.department_id',
  topicPath: 't.topic_path',
};
const CONV_SCOPE = {
  enterprise: 'c.enterprise_id',
  department: 'c.department_id',
  topicPath: 'c.topic_path',
};

/** Тикет, видимый сотруднику: назначенный, создатель, заместитель создателя или тикет в области видимости. */
type VisibleTicket = TicketRow & { my_role: 'responsible' | 'curator' | null };

/** Вторая линия: передача из карточки, кабинет ответственного/куратора, согласование (M-TKT-*). */
@Controller('api/v1')
export class TicketsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  // ---------- Передача на 2-ю линию (оператор) ----------

  @Post('conversations/:id/escalate')
  @HttpCode(200)
  @RequirePerm('conversations.work')
  async escalate(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(EscalateBody, body);
    const ticketId = await withTx(this.ctx.pool, async (tx) => {
      const sc = scopeFilter(p.scope, CONV_SCOPE, 3);
      const c = await one<{ status: string; assignee_id: string | null; queue_id: string | null }>(
        tx,
        `SELECT c.status, c.assignee_id, c.queue_id FROM conversation c
          WHERE c.id = $1 AND (${sc.sql} OR c.assignee_id = $2) FOR UPDATE`,
        [id, p.id, ...sc.params],
      );
      if (!c) throw notFound('Обращение');
      if (c.status === 'closed') throw badRequest('Обращение закрыто');
      if (c.status === 'waiting_2nd_line')
        throw new ApiError(409, 'ticket_exists', 'Обращение уже передано на 2-ю линию');
      if (c.assignee_id !== p.id && !hasPerm(p, 'supervisor.monitor')) {
        throw new ApiError(
          409,
          'not_assignee',
          'Обращение ведёт другой оператор — возьмите его или попросите передать',
        );
      }
      await ensureRequiredTag(tx, id);
      const t = await createTicket(tx, { conversationId: id, actorId: p.id, ...b });
      // Постобработка оператора после передачи — как после закрытия (M-RT-06).
      if (c.assignee_id === p.id) {
        const q = await one<{ wrap_up_s: number }>(tx, 'SELECT wrap_up_s FROM queue WHERE id = $1', [
          c.queue_id,
        ]);
        const seconds = q?.wrap_up_s ?? 15;
        const cur = await one<{ status: string }>(
          tx,
          'SELECT status FROM agent_status WHERE user_id = $1 FOR UPDATE',
          [p.id],
        );
        if (seconds > 0 && (cur?.status === 'ready' || cur?.status === 'wrap_up'))
          await setAgentStatus(tx, p.id, 'wrap_up', { wrapUpUntil: new Date(Date.now() + seconds * 1000) });
      }
      return t.id;
    });
    return this.detail(p, ticketId);
  }

  /** Подстановка для формы передачи: ответственные, кураторы, срок; список возможных назначенных. */
  @Get('tickets/assignable')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async assignable() {
    const list = await rows(
      this.ctx.pool,
      `SELECT u.id, u.full_name, u.email FROM app_user u
        WHERE u.is_active AND u.can_login AND EXISTS (
          SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
           WHERE ur.user_id = u.id AND 'tickets.work' = ANY(r.permissions))
        ORDER BY u.full_name`,
    );
    return list.map((r) => toApi(r));
  }

  @Get('tickets/defaults')
  @RequirePerm('conversations.work', 'tickets.work')
  async defaults(@Query() q: Record<string, string>) {
    const { enterpriseId, departmentId, topicId } = parse(
      z.object({ enterpriseId: uuid, departmentId: uuid, topicId: uuid }),
      q,
    );
    const ed = await one<{ id: string }>(
      this.ctx.pool,
      `SELECT ed.id FROM enterprise_department ed WHERE ed.enterprise_id = $1 AND ed.department_id = $2 AND ed.is_active`,
      [enterpriseId, departmentId],
    );
    if (!ed) throw notFound('Подразделение на предприятии');
    const topic = await one<{ path: string[] }>(
      this.ctx.pool,
      'SELECT path FROM topic WHERE id = $1 AND is_active',
      [topicId],
    );
    if (!topic) throw notFound('Тема');
    const d = await matrixDefaults(this.ctx.pool, ed.id, topic.path);
    return {
      responsibleIds: d.responsibles,
      curatorIds: d.curators,
      dueDate: await defaultDueDate(this.ctx.pool, topic.path),
    };
  }

  // ---------- Списки ----------

  /**
   * Списки тикетов: `cabinet` (по умолчанию) — где я назначен и видимые по области; `created` — «Переданные»
   * оператора; `approvals` — «На согласовании» у создателя/заместителя; `approvals_all` — все согласования
   * супервизора; `attention` — «требуют переназначения».
   */
  @Get('tickets')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async list(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const f = await this.listQuery(p, q);
    const list = await rows(this.ctx.pool, `${LIST_SQL} WHERE ${f.where} ${f.order} LIMIT 500`, f.params);
    return list.map((r) => toApi(r));
  }

  /** Условия списка обращений 2-й линии (список и выгрузка в Excel): вид, права, фильтры, поиск, порядок. */
  private async listQuery(
    p: Principal,
    q: Record<string, string>,
  ): Promise<{ where: string; params: unknown[]; order: string }> {
    const tz = await systemTimezone(this.ctx.pool);
    const today = localDate(new Date(), tz);
    const params: unknown[] = [p.id, today];
    const where: string[] = [];
    const add = (sql: string, ...vals: unknown[]) => {
      let s = sql;
      for (const v of vals) {
        params.push(v);
        s = s.replace('?', `$${params.length}`);
      }
      where.push(s);
    };
    const scope = () => {
      const sc = scopeFilter(p.scope, TICKET_SCOPE, params.length + 1);
      params.push(...sc.params);
      return sc.sql;
    };
    const view = q.view ?? 'cabinet';
    switch (view) {
      case 'cabinet': {
        if (!hasPerm(p, 'tickets.work', 'supervisor.approvals')) throw forbidden();
        where.push(
          `(EXISTS (SELECT 1 FROM ticket_assignee a WHERE a.ticket_id = t.id AND a.user_id = $1 AND a.is_active) OR ${scope()})`,
        );
        break;
      }
      case 'created':
        where.push('t.created_by = $1');
        break;
      case 'approvals': {
        const mode = await one<{ v: string }>(
          this.ctx.pool,
          `SELECT value #>> '{}' AS v FROM system_setting WHERE key = 'ticket.approval_mode'`,
        );
        const parts: string[] = [];
        if (mode?.v !== 'supervisor') {
          parts.push('t.created_by = $1');
          parts.push(`EXISTS (SELECT 1 FROM approval_substitute s WHERE s.user_id = t.created_by AND s.substitute_id = $1 AND s.is_active
              AND (s.valid_from IS NULL OR s.valid_from <= $2::date) AND (s.valid_to IS NULL OR s.valid_to >= $2::date))`);
        }
        if (hasPerm(p, 'supervisor.approvals')) parts.push(scope());
        where.push(`t.status = 'approval'`, `(${parts.join(' OR ') || 'FALSE'})`);
        break;
      }
      case 'approvals_all':
        if (!hasPerm(p, 'supervisor.approvals')) throw forbidden();
        where.push(`t.status = 'approval'`, scope());
        break;
      case 'attention':
        if (!hasPerm(p, 'supervisor.approvals', 'admin.matrix')) throw forbidden();
        where.push(
          `t.status <> 'closed'`,
          `NOT EXISTS (SELECT 1 FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id AND u.is_active AND u.can_login
                        WHERE a.ticket_id = t.id AND a.is_active AND a.kind = 'responsible')`,
          scope(),
        );
        break;
      default:
        throw badRequest('Неизвестный список');
    }
    if (q.status) {
      const st = q.status.split(',');
      add('t.status = ANY(?::text[])', st);
    } else if (view === 'cabinet' && q.closed !== 'true') {
      where.push(`t.status <> 'closed'`);
    }
    if (q.role === 'responsible' || q.role === 'curator')
      add(
        `EXISTS (SELECT 1 FROM ticket_assignee a WHERE a.ticket_id = t.id AND a.user_id = $1 AND a.is_active AND a.kind = ?)`,
        q.role,
      );
    // Фильтры списка: несколько ответственных/кураторов («me» — я), тем (с подтемами), предприятий и
    // подразделений на предприятии («e» — всё предприятие, «e/d» — подразделение).
    for (const kind of ['responsible', 'curator'] as const) {
      const list = idList(q[`${kind}Ids`], p.id);
      if (list.length)
        add(
          `EXISTS (SELECT 1 FROM ticket_assignee a WHERE a.ticket_id = t.id AND a.is_active AND a.kind = '${kind}' AND a.user_id = ANY(?::uuid[]))`,
          list,
        );
    }
    const topicIds = idList(q.topicIds);
    if (topicIds.length) add('t.topic_path && ?::uuid[]', topicIds);
    const orgs = (q.orgs ?? '').split(',').filter((v) => /^[0-9a-f-]{36}(\/[0-9a-f-]{36})?$/i.test(v));
    if (orgs.length)
      add(
        `(t.enterprise_id = ANY(?::uuid[]) OR (t.enterprise_id::text || '/' || t.department_id::text) = ANY(?::text[]))`,
        orgs.filter((v) => !v.includes('/')),
        orgs.filter((v) => v.includes('/')).map((v) => v.toLowerCase()),
      );
    // Только просроченные (на просроченные фильтр по дате поступления не действует — они видны всегда).
    const OVERDUE = `(t.status IN ('new', 'in_work', 'rework') AND t.due_date < $2::date)`;
    if (q.overdue === 'true') where.push(OVERDUE);
    if (q.important === 'true') where.push('t.is_important');
    if (q.enterpriseId) add('t.enterprise_id = ?', q.enterpriseId);
    if (q.departmentId) add('t.department_id = ?', q.departmentId);
    if (q.topicId) add('? = ANY(t.topic_path)', q.topicId);
    if (q.dueFrom) add('t.due_date >= ?::date', parse(day, q.dueFrom));
    if (q.dueTo) add('t.due_date <= ?::date', parse(day, q.dueTo));
    // Дата поступления на 2-ю линию — по местному времени системы; просроченные — всегда.
    const dates: string[] = [];
    const dparams: unknown[] = [];
    if (q.createdFrom) {
      dates.push('(t.created_at AT TIME ZONE ?)::date >= ?::date');
      dparams.push(tz, parse(day, q.createdFrom));
    }
    if (q.createdTo) {
      dates.push('(t.created_at AT TIME ZONE ?)::date <= ?::date');
      dparams.push(tz, parse(day, q.createdTo));
    }
    if (dates.length) add(`((${dates.join(' AND ')}) OR ${OVERDUE})`, ...dparams);
    // Источник (канал обращения), способ ответа, вина работника.
    const sources = (q.sources ?? '').split(',').filter((v) => /^[a-z_]{2,20}$/.test(v));
    if (sources.length) add('c.channel_kind = ANY(?::text[])', sources);
    const methods = idList(q.answerMethods);
    if (methods.length) add('t.answer_method_id = ANY(?::uuid[])', methods);
    const guilt = (q.guilt ?? '').split(',').filter((v) => ['yes', 'no', 'unknown'].includes(v));
    if (guilt.length && guilt.length < 3)
      where.push(
        `(${guilt
          .map((g) =>
            g === 'yes' ? 't.staff_guilty' : g === 'no' ? 't.staff_guilty = false' : 't.staff_guilty IS NULL',
          )
          .join(' OR ')})`,
      );
    // Поиск — по выбранным полям (по умолчанию по всем): номер, клиент, телефон, e-mail, суть,
    // топливная карта (вместе с № договора), карта лояльности.
    const text = (q.q ?? '').trim();
    if (text) {
      const all = ['number', 'name', 'phone', 'email', 'summary', 'fuel', 'loyalty'];
      const inFields = q.qIn ? q.qIn.split(',').filter((f) => all.includes(f)) : all;
      const like = `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      const digits = text.replace(/\D/g, '');
      const parts: string[] = [];
      const vals: unknown[] = [];
      const field = (k: string) => `(c.fields ->> '${k}')`;
      for (const f of inFields) {
        if (f === 'number') {
          parts.push('t.number::text = ?');
          vals.push(text.replace(/^№\s*/, ''));
        } else if (f === 'name') {
          parts.push(`(ct.display_name ILIKE ? OR ${field('client_name')} ILIKE ?)`);
          vals.push(like, like);
        } else if (f === 'phone') {
          parts.push(`(ct.phone ILIKE ? OR ${field('client_phone')} ILIKE ?)`);
          vals.push(digits.length >= 3 ? `%${digits}%` : like, like);
        } else if (f === 'email') {
          parts.push('ct.email ILIKE ?');
          vals.push(like);
        } else if (f === 'summary') {
          parts.push('t.summary ILIKE ?');
          vals.push(like);
        } else if (f === 'fuel') {
          parts.push(
            `(${field('fuel_card')} ILIKE ? OR ${field('card_number')} ILIKE ? OR ${field('contract_no')} ILIKE ?)`,
          );
          vals.push(like, like, like);
        } else if (f === 'loyalty') {
          parts.push(`${field('bonus_card')} ILIKE ?`);
          vals.push(like);
        }
      }
      if (parts.length) add(`(${parts.join(' OR ')})`, ...vals);
    }
    // Порядок: просроченные; требующие закрытия (новые, в работе, на доработке); на согласовании; остальные.
    // Внутри — по дате поступления, свежие сверху.
    const order = `ORDER BY ${OVERDUE} DESC, (t.status IN ('new', 'in_work', 'rework')) DESC, (t.status = 'approval') DESC,
                   t.created_at DESC, t.number DESC`;
    return { where: where.join(' AND '), params, order };
  }

  /**
   * Выгрузка в Excel (п. 12): все поля каждого обращения 2-й линии с учётом фильтров списка (до 10 000 строк).
   * Выгрузка персональных данных — в журнал аудита.
   */
  @Get('tickets/export')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async export(@CurrentUser() p: Principal, @Query() q: Record<string, string>, @Res() reply: FastifyReply) {
    const f = await this.listQuery(p, q);
    const ids = (
      await rows<{ id: string }>(
        this.ctx.pool,
        `SELECT t.id FROM ticket t JOIN conversation c ON c.id = t.conversation_id JOIN contact ct ON ct.id = c.contact_id
          WHERE ${f.where} ${f.order} LIMIT 10000`,
        f.params,
      )
    ).map((r) => r.id);
    const tz = await systemTimezone(this.ctx.pool);
    const data = ids.length
      ? await rows<Record<string, unknown>>(
          this.ctx.pool,
          `SELECT t.id, t.number, t.status, t.is_important, t.summary, t.returns_count, t.staff_guilty, t.measures,
                  t.answer_summary, t.closed_in_time,
                  to_char(t.created_at AT TIME ZONE $2, 'DD.MM.YYYY HH24:MI') AS created,
                  to_char(c.created_at AT TIME ZONE $2, 'DD.MM.YYYY HH24:MI') AS received,
                  to_char(t.due_date, 'DD.MM.YYYY') AS due,
                  to_char(t.answered_at AT TIME ZONE $2, 'DD.MM.YYYY HH24:MI') AS answered,
                  to_char(t.closed_at AT TIME ZONE $2, 'DD.MM.YYYY HH24:MI') AS closed,
                  (t.due_date - (now() AT TIME ZONE $2)::date) AS days_left,
                  (t.status IN ('new', 'in_work', 'rework') AND t.due_date < (now() AT TIME ZONE $2)::date) AS overdue,
                  (SELECT string_agg(x.name, ' / ' ORDER BY array_position(t.topic_path, x.id)) FROM topic x
                    WHERE x.id = ANY(t.topic_path)) AS topic,
                  e.name AS enterprise, d.name AS department,
                  (SELECT o.name FROM service_object o WHERE o.id = c.object_id) AS object,
                  c.channel_kind, c.fields, ct.display_name, ct.phone, ct.email,
                  cu.full_name AS creator, ap.full_name AS approver,
                  (SELECT m.name FROM answer_method m WHERE m.id = t.answer_method_id) AS answer_method,
                  (SELECT string_agg(u.full_name, ', ' ORDER BY u.full_name) FROM ticket_assignee a
                     JOIN app_user u ON u.id = a.user_id WHERE a.ticket_id = t.id AND a.is_active AND a.kind = 'responsible') AS responsible,
                  (SELECT string_agg(u.full_name, ', ' ORDER BY u.full_name) FROM ticket_assignee a
                     JOIN app_user u ON u.id = a.user_id WHERE a.ticket_id = t.id AND a.is_active AND a.kind = 'curator') AS curators,
                  (SELECT string_agg(split_part(u.full_name, ' ', 1) || ' (' || to_char(cm.created_at AT TIME ZONE $2, 'DD.MM.YYYY') || '): ' || cm.body,
                                     E'\n' ORDER BY cm.created_at)
                     FROM ticket_comment cm LEFT JOIN app_user u ON u.id = cm.author_id
                    WHERE cm.ticket_id = t.id AND cm.kind = 'comment') AS notes,
                  (SELECT string_agg(a->>'filename', ', ') FROM ticket_comment cm, jsonb_array_elements(cm.attachments) a
                    WHERE cm.ticket_id = t.id) AS documents
             FROM ticket t
             JOIN conversation c ON c.id = t.conversation_id
             JOIN contact ct ON ct.id = c.contact_id
             JOIN enterprise e ON e.id = t.enterprise_id
             JOIN department d ON d.id = t.department_id
             JOIN app_user cu ON cu.id = t.created_by
             LEFT JOIN app_user ap ON ap.id = t.approved_by
            WHERE t.id = ANY($1)
            ORDER BY array_position($1::uuid[], t.id)`,
          [ids, tz],
        )
      : [];
    // Поля карточек тем — отдельными колонками (подписи по ключам), кроме общих полей (у них свои колонки).
    const COMMON: [string, string][] = [
      ['feedback_channel', 'Предпочтительный способ обратной связи'],
      ['eq_number', '№ электронной очереди'],
      ['company_name', 'Предприятие клиента'],
      ['bonus_card', '№ карты лояльности'],
      ['fuel_card', '№ топливной карты'],
      ['contract_no', '№ договора'],
    ];
    const commonKeys = new Set(COMMON.map(([k]) => k));
    const extraKeys = [
      ...new Set(
        data
          .flatMap((r) => Object.keys((r.fields as Record<string, unknown> | null) ?? {}))
          .filter((k) => !commonKeys.has(k)),
      ),
    ].sort();
    const labels = new Map(
      (
        await rows<{ key: string; label: string }>(
          this.ctx.pool,
          `SELECT DISTINCT ON (key) key, label FROM field_def WHERE key = ANY($1) ORDER BY key, is_active DESC`,
          [extraKeys],
        )
      ).map((r) => [r.key, r.label]),
    );
    const STATUS: Record<string, string> = {
      new: 'Новое',
      in_work: 'В работе',
      rework: 'На доработке',
      approval: 'На согласовании',
      closed: 'Закрыто',
    };
    const CHANNEL: Record<string, string> = {
      voice: 'Звонок',
      webchat: 'Сайт',
      app: 'Приложение',
      telegram: 'Telegram',
      email: 'E-mail',
      review: 'Отзыв на картах',
      api: 'Внешняя система',
    };
    const MEASURE: Record<string, string> = {
      none: 'Не применялись',
      remark: 'Замечание',
      reprimand: 'Выговор',
      depremium: 'Депремирование',
      dismissal: 'Увольнение',
    };
    const yesNo = (v: unknown) => (v === true ? 'Да' : v === false ? 'Нет' : '');
    const str = (v: unknown) =>
      v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const header = [
      '№ обращения (2 линия)',
      'Статус',
      'Просрочено',
      'Осталось дней',
      'Срок ответа',
      'Поступило на 2-ю линию',
      'Обращение поступило',
      'Источник',
      'Особо важное',
      'Тема / подтема',
      'Предприятие',
      'Подразделение',
      'Объект',
      'Суть обращения',
      'Клиент',
      'Телефон',
      'E-mail',
      ...COMMON.map(([, l]) => l),
      'Ответственные',
      'Кураторы',
      'Передал (оператор)',
      'Способ ответа',
      'Суть ответа',
      'Ответ дан',
      'Вина работника',
      'Принятые меры',
      'Документы',
      'Возвратов на доработку',
      'Закрыто',
      'Закрыто в срок',
      'Принял ответ',
      'Заметки',
      ...extraKeys.map((k) => labels.get(k) ?? k),
    ];
    const body = data.map((r) => {
      const fields = (r.fields as Record<string, unknown> | null) ?? {};
      return [
        Number(r.number),
        STATUS[str(r.status)] ?? str(r.status),
        yesNo(r.overdue),
        ['new', 'in_work', 'rework'].includes(str(r.status)) ? Number(r.days_left) : '',
        str(r.due),
        str(r.created),
        str(r.received),
        CHANNEL[str(r.channel_kind)] ?? str(r.channel_kind),
        yesNo(r.is_important),
        str(r.topic),
        str(r.enterprise),
        str(r.department),
        str(r.object),
        str(r.summary),
        str(r.display_name),
        str(r.phone),
        str(r.email),
        ...COMMON.map(([k]) => str(fields[k])),
        str(r.responsible),
        str(r.curators),
        str(r.creator),
        str(r.answer_method),
        str(r.answer_summary),
        str(r.answered),
        yesNo(r.staff_guilty),
        ((r.measures as string[] | null) ?? []).map((m) => MEASURE[m] ?? m).join(', '),
        str(r.documents),
        Number(r.returns_count ?? 0),
        str(r.closed),
        yesNo(r.closed_in_time),
        str(r.approver),
        str(r.notes),
        ...extraKeys.map((k) => str(fields[k])),
      ];
    });
    await withTx(this.ctx.pool, (tx) =>
      audit(
        tx,
        p,
        'export',
        'ticket',
        null,
        null,
        { rows: body.length, filters: q },
        { configChanged: false },
      ),
    );
    const file = buildXlsx('Обращения 2-й линии', header, body);
    const name = `obrashcheniya-2-linii-${localDate(new Date(), tz)}.xlsx`;
    reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('content-length', file.length);
    return reply.send(file);
  }

  /** Сотрудник щёлкнул обращение — для него оно больше не «Новое». */
  @Post('tickets/:id/seen')
  @HttpCode(200)
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async seen(@CurrentUser() p: Principal, @Param('id') id: string) {
    await this.visible(p, id);
    await this.ctx.pool.query(
      `INSERT INTO ticket_view (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, p.id],
    );
    return { ok: true };
  }

  /**
   * Дерево для фильтров «Ответственный»/«Куратор»: предприятие → подразделение → сотрудник (по матрице
   * ответственности); сотрудники 2-й линии без назначений в матрице — отдельной строкой без предприятия.
   */
  @Get('tickets/assignee-tree')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async assigneeTree(@Query('kind') kindRaw?: string) {
    const kind = kindRaw === 'curator' ? 'curator' : 'responsible';
    const list = await rows(
      this.ctx.pool,
      `SELECT DISTINCT e.id AS enterprise_id, e.name AS enterprise_name, ed.id AS ed_id, d.name AS department_name,
              u.id AS user_id, u.full_name
         FROM responsibility r
         JOIN enterprise_department ed ON ed.id = r.enterprise_department_id AND ed.is_active
         JOIN enterprise e ON e.id = ed.enterprise_id AND e.is_active
         JOIN department d ON d.id = ed.department_id AND d.is_active
         JOIN app_user u ON u.id = r.user_id AND u.is_active
        WHERE r.is_active AND r.kind = $1
       UNION ALL
       SELECT NULL, NULL, NULL, NULL, u.id, u.full_name FROM app_user u
        WHERE u.is_active AND u.can_login
          AND EXISTS (SELECT 1 FROM user_role ur JOIN role ro ON ro.code = ur.role_code
                       WHERE ur.user_id = u.id AND 'tickets.work' = ANY(ro.permissions))
          AND NOT EXISTS (SELECT 1 FROM responsibility r WHERE r.user_id = u.id AND r.is_active AND r.kind = $1)
        ORDER BY 2 NULLS LAST, 4, 6`,
      [kind],
    );
    return list.map((r) => toApi(r));
  }

  /** Кем сотрудник обычно бывает на 2-й линии — для фильтра по умолчанию («я ответственный» / «я куратор»). */
  @Get('tickets/my-kind')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async myKind(@CurrentUser() p: Principal) {
    const r = await one<{ resp: number; cur: number }>(
      this.ctx.pool,
      `SELECT (SELECT count(*)::int FROM responsibility WHERE user_id = $1 AND is_active AND kind = 'responsible')
            + (SELECT count(*)::int FROM ticket_assignee WHERE user_id = $1 AND is_active AND kind = 'responsible') AS resp,
              (SELECT count(*)::int FROM responsibility WHERE user_id = $1 AND is_active AND kind = 'curator')
            + (SELECT count(*)::int FROM ticket_assignee WHERE user_id = $1 AND is_active AND kind = 'curator') AS cur`,
      [p.id],
    );
    const resp = r?.resp ?? 0;
    const cur = r?.cur ?? 0;
    return { kind: cur > resp ? 'curator' : 'responsible' };
  }

  /** «Требуют переназначения» (M-TKT-12a) — без активного ответственного. Короткий путь для админки. */
  @Get('tickets/reassignment-report')
  @RequirePerm('supervisor.approvals', 'admin.matrix')
  async reassignmentReport(@CurrentUser() p: Principal) {
    const all = await ticketsNeedingReassignment(this.ctx.pool);
    return all
      .filter((t) => this.inTicketScope(p, t))
      .map((t) => ({ id: t.id, number: Number(t.number), status: t.status, dueDate: t.due }));
  }

  @Post('tickets/apply-matrix')
  @HttpCode(200)
  @RequirePerm('admin.matrix')
  async applyMatrix(@CurrentUser() p: Principal) {
    return withTx(this.ctx.pool, async (tx) => {
      const r = await applyMatrixToOpenTickets(tx, p.id);
      await audit(tx, p, 'apply_matrix', 'ticket', null, null, {
        changed: r.changed,
        unresolved: r.unresolved.length,
      });
      return r;
    });
  }

  // ---------- Карточка тикета ----------

  @Get('tickets/:id')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async get(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.detail(p, id);
  }

  @Get('tickets/:id/messages')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async messages(@CurrentUser() p: Principal, @Param('id') id: string) {
    const t = await this.visible(p, id);
    const list = await rows(
      this.ctx.pool,
      // Подсказки супервизора оператору (Ф14) — не для 2-й линии.
      `SELECT m.*, u.full_name AS author_name FROM message m LEFT JOIN app_user u ON u.id = m.author_user_id
        WHERE m.conversation_id = $1 AND NOT (m.meta ? 'hint') ORDER BY m.sent_at, m.seq`,
      [t.conversation_id],
    );
    return list.map((r) => toApi(r));
  }

  @Post('tickets/attachments')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals')
  upload(@CurrentUser() p: Principal, @Req() req: FastifyRequest) {
    return saveUpload(this.ctx, req, { userId: p.id });
  }

  @Get('tickets/:id/files/:fileId')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async download(
    @CurrentUser() p: Principal,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res() reply: FastifyReply,
  ) {
    const t = await this.visible(p, id);
    const a = await one<{ ticket_id: string | null; conversation_id: string | null }>(
      this.ctx.pool,
      'SELECT ticket_id, conversation_id FROM attachment WHERE id = $1',
      [fileId],
    );
    const ok = !!a && (a.ticket_id === t.id || a.conversation_id === t.conversation_id);
    return sendAttachment(this.ctx, fileId, reply, async () => ok);
  }

  // ---------- Действия ----------

  /** «Открыть» тикет: «Новый»/«На доработке» → «В работе». Доступно любому назначенному (M-TKT-03). */
  @Post('tickets/:id/open')
  @HttpCode(200)
  @RequirePerm('tickets.work')
  async open(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    parse(OpenBody, body ?? {});
    await withTx(this.ctx.pool, async (tx) => {
      this.requireParticipant(await this.visible(p, id, tx));
      await openTicket(tx, id, p.id);
    });
    return this.detail(p, id);
  }

  @Post('tickets/:id/close')
  @HttpCode(200)
  @RequirePerm('tickets.work')
  async close(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(CloseBody, body);
    const attachments = await this.ownFiles(b.attachmentIds, p.id);
    await withTx(this.ctx.pool, async (tx) => {
      this.requireParticipant(await this.visible(p, id, tx));
      await closeTicketByResponsible(tx, id, p.id, {
        version: b.version,
        answerMethodId: b.answerMethodId,
        answerSummary: b.answerSummary,
        staffGuilty: b.staffGuilty,
        measures: b.measures,
        attachments,
      });
    });
    return this.detail(p, id);
  }

  @Post('tickets/:id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ApproveBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      await this.requireApprover(p, await this.visible(p, id, tx), tx);
      await approveTicket(tx, id, p.id, b);
    });
    return this.detail(p, id);
  }

  @Post('tickets/:id/return')
  @HttpCode(200)
  async returnToWork(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ReturnBody, body);
    const attachments = await this.ownFiles(b.attachmentIds, p.id);
    await withTx(this.ctx.pool, async (tx) => {
      await this.requireApprover(p, await this.visible(p, id, tx), tx);
      await returnTicket(tx, id, p.id, { version: b.version, comment: b.comment, attachments });
    });
    return this.detail(p, id);
  }

  @Post('tickets/:id/redirect')
  @HttpCode(200)
  @RequirePerm('tickets.work')
  async redirect(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(RedirectBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      this.requireParticipant(await this.visible(p, id, tx));
      await redirectTicket(tx, id, p.id, b);
    });
    return this.detail(p, id);
  }

  /** Запрос продления срока: ответственный или куратор; решают создатель и супервизоры. */
  @Post('tickets/:id/extension')
  @HttpCode(200)
  @RequirePerm('tickets.work')
  async extension(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ExtensionBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      this.requireParticipant(await this.visible(p, id, tx));
      await requestExtension(tx, id, p.id, b);
    });
    return this.detail(p, id);
  }

  /** Отказ в продлении — тот, кто может менять срок (создатель, супервизор, администратор матрицы). */
  @Post('tickets/:id/extension/decline')
  @HttpCode(200)
  async declineExtension(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(DeclineBody, body ?? {});
    await withTx(this.ctx.pool, async (tx) => {
      if (!this.canReassign(p, await this.visible(p, id, tx))) throw forbidden();
      await declineExtension(tx, id, p.id, b.comment);
    });
    return this.detail(p, id);
  }

  /** Замена ответственных, срока и отметки создателем тикета, супервизором или администратором. */
  @Post('tickets/:id/reassign')
  @HttpCode(200)
  async reassign(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ReassignBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const t = await this.visible(p, id, tx);
      if (!this.canReassign(p, t)) throw forbidden();
      await reassignTicket(tx, id, p.id, b);
    });
    return this.detail(p, id);
  }

  @Post('tickets/:id/comments')
  @HttpCode(200)
  async comment(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(CommentBody, body);
    const attachments = await this.ownFiles(b.attachmentIds, p.id);
    await withTx(this.ctx.pool, async (tx) => {
      const t = await this.visible(p, id, tx);
      const ok =
        !!t.my_role ||
        t.created_by === p.id ||
        (await this.isApprover(p, t, tx)) ||
        hasPerm(p, 'admin.matrix', 'supervisor.approvals');
      if (!ok) throw forbidden();
      await commentTicket(tx, id, p.id, b.body, attachments);
    });
    return this.detail(p, id);
  }

  /** Исправление сути — только оператор, передавший обращение на 2-ю линию (ответственный пишет заметку). */
  @Post('tickets/:id/edit')
  @HttpCode(200)
  @RequirePerm('conversations.work')
  async edit(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(EditBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const t = await this.visible(p, id, tx);
      if (t.created_by !== p.id)
        throw new ApiError(
          403,
          'forbidden',
          'Суть исправляет только оператор, передавший обращение на 2-ю линию',
        );
      if (t.status === 'closed') throw new ApiError(409, 'bad_status', 'Обращение закрыто');
      if (t.version !== b.version)
        throw new ApiError(
          409,
          'ticket_changed',
          'Обращение уже изменено другим сотрудником — обновите страницу',
        );
      await tx.query(
        `UPDATE ticket SET summary = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, b.summary],
      );
      await tx.query(
        `INSERT INTO ticket_transition (id, ticket_id, actor_id, action, from_status, to_status, details)
         VALUES ($1, $2, $3, 'edited', $4, $4, $5)`,
        [newId(), id, p.id, t.status, JSON.stringify({ before: t.summary })],
      );
      await audit(tx, p, 'update', 'ticket', id, { summary: t.summary }, { summary: b.summary });
    });
    return this.detail(p, id);
  }

  /** Записи разговоров обращения — участникам 2-й линии (без прав оператора), каждое прослушивание — в аудит. */
  @Get('tickets/:id/recordings')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async recordings(@CurrentUser() p: Principal, @Param('id') id: string) {
    const t = await this.visible(p, id);
    const list = await rows(
      this.ctx.pool,
      `SELECT r.id, r.status, r.duration_s, r.deleted_at, r.created_at, c.direction, c.from_number, c.to_number,
              u.full_name AS agent_name
         FROM call_recording r JOIN call c ON c.id = r.call_id LEFT JOIN app_user u ON u.id = c.agent_user_id
        WHERE r.conversation_id = $1 ORDER BY r.created_at`,
      [t.conversation_id],
    );
    return list.map((r) => toApi(r));
  }

  @Get('tickets/:id/recordings/:recId')
  @RequirePerm('conversations.work', 'tickets.work', 'supervisor.approvals', 'admin.matrix')
  async recordingFile(
    @CurrentUser() p: Principal,
    @Param('id') id: string,
    @Param('recId') recId: string,
    @Res() reply: FastifyReply,
  ) {
    const t = await this.visible(p, id);
    if (!uuid.safeParse(recId).success) throw notFound('Запись');
    const r = await one<{ storage_key: string | null; status: string; deleted_at: Date | null }>(
      this.ctx.pool,
      `SELECT storage_key, status, deleted_at FROM call_recording WHERE id = $1 AND conversation_id = $2`,
      [recId, t.conversation_id],
    );
    if (!r) throw notFound('Запись');
    if (r.deleted_at) throw new ApiError(410, 'deleted', 'Запись удалена: истёк срок хранения');
    if (r.status !== 'uploaded' || !r.storage_key)
      throw new ApiError(409, 'not_ready', 'Запись ещё обрабатывается');
    await withTx(this.ctx.pool, (tx) =>
      audit(tx, p, 'recording.play', 'call_recording', recId, null, null, { configChanged: false }),
    );
    const obj = await this.ctx.storage.get(r.storage_key);
    reply.header('content-type', 'audio/wav').header('x-content-type-options', 'nosniff');
    if (obj.length) reply.header('content-length', obj.length);
    return reply.send(obj.body);
  }

  // ---------- Внутреннее ----------

  private async visible(
    p: Principal,
    id: string,
    db: Pool | PoolClient = this.ctx.pool,
  ): Promise<VisibleTicket> {
    if (!uuid.safeParse(id).success) throw notFound('Обращение');
    const sc = scopeFilter(p.scope, TICKET_SCOPE, 3);
    const t = await one<VisibleTicket>(
      db,
      `SELECT ${TICKET_COLS},
              (SELECT a.kind FROM ticket_assignee a WHERE a.ticket_id = t.id AND a.user_id = $2 AND a.is_active) AS my_role
         FROM ticket t
        WHERE t.id = $1 AND (
              t.created_by = $2
           OR EXISTS (SELECT 1 FROM ticket_assignee a WHERE a.ticket_id = t.id AND a.user_id = $2 AND a.is_active)
           OR EXISTS (SELECT 1 FROM approval_substitute s WHERE s.user_id = t.created_by AND s.substitute_id = $2 AND s.is_active)
           OR ${sc.sql})`,
      [id, p.id, ...sc.params],
    );
    if (!t) throw notFound('Обращение');
    return t;
  }

  private requireParticipant(t: VisibleTicket): void {
    if (!t.my_role)
      throw new ApiError(403, 'forbidden', 'Действовать может только ответственный или куратор обращения');
  }

  private async isApprover(p: Principal, t: TicketRow, db: Pool | PoolClient): Promise<boolean> {
    if (t.status !== 'approval') return false;
    const today = localDate(new Date(), await systemTimezone(db));
    const ctx = await loadApprovalContext(db, t, today);
    return canApprove(ctx, t, { id: p.id, canSupervise: hasPerm(p, 'supervisor.approvals'), scope: p.scope });
  }

  private async requireApprover(p: Principal, t: TicketRow, db: Pool | PoolClient): Promise<void> {
    if (!(await this.isApprover(p, t, db))) {
      if (t.status !== 'approval') throw new ApiError(409, 'bad_status', 'Обращение не ожидает согласования');
      throw new ApiError(
        403,
        'forbidden',
        'Согласовать может создатель обращения, его заместитель или супервизор',
      );
    }
  }

  private canReassign(p: Principal, t: TicketRow): boolean {
    return (
      t.created_by === p.id ||
      hasPerm(p, 'admin.matrix') ||
      (hasPerm(p, 'supervisor.approvals') && this.inTicketScope(p, t))
    );
  }

  /** Тикет в области видимости сотрудника — тот же предикат, что у SQL-фильтра (`inScope`). */
  private inTicketScope(p: Principal, t: TicketRow): boolean {
    return inScope(p.scope, {
      enterpriseId: t.enterprise_id,
      departmentId: t.department_id,
      topicPath: t.topic_path,
    });
  }

  /** Вложения, загруженные этим сотрудником и ещё не привязанные ни к обращению, ни к тикету. */
  private async ownFiles(fileIds: string[], userId: string): Promise<AttachmentRef[]> {
    if (!fileIds.length) return [];
    const list = await rows<{ id: string; filename: string; content_type: string; size_bytes: string }>(
      this.ctx.pool,
      `SELECT id, filename, content_type, size_bytes FROM attachment
        WHERE id = ANY($1) AND uploaded_by_user = $2 AND conversation_id IS NULL AND ticket_id IS NULL`,
      [fileIds, userId],
    );
    if (list.length !== new Set(fileIds).size) throw badRequest('Вложение не найдено или уже использовано');
    return list.map((r) => ({
      id: r.id,
      filename: r.filename,
      contentType: r.content_type,
      size: Number(r.size_bytes),
    }));
  }

  private async detail(p: Principal, id: string) {
    const t = await this.visible(p, id);
    const tz = await systemTimezone(this.ctx.pool);
    const today = localDate(new Date(), tz);
    const row = await one(this.ctx.pool, `${LIST_SQL} WHERE t.id = $3`, [p.id, today, id]);
    const assignees = await rows(
      this.ctx.pool,
      `SELECT a.user_id, a.kind, a.is_active, a.added_at, a.removed_at, a.removed_reason, u.full_name, u.email,
              (u.is_active AND u.can_login) AS user_active
         FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id WHERE a.ticket_id = $1
        ORDER BY a.is_active DESC, a.kind DESC, u.full_name`,
      [id],
    );
    const comments = await rows(
      this.ctx.pool,
      `SELECT c.id, c.kind, c.body, c.attachments, c.created_at, u.full_name AS author_name
         FROM ticket_comment c LEFT JOIN app_user u ON u.id = c.author_id WHERE c.ticket_id = $1 ORDER BY c.created_at`,
      [id],
    );
    const history = await rows(
      this.ctx.pool,
      `SELECT x.id, x.at, x.action, x.from_status, x.to_status, x.details, u.full_name AS actor_name
         FROM ticket_transition x LEFT JOIN app_user u ON u.id = x.actor_id WHERE x.ticket_id = $1 ORDER BY x.at, x.id`,
      [id],
    );
    const conv = await one(
      this.ctx.pool,
      `SELECT c.id, c.channel_kind, c.status, c.fields, c.contact_id, c.created_at, c.is_urgent,
              ct.display_name, ct.phone, ct.email,
              (SELECT o.name FROM service_object o WHERE o.id = c.object_id) AS object_name,
              (SELECT count(*)::int FROM call_recording r WHERE r.conversation_id = c.id AND r.deleted_at IS NULL) AS recordings
         FROM conversation c JOIN contact ct ON ct.id = c.contact_id WHERE c.id = $1`,
      [t.conversation_id],
    );
    // Подписи полей карточки темы (для показа заполненных полей на 2-й линии).
    const fieldDefs = await rows(
      this.ctx.pool,
      `SELECT DISTINCT ON (f.key) f.key, f.label FROM field_def f
        WHERE f.topic_id = ANY($1) AND f.is_active ORDER BY f.key, f.sort_order`,
      [t.topic_path],
    );
    const approvalMode = await one<{ v: string }>(
      this.ctx.pool,
      `SELECT value #>> '{}' AS v FROM system_setting WHERE key = 'ticket.approval_mode'`,
    );
    const canApproveNow = await this.isApprover(p, t, this.ctx.pool);
    const active = ['new', 'in_work', 'rework'].includes(t.status);
    return {
      ...toApi(row!),
      assignees: assignees.map((r) => toApi(r)),
      comments: comments.map((r) => toApi(r)),
      history: history.map((r) => toApi(r)),
      conversation: conv ? toApi(conv) : null,
      fieldDefs: fieldDefs.map((r) => toApi(r)),
      approvalMode: approvalMode?.v ?? 'creator',
      can: {
        open: !!t.my_role && (t.status === 'new' || t.status === 'rework'),
        close: !!t.my_role && active,
        extend: !!t.my_role && active,
        redirect: !!t.my_role && active,
        approve: canApproveNow,
        reassign: t.status !== 'closed' && this.canReassign(p, t),
        comment:
          !!t.my_role ||
          t.created_by === p.id ||
          canApproveNow ||
          hasPerm(p, 'admin.matrix', 'supervisor.approvals'),
        edit: t.created_by === p.id && t.status !== 'closed',
      },
    };
  }
}

const LIST_SQL = `SELECT t.id, t.number, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.is_important, t.returns_count,
    t.summary, t.enterprise_id, t.department_id, t.topic_id, t.topic_path, t.created_by, t.conversation_id, t.created_at,
    t.updated_at, t.answered_at, t.closed_at, t.closed_in_time, t.answer_summary, t.version, t.staff_guilty, t.measures,
    t.answer_method_id,
    (SELECT m.name FROM answer_method m WHERE m.id = t.answer_method_id) AS answer_method_name,
    e.name AS enterprise_name, d.name AS department_name,
    (SELECT string_agg(x.name, ' / ' ORDER BY array_position(t.topic_path, x.id)) FROM topic x WHERE x.id = ANY(t.topic_path)) AS topic_name,
    cu.full_name AS creator_name,
    COALESCE(ct.display_name, ct.phone, ct.email, 'Клиент') AS contact_name, ct.phone AS contact_phone, ct.email AS contact_email,
    c.channel_kind,
    (SELECT a.kind FROM ticket_assignee a WHERE a.ticket_id = t.id AND a.user_id = $1 AND a.is_active) AS my_role,
    (SELECT string_agg(u.full_name, ', ' ORDER BY u.full_name) FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id
      WHERE a.ticket_id = t.id AND a.is_active AND a.kind = 'responsible') AS responsible_names,
    (t.due_date - $2::date) AS days_left,
    (t.due_date - t.created_at::date) AS total_days,
    NOT EXISTS (SELECT 1 FROM ticket_view v WHERE v.ticket_id = t.id AND v.user_id = $1) AS is_new,
    (t.status IN ('new', 'in_work', 'rework') AND t.due_date < $2::date) AS is_overdue,
    CASE WHEN t.status = 'approval' THEN floor(EXTRACT(EPOCH FROM (now() - t.approval_wait_since)) / 86400)::int END AS approval_wait_days
  FROM ticket t
  JOIN enterprise e ON e.id = t.enterprise_id
  JOIN department d ON d.id = t.department_id
  JOIN app_user cu ON cu.id = t.created_by
  JOIN conversation c ON c.id = t.conversation_id
  JOIN contact ct ON ct.id = c.contact_id`;
