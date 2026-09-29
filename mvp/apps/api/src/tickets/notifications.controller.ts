import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { newId } from '@cc/contracts';
import type { Principal } from '@cc/auth';
import { z } from 'zod';
import { CurrentUser, hasPerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { badRequest, forbidden, notFound, parse } from '../lib/errors';

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SubstituteBody = z
  .object({
    userId: uuid.optional(),
    substituteId: uuid,
    validFrom: day.nullable().optional(),
    validTo: day.nullable().optional(),
  })
  .strict();

/** Уведомления в интерфейсе (колокольчик, M-TKT-12) и заместители по согласованию (M-TKT-09). */
@Controller('api/v1')
export class NotificationsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('notifications')
  async list(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const limit = Math.min(Number(q.limit) || 50, 200);
    const items = await rows(
      this.ctx.pool,
      `SELECT n.id, n.kind, n.subject, n.ticket_id, n.data, n.created_at, n.read_at, t.number AS ticket_number, t.status AS ticket_status
         FROM notification n LEFT JOIN ticket t ON t.id = n.ticket_id
        WHERE n.user_id = $1 AND n.channel = 'ui' AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
        ORDER BY n.created_at DESC LIMIT $3`,
      [p.id, q.unread === 'true', limit],
    );
    const unread = await one<{ n: number }>(
      this.ctx.pool,
      `SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND channel = 'ui' AND read_at IS NULL`,
      [p.id],
    );
    return { items: items.map((r) => toApi(r)), unread: unread?.n ?? 0 };
  }

  /** Отметить прочитанными указанные уведомления (без списка — все). */
  @Post('notifications/read')
  @HttpCode(200)
  async read(@CurrentUser() p: Principal, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: z.array(uuid).max(500).optional() }).strict(), body ?? {});
    const r = await this.ctx.pool.query(
      `UPDATE notification SET read_at = now()
        WHERE user_id = $1 AND channel = 'ui' AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))`,
      [p.id, ids ?? null],
    );
    return { updated: r.rowCount };
  }

  // ---------- Заместители по согласованию ----------

  /** Свои заместители и те, кого замещаю; администратор с `all=true` — все. */
  @Get('approval-substitutes')
  async substitutes(@CurrentUser() p: Principal, @Query('all') all?: string) {
    const admin = all === 'true' && hasPerm(p, 'admin.users');
    const list = await rows(
      this.ctx.pool,
      `SELECT s.id, s.user_id, s.substitute_id, to_char(s.valid_from, 'YYYY-MM-DD') AS valid_from,
              to_char(s.valid_to, 'YYYY-MM-DD') AS valid_to, s.created_at,
              u.full_name AS user_name, sub.full_name AS substitute_name
         FROM approval_substitute s
         JOIN app_user u ON u.id = s.user_id JOIN app_user sub ON sub.id = s.substitute_id
        WHERE s.is_active AND ($2::boolean OR s.user_id = $1 OR s.substitute_id = $1)
        ORDER BY u.full_name, sub.full_name`,
      [p.id, admin],
    );
    return list.map((r) => toApi(r));
  }

  /** Назначает заместителя: администратор — любому оператору, оператор — себе на период отсутствия. */
  @Post('approval-substitutes')
  async addSubstitute(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(SubstituteBody, body);
    const userId = b.userId ?? p.id;
    if (userId !== p.id && !hasPerm(p, 'admin.users')) throw forbidden();
    if (!hasPerm(p, 'conversations.work', 'admin.users')) throw forbidden();
    if (userId === b.substituteId) throw badRequest('Нельзя назначить заместителем самого себя');
    if (b.validFrom && b.validTo && b.validFrom > b.validTo) throw badRequest('Период указан неверно');
    return withTx(this.ctx.pool, async (tx) => {
      const sub = await one(
        tx,
        `SELECT u.id FROM app_user u WHERE u.id = $1 AND u.is_active AND u.can_login AND EXISTS (
           SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
            WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))`,
        [b.substituteId],
      );
      if (!sub) throw badRequest('Заместитель — активный оператор или супервизор');
      const id = newId();
      await tx.query(
        `INSERT INTO approval_substitute (id, user_id, substitute_id, valid_from, valid_to, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, userId, b.substituteId, b.validFrom ?? null, b.validTo ?? null, p.id],
      );
      await audit(
        tx,
        p,
        'create',
        'approval_substitute',
        id,
        null,
        { userId, ...b },
        { configChanged: false },
      );
      return { id };
    });
  }

  @Delete('approval-substitutes/:id')
  @HttpCode(200)
  async removeSubstitute(@CurrentUser() p: Principal, @Param('id') id: string) {
    return withTx(this.ctx.pool, async (tx) => {
      const s = await one<{ user_id: string }>(
        tx,
        'SELECT user_id FROM approval_substitute WHERE id = $1 AND is_active FOR UPDATE',
        [id],
      );
      if (!s) throw notFound('Заместитель');
      if (s.user_id !== p.id && !hasPerm(p, 'admin.users')) throw forbidden();
      await tx.query('UPDATE approval_substitute SET is_active = false WHERE id = $1', [id]);
      await audit(tx, p, 'delete', 'approval_substitute', id, s, null, { configChanged: false });
      return { ok: true };
    });
  }
}
