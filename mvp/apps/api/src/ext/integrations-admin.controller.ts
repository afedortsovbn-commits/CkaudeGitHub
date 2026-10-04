import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  API_KEY_PERMISSION_LIST,
  API_KEY_PERMISSIONS,
  BOT_TURN_EVENT,
  newId,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_EVENTS,
} from '@cc/contracts';
import type { Principal } from '@cc/auth';
import { retryNow, sendTestDelivery } from '@cc/domain';
import { sealSecret } from '@cc/service-kit';
import { z } from 'zod';
import { apiKeys, CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { type Db, one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';
import { generateKey } from './api-key';

const uuid = z.string().uuid();
const scopeRule = z.object({
  enterpriseIds: z.array(uuid).nullable(),
  departmentIds: z.array(uuid).nullable(),
  topicIds: z.array(uuid).nullable(),
});

const KeyBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    permissions: z.array(z.enum(API_KEY_PERMISSION_LIST as [string, ...string[]])).min(1),
    /** null — все обращения; иначе правила области (как у сотрудника). */
    scopeRules: z.array(scopeRule).max(50).nullable().default(null),
    channelId: uuid.nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const KeyPatch = KeyBody.partial().strict();

const headerName = z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'Имя заголовка: латиница, цифры, -');
const SubBody = z
  .object({
    kind: z.enum(['events', 'bot']).default('events'),
    name: z.string().trim().min(1).max(200),
    url: z
      .string()
      .trim()
      .max(2000)
      .regex(/^https?:\/\/\S+$/i, 'URL должен начинаться с http:// или https://'),
    eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES as [string, ...string[]])).default([]),
    channelIds: z.array(uuid).default([]),
    headers: z.record(headerName, z.string().max(2000)).default({}),
    timeoutMs: z.number().int().min(500).max(30000).default(5000),
    botTimeoutS: z.number().int().min(5).max(3600).default(30),
  })
  .strict();
const SubPatch = SubBody.omit({ kind: true }).partial().strict();

const KEY_COLS = `k.id, k.name, k.prefix, k.permissions, k.scope_rules, k.channel_id, ch.name AS channel_name,
  k.expires_at, k.last_used_at, k.is_active, k.revoked_at, k.created_at, u.full_name AS created_by_name`;
const SUB_COLS = `s.id, s.kind, s.name, s.url, s.event_types, s.channel_ids, s.headers, s.timeout_ms, s.bot_timeout_s,
  s.failures, s.next_probe_at, s.last_success_at, s.last_failure_at, s.last_error, s.is_active, s.created_at,
  (SELECT count(*)::int FROM webhook_delivery d WHERE d.subscription_id = s.id AND d.status = 'pending') AS pending,
  (SELECT count(*)::int FROM webhook_delivery d WHERE d.subscription_id = s.id AND d.status = 'failed' AND NOT d.is_test) AS failed,
  (SELECT coalesce(array_agg(c.name ORDER BY c.name), '{}') FROM channel c WHERE c.bot_webhook_id = s.id) AS bot_channels`;

/**
 * Администрирование интеграций (Ф9): ключи публичного API (M-INT-01), подписки webhooks и внешние боты
 * (M-INT-02, M-AI-02) с журналом доставки, проверкой и повтором. Ключ и секрет подписи показываются один раз.
 */
