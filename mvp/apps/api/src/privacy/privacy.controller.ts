import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, notFound, parse } from '../lib/errors';
import { anonymizeContact, anonymizeUser, runRecordingRetention } from './privacy';

const AnonymizeBody = z
  .object({
    /** Явное подтверждение: действие необратимо. */
    confirm: z.literal(true, { errorMap: () => ({ message: 'Подтвердите обезличивание' }) }),
    reason: z.string().trim().min(3, 'Укажите основание').max(500),
  })
  .strict();

/** Согласия на обработку ПДн, сроки хранения и обезличивание (M-NFR-07, Ф12). */
@Controller('api/v1')
export class PrivacyController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Реестр согласий: кто, когда, в каком канале и с какой версией текста согласился. */
  @Get('admin/consents')
  @RequirePerm('admin.audit', 'admin.settings')
  async consents(@Query() q: Record<string, string>) {
    const params: unknown[] = [];
    const where: string[] = ['TRUE'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.channelId) add('k.channel_id = ?::uuid', q.channelId);
    if (q.version) add('k.text_version = ?', q.version);
    if (q.contactId) add('k.contact_id = ?::uuid', q.contactId);
    if (q.q) {
      params.push(`%${q.q}%`);
      const n = `$${params.length}`;
      where.push(`(ct.display_name ILIKE ${n} OR ct.phone ILIKE ${n} OR ct.email ILIKE ${n})`);
    }
    const list = await rows(
      this.ctx.pool,
      `SELECT k.id, k.accepted_at, k.text_version, k.ip, k.contact_id, ct.display_name AS contact_name,
              ct.anonymized_at IS NOT NULL AS contact_anonymized, ch.name AS channel_name, k.channel_id,
              t.id AS text_id
         FROM consent k JOIN contact ct ON ct.id = k.contact_id JOIN channel ch ON ch.id = k.channel_id
         LEFT JOIN consent_text t ON t.channel_id = k.channel_id AND t.version = k.text_version
        WHERE ${where.join(' AND ')} ORDER BY k.accepted_at DESC LIMIT 500`,
      params,
    );
    return list.map((r) => toApi(r));
  }

  /** Поиск клиента для обезличивания (по имени, телефону, email или идентификатору в канале). */
  @Get('admin/contacts')
  @RequirePerm('admin.users')
  async contacts(@Query('q') q?: string) {
    if (!q || q.trim().length < 2) return [];
    const list = await rows(
      this.ctx.pool,
      `SELECT c.id, c.display_name, c.phone, c.email, c.anonymized_at, c.created_at,
              (SELECT count(*)::int FROM conversation v WHERE v.contact_id = c.id) AS conversations
         FROM contact c
        WHERE c.merged_into_id IS NULL
          AND (c.display_name ILIKE $1 OR c.phone ILIKE $1 OR c.email ILIKE $1
               OR EXISTS (SELECT 1 FROM contact_identity i WHERE i.contact_id = c.id AND i.value ILIKE $1))
        ORDER BY c.created_at DESC LIMIT 50`,
      [`%${q.trim()}%`],
    );
    return list.map((r) => toApi(r));
  }

  /** Версии текстов согласия по каналам (текст каждой версии хранится навсегда). */
  @Get('admin/consent-texts')
  @RequirePerm('admin.audit', 'admin.settings', 'admin.directories')
  async consentTexts(@Query('channelId') channelId?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT t.id, t.channel_id, ch.name AS channel_name, t.version, t.text, t.created_at,
              (SELECT count(*)::int FROM consent k WHERE k.channel_id = t.channel_id AND k.text_version = t.version) AS accepted
         FROM consent_text t JOIN channel ch ON ch.id = t.channel_id
        WHERE ($1::uuid IS NULL OR t.channel_id = $1::uuid)
        ORDER BY ch.name, t.created_at DESC`,
      [channelId ?? null],
    );
    return list.map((r) => toApi(r));
  }

  /** Обезличивание клиента по запросу субъекта ПДн (необратимо, с основанием в журнале аудита). */
  @Post('contacts/:id/anonymize')
  @HttpCode(200)
  @RequirePerm('admin.users')
  async anonymizeContact(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(AnonymizeBody, body);
    const files = await withTx(this.ctx.pool, async (tx) => {
      const c = await one<{ anonymized_at: Date | null }>(
        tx,
        'SELECT anonymized_at FROM contact WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!c) throw notFound('Клиент');
      if (c.anonymized_at) throw new ApiError(409, 'already_anonymized', 'Клиент уже обезличен');
      const open = await one<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM conversation WHERE contact_id = $1 AND status NOT IN ('closed', 'waiting_2nd_line')`,
        [id],
      );
      if (open!.n > 0)
        throw new ApiError(
          409,
          'open_conversations',
          'У клиента есть незакрытые обращения — сначала закройте их',
        );
      const f = await anonymizeContact(tx, id);
      await audit(
        tx,
        p,
        'contact.anonymized',
        'contact',
        id,
        null,
        { reason: b.reason, files: f.keys.length },
        {
          configChanged: false,
        },
      );
      return f;
    });
    // Файлы — после фиксации: при сбое удаления строка уже помечена, файл недоступен через API.
    let removed = 0;
    for (const k of files.keys) {
      await this.ctx.storage
        .remove(k)
        .then(() => removed++)
        .catch((err: unknown) => this.ctx.logger.warn({ err: String(err) }, 'не удалось удалить файл'));
    }
    return { ok: true, filesRemoved: removed };
  }

  /** Обезличивание уволенного (отключённого) сотрудника. */
  @Post('users/:id/anonymize')
  @HttpCode(200)
  @RequirePerm('admin.users')
  async anonymizeUser(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(AnonymizeBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      const u = await one<{ is_active: boolean; anonymized_at: Date | null }>(
        tx,
        'SELECT is_active, anonymized_at FROM app_user WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!u) throw notFound('Сотрудник');
      if (u.is_active)
        throw new ApiError(
          409,
          'user_active',
          'Обезличить можно только отключённого (уволенного) сотрудника',
        );
      if (u.anonymized_at) throw new ApiError(409, 'already_anonymized', 'Сотрудник уже обезличен');
      await anonymizeUser(tx, id);
      await audit(
        tx,
        p,
        'user.anonymized',
        'app_user',
        id,
        null,
        { reason: b.reason },
        { configChanged: false },
      );
    });
    this.ctx.principals.invalidate();
    return { ok: true };
  }

  /** Запустить очистку записей по сроку хранения сейчас (обычно — по расписанию раз в час). */
  @Post('admin/retention/run')
  @HttpCode(200)
  @RequirePerm('admin.settings')
  async retention(@CurrentUser() p: Principal) {
    const r = await runRecordingRetention(this.ctx.pool, this.ctx.storage);
    await withTx(this.ctx.pool, (tx) =>
      audit(tx, p, 'retention.run', 'call_recording', null, null, r, { configChanged: false }),
    );
    return r;
  }
}
