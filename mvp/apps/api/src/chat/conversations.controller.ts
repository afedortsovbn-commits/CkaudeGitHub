import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { CONVERSATION_EVENTS } from '@cc/contracts';
import { scopeFilter, type Principal } from '@cc/auth';
import { appendMessage, emitConversation, loadRef, setAgentStatus } from '@cc/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, hasPerm, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { ownAttachments, saveUpload, sendAttachment } from '../lib/attachments';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';
import { ensureRequiredTag } from './required-tag';

const uuid = z.string().uuid();
const SCOPE_COLS = {
  enterprise: 'c.enterprise_id',
  department: 'c.department_id',
  topicPath: 'c.topic_path',
};

const SendBody = z
  .object({
    body: z.string().max(10000).default(''),
    attachmentIds: z.array(uuid).max(10).default([]),
    note: z.boolean().default(false),
  })
  .strict()
  .refine((m) => m.body.trim() || m.attachmentIds.length, 'Пустое сообщение');
const PatchBody = z
  .object({
    topicId: uuid.nullable().optional(),
    enterpriseId: uuid.nullable().optional(),
    departmentId: uuid.nullable().optional(),
    objectId: uuid.nullable().optional(),
    fields: z.record(z.unknown()).optional(),
    isImportant: z.boolean().optional(),
    isUrgent: z.boolean().optional(),
    tagIds: z.array(uuid).optional(),
  })
  .strict();
const TransferBody = z
  .object({ toUserId: uuid.optional(), toQueueId: uuid.optional(), comment: z.string().max(1000).optional() })
  .strict()
  .refine((b) => !!b.toUserId !== !!b.toQueueId, 'Укажите оператора или очередь');
const CloseBody = z
  .object({ dispositionId: uuid, callbackAt: z.string().datetime({ offset: true }).optional() })
  .strict();
