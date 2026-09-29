import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import {
  CONVERSATION_EVENTS,
  ExtBotMessageSchema,
  ExtConversationPatchSchema,
  ExtHandoffSchema,
  type ExtInbound,
  ExtInboundSchema,
  inboundSubject,
  type InboundMessage,
  newId,
  normalizePhone,
} from '@cc/contracts';
import { scopeFilter } from '@cc/auth';
import {
  afterInbound,
  appendMessage,
  emitConversation,
  externalBotHandoff,
  externalBotReply,
  ingestInbound,
  loadRef,
} from '@cc/domain';
import type { FastifyReply } from 'fastify';
import { headers } from 'nats';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';
import { ApiKeyAuth, CurrentKey, type KeyPrincipal, RequireKeyPerm } from './api-key';

const SCOPE_COLS = {
  enterprise: 'c.enterprise_id',
  department: 'c.department_id',
  topicPath: 'c.topic_path',
};
const uuid = z.string().uuid();

const ListQuery = z
  .object({
    status: z.enum(['open', 'closed', 'bot', 'all']).default('all'),
    channelId: uuid.optional(),
    updatedSince: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const CONV_SQL = `SELECT c.id, c.status, c.channel_id, c.channel_kind, c.contact_id, c.queue_id, c.assignee_id,
    u.full_name AS assignee_name, c.topic_id, t.name AS topic_name, c.enterprise_id, c.department_id,
    c.is_important, c.fields, d.name AS disposition, c.created_at, c.updated_at, c.closed_at,
    COALESCE((SELECT array_agg(tg.name ORDER BY tg.name) FROM conversation_tag ct JOIN tag tg ON tg.id = ct.tag_id
              WHERE ct.conversation_id = c.id), '{}') AS tags
  FROM conversation c
  LEFT JOIN app_user u ON u.id = c.assignee_id
  LEFT JOIN topic t ON t.id = c.topic_id
  LEFT JOIN disposition d ON d.id = c.disposition_id`;

/**
 * Публичный REST API (Ф9, M-INT-01) для внешних систем: вход по ключу API, права и область видимости ключа.
 * Чтение обращений и сообщений, запись результатов анализа (M-AI-03), ответы внешнего бота (Bot Gateway,
 * M-AI-02), приём сообщений сторонней системы как обращений (внешний канал, M-CH-09). Описание — OpenAPI
 * (`GET /api/v1/openapi.json`), страница документации — «Администрирование → Документация API».
 */
@Controller('api/v1/ext')
@ApiKeyAuth()
export class ExtController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Обращение в области видимости ключа; иначе 404 (как для сотрудника). */
  private async visible(k: KeyPrincipal, id: string, db: Pool | PoolClient = this.ctx.pool, lock = false) {
    if (!uuid.safeParse(id).success) throw notFound('Обращение');
    const sc = scopeFilter(k.scope, SCOPE_COLS, 2);
    const c = await one<{ id: string; channel_kind: string; status: string }>(
      db,
      `SELECT c.id, c.channel_kind, c.status FROM conversation c WHERE c.id = $1 AND ${sc.sql} ${lock ? 'FOR UPDATE' : ''}`,
      [id, ...sc.params],
    );
    if (!c) throw notFound('Обращение');
    return c;
  }

  @Get('me')
  me(@CurrentKey() k: KeyPrincipal) {
    return {
      keyId: k.keyId,
      name: k.name,
      permissions: [...k.permissions].sort(),
      channelId: k.channelId,
      scope: k.scope.all ? 'all' : k.scope.rules,
    };
  }

  // ------------------------------------------------------------------ чтение

  @Get('conversations')
  @RequireKeyPerm('conversations.read')
  async list(@CurrentKey() k: KeyPrincipal, @Query() query: Record<string, string>) {
    const q = parse(ListQuery, query);
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status === 'open') where.push(`c.status NOT IN ('closed', 'bot')`);
    if (q.status === 'closed') where.push(`c.status = 'closed'`);
    if (q.status === 'bot') where.push(`c.status = 'bot'`);
    if (q.channelId) add('c.channel_id = ?', q.channelId);
    if (q.updatedSince) add('c.updated_at > ?', q.updatedSince);
    const sc = scopeFilter(k.scope, SCOPE_COLS, params.length + 1);
    where.push(sc.sql);
    params.push(...sc.params);
    const list = await rows(
      this.ctx.pool,
      `${CONV_SQL} WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC LIMIT ${q.limit}`,
      params,
    );
    return list.map((r) => toApi(r));
  }

  @Get('conversations/:id')
  @RequireKeyPerm('conversations.read')
  async get(@CurrentKey() k: KeyPrincipal, @Param('id') id: string) {
    await this.visible(k, id);
    const c = await one(this.ctx.pool, `${CONV_SQL} WHERE c.id = $1`, [id]);
    const contact = await one(
      this.ctx.pool,
      `SELECT id, display_name AS name, phone, email, segment FROM contact WHERE id = $1`,
      [c!.contact_id],
    );
    const recordings = await rows(
      this.ctx.pool,
      `SELECT r.id, r.call_id, r.created_at FROM call_recording r
        WHERE r.conversation_id = $1 AND r.status = 'uploaded' ORDER BY r.created_at`,
      [id],
    );
    return { ...toApi(c!), contact: toApi(contact!), recordings: recordings.map((r) => toApi(r)) };
  }

  @Get('conversations/:id/messages')
  @RequireKeyPerm('conversations.read')
  async messages(
    @CurrentKey() k: KeyPrincipal,
    @Param('id') id: string,
    @Query('includeNotes') includeNotes?: string,
  ) {
    await this.visible(k, id);
    const list = await rows(
      this.ctx.pool,
      `SELECT m.id, m.seq, m.direction, m.body AS text, m.attachments, m.sent_at, m.meta,
              u.full_name AS author_name, m.delivery_status
         FROM message m LEFT JOIN app_user u ON u.id = m.author_user_id
        WHERE m.conversation_id = $1 AND ($2 OR m.direction <> 'note') ORDER BY m.sent_at, m.seq`,
      [id, includeNotes === 'true'],
    );
    return list.map((r) => toApi(r));
  }

  @Get('contacts/:id')
  @RequireKeyPerm('conversations.read')
  async contact(@CurrentKey() k: KeyPrincipal, @Param('id') id: string) {
    if (!uuid.safeParse(id).success) throw notFound('Клиент');
    const sc = scopeFilter(k.scope, SCOPE_COLS, 2);
    const c = await one(
      this.ctx.pool,
      `SELECT ct.id, ct.display_name AS name, ct.phone, ct.email, ct.segment FROM contact ct
        WHERE ct.id = $1 AND EXISTS (SELECT 1 FROM conversation c WHERE c.contact_id = ct.id AND ${sc.sql})`,
      [id, ...sc.params],
    );
    if (!c) throw notFound('Клиент');
    const ids = await rows(
      this.ctx.pool,
      `SELECT kind, value FROM contact_identity WHERE contact_id = $1 AND kind NOT IN ('webchat', 'app') ORDER BY created_at`,
      [id],
    );
    return { ...toApi(c), identities: ids };
  }

  /** Запись разговора для внешнего анализатора (событие recording.ready); скачивание — в журнал аудита. */
  @Get('recordings/:id')
  @RequireKeyPerm('conversations.read')
  async recording(@CurrentKey() k: KeyPrincipal, @Param('id') id: string, @Res() reply: FastifyReply) {
    if (!uuid.safeParse(id).success) throw notFound('Запись');
    const r = await one<{ conversation_id: string; storage_key: string | null; status: string }>(
      this.ctx.pool,
      `SELECT conversation_id, storage_key, status FROM call_recording WHERE id = $1`,
      [id],
    );
    if (!r) throw notFound('Запись');
    await this.visible(k, r.conversation_id);
    if (r.status !== 'uploaded' || !r.storage_key)
      throw new ApiError(409, 'not_ready', 'Запись ещё обрабатывается');
    await withTx(this.ctx.pool, (tx) =>
      audit(
        tx,
        null,
        'recording.download_api',
        'call_recording',
        id,
        null,
        { apiKey: k.name, ip: k.ip },
        {
          configChanged: false,
        },
      ),
    );
    const obj = await this.ctx.storage.get(r.storage_key);
    reply.header('content-type', 'audio/wav').header('x-content-type-options', 'nosniff');
    if (obj.length) reply.header('content-length', obj.length);
    return reply.send(obj.body);
  }

  // ------------------------------------------------------------------ результаты анализа (M-AI-03)

  /** Поля (объединение), теги (по названию), внутренняя заметка оператору — одной транзакцией. */
  @Patch('conversations/:id')
  @RequireKeyPerm('conversations.write')
  async patch(@CurrentKey() k: KeyPrincipal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ExtConversationPatchSchema, body);
    await withTx(this.ctx.pool, async (tx) => {
      const c = await this.visible(k, id, tx, true);
      if (b.fields) {
        const set = Object.fromEntries(Object.entries(b.fields).filter(([, v]) => v !== null));
        const drop = Object.entries(b.fields)
          .filter(([, v]) => v === null)
          .map(([key]) => key);
        await tx.query(
          `UPDATE conversation SET fields = (fields - $3::text[]) || $2::jsonb, version = version + 1, updated_at = now()
            WHERE id = $1`,
          [id, JSON.stringify(set), drop],
        );
      }
      if (b.addTags?.length) {
        const tags = await rows<{ id: string; name: string }>(
          tx,
          `SELECT id, name FROM tag WHERE is_active AND lower(name) = ANY ($1)`,
          [b.addTags.map((x) => x.toLowerCase())],
        );
        const missing = b.addTags.filter((x) => !tags.some((t) => t.name.toLowerCase() === x.toLowerCase()));
        if (missing.length) throw badRequest(`Нет таких тегов: ${missing.join(', ')}`);
        for (const t of tags)
          await tx.query(`INSERT INTO conversation_tag VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, t.id]);
      }
      if (b.note)
        await appendMessage(tx, {
          conversationId: id,
          direction: 'note',
          body: b.note,
          channelKind: c.channel_kind,
          meta: { external: k.name },
        });
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, id), {
        action: 'external_update',
        source: k.name,
      });
    });
    return this.get(k, id);
  }

  @Post('conversations/:id/notes')
  @RequireKeyPerm('conversations.write')
  async note(@CurrentKey() k: KeyPrincipal, @Param('id') id: string, @Body() body: unknown) {
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(10000) }).strict(), body);
    return withTx(this.ctx.pool, async (tx) => {
      const c = await this.visible(k, id, tx, true);
      return appendMessage(tx, {
        conversationId: id,
        direction: 'note',
        body: text,
        channelKind: c.channel_kind,
        meta: { external: k.name },
      });
    });
  }

  // ------------------------------------------------------------------ Bot Gateway (M-AI-02)

  @Post('conversations/:id/messages')
  @RequireKeyPerm('bot.reply')
  async botMessage(@CurrentKey() k: KeyPrincipal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ExtBotMessageSchema, body);
    return withTx(this.ctx.pool, async (tx) => {
      await this.visible(k, id, tx);
      return externalBotReply(tx, id, b, k.name);
    });
  }

  @Post('conversations/:id/handoff')
  @HttpCode(200)
  @RequireKeyPerm('bot.reply')
  async handoff(@CurrentKey() k: KeyPrincipal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ExtHandoffSchema, body);
    await withTx(this.ctx.pool, async (tx) => {
      await this.visible(k, id, tx);
      await externalBotHandoff(tx, id, b, k.name);
    });
    return { ok: true };
  }

  // ------------------------------------------------------------------ внешний канал (M-CH-09)

  /**
   * Сообщение сторонней системы (форма сайта, CRM…) становится обращением канала ключа: клиент узнаётся по
   * телефону/email (как в других каналах) или по идентификатору в сторонней системе; повтор с тем же
   * externalId не создаёт дубля. Ответы операторов сторонняя система получает событием message.created.
   */
  @Post('inbound')
  @HttpCode(202)
  @RequireKeyPerm('inbound')
  async inbound(@CurrentKey() k: KeyPrincipal, @Body() body: unknown) {
    const b = parse(ExtInboundSchema, body);
    if (!k.channelId) throw badRequest('Ключу не назначен внешний канал');
    const ch = await one<{ id: string; kind: string; is_active: boolean }>(
      this.ctx.pool,
      `SELECT id, kind, is_active FROM channel WHERE id = $1`,
      [k.channelId],
    );
    if (!ch?.is_active || ch.kind !== 'api')
      throw new ApiError(409, 'channel_inactive', 'Внешний канал отключён');
    const msg = inboundOf(ch.id, b);
    if (!this.ctx.js) {
      // Без NATS (интеграционные тесты api) — обработка сразу, как это сделал бы worker.
      const r = await withTx(this.ctx.pool, async (tx) => {
        const x = await ingestInbound(tx, msg);
        if (!x.duplicate)
          await afterInbound(tx, { conversationId: x.conversationId, created: x.created, body: msg.body });
        return x;
      });
      return { accepted: true, id: msg.id, conversationId: r.conversationId, duplicate: r.duplicate };
    }
    const h = headers();
    h.set('Nats-Msg-Id', `api:${msg.externalId}`);
    await this.ctx.js.publish(inboundSubject('api'), JSON.stringify(msg), {
      msgID: `api:${msg.externalId}`,
      headers: h,
      timeout: 5000,
    });
    return { accepted: true, id: msg.id };
  }
}

/** Входящее внешнего канала: идентификатор сообщения и клиента — в пространстве канала. */
export function inboundOf(channelId: string, b: ExtInbound): InboundMessage {
  const phone = b.contact.phone ? normalizePhone(b.contact.phone) : null;
  if (b.contact.phone && !phone) throw badRequest('Не удалось распознать номер телефона');
  const identity = phone
    ? { kind: 'phone' as const, value: phone }
    : b.contact.email
      ? { kind: 'email' as const, value: b.contact.email.toLowerCase() }
      : { kind: 'other' as const, value: `${channelId}:${b.contact.externalId}` };
  return {
    id: newId(),
    channelId,
    channelKind: 'api',
    externalId: `${channelId}:${b.externalId}`,
    identity,
    contact: {
      ...(b.contact.name ? { displayName: b.contact.name } : {}),
      ...(phone ? { phone } : {}),
      ...(b.contact.email ? { email: b.contact.email } : {}),
    },
    body: b.text,
    attachments: [],
    receivedAt: Date.now(),
    ...(b.fields ? { meta: { fields: b.fields } } : {}),
  };
}
