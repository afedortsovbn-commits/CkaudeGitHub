import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { inboundSubject, type InboundMessage, newId } from '@cc/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { headers } from 'nats';
import { z } from 'zod';
import { Public } from '../auth/guard';
import { RateLimiter } from '../lib/rate-limit';
import { APP_CONTEXT, type AppContext } from '../context';
import { ownAttachments, saveUpload, sendAttachment } from '../lib/attachments';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, parse } from '../lib/errors';

interface ChannelRow {
  id: string;
  kind: string;
  name: string;
  is_active: boolean;
  config: {
    public_key?: string;
    allowed_origins?: string[];
    consent_text?: string;
    consent_version?: string;
    greeting?: string;
    max_file_mb?: number;
    app_secret?: string;
  };
}

const SessionBody = z
  .object({
    publicKey: z.string().min(1),
    consentVersion: z.string().min(1),
    consentAccepted: z.literal(true, {
      errorMap: () => ({ message: 'Необходимо согласие на обработку персональных данных' }),
    }),
    name: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(64).optional(),
    email: z.string().trim().email().max(200).optional().or(z.literal('')),
    /** Чат в приложении: идентификатор пользователя приложения, подписанный бэкендом приложения (HMAC-SHA256). */
    appUser: z.object({ id: z.string().min(1).max(200), signature: z.string().min(1) }).optional(),
  })
  .strict();
const MessageBody = z
  .object({
    clientMessageId: z.string().uuid(),
    body: z.string().max(4000).default(''),
    attachmentIds: z.array(z.string().uuid()).max(5).default([]),
  })
  .strict()
  .refine((m) => m.body.trim() || m.attachmentIds.length, 'Пустое сообщение');

export function originAllowed(channel: ChannelRow, origin: string | undefined): boolean {
  const list = channel.config.allowed_origins ?? [];
  if (list.includes('*')) return true;
  if (!origin) return channel.kind === 'app'; // WebView приложения может не передавать Origin
  return list.some((o) => o.toLowerCase() === origin.toLowerCase());
}

type ClientReq = FastifyRequest & { query: Record<string, string | undefined> };

/**
 * Открытый API клиентского чата (сайт и мобильное приложение, M-CH-03/04, REQ-INT-04).
 * Аутентификация — токен клиента (Bearer или ?t= для ссылок на файлы).
 */
@Public()
@Controller('api/v1/client')
export class ClientChatController {
  private readonly messageLimiter = new RateLimiter(20, 10_000);
  private readonly sessionLimiter = new RateLimiter(10, 60_000);

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  private async channelByKey(publicKey: string): Promise<ChannelRow> {
    const ch = await one<ChannelRow>(
      this.ctx.pool,
      `SELECT * FROM channel WHERE config ->> 'public_key' = $1 AND kind IN ('webchat', 'app')`,
      [publicKey],
    );
    if (!ch || !ch.is_active) throw new ApiError(404, 'channel_not_found', 'Чат недоступен');
    return ch;
  }

  private async auth(req: ClientReq): Promise<{ contactId: string; channel: ChannelRow }> {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : req.query.t;
    if (!token) throw new ApiError(401, 'unauthorized', 'Нет сессии чата');
    let claims;
    try {
      claims = await this.ctx.tokens.verifyClient(token);
    } catch {
      throw new ApiError(401, 'token_invalid', 'Сессия чата истекла');
    }
    const channel = await one<ChannelRow>(this.ctx.pool, 'SELECT * FROM channel WHERE id = $1', [
      claims.channelId,
    ]);
    if (!channel?.is_active) throw new ApiError(404, 'channel_not_found', 'Чат недоступен');
    if (!originAllowed(channel, req.headers.origin))
      throw new ApiError(403, 'origin', 'Чат не разрешён на этом сайте');
    return { contactId: claims.contactId, channel };
  }

  /** Публичные настройки виджета: приветствие, текст и версия согласия, лимит файлов. */
  @Get('config')
  async config(@Query('publicKey') publicKey: string, @Req() req: ClientReq) {
    const ch = await this.channelByKey(publicKey ?? '');
    if (!originAllowed(ch, req.headers.origin))
      throw new ApiError(403, 'origin', 'Чат не разрешён на этом сайте');
    return {
      name: ch.name,
      kind: ch.kind,
      greeting: ch.config.greeting ?? 'Здравствуйте! Чем можем помочь?',
      consentText: ch.config.consent_text ?? 'Я согласен(на) на обработку персональных данных.',
      consentVersion: ch.config.consent_version ?? '1',
      maxFileMb: ch.config.max_file_mb ?? this.ctx.config.MAX_UPLOAD_MB,
    };
  }

  /** Новая сессия чата: фиксируется согласие на обработку ПДн (с версией текста), выдаётся токен клиента. */
  @Post('session')
  @HttpCode(200)
  async session(@Body() body: unknown, @Req() req: ClientReq) {
    const b = parse(SessionBody, body);
    if (!this.sessionLimiter.allow(req.ip))
      throw new ApiError(429, 'rate_limited', 'Слишком много запросов, попробуйте позже');
    const ch = await this.channelByKey(b.publicKey);
    if (!originAllowed(ch, req.headers.origin))
      throw new ApiError(403, 'origin', 'Чат не разрешён на этом сайте');
    if (b.consentVersion !== (ch.config.consent_version ?? '1'))
      throw badRequest('Текст согласия изменился — обновите страницу');

    let identity: { kind: 'webchat' | 'app'; value: string };
    if (ch.kind === 'app' && b.appUser) {
      const expected = createHmac('sha256', ch.config.app_secret ?? '')
        .update(b.appUser.id)
        .digest('hex');
      const ok =
        !!ch.config.app_secret &&
        expected.length === b.appUser.signature.length &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(b.appUser.signature));
      if (!ok) throw new ApiError(401, 'app_signature', 'Подпись пользователя приложения неверна');
      identity = { kind: 'app', value: `${ch.id}:${b.appUser.id}` };
    } else {
      identity = { kind: 'webchat', value: randomBytes(16).toString('hex') };
    }

