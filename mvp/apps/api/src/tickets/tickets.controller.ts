import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { inScope, scopeFilter, type Principal } from '@cc/auth';
import {
  applyMatrixToOpenTickets,
  approveTicket,
  canApprove,
  closeTicketByResponsible,
  commentTicket,
  createTicket,
  loadApprovalContext,
  localDate,
  matrixDefaults,
  defaultDueDate,
  openTicket,
  redirectTicket,
  reassignTicket,
  returnTicket,
  setAgentStatus,
  systemTimezone,
  ticketsNeedingReassignment,
  TICKET_COLS,
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
    if (q.overdue === 'true')
      where.push(`t.status IN ('new', 'in_work', 'rework') AND t.due_date < $2::date`);
    if (q.important === 'true') where.push('t.is_important');
    if (q.enterpriseId) add('t.enterprise_id = ?', q.enterpriseId);
    if (q.departmentId) add('t.department_id = ?', q.departmentId);
    if (q.topicId) add('? = ANY(t.topic_path)', q.topicId);
    if (q.dueFrom) add('t.due_date >= ?::date', q.dueFrom);
    if (q.dueTo) add('t.due_date <= ?::date', q.dueTo);
    if (q.q)
      add(
        `(t.number::text = ? OR ct.display_name ILIKE ? OR ct.phone ILIKE ? OR ct.email ILIKE ? OR t.summary ILIKE ?)`,
        q.q.replace(/^№/, ''),
        `%${q.q}%`,
        `%${q.q}%`,
        `%${q.q}%`,
        `%${q.q}%`,
      );
    const list = await rows(
      this.ctx.pool,
      `${LIST_SQL} WHERE ${where.join(' AND ')}
        ORDER BY (t.status IN ('new', 'in_work', 'rework')) DESC, t.due_date, t.number LIMIT 300`,
      params,
    );
    return list.map((r) => toApi(r));
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
        hasPerm(p, 'admin.matrix');
      if (!ok) throw forbidden();
      await commentTicket(tx, id, p.id, b.body, attachments);
    });
    return this.detail(p, id);
  }

  // ---------- Внутреннее ----------

  private async visible(
    p: Principal,
    id: string,
    db: Pool | PoolClient = this.ctx.pool,
  ): Promise<VisibleTicket> {
    if (!uuid.safeParse(id).success) throw notFound('Тикет');
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
    if (!t) throw notFound('Тикет');
    return t;
  }

  private requireParticipant(t: VisibleTicket): void {
    if (!t.my_role)
      throw new ApiError(403, 'forbidden', 'Действовать может только ответственный или куратор тикета');
  }

  private async isApprover(p: Principal, t: TicketRow, db: Pool | PoolClient): Promise<boolean> {
    if (t.status !== 'approval') return false;
    const today = localDate(new Date(), await systemTimezone(db));
    const ctx = await loadApprovalContext(db, t, today);
    return canApprove(ctx, t, { id: p.id, canSupervise: hasPerm(p, 'supervisor.approvals'), scope: p.scope });
  }

  private async requireApprover(p: Principal, t: TicketRow, db: Pool | PoolClient): Promise<void> {
    if (!(await this.isApprover(p, t, db))) {
      if (t.status !== 'approval') throw new ApiError(409, 'bad_status', 'Тикет не ожидает согласования');
      throw new ApiError(
        403,
        'forbidden',
        'Согласовать может создатель тикета, его заместитель или супервизор',
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
      `SELECT c.id, c.channel_kind, c.status, c.fields, c.contact_id, ct.display_name, ct.phone, ct.email
         FROM conversation c JOIN contact ct ON ct.id = c.contact_id WHERE c.id = $1`,
      [t.conversation_id],
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
      approvalMode: approvalMode?.v ?? 'creator',
      can: {
        open: !!t.my_role && (t.status === 'new' || t.status === 'rework'),
        close: !!t.my_role && (t.status === 'in_work' || t.status === 'rework'),
        redirect: !!t.my_role && active,
        approve: canApproveNow,
        reassign: t.status !== 'closed' && this.canReassign(p, t),
        comment: !!t.my_role || t.created_by === p.id || canApproveNow,
      },
    };
  }
}

const LIST_SQL = `SELECT t.id, t.number, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.is_important, t.returns_count,
    t.summary, t.enterprise_id, t.department_id, t.topic_id, t.topic_path, t.created_by, t.conversation_id, t.created_at,
    t.updated_at, t.answered_at, t.closed_at, t.closed_in_time, t.answer_summary, t.version,
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
    (t.status IN ('new', 'in_work', 'rework') AND t.due_date < $2::date) AS is_overdue,
    CASE WHEN t.status = 'approval' THEN floor(EXTRACT(EPOCH FROM (now() - t.approval_wait_since)) / 86400)::int END AS approval_wait_days
  FROM ticket t
  JOIN enterprise e ON e.id = t.enterprise_id
  JOIN department d ON d.id = t.department_id
  JOIN app_user cu ON cu.id = t.created_by
  JOIN conversation c ON c.id = t.conversation_id
  JOIN contact ct ON ct.id = c.contact_id`;