@Controller('api/v1')
@RequirePerm('apikeys.manage', 'webhooks.manage', 'integrations.manage')
export class IntegrationsAdminController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('integrations-catalog')
  catalog() {
    return {
      permissions: Object.entries(API_KEY_PERMISSIONS).map(([code, title]) => ({ code, title })),
      events: Object.entries(WEBHOOK_EVENTS).map(([code, title]) => ({ code, title })),
      botEvent: BOT_TURN_EVENT,
    };
  }

  // ------------------------------------------------------------------ ключи API

  @Get('api-keys')
  @RequirePerm('apikeys.manage')
  async keys() {
    const list = await rows(
      this.ctx.pool,
      `SELECT ${KEY_COLS} FROM api_key k LEFT JOIN channel ch ON ch.id = k.channel_id
         LEFT JOIN app_user u ON u.id = k.created_by ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`,
    );
    return list.map((r) => toApi(r));
  }

  private async checkKey(db: Db, perms: string[] | undefined, channelId: string | null | undefined) {
    if (channelId) {
      const ch = await one<{ kind: string }>(db, `SELECT kind FROM channel WHERE id = $1`, [channelId]);
      if (ch?.kind !== 'api') throw badRequest('Выберите канал типа «Внешняя система (API)»');
    }
    if (perms?.includes('inbound') && !channelId)
      throw badRequest(
        'Для права «Внешний канал» выберите канал, от имени которого ключ принимает сообщения',
      );
  }

  @Post('api-keys')
  @RequirePerm('apikeys.manage')
  async createKey(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(KeyBody, body);
    const g = generateKey();
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      await this.checkKey(tx, b.permissions, b.channelId);
      await tx.query(
        `INSERT INTO api_key (id, name, prefix, key_hash, permissions, scope_rules, channel_id, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          b.name,
          g.prefix,
          g.hash,
          b.permissions,
          b.scopeRules === null ? null : JSON.stringify(b.scopeRules),
          b.channelId ?? null,
          b.expiresAt ?? null,
          p.id,
        ],
      );
      const row = await this.key(tx, id);
      await audit(tx, p, 'create', 'api_key', id, null, row, { configChanged: false });
      // Ключ целиком — только в этом ответе.
      return { ...toApi(row), key: g.key };
    });
  }

  private async key(db: Db, id: string) {
    const r = await one(
      db,
      `SELECT ${KEY_COLS} FROM api_key k LEFT JOIN channel ch ON ch.id = k.channel_id
         LEFT JOIN app_user u ON u.id = k.created_by WHERE k.id = $1`,
      [id],
    );
    if (!r) throw notFound('Ключ API');
    return r;
  }

  @Patch('api-keys/:id')
  @RequirePerm('apikeys.manage')
  async patchKey(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(KeyPatch, body);
    const r = await withTx(this.ctx.pool, async (tx) => {
      const before = await one<{ permissions: string[]; channel_id: string | null; revoked_at: Date | null }>(
        tx,
        `SELECT permissions, channel_id, revoked_at FROM api_key WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!before) throw notFound('Ключ API');
      if (before.revoked_at) throw badRequest('Ключ отозван');
      await this.checkKey(
        tx,
        b.permissions ?? before.permissions,
        b.channelId !== undefined ? b.channelId : before.channel_id,
      );
      const was = await this.key(tx, id);
      await tx.query(
        `UPDATE api_key SET name = COALESCE($2, name), permissions = COALESCE($3, permissions),
           scope_rules = CASE WHEN $4 THEN $5::jsonb ELSE scope_rules END,
           channel_id = CASE WHEN $6 THEN $7::uuid ELSE channel_id END,
           expires_at = CASE WHEN $8 THEN $9::timestamptz ELSE expires_at END, updated_at = now()
         WHERE id = $1`,
        [
          id,
          b.name ?? null,
          b.permissions ?? null,
          b.scopeRules !== undefined,
          b.scopeRules ? JSON.stringify(b.scopeRules) : null,
          b.channelId !== undefined,
          b.channelId ?? null,
          b.expiresAt !== undefined,
          b.expiresAt ?? null,
        ],
      );
      const row = await this.key(tx, id);
      await audit(tx, p, 'update', 'api_key', id, was, row, { configChanged: false });
      return toApi(row);
    });
    apiKeys(this.ctx).invalidate();
    return r;
  }

  /** Отзыв необратим: ключ перестаёт работать в течение нескольких секунд на всех экземплярах api. */
  @Post('api-keys/:id/revoke')
  @RequirePerm('apikeys.manage')
  @HttpCode(200)
  async revoke(@CurrentUser() p: Principal, @Param('id') id: string) {
    const r = await withTx(this.ctx.pool, async (tx) => {
      const was = await this.key(tx, id);
      await tx.query(
        `UPDATE api_key SET is_active = false, revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE id = $1`,
        [id],
      );
      const row = await this.key(tx, id);
      await audit(tx, p, 'revoke', 'api_key', id, was, row, { configChanged: false });
      return toApi(row);
    });
    apiKeys(this.ctx).invalidate();
    return r;
  }

  // ------------------------------------------------------------------ подписки webhooks и внешние боты

  @Get('webhooks')
  @RequirePerm('webhooks.manage')
  async subs(@Query('kind') kind?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT ${SUB_COLS} FROM webhook_subscription s WHERE ($1::text IS NULL OR s.kind = $1)
        ORDER BY s.is_active DESC, s.name`,
      [kind ?? null],
    );
    return list.map((r) => toApi(r));
  }

  private async sub(db: Db, id: string) {
    if (!uuid.safeParse(id).success) throw notFound('Подписка');
    const r = await one(db, `SELECT ${SUB_COLS} FROM webhook_subscription s WHERE s.id = $1`, [id]);
    if (!r) throw notFound('Подписка');
    return r;
  }

  @Get('webhooks/:id')
  @RequirePerm('webhooks.manage')
  async getSub(@Param('id') id: string) {
    return toApi(await this.sub(this.ctx.pool, id));
  }

  private sealed(): { plain: string; sealed: string } {
    const key = this.ctx.config.SECRETS_KEY;
    if (!key) throw badRequest('Не задан SECRETS_KEY — секрет подписи нельзя сохранить');
    const plain = `whsec_${randomBytes(24).toString('base64url')}`;
    return { plain, sealed: sealSecret(plain, key) };
  }

  @Post('webhooks')
  @RequirePerm('webhooks.manage')
  async createSub(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(SubBody, body);
    const s = this.sealed();
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      await tx.query(
        `INSERT INTO webhook_subscription (id, kind, name, url, secret, event_types, channel_ids, headers, timeout_ms, bot_timeout_s, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          b.kind,
          b.name,
          b.url,
          s.sealed,
          b.kind === 'bot' ? [] : b.eventTypes,
          b.kind === 'bot' ? [] : b.channelIds,
          JSON.stringify(b.headers),
          b.timeoutMs,
          b.botTimeoutS,
          p.id,
        ],
      );
      const row = await this.sub(tx, id);
      await audit(tx, p, 'create', 'webhook_subscription', id, null, row);
      return { ...toApi(row), secret: s.plain };
    });
  }

  @Patch('webhooks/:id')
  @RequirePerm('webhooks.manage')
  async patchSub(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(SubPatch, body);
    return withTx(this.ctx.pool, async (tx) => {
      const was = await this.sub(tx, id);
      const map: [string, unknown][] = [
        ['name', b.name],
        ['url', b.url],
        ['event_types', b.eventTypes],
        ['channel_ids', b.channelIds],
        ['headers', b.headers === undefined ? undefined : JSON.stringify(b.headers)],
        ['timeout_ms', b.timeoutMs],
        ['bot_timeout_s', b.botTimeoutS],
      ];
      const set = map.filter(([, v]) => v !== undefined);
      if (set.length)
        await tx.query(
          `UPDATE webhook_subscription SET ${set.map(([c], i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
            WHERE id = $1`,
          [id, ...set.map(([, v]) => v)],
        );
      const row = await this.sub(tx, id);
      await audit(tx, p, 'update', 'webhook_subscription', id, was, row);
      return toApi(row);
    });
  }

  private async setActive(p: Principal, id: string, active: boolean) {
    return withTx(this.ctx.pool, async (tx) => {
      const was = await this.sub(tx, id);
      await tx.query(
        `UPDATE webhook_subscription SET is_active = $2, updated_at = now(),
           failures = CASE WHEN $2 THEN 0 ELSE failures END, next_probe_at = CASE WHEN $2 THEN NULL ELSE next_probe_at END
         WHERE id = $1`,
        [id, active],
      );
      const row = await this.sub(tx, id);
      await audit(tx, p, active ? 'activate' : 'deactivate', 'webhook_subscription', id, was, row);
      return toApi(row);
    });
  }

  @Post('webhooks/:id/activate')
  @RequirePerm('webhooks.manage')
  @HttpCode(200)
  activate(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.setActive(p, id, true);
  }

  /** Отключённая подписка не получает новых событий; накопленная очередь сохраняется до включения. */
  @Post('webhooks/:id/deactivate')
  @RequirePerm('webhooks.manage')
  @HttpCode(200)
  deactivate(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.setActive(p, id, false);
  }

  @Post('webhooks/:id/rotate-secret')
  @RequirePerm('webhooks.manage')
  @HttpCode(200)
  async rotate(@CurrentUser() p: Principal, @Param('id') id: string) {
    const s = this.sealed();
    return withTx(this.ctx.pool, async (tx) => {
      await this.sub(tx, id);
      await tx.query(`UPDATE webhook_subscription SET secret = $2, updated_at = now() WHERE id = $1`, [
        id,
        s.sealed,
      ]);
      await audit(tx, p, 'rotate_secret', 'webhook_subscription', id, null, null);
      return { secret: s.plain };
    });
  }

  /** Кнопка «Тест»: проверочная доставка сразу, с результатом (код ответа, ошибка, время). */
  @Post('webhooks/:id/test')
  @RequirePerm('webhooks.manage')
  @HttpCode(200)
  async test(@Param('id') id: string) {
    await this.sub(this.ctx.pool, id);
    return sendTestDelivery(this.ctx.pool, id, {
      secretsKey: this.ctx.config.SECRETS_KEY,
      baseUrl: this.ctx.config.PUBLIC_BASE_URL,
      maxBackoffS: 60,
      maxAgeH: 1,
    });
  }

  /** Журнал доставки подписки. */
  @Get('webhooks/:id/deliveries')
  @RequirePerm('webhooks.manage')
  async deliveries(@Param('id') id: string, @Query('status') status?: string) {
    await this.sub(this.ctx.pool, id);
    const list = await rows(
      this.ctx.pool,
      `SELECT id, event_id, event_type, conversation_id, status, is_test, attempts, next_attempt_at, last_status,
              last_error, duration_ms, created_at, sent_at
         FROM webhook_delivery WHERE subscription_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC LIMIT 200`,
      [id, status || null],
    );
    return list.map((r) => toApi(r));
  }

  @Get('webhooks/:id/deliveries/:deliveryId')
  @RequirePerm('webhooks.manage')
  async delivery(@Param('id') id: string, @Param('deliveryId') deliveryId: string) {
    if (!uuid.safeParse(deliveryId).success) throw notFound('Доставка');
    const r = await one(
      this.ctx.pool,
      `SELECT * FROM webhook_delivery WHERE id = $1 AND subscription_id = $2`,
      [deliveryId, id],
    );
    if (!r) throw notFound('Доставка');
    return toApi(r);
  }

  /** «Повторить сейчас»: вся очередь подписки (и неудавшиеся) или одна доставка. */
  @Post('webhooks/:id/retry')
  @RequirePerm('webhooks.manage')
  @HttpCode(200)
  async retry(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { deliveryId } = parse(z.object({ deliveryId: uuid.optional() }).strict(), body ?? {});
    await this.sub(this.ctx.pool, id);
    const n = await retryNow(this.ctx.pool, id, deliveryId);
    if (deliveryId && !n) throw new ApiError(409, 'already_sent', 'Доставка уже выполнена');
    await withTx(this.ctx.pool, (tx) =>
      audit(tx, p, 'retry', 'webhook_subscription', id, null, { deliveries: n }, { configChanged: false }),
    );
    return { requeued: n };
  }
}