    const contactId = await withTx(this.ctx.pool, async (tx) => {
      const existing = await one<{ contact_id: string }>(
        tx,
        'SELECT contact_id FROM contact_identity WHERE kind = $1 AND value = $2',
        [identity.kind, identity.value],
      );
      let id = existing?.contact_id;
      if (!id) {
        id = newId();
        await tx.query('INSERT INTO contact (id, display_name, phone, email) VALUES ($1,$2,$3,$4)', [
          id,
          b.name || null,
          b.phone || null,
          b.email || null,
        ]);
        await tx.query('INSERT INTO contact_identity (id, contact_id, kind, value) VALUES ($1,$2,$3,$4)', [
          newId(),
          id,
          identity.kind,
          identity.value,
        ]);
        // Телефон/email из формы до диалога — дополнительные идентификаторы: узнавание клиента в других каналах.
        if (b.phone) {
          await tx.query(
            `INSERT INTO contact_identity (id, contact_id, kind, value) VALUES ($1,$2,'phone',$3) ON CONFLICT DO NOTHING`,
            [newId(), id, b.phone.replace(/[^\d+]/g, '')],
          );
        }
      }
      await tx.query(
        'INSERT INTO consent (id, contact_id, channel_id, text_version, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)',
        [newId(), id, ch.id, b.consentVersion, req.ip, req.headers['user-agent'] ?? null],
      );
      return id;
    });
    const token = await this.ctx.tokens.signClient({
      contactId,
      channelId: ch.id,
      sessionKey: identity.value,
    });
    return { token, contactId };
  }

  /** История клиента в этом канале (без внутренних заметок операторов); after — для догрузки после переподключения. */
  @Get('messages')
  async messages(@Req() req: ClientReq, @Query('after') after?: string) {
    const { contactId, channel } = await this.auth(req);
    const list = await rows(
      this.ctx.pool,
      `SELECT m.id, m.conversation_id, m.seq, m.direction, m.body, m.attachments, m.sent_at, m.external_id,
              CASE WHEN m.direction = 'out' THEN split_part(u.full_name, ' ', 2) END AS author_name
         FROM message m JOIN conversation c ON c.id = m.conversation_id
         LEFT JOIN app_user u ON u.id = m.author_user_id
        WHERE c.contact_id = $1 AND c.channel_id = $2 AND m.direction <> 'note'
          AND ($3::timestamptz IS NULL OR m.sent_at > $3)
        ORDER BY m.sent_at, m.seq LIMIT 500`,
      [contactId, channel.id, after || null],
    );
    return list.map((r) => toApi(r));
  }

  /**
   * Сообщение клиента: публикуется в поток CC_INBOUND и подтверждается клиенту только после записи
   * в JetStream (R3). Повтор с тем же clientMessageId не создаёт дубль.
   */
  @Post('messages')
  @HttpCode(202)
  async send(@Req() req: ClientReq, @Body() body: unknown) {
    const { contactId, channel } = await this.auth(req);
    const b = parse(MessageBody, body);
    if (!this.messageLimiter.allow(contactId))
      throw new ApiError(429, 'rate_limited', 'Слишком часто, подождите немного');
    const attachments = await ownAttachments(this.ctx, b.attachmentIds, { contactId });
    const ident = await one<{ kind: 'webchat' | 'app'; value: string }>(
      this.ctx.pool,
      `SELECT kind, value FROM contact_identity WHERE contact_id = $1 AND kind IN ('webchat', 'app') ORDER BY created_at LIMIT 1`,
      [contactId],
    );
    const msg: InboundMessage = {
      id: newId(),
      channelId: channel.id,
      channelKind: channel.kind as 'webchat' | 'app',
      externalId: b.clientMessageId,
      identity: ident ?? { kind: 'webchat', value: contactId },
      contactId,
      body: b.body,
      attachments,
      receivedAt: Date.now(),
    };
    if (!this.ctx.js) throw new ApiError(503, 'unavailable', 'Приём сообщений временно недоступен');
    const h = headers();
    h.set('Nats-Msg-Id', `${channel.kind}:${b.clientMessageId}`);
    await this.ctx.js.publish(inboundSubject(channel.kind), JSON.stringify(msg), {
      msgID: `${channel.kind}:${b.clientMessageId}`,
      headers: h,
      timeout: 5000,
    });
    return { accepted: true, clientMessageId: b.clientMessageId };
  }

  @Post('attachments')
  async upload(@Req() req: ClientReq) {
    const { contactId, channel } = await this.auth(req);
    return saveUpload(this.ctx, req, { contactId }, channel.config.max_file_mb);
  }

  @Get('attachments/:id')
  async download(@Req() req: ClientReq, @Param('id') id: string, @Res() reply: FastifyReply) {
    const { contactId } = await this.auth(req);
    return sendAttachment(this.ctx, id, reply, async (a) => {
      if (a.contact_id === contactId) return true;
      if (!a.conversation_id) return false;
      const c = await one(this.ctx.pool, 'SELECT 1 FROM conversation WHERE id = $1 AND contact_id = $2', [
        a.conversation_id,
        contactId,
      ]);
      return !!c;
    });
  }
}