const ContactPatch = z
  .object({
    displayName: z.string().trim().max(200).nullable().optional(),
    phone: z.string().trim().max(64).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
    segment: z.string().trim().max(64).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

interface Conv {
  id: string;
  status: string;
  assignee_id: string | null;
  queue_id: string | null;
  topic_id: string | null;
  contact_id: string;
  channel_kind: string;
  fields: Record<string, unknown>;
  important_manual: boolean;
  version: number;
}

const LIST_SQL = `SELECT c.id, c.status, c.channel_kind, c.queue_id, c.assignee_id, c.topic_id, c.enterprise_id,
    c.is_important, c.is_urgent, c.callback_requested, c.last_message_at, c.created_at, c.assigned_at, c.closed_at, c.seq, c.contact_id,
    COALESCE(ct.display_name, ct.phone, ct.email, 'Клиент') AS contact_name, q.name AS queue_name, q.require_tag AS queue_require_tag, u.full_name AS assignee_name,
    t.name AS topic_name,
    (SELECT left(m.body, 140) FROM message m WHERE m.conversation_id = c.id AND m.direction IN ('in','out')
      ORDER BY m.sent_at DESC, m.seq DESC LIMIT 1) AS last_message,
    (SELECT m.direction FROM message m WHERE m.conversation_id = c.id AND m.direction IN ('in','out')
      ORDER BY m.sent_at DESC, m.seq DESC LIMIT 1) AS last_direction
  FROM conversation c
  JOIN contact ct ON ct.id = c.contact_id
  LEFT JOIN queue q ON q.id = c.queue_id
  LEFT JOIN app_user u ON u.id = c.assignee_id
  LEFT JOIN topic t ON t.id = c.topic_id`;

/** Рабочее место оператора: обращения текстовых каналов (M-OP-*, M-CARD-*). */
@Controller('api/v1')
@RequirePerm('conversations.work')
export class ConversationsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('conversations')
  async list(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, ...vals: unknown[]) => {
      let s = sql;
      for (const v of vals) {
        params.push(v);
        s = s.replace('?', `$${params.length}`);
      }
      where.push(s);
    };
    switch (q.tab ?? 'mine') {
      case 'mine':
        add(`c.assignee_id = ? AND c.status NOT IN ('closed', 'waiting_2nd_line')`, p.id);
        break;
      case 'queue':
        // Очередь: ожидающие без оператора — в очередях сотрудника (супервизор видит все очереди).
        if (hasPerm(p, 'supervisor.monitor')) add(`c.status = 'queued'`);
        else
          add(
            `c.status = 'queued' AND (c.queue_id IS NULL OR c.queue_id IN (SELECT queue_id FROM user_queue WHERE user_id = ?))`,
            p.id,
          );
        break;
      case 'active':
        add(`c.status NOT IN ('closed')`);
        break;
      case 'closed':
        add(`c.status = 'closed'`);
        break;
      case 'hold':
        // «Удержание» (M-OP-02): мои обращения, чей звонок сейчас на удержании (клиент слушает музыку).
        add(
          `c.assignee_id = ? AND c.status = 'active' AND EXISTS (SELECT 1 FROM call k WHERE k.conversation_id = c.id
             AND k.state = 'talking' AND k.on_hold)`,
          p.id,
        );
        break;
      case 'wrapup':
        // «Постобработка» (M-OP-02): разговор с клиентом завершён, а карточка ещё не закрыта. Звонок — все вызовы
        // обращения завершены (был разговор); чат — последним написал оператор и клиент молчит дольше
        // operator.wrapup_chat_idle_s («Настройки»). Статусы обращения не меняются — вкладка строится по признакам.
        add(
          `c.assignee_id = ? AND c.status = 'active' AND (
             (c.channel_kind = 'voice'
               AND EXISTS (SELECT 1 FROM call k WHERE k.conversation_id = c.id AND k.connected_at IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM call k WHERE k.conversation_id = c.id AND k.state <> 'ended'))
             OR (c.channel_kind <> 'voice' AND (
               SELECT m.direction = 'out' AND m.sent_at < now() - make_interval(secs => COALESCE(
                        (SELECT (value #>> '{}')::int FROM system_setting WHERE key = 'operator.wrapup_chat_idle_s'), 300))
                 FROM message m WHERE m.conversation_id = c.id AND m.direction IN ('in', 'out')
                ORDER BY m.sent_at DESC, m.seq DESC LIMIT 1)))`,
          p.id,
        );
        break;
      case 'bot':
        // «У бота» (M-OP-02): текстовые диалоги с ботом и звонки в IVR — до перевода на оператора.
        add(`c.status = 'bot'`);
        break;
      default:
        throw badRequest('Неизвестная вкладка');
    }
    if (q.contactId) add('c.contact_id = ?', q.contactId);
    // Задачи «перезвонить» из IVR (голосовое сообщение / заказ обратного звонка, M-TEL-08).
    if (q.callback === 'true') add('c.callback_requested');
    if (q.important === 'true') add('c.is_important');
    if (q.q)
      add(
        `(ct.display_name ILIKE ? OR ct.phone ILIKE ? OR ct.email ILIKE ?)`,
        `%${q.q}%`,
        `%${q.q}%`,
        `%${q.q}%`,
      );
    const sc = scopeFilter(p.scope, SCOPE_COLS, params.length + 1);
    where.push(sc.sql);
    params.push(...sc.params);
    const order =
      q.tab === 'queue'
        ? 'c.is_urgent DESC, c.created_at'
        : q.tab === 'closed'
          ? 'c.closed_at DESC'
          : 'c.last_message_at DESC NULLS LAST';
    const list = await rows(
      this.ctx.pool,
      `${LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`,
      params,
    );
    return list.map((r) => toApi(r));
  }

  /** Обращение в области видимости сотрудника; иначе 404 (не раскрываем существование). */
  private async visible(
    p: Principal,
    id: string,
    db: import('pg').Pool | PoolClient = this.ctx.pool,
    lock = false,
  ): Promise<Conv> {
    const sc = scopeFilter(p.scope, SCOPE_COLS, 2);
    const c = await one<Conv>(
      db,
      `SELECT c.* FROM conversation c WHERE c.id = $1 AND (${sc.sql} OR c.assignee_id = '${p.id}') ${lock ? 'FOR UPDATE' : ''}`,
      [id, ...sc.params],
    );
    if (!c) throw notFound('Обращение');
    return c;
  }

  private ensureHandler(p: Principal, c: Conv, strict = false): void {
    if (c.status === 'closed') throw badRequest('Обращение закрыто');
    if (c.status === 'waiting_2nd_line' && strict)
      throw new ApiError(
        409,
        'waiting_2nd_line',
        'Обращение на 2-й линии: закроет его согласующий после принятия ответа',
      );
    if (c.assignee_id !== p.id && !hasPerm(p, 'supervisor.monitor')) {
      throw new ApiError(
        409,
        'not_assignee',
        'Обращение ведёт другой оператор — возьмите его или попросите передать',
      );
    }
  }

  @Get('conversations/:id')
  async get(@CurrentUser() p: Principal, @Param('id') id: string) {
    await this.visible(p, id);
    const c = await one(this.ctx.pool, `${LIST_SQL} WHERE c.id = $1`, [id]);
    const full = await one(
      this.ctx.pool,
      `SELECT fields, topic_path, department_id, object_id, disposition_id, important_manual, version, channel_id,
              (SELECT r.score FROM csat_rating r WHERE r.conversation_id = conversation.id AND r.call_id IS NULL
                ORDER BY r.created_at DESC LIMIT 1) AS chat_csat
         FROM conversation WHERE id = $1`,
      [id],
    );
    const tags = await rows<{ tag_id: string }>(
      this.ctx.pool,
      'SELECT tag_id FROM conversation_tag WHERE conversation_id = $1',
      [id],
    );
    const ticket = await one(
      this.ctx.pool,
      `SELECT id, number, status, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM ticket
        WHERE conversation_id = $1 ORDER BY (status <> 'closed') DESC, created_at DESC LIMIT 1`,
      [id],
    );
    return {
      ...toApi(c!),
      ...toApi(full!),
      tagIds: tags.map((t) => t.tag_id),
      ticket: ticket ? toApi(ticket) : null,
    };
  }

  @Get('conversations/:id/messages')
  async messages(@CurrentUser() p: Principal, @Param('id') id: string, @Query('afterSeq') afterSeq?: string) {
    await this.visible(p, id);
    const list = await rows(
      this.ctx.pool,
      `SELECT m.*, u.full_name AS author_name FROM message m LEFT JOIN app_user u ON u.id = m.author_user_id
        WHERE m.conversation_id = $1 AND m.seq > $2 ORDER BY m.sent_at, m.seq`,
      [id, Number(afterSeq) || 0],
    );
    return list.map((r) => toApi(r));
  }

  /**
   * Взять обращение из очереди вручную — наравне с автоматическим распределением router (Ф3):
   * пригодится, когда оператор хочет опередить очередь предложений или супервизор назначает вручную
   * (M-RT-05). Лимит одновременных чатов (M-OP-03) общий с автоматическим назначением.
   */
  @Post('conversations/:id/take')
  @HttpCode(200)
  async take(@CurrentUser() p: Principal, @Param('id') id: string) {
    await withTx(this.ctx.pool, async (tx) => {
      const c = await this.visible(p, id, tx, true);
      if (c.status === 'offered')
        throw new ApiError(409, 'taken', 'Обращение уже предложено другому оператору');
      if (c.status !== 'queued' || c.assignee_id)
        throw new ApiError(409, 'taken', 'Обращение уже взято другим оператором');
      const max = await one<{ value: number }>(
        tx,
        `SELECT value FROM system_setting WHERE key = 'operator.max_chats'`,
      );
      const active = await one<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM conversation WHERE assignee_id = $1 AND status IN ('active', 'hold', 'offered') AND channel_kind <> 'voice'`,
        [p.id],
      );
      if ((active?.n ?? 0) >= Number(max?.value ?? 5))
        throw new ApiError(409, 'limit', `Достигнут лимит одновременных чатов (${Number(max?.value ?? 5)})`);
      await tx.query(
        `UPDATE conversation SET assignee_id = $2, status = 'active', assigned_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
        [id, p.id],
      );
      // Только отметка для стратегии least_recent; статус не трогаем — ручное «Взять» не делает оператора «Готов».
      await tx.query(
        `UPDATE agent_status SET last_assigned_at = now(), updated_at = now() WHERE user_id = $1`,
        [p.id],
      );
      await appendMessage(tx, {
        conversationId: id,
        direction: 'system',
        body: `Оператор ${p.fullName} подключился к диалогу`,
        channelKind: c.channel_kind,
      });
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, id), { action: 'assigned' });
    });
    return this.get(p, id);
  }

  /** Оператор принимает предложенное router обращение (M-RT-05). */
  @Post('conversations/:id/accept')
  @HttpCode(200)
  async accept(@CurrentUser() p: Principal, @Param('id') id: string) {
    await withTx(this.ctx.pool, async (tx) => {
      const c = await this.visible(p, id, tx, true);
      if (c.status !== 'offered' || c.assignee_id !== p.id)
        throw new ApiError(409, 'not_offered', 'Обращение не предложено вам');
      await tx.query(
        `UPDATE conversation SET status = 'active', assigned_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
        [id],
      );
      await tx.query(
        `UPDATE routing_offer SET outcome = 'accepted', decided_at = now()
          WHERE conversation_id = $1 AND user_id = $2 AND outcome IS NULL`,
        [id, p.id],
      );
      await appendMessage(tx, {
        conversationId: id,
        direction: 'system',
        body: `Оператор ${p.fullName} подключился к диалогу`,
        channelKind: c.channel_kind,
      });
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, id), { action: 'accepted' });
    });
    return this.get(p, id);
  }

  /** Оператор отклоняет предложение — router предложит его следующему подходящему оператору (M-RT-05). */
  @Post('conversations/:id/decline')
  @HttpCode(200)
  async decline(@CurrentUser() p: Principal, @Param('id') id: string) {
    await withTx(this.ctx.pool, async (tx) => {
      const c = await this.visible(p, id, tx, true);
      if (c.status !== 'offered' || c.assignee_id !== p.id)
        throw new ApiError(409, 'not_offered', 'Обращение не предложено вам');
      await tx.query(
        `UPDATE conversation SET status = 'queued', assignee_id = NULL, offered_at = NULL,
           version = version + 1, updated_at = now() WHERE id = $1`,
        [id],
      );
      await tx.query(
        `UPDATE routing_offer SET outcome = 'declined', decided_at = now()
          WHERE conversation_id = $1 AND user_id = $2 AND outcome IS NULL`,
        [id, p.id],
      );
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, id), {
        action: 'declined',
        userId: p.id,
      });
    });
    return { ok: true };
  }

  @Post('conversations/:id/messages')
  async send(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(SendBody, body);
    const attachments = await ownAttachments(this.ctx, b.attachmentIds, { userId: p.id });
    return withTx(this.ctx.pool, async (tx) => {
      const c = await this.visible(p, id, tx, true);
      if (!b.note) this.ensureHandler(p, c);
      const m = await appendMessage(tx, {
        conversationId: id,
        direction: b.note ? 'note' : 'out',
        body: b.body,
        attachments,
        authorUserId: p.id,
        channelKind: c.channel_kind,
      });
      return { ...m, authorName: p.fullName };
    });
  }

  /** Классификация: тема (путь и авто-«важность»), предприятие/подразделение/объект, поля, теги (M-CARD-03/04/06/08). */
  @Patch('conversations/:id')
  async patch(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(PatchBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const c = await this.visible(p, id, tx, true);
      if (c.status === 'closed' && !hasPerm(p, 'supervisor.monitor')) throw badRequest('Обращение закрыто');
      const sets: string[] = [];
      const vals: unknown[] = [id];
      const set = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      let manual = c.important_manual;
      if (b.isImportant !== undefined) {
        manual = true;
        set('important_manual', true);
        set('is_important', b.isImportant);
      }
      if (b.topicId !== undefined) {
        if (b.topicId) {
          const t = await one<{ path: string[] }>(tx, 'SELECT path FROM topic WHERE id = $1 AND is_active', [
            b.topicId,
          ]);
          if (!t) throw notFound('Тема');
          set('topic_id', b.topicId);
          set('topic_path', t.path);
          if (!manual) {
            const imp = await one<{ v: boolean }>(
              tx,
              'SELECT bool_or(is_important) AS v FROM topic WHERE id = ANY($1)',
              [t.path],
            );
            set('is_important', !!imp?.v);
          }
        } else {
          set('topic_id', null);
          set('topic_path', []);
          if (!manual) set('is_important', false);
        }
      }
      if (b.enterpriseId !== undefined) set('enterprise_id', b.enterpriseId);
      if (b.departmentId !== undefined) set('department_id', b.departmentId);
      if (b.objectId !== undefined) set('object_id', b.objectId);
      if (b.isUrgent !== undefined) set('is_urgent', b.isUrgent);
      if (b.fields !== undefined) set('fields', JSON.stringify({ ...c.fields, ...b.fields }));
      if (sets.length)
        await tx.query(
          `UPDATE conversation SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`,
          vals,
        );
      if (b.tagIds) {
        await tx.query('DELETE FROM conversation_tag WHERE conversation_id = $1', [id]);
        for (const t of b.tagIds) await tx.query('INSERT INTO conversation_tag VALUES ($1, $2)', [id, t]);
      }
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, id), {
        action: 'classified',
      });
    });
    return this.get(p, id);
  }

  /** Передача оператору или в очередь с контекстом (M-OP-08). */
  @Post('conversations/:id/transfer')
  @HttpCode(200)
  async transfer(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(TransferBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const c = await this.visible(p, id, tx, true);
      this.ensureHandler(p, c, true);
      if (b.toUserId) {
        const u = await one<{ full_name: string }>(
          tx,
          `SELECT u.full_name FROM app_user u WHERE u.id = $1 AND u.is_active
             AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                          WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))`,
          [b.toUserId],
        );
        if (!u) throw badRequest('Оператор не найден');
        await tx.query(
          `UPDATE conversation SET assignee_id = $2, status = 'active', assigned_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
          [id, b.toUserId],
        );
        await appendMessage(tx, {
          conversationId: id,
          direction: 'system',
          body: `Диалог передан оператору ${u.full_name}${b.comment ? `: ${b.comment}` : ''}`,
          channelKind: c.channel_kind,
          authorUserId: p.id,
        });
      } else {
        const q = await one<{ name: string; priority: number }>(
          tx,
          'SELECT name, priority FROM queue WHERE id = $1 AND is_active',
          [b.toQueueId],
        );
        if (!q) throw badRequest('Очередь не найдена');
        // Новая постановка в очередь (M-RT-04): отсчёт ожидания для перелива/эскалации начинается заново.
        await tx.query(
          `UPDATE conversation SET assignee_id = NULL, queue_id = $2, status = 'queued', priority = $3,
             escalated = false, queued_at = now(), offered_at = NULL, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [id, b.toQueueId, q.priority],
        );
        await appendMessage(tx, {
          conversationId: id,
          direction: 'system',
          body: `Диалог передан в очередь «${q.name}»${b.comment ? `: ${b.comment}` : ''}`,
          channelKind: c.channel_kind,
          authorUserId: p.id,
        });
      }
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, id), {
        action: 'transferred',
        transferKind: b.toUserId ? 'user' : 'queue',
        byUserId: p.id,
      });
    });
    return this.get(p, id);
  }

  /** Закрытие с результатом обработки: тема обязательна, обязательные «при закрытии» поля темы — заполнены. */
  @Post('conversations/:id/close')
  @HttpCode(200)
  async close(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { dispositionId, callbackAt } = parse(CloseBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const c = await this.visible(p, id, tx, true);
      this.ensureHandler(p, c, true);
      const d = await one<{ behavior: string; name: string }>(
        tx,
        'SELECT behavior, name FROM disposition WHERE id = $1 AND is_active',
        [dispositionId],
      );
      if (!d) throw notFound('Результат обработки');
      if (d.behavior === 'escalate')
        throw badRequest('Для передачи на 2-ю линию используйте форму передачи (POST …/escalate)');
      if (d.behavior === 'postponed' && !callbackAt) throw badRequest('Укажите дату и время перезвона');
      if (d.behavior === 'postponed' && new Date(callbackAt!).getTime() <= Date.now())
        throw badRequest('Дата перезвона должна быть в будущем');
      if (d.behavior !== 'no_reply_needed' && !c.topic_id) throw badRequest('Укажите тему обращения');
      if (c.topic_id) {
        const req = await rows<{ key: string; label: string }>(
          tx,
          `SELECT f.key, f.label FROM topic t JOIN field_def f ON f.topic_id = ANY(t.path) AND f.is_active AND f.required_on_close WHERE t.id = $1`,
          [c.topic_id],
        );
        const missing = req.filter(
          (f) => c.fields[f.key] === undefined || c.fields[f.key] === null || c.fields[f.key] === '',
        );
        if (missing.length)
          throw badRequest(`Заполните обязательные поля: ${missing.map((f) => f.label).join(', ')}`);
      }
      await ensureRequiredTag(tx, id);
      await tx.query(
        `UPDATE conversation SET status = 'closed', disposition_id = $2, closed_at = now(), closed_by = $3,
           callback_at = $4, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, dispositionId, p.id, d.behavior === 'postponed' ? callbackAt : null],
      );
      await appendMessage(tx, {
        conversationId: id,
        direction: 'system',
        body:
          d.behavior === 'postponed'
            ? `Мы свяжемся с вами ${new Date(callbackAt!).toLocaleString('ru-RU', {
                timeZone: 'Europe/Minsk',
                dateStyle: 'short',
                timeStyle: 'short',
              })}`
            : 'Диалог завершён. Спасибо за обращение!',
        channelKind: c.channel_kind,
        authorUserId: p.id,
        // Оценка чата (Ф7): виджет и чат в приложении показывают клиенту кнопки 1–5.
        ...(['webchat', 'app'].includes(c.channel_kind) && d.behavior !== 'postponed'
          ? { meta: { csat: true } }
          : {}),
      });
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, id), {
        action: 'closed',
        disposition: d.name,
        dispositionId: dispositionId,
        dispositionKind: d.behavior,
      });
      // Постобработка (M-RT-06) — только для своего обращения и только из «Готов»: иначе оператор на перерыве
      // (или супервизор, закрывший чужое) через wrap_up_s автоматически стал бы «Готов» и получал обращения.
      const wrapUpS = await one<{ wrap_up_s: number }>(tx, `SELECT wrap_up_s FROM queue WHERE id = $1`, [
        c.queue_id,
      ]);
      const seconds = wrapUpS?.wrap_up_s ?? 15;
      const cur = await one<{ status: string }>(
        tx,
        `SELECT status FROM agent_status WHERE user_id = $1 FOR UPDATE`,
        [p.id],
      );
      if (seconds > 0 && c.assignee_id === p.id && (cur?.status === 'ready' || cur?.status === 'wrap_up')) {
        await setAgentStatus(tx, p.id, 'wrap_up', {
          wrapUpUntil: new Date(Date.now() + seconds * 1000),
        });
      }
    });
    return this.get(p, id);
  }

  /** Операторы для передачи диалога. */
  @Get('operators')
  async operators() {
    const list = await rows(
      this.ctx.pool,
      `SELECT u.id, u.full_name FROM app_user u
        WHERE u.is_active AND u.can_login AND EXISTS (
          SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
           WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))
        ORDER BY u.full_name`,
    );
    return list.map((r) => toApi(r));
  }

  // ---------- Клиент и кросс-канальная история (M-CARD-01/02) ----------

  @Get('contacts/:id')
  async contact(@Param('id') id: string) {
    const c = await one(this.ctx.pool, 'SELECT * FROM contact WHERE id = $1', [id]);
    if (!c) throw notFound('Клиент');
    const ids = await rows(
      this.ctx.pool,
      'SELECT kind, value FROM contact_identity WHERE contact_id = $1 ORDER BY created_at',
      [id],
    );
    // Согласия на обработку ПДн (M-NFR-07): канал, версия текста и дата — видны в карточке клиента.
    const consents = await rows(
      this.ctx.pool,
      `SELECT ch.name AS channel_name, k.text_version, k.accepted_at FROM consent k JOIN channel ch ON ch.id = k.channel_id
        WHERE k.contact_id = $1 ORDER BY k.accepted_at DESC LIMIT 20`,
      [id],
    );
    return {
      ...toApi(c),
      identities: ids
        .filter((i) => !['webchat', 'app'].includes(String(i.kind)) && !String(i.value).startsWith('anon:'))
        .map((r) => toApi(r)),
      consents: consents.map((r) => toApi(r)),
    };
  }

  @Get('contacts/:id/conversations')
  async history(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.list(p, { tab: 'active', contactId: id }).then(async (open) => {
      const closed = await this.list(p, { tab: 'closed', contactId: id });
      return [...open, ...closed];
    });
  }

  @Patch('contacts/:id')
  async patchContact(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(ContactPatch, body) as Record<string, unknown>;
    const cols = Object.keys(data).map((k) => k.replace(/[A-Z]/g, (x) => `_${x.toLowerCase()}`));
    if (!cols.length) return this.contact(id);
    await withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        `UPDATE contact SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
        [id, ...Object.values(data)],
      );
      if (!r.rowCount) throw notFound('Клиент');
      if (typeof data.phone === 'string' && data.phone) {
        await tx.query(
          `INSERT INTO contact_identity (id, contact_id, kind, value) VALUES (gen_random_uuid(), $1, 'phone', $2) ON CONFLICT DO NOTHING`,
          [id, data.phone.replace(/[^\d+]/g, '')],
        );
      }
      if (typeof data.email === 'string' && data.email) {
        await tx.query(
          `INSERT INTO contact_identity (id, contact_id, kind, value) VALUES (gen_random_uuid(), $1, 'email', lower($2)) ON CONFLICT DO NOTHING`,
          [id, data.email],
        );
      }
      void p;
    });
    return this.contact(id);
  }

  // ---------- Вложения оператора ----------

  @Post('attachments')
  upload(@CurrentUser() p: Principal, @Req() req: FastifyRequest) {
    return saveUpload(this.ctx, req, { userId: p.id });
  }

  @Get('attachments/:id')
  async download(@CurrentUser() p: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    return sendAttachment(this.ctx, id, reply, async (a) => {
      if (!a.conversation_id) return true; // только что загружено — ещё не привязано
      await this.visible(p, a.conversation_id);
      return true;
    });
  }
}
