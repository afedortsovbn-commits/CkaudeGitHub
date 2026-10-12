import { randomInt } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Principal } from '@cc/auth';
import {
  loadMailPolicy,
  loadStaffingMinimum,
  loadStaffTelegram,
  markUnsubscribed,
  NOTIFY_CHANNELS,
  NOTIFY_EVENTS,
  resubscribe,
  saveStaffingMinimum,
  StaffTelegramApi,
  UNSUB_PHRASE,
} from '@cc/domain';
import { newId } from '@cc/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, hasPerm, Public, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';

const uuid = z.string().uuid();
const channels = z.array(z.enum(['ui', 'email', 'telegram'])).max(3);
const RuleBody = z
  .object({
    event: z.string().refine((e) => e in NOTIFY_EVENTS && !NOTIFY_EVENTS[e]!.optIn, 'Неизвестное событие'),
    name: z.string().trim().max(200).default(''),
    channels: channels.min(1),
    roleCodes: z.array(z.string().max(64)).max(20).default([]),
    userIds: z.array(uuid).max(200).default([]),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((r) => r.roleCodes.length || r.userIds.length, 'Укажите роли или сотрудников');
const RulePatch = RuleBody.innerType().partial().strict();
const PrefsBody = z
  .object({ prefs: z.record(z.string(), channels) })
  .strict()
  .refine((b) => Object.keys(b.prefs).every((e) => NOTIFY_EVENTS[e]?.optIn), 'Неизвестное событие');
const TelegramBody = z
  .object({
    botToken: z.string().trim().max(200).nullable().optional(),
    apiRoot: z.string().trim().url().max(200).nullable().optional(),
    miniAppUrl: z.string().trim().url().max(300).nullable().optional(),
  })
  .strict();
const MailBody = z.object({ copyTo: z.array(z.string().trim().email().max(200)).max(10) }).strict();
const StaffingBody = z
  .object({
    cells: z
      .array(
        z
          .object({
            weekday: z.number().int().min(1).max(7),
            hour: z.number().int().min(0).max(23),
            required: z.number().int().min(0).max(1000),
          })
          .strict(),
      )
      .max(168),
  })
  .strict();

const MANAGE = ['settings.manage', 'supervisor.monitor'] as const;

/**
 * Уведомления о событиях (Д-012): каталог событий, правила (кому и каким каналом), настройки бота Telegram для
 * сотрудников и политики писем (Д-013), минимум операторов на линии (Д-011), личные настройки сотрудника и привязка
 * Telegram, отписка от писем. Правила — администратор и супервизор; личные настройки — любой сотрудник.
 */
@Controller('api/v1')
export class NotifyController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  // ---------- каталог и правила

  @Get('notify/events')
  @RequirePerm(...MANAGE)
  events() {
    return Object.entries(NOTIFY_EVENTS).map(([code, d]) => ({ code, ...d }));
  }

  @Get('notify/rules')
  @RequirePerm(...MANAGE)
  async rules() {
    const list = await rows(
      this.ctx.pool,
      `SELECT r.*, (SELECT array_agg(u.full_name ORDER BY u.full_name) FROM app_user u WHERE u.id = ANY(r.user_ids)) AS user_names
         FROM notify_rule r ORDER BY r.event, r.created_at`,
    );
    return list.map((r) => ({ ...toApi(r), title: NOTIFY_EVENTS[String(r.event)]?.title ?? r.event }));
  }

  @Post('notify/rules')
  @RequirePerm(...MANAGE)
  async createRule(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(RuleBody, body);
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      const row = await one(
        tx,
        `INSERT INTO notify_rule (id, event, name, channels, role_codes, user_ids, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, b.event, b.name, b.channels, b.roleCodes, b.userIds, b.isActive],
      );
      await audit(tx, p, 'create', 'notify_rule', id, null, row);
      return toApi(row!);
    });
  }

  @Patch('notify/rules/:id')
  @RequirePerm(...MANAGE)
  async patchRule(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(RulePatch, body);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, `SELECT * FROM notify_rule WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Правило');
      const next = {
        event: b.event ?? before.event,
        name: b.name ?? before.name,
        channels: b.channels ?? before.channels,
        role_codes: b.roleCodes ?? before.role_codes,
        user_ids: b.userIds ?? before.user_ids,
        is_active: b.isActive ?? before.is_active,
      };
      if (!(next.role_codes as string[]).length && !(next.user_ids as string[]).length)
        throw badRequest('Укажите роли или сотрудников');
      const row = await one(
        tx,
        `UPDATE notify_rule SET event = $2, name = $3, channels = $4, role_codes = $5, user_ids = $6, is_active = $7,
                updated_at = now() WHERE id = $1 RETURNING *`,
        [id, next.event, next.name, next.channels, next.role_codes, next.user_ids, next.is_active],
      );
      await audit(tx, p, 'update', 'notify_rule', id, before, row);
      return toApi(row!);
    });
  }

  @Delete('notify/rules/:id')
  @RequirePerm(...MANAGE)
  @HttpCode(200)
  async deleteRule(@CurrentUser() p: Principal, @Param('id') id: string) {
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, `DELETE FROM notify_rule WHERE id = $1 RETURNING *`, [id]);
      if (!before) throw notFound('Правило');
      await audit(tx, p, 'delete', 'notify_rule', id, before, null);
      return { ok: true };
    });
  }

  // ---------- бот Telegram для сотрудников и политика писем

  @Get('notify/telegram')
  @RequirePerm(...MANAGE)
  async telegram() {
    const s = await loadStaffTelegram(this.ctx.pool);
    return {
      configured: !!s.botToken,
      botTokenMasked: s.botToken ? `${s.botToken.slice(0, 6)}…` : null,
      apiRoot: s.apiRoot,
      miniAppUrl: s.miniAppUrl,
      botUsername: s.botUsername,
    };
  }

  @Patch('notify/telegram')
  @RequirePerm('settings.manage')
  async patchTelegram(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(TelegramBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const before = await one<{ value: Record<string, unknown> }>(
        tx,
        `SELECT value FROM system_setting WHERE key = 'notify.telegram' FOR UPDATE`,
      );
      const cur = before?.value ?? {};
      const next: Record<string, unknown> = { ...cur };
      if (b.botToken !== undefined) next.botToken = b.botToken || null;
      if (b.apiRoot !== undefined) next.apiRoot = b.apiRoot || null;
      if (b.miniAppUrl !== undefined) next.miniAppUrl = b.miniAppUrl || null;
      // Имя бота — для подсказки сотруднику («напишите боту @…»); при недоступном API просто не заполняется.
      if (next.botToken && (b.botToken !== undefined || b.apiRoot !== undefined)) {
        try {
          const me = await new StaffTelegramApi(
            String(next.botToken),
            String(next.apiRoot ?? '') || undefined,
          ).getMe();
          next.botUsername = me.username ?? null;
        } catch {
          next.botUsername = null;
        }
      }
      if (!next.botToken) next.botUsername = null;
      await tx.query(
        `INSERT INTO system_setting (key, value) VALUES ('notify.telegram', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(next)],
      );
      await audit(
        tx,
        p,
        'update',
        'system_setting',
        'notify.telegram',
        { configured: !!cur.botToken },
        {
          configured: !!next.botToken,
          apiRoot: next.apiRoot,
          miniAppUrl: next.miniAppUrl,
        },
      );
    });
    return this.telegram();
  }

  @Get('notify/mail')
  @RequirePerm(...MANAGE)
  async mail() {
    return { ...(await loadMailPolicy(this.ctx.pool)), unsubscribePhrase: UNSUB_PHRASE };
  }

  @Patch('notify/mail')
  @RequirePerm('settings.manage')
  async patchMail(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(MailBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, `SELECT value FROM system_setting WHERE key = 'mail.policy'`);
      await tx.query(
        `INSERT INTO system_setting (key, value) VALUES ('mail.policy', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({ copyTo: b.copyTo })],
      );
      await audit(tx, p, 'update', 'system_setting', 'mail.policy', before, { value: { copyTo: b.copyTo } });
    });
    return this.mail();
  }

  // ---------- минимум операторов на линии (Д-011)

  @Get('staffing/minimum')
  @RequirePerm('settings.manage', 'supervisor.monitor', 'schedule.manage')
  async staffing() {
    return { cells: await loadStaffingMinimum(this.ctx.pool) };
  }

  @Put('staffing/minimum')
  @RequirePerm('settings.manage', 'supervisor.monitor', 'schedule.manage')
  @HttpCode(200)
  async putStaffing(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(StaffingBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const before = await loadStaffingMinimum(tx);
      await saveStaffingMinimum(tx, b.cells);
      await audit(tx, p, 'update', 'staffing_minimum', null, { cells: before }, { cells: b.cells });
    });
    return this.staffing();
  }

  // ---------- личные настройки сотрудника

  @Get('me/notify')
  async myPrefs(@CurrentUser() p: Principal) {
    const prefs = await rows<{ event: string; channels: string[] }>(
      this.ctx.pool,
      `SELECT event, channels FROM user_notify_pref WHERE user_id = $1`,
      [p.id],
    );
    const u = await one<{
      telegram_chat_id: string | null;
      telegram_linked_at: string | null;
      telegram_link_code: string | null;
      email_unsubscribed_at: string | null;
    }>(
      this.ctx.pool,
      `SELECT telegram_chat_id, telegram_linked_at, telegram_link_code, email_unsubscribed_at FROM app_user WHERE id = $1`,
      [p.id],
    );
    const tg = await loadStaffTelegram(this.ctx.pool);
    return {
      events: Object.entries(NOTIFY_EVENTS)
        .filter(([, d]) => d.optIn)
        .map(([code, d]) => ({ code, title: d.title, description: d.description })),
      channels: NOTIFY_CHANNELS,
      prefs: Object.fromEntries(prefs.map((r) => [r.event, r.channels])),
      telegram: {
        available: !!tg.botToken,
        botUsername: tg.botUsername,
        linked: !!u?.telegram_chat_id,
        linkedAt: u?.telegram_linked_at ?? null,
        code: u?.telegram_link_code ?? null,
      },
      emailUnsubscribedAt: u?.email_unsubscribed_at ?? null,
    };
  }

  @Put('me/notify')
  @HttpCode(200)
  async putMyPrefs(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(PrefsBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query(`DELETE FROM user_notify_pref WHERE user_id = $1`, [p.id]);
      for (const [event, ch] of Object.entries(b.prefs))
        if (ch.length)
          await tx.query(`INSERT INTO user_notify_pref (user_id, event, channels) VALUES ($1, $2, $3)`, [
            p.id,
            event,
            ch,
          ]);
    });
    return this.myPrefs(p);
  }

  /** Код привязки Telegram: сотрудник отправляет боту «/start КОД» (действует, пока не привязан или не заменён). */
  @Post('me/telegram/link')
  @HttpCode(200)
  async telegramLink(@CurrentUser() p: Principal) {
    const tg = await loadStaffTelegram(this.ctx.pool);
    if (!tg.botToken)
      throw new ApiError(409, 'telegram_not_configured', 'Бот Telegram для сотрудников не настроен');
    const code = String(randomInt(100000, 999999));
    await this.ctx.pool.query(
      `UPDATE app_user SET telegram_link_code = $2, updated_at = now() WHERE id = $1`,
      [p.id, code],
    );
    return { code, botUsername: tg.botUsername };
  }

  @Delete('me/telegram')
  @HttpCode(200)
  async telegramUnlink(@CurrentUser() p: Principal) {
    await this.ctx.pool.query(
      `UPDATE app_user SET telegram_chat_id = NULL, telegram_linked_at = NULL, telegram_link_code = NULL, updated_at = now() WHERE id = $1`,
      [p.id],
    );
    return { ok: true };
  }

  @Post('me/resubscribe')
  @HttpCode(200)
  async meResubscribe(@CurrentUser() p: Principal) {
    await resubscribe(this.ctx.pool, p.id);
    return { ok: true };
  }

  // ---------- отписка (Д-013): из письма и по ответу «отписаться» через почтовый relay

  @Public()
  @Get('unsubscribe')
  async unsubscribe(@Query('token') token: string | undefined, @Res() reply: FastifyReply) {
    const ok = token ? await markUnsubscribed(this.ctx.pool, { token }) : false;
    const text = ok
      ? 'Вы отписаны от писем контакт-центра. Снова включить письма можно в профиле сотрудника.'
      : 'Ссылка отписки недействительна.';
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="ru"><body style="font-family:Arial,sans-serif;padding:40px"><h2>${text}</h2></body></html>`,
      );
  }

  /** Почтовый relay: в ответе на письмо нашлось слово «отписаться» — отписать адрес (секрет INBOUND_SECRET). */
  @Public()
  @Post('inbound/unsubscribe')
  @HttpCode(200)
  async inboundUnsubscribe(@Headers('x-inbound-secret') secret: string | undefined, @Body() body: unknown) {
    const expected = this.ctx.config.INBOUND_SECRET;
    if (!expected || !secret || secret !== expected) throw new ApiError(401, 'unauthorized', 'Нет доступа');
    const { email } = parse(z.object({ email: z.string().trim().email() }).passthrough(), body);
    return { ok: true, found: await markUnsubscribed(this.ctx.pool, { email }) };
  }

  /** Является ли сотрудник получателем аналитики бота (для подсказок в профиле). */
  @Get('me/analytics-access')
  analyticsAccess(@CurrentUser() p: Principal) {
    return { wallboard: hasPerm(p, 'supervisor.monitor'), reports: hasPerm(p, 'reports.view') };
  }
}
