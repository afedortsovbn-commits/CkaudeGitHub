import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { APP_EVENTS, makeEvent, newId } from '@cc/contracts';
import type { Principal } from '@cc/auth';
import { enqueueEvent } from '@cc/service-kit';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { badRequest, notFound, parse } from '../lib/errors';

const uuid = z.string().uuid();
const SendBody = z
  .object({
    importance: z.enum(['normal', 'important', 'urgent']).default('normal'),
    subject: z.string().trim().min(1, 'Укажите тему').max(200),
    body: z.string().trim().max(5000).default(''),
    /** Пусто — все сотрудники; иначе — только эти роли. */
    roles: z.array(z.string().max(64)).max(50).default([]),
    /** Только тем, кто сейчас на линии (статус «В работе», «Перерыв», «Постобработка»). */
    onlineOnly: z.boolean().default(false),
  })
  .strict();

/** Сообщить получателям через realtime: у сотрудника всплывает окно. */
async function push(tx: PoolClient, messageId: string, userIds: string[]) {
  if (!userIds.length) return;
  await enqueueEvent(
    tx,
    makeEvent({
      type: APP_EVENTS.staffMessage,
      source: 'staff-messages',
      data: { messageId, notifyUserIds: userIds },
    }),
  );
}

/**
 * Рассылка сотрудникам: администратор или супервизор отправляет сообщение всем или выбранным ролям (можно —
 * только тем, кто на линии), с важностью. У сотрудника — окно с кнопкой «Прочитал(а)»; автор видит по каждому
 * получателю, прочитал ли он, и может напомнить непрочитавшим.
 */
@Controller('api/v1/staff-messages')
export class StaffMessagesController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  // ---------- Получатель ----------

  /** Мои непрочитанные сообщения (старые — первыми). */
  @Get('inbox')
  async inbox(@CurrentUser() p: Principal) {
    const list = await rows(
      this.ctx.pool,
      `SELECT m.id, m.importance, m.subject, m.body, m.created_at, a.full_name AS author_name
         FROM staff_message_recipient r JOIN staff_message m ON m.id = r.message_id
         JOIN app_user a ON a.id = m.author_id
        WHERE r.user_id = $1 AND r.read_at IS NULL ORDER BY m.created_at`,
      [p.id],
    );
    return list.map((r) => toApi(r));
  }

  @Post(':id/read')
  @HttpCode(200)
  async read(@CurrentUser() p: Principal, @Param('id') id: string) {
    const r = await this.ctx.pool.query(
      `UPDATE staff_message_recipient SET read_at = now() WHERE message_id = $1 AND user_id = $2 AND read_at IS NULL`,
      [parse(uuid, id), p.id],
    );
    return { updated: r.rowCount };
  }

  // ---------- Автор ----------

  /** Роли для выбора получателей (с числом действующих сотрудников). */
  @Get('roles')
  @RequirePerm('staff.broadcast')
  async roles() {
    const list = await rows(
      this.ctx.pool,
      `SELECT r.code, r.name, (SELECT count(*)::int FROM user_role ur JOIN app_user u ON u.id = ur.user_id
                                WHERE ur.role_code = r.code AND u.is_active AND u.can_login) AS users
         FROM role r ORDER BY r.name`,
    );
    return list.map((r) => toApi(r));
  }

  @Get()
  @RequirePerm('staff.broadcast')
  async list() {
    const list = await rows(
      this.ctx.pool,
      `SELECT m.id, m.importance, m.subject, m.body, m.audience, m.created_at, a.full_name AS author_name,
              (SELECT count(*)::int FROM staff_message_recipient r WHERE r.message_id = m.id) AS total,
              (SELECT count(*)::int FROM staff_message_recipient r WHERE r.message_id = m.id AND r.read_at IS NOT NULL) AS read
         FROM staff_message m JOIN app_user a ON a.id = m.author_id
        ORDER BY m.created_at DESC LIMIT 100`,
    );
    return list.map((r) => toApi(r));
  }

  /** Получатели: прочитал ли, когда, роль и текущий статус на линии. */
  @Get(':id')
  @RequirePerm('staff.broadcast')
  async recipients(@Param('id') id: string) {
    const m = await one(this.ctx.pool, 'SELECT id FROM staff_message WHERE id = $1', [parse(uuid, id)]);
    if (!m) throw notFound('Сообщение');
    const list = await rows(
      this.ctx.pool,
      `SELECT u.id AS user_id, u.full_name, r.read_at, r.reminded_at, COALESCE(ag.status, 'offline') AS agent_status,
              (SELECT string_agg(ro.name, ', ' ORDER BY ro.name) FROM user_role ur JOIN role ro ON ro.code = ur.role_code
                WHERE ur.user_id = u.id) AS roles
         FROM staff_message_recipient r JOIN app_user u ON u.id = r.user_id
         LEFT JOIN agent_status ag ON ag.user_id = u.id
        WHERE r.message_id = $1 ORDER BY (r.read_at IS NULL) DESC, u.full_name`,
      [id],
    );
    return list.map((r) => toApi(r));
  }

  @Post()
  @RequirePerm('staff.broadcast')
  async send(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(SendBody, body);
    return withTx(this.ctx.pool, async (tx) => {
      const users = await rows<{ id: string }>(
        tx,
        `SELECT u.id FROM app_user u LEFT JOIN agent_status ag ON ag.user_id = u.id
          WHERE u.is_active AND u.can_login AND u.id <> $1
            AND (cardinality($2::text[]) = 0 OR EXISTS (
                 SELECT 1 FROM user_role ur WHERE ur.user_id = u.id AND ur.role_code = ANY($2)))
            AND (NOT $3 OR COALESCE(ag.status, 'offline') <> 'offline')`,
        [p.id, b.roles, b.onlineOnly],
      );
      if (!users.length) throw badRequest('Получателей нет — измените, кому отправить');
      const id = newId();
      await tx.query(
        `INSERT INTO staff_message (id, author_id, importance, subject, body, audience) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          p.id,
          b.importance,
          b.subject,
          b.body,
          JSON.stringify({ roles: b.roles, onlineOnly: b.onlineOnly }),
        ],
      );
      await tx.query(
        `INSERT INTO staff_message_recipient (message_id, user_id) SELECT $1, unnest($2::uuid[])`,
        [id, users.map((u) => u.id)],
      );
      await push(
        tx,
        id,
        users.map((u) => u.id),
      );
      await audit(tx, p, 'create', 'staff_message', id, null, { ...b, recipients: users.length });
      return { id, recipients: users.length };
    });
  }

  /** Напомнить тем, кто ещё не прочитал: окно всплывёт снова. */
  @Post(':id/remind')
  @HttpCode(200)
  @RequirePerm('staff.broadcast')
  async remind(@Param('id') id: string) {
    return withTx(this.ctx.pool, async (tx) => {
      const r = await rows<{ user_id: string }>(
        tx,
        `UPDATE staff_message_recipient SET reminded_at = now()
          WHERE message_id = $1 AND read_at IS NULL RETURNING user_id`,
        [parse(uuid, id)],
      );
      await push(
        tx,
        id,
        r.map((x) => x.user_id),
      );
      return { reminded: r.length };
    });
  }
}
