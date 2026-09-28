import { createHmac, randomBytes } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import {
  type CallControlCommand,
  type CallControlReply,
  callControlSubject,
  normalizePhone,
  sipUserOf,
  type SoftphoneConfig,
} from '@cc/contracts';
import { scopeFilter, type Principal } from '@cc/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser, hasPerm, Public, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';
import { RateLimiter } from '../lib/rate-limit';

const SCOPE_COLS = { enterprise: 'c.enterprise_id', department: 'c.department_id', topicPath: 'c.topic_path' };

const uuid = z.string().uuid();
const TransferBody = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('user'), userId: uuid }),
      z.object({ kind: z.literal('queue'), queueId: uuid }),
      z.object({ kind: z.literal('department'), enterpriseId: uuid, departmentId: uuid }),
    ]),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict();
const DemoBody = z
  .object({ phone: z.string().trim().max(32).optional(), name: z.string().trim().max(100).optional() })
  .strict();

/** Короткоживущие учётные данные по схеме TURN REST API: «срок:пользователь» + HMAC-SHA1 общим секретом. */
export function ephemeralCredentials(secret: string, user: string, ttlSec: number) {
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  const username = `${expires}:${user}`;
  return {
    username,
    password: createHmac('sha1', secret).update(username).digest('base64'),
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

type Req = FastifyRequest;

/**
 * Телефония для рабочего места (Ф5): учётные данные софтфона и ICE-серверы (выдаются перед входом и перед
 * каждым вызовом — 02-архитектура 8.1), управление звонком (удержание, перевод, отбой, прослушивание — через
 * активный call-control узла), журнал вызовов и записи разговоров обращения с правами доступа (M-TEL-04/05).
 */
@Controller('api/v1')
export class TelephonyController {
  private readonly demoLimiter = new RateLimiter(10, 60_000);

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  private wsUri(req: Req): string {
    return this.ctx.config.SIP_WSS_URL || `wss://${req.hostname.split(':')[0]}:${this.ctx.config.SIP_WSS_PORT}`;
  }

  private iceServers(user: string) {
    const urls = this.ctx.config.TURN_URLS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!urls.length || !this.ctx.config.TURN_SECRET) return [];
    const c = ephemeralCredentials(this.ctx.config.TURN_SECRET, user, 3600);
    return [
      { urls: urls.map((u) => u.replace(/^turns?:/, 'stun:')).filter((u) => u.startsWith('stun:')) },
      { urls, username: c.username, credential: c.password },
    ];
  }

  private secret(): string {
    if (!this.ctx.config.SIP_SECRET) throw new ApiError(503, 'telephony_off', 'Телефония не настроена');
    return this.ctx.config.SIP_SECRET;
  }

  /** Учётные данные софтфона оператора/супервизора (SIP-пароль живёт SIP_CREDENTIALS_TTL_H часов). */
  @Get('telephony/softphone')
  @RequirePerm('conversations.work', 'supervisor.monitor')
  softphone(@CurrentUser() p: Principal, @Req() req: Req) {
    const user = sipUserOf(p.id);
    const c = ephemeralCredentials(this.secret(), user, this.ctx.config.SIP_CREDENTIALS_TTL_H * 3600);
    const cfg: SoftphoneConfig = {
      wsUri: this.wsUri(req),
      sipUri: `sip:${user}@${this.ctx.config.SIP_DOMAIN}`,
      authorizationUser: c.username,
      password: c.password,
      displayName: p.fullName,
      domain: this.ctx.config.SIP_DOMAIN,
      expiresAt: c.expiresAt,
    };
    return { ...cfg, iceServers: this.iceServers(user) };
  }

  /** ICE-серверы с новыми TURN-учётными данными — перед каждым вызовом (вывод coturn из работы, 6.5). */
  @Get('telephony/ice')
  @RequirePerm('conversations.work', 'supervisor.monitor')
  ice(@CurrentUser() p: Principal) {
    return { iceServers: this.iceServers(sipUserOf(p.id)) };
  }

  /** Демо-страница «Позвонить в КЦ»: одноразовый WebRTC-абонент без SIP-транка (только демо-стенд). */
  @Public()
  @Post('telephony/demo-caller')
  @HttpCode(200)
  demoCaller(@Body() body: unknown, @Req() req: Req) {
    if (this.ctx.config.DEMO_CALLER_ENABLED !== 'true') throw notFound('Страница');
    if (!this.demoLimiter.allow(req.ip)) throw new ApiError(429, 'rate_limited', 'Слишком часто, подождите немного');
    const b = parse(DemoBody, body);
    const phone = b.phone ? normalizePhone(b.phone) : null;
    if (b.phone && !phone) throw badRequest('Некорректный номер телефона');
    const user = `demo-${phone ? phone.replace('+', '') : `anon${randomBytes(4).toString('hex')}`}`;
    const c = ephemeralCredentials(this.secret(), user, 600);
    return {
      wsUri: this.wsUri(req),
      sipUri: `sip:${user}@${this.ctx.config.SIP_DOMAIN}`,
      authorizationUser: c.username,
      password: c.password,
      displayName: b.name || 'Демо-клиент',
      domain: this.ctx.config.SIP_DOMAIN,
      did: this.ctx.config.DEMO_CALLER_DID,
      iceServers: this.iceServers(user),
    };
  }

  private async visible(p: Principal, conversationId: string): Promise<void> {
    const sc = scopeFilter(p.scope, SCOPE_COLS, 3);
    const c = await one(
      this.ctx.pool,
      `SELECT 1 FROM conversation c WHERE c.id = $1 AND (${sc.sql} OR c.assignee_id = $2)`,
      [conversationId, p.id, ...sc.params],
    );
    if (!c) throw notFound('Обращение'); // вне области — как «не существует»
  }

  /** Журнал вызовов обращения (M-TEL-05): стадии, длительности, записи. */
  @Get('conversations/:id/calls')
  @RequirePerm('conversations.work', 'supervisor.monitor')
  async calls(@CurrentUser() p: Principal, @Param('id') id: string) {
    await this.visible(p, id);
    const list = await rows(
      this.ctx.pool,
      `SELECT c.id, c.direction, c.state, c.from_number, c.to_number, c.did, c.on_hold, c.started_at,
              c.connected_at, c.ended_at, c.end_reason, u.full_name AS agent_name, c.agent_user_id,
              EXTRACT(EPOCH FROM (COALESCE(c.connected_at, c.ended_at, now()) - c.started_at))::int AS wait_s,
              CASE WHEN c.connected_at IS NULL THEN 0
                   ELSE EXTRACT(EPOCH FROM (COALESCE(c.ended_at, now()) - c.connected_at))::int END AS talk_s,
              COALESCE((SELECT json_agg(json_build_object('id', r.id, 'status', r.status, 'durationS', r.duration_s,
                          'sizeBytes', r.size_bytes) ORDER BY r.created_at)
                          FROM call_recording r WHERE r.call_id = c.id), '[]') AS recordings,
              COALESCE((SELECT json_agg(json_build_object('at', e.at, 'type', e.type, 'userName', eu.full_name,
                          'data', e.data) ORDER BY e.at)
                          FROM call_event e LEFT JOIN app_user eu ON eu.id = e.user_id WHERE e.call_id = c.id), '[]') AS events
         FROM call c LEFT JOIN app_user u ON u.id = c.agent_user_id
        WHERE c.conversation_id = $1 ORDER BY c.started_at`,
      [id],
    );
    return list.map((r) => toApi(r));
  }

  /** Запись разговора (M-TEL-04): только при доступе к обращению; каждое прослушивание — в журнал аудита. */
  @Get('recordings/:id')
  @RequirePerm('conversations.work', 'supervisor.monitor')
  async recording(@CurrentUser() p: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    const r = await one<{ conversation_id: string; storage_key: string | null; status: string }>(
      this.ctx.pool,
      `SELECT conversation_id, storage_key, status FROM call_recording WHERE id = $1`,
      [id],
    );
    if (!r) throw notFound('Запись');
    await this.visible(p, r.conversation_id);
    if (r.status !== 'uploaded' || !r.storage_key)
      throw new ApiError(409, 'not_ready', 'Запись ещё обрабатывается');
    await withTx(this.ctx.pool, (tx) =>
      audit(tx, p, 'recording.play', 'call_recording', id, null, null, { configChanged: false }),
    );
    const obj = await this.ctx.storage.get(r.storage_key);
    reply.header('content-type', 'audio/wav').header('x-content-type-options', 'nosniff');
    if (obj.length) reply.header('content-length', obj.length);
    return reply.send(obj.body);
  }

  /** Управление звонком: команда уходит активному call-control узла, на котором идёт вызов. */
  @Post('calls/:id/:op')
  @HttpCode(200)
  @RequirePerm('conversations.work', 'supervisor.monitor')
  async control(
    @CurrentUser() p: Principal,
    @Param('id') id: string,
    @Param('op') op: string,
    @Body() body: unknown,
  ) {
    const call = await one<{ node: string; conversation_id: string }>(
      this.ctx.pool,
      `SELECT node, conversation_id FROM call WHERE id = $1 AND state <> 'ended'`,
      [id],
    );
    if (!call) throw notFound('Звонок');
    await this.visible(p, call.conversation_id);
    let cmd: CallControlCommand;
    if (op === 'hold' || op === 'unhold' || op === 'hangup') cmd = { op, callId: id, userId: p.id };
    else if (op === 'transfer') cmd = { op, callId: id, userId: p.id, ...parse(TransferBody, body) };
    else if (op === 'listen') {
      if (!hasPerm(p, 'supervisor.monitor')) throw new ApiError(403, 'forbidden', 'Недостаточно прав');
      cmd = { op, callId: id, userId: p.id };
    } else throw notFound('Действие');
    if (!this.ctx.nc) throw new ApiError(503, 'call_control_down', 'Управление звонками недоступно');
    let reply: CallControlReply;
    try {
      const m = await this.ctx.nc.request(callControlSubject(call.node), JSON.stringify(cmd), { timeout: 8000 });
      reply = m.json<CallControlReply>();
    } catch {
      throw new ApiError(
        503,
        'call_control_down',
        'Управление звонками переключается — повторите через несколько секунд',
      );
    }
    if (!reply.ok) throw new ApiError(409, 'call_command', reply.error ?? 'Команда не выполнена');
    if (op === 'listen')
      await withTx(this.ctx.pool, (tx) =>
        audit(tx, p, 'call.listen', 'call', id, null, null, { configChanged: false }),
      );
    return { ok: true };
  }
}
