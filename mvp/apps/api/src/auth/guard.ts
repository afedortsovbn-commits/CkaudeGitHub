import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../lib/errors';
import type { Principal } from '@cc/auth';
import { APP_CONTEXT, type AppContext } from '../context';
import {
  ApiKeyStore,
  EXT_METADATA,
  KEY_PERMS_METADATA,
  keyFromRequest,
  type KeyPrincipal,
} from '../ext/api-key';
import { RateLimiter } from '../lib/rate-limit';

const PUBLIC = 'cc:public';
const PERMS = 'cc:perms';

/** Эндпоинт без аутентификации. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Требует хотя бы одно из перечисленных прав. */
export const RequirePerm = (...perms: string[]) => SetMetadata(PERMS, perms);

type Req = FastifyRequest & { principal?: Principal; apiKey?: KeyPrincipal };

/** Общий для guard и контроллера ключей (сброс кэша при отзыве). */
export function apiKeys(ctx: AppContext): ApiKeyStore {
  ctx.apiKeys ??= new ApiKeyStore(ctx.pool);
  return ctx.apiKeys;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const p = ctx.switchToHttp().getRequest<Req>().principal;
  if (!p) throw new ApiError(401, 'unauthorized', 'Требуется вход');
  return p;
});

@Injectable()
export class AuthGuard implements CanActivate {
  /** Публичный API: не больше 500 запросов за 10 с на ключ (на экземпляр api). */
  private readonly keyLimiter = new RateLimiter(500, 10_000);
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONTEXT) private readonly ctx: AppContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest<Req>();
    if (this.reflector.getAllAndOverride<boolean>(EXT_METADATA, targets)) return this.byKey(req, targets);
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'unauthorized', 'Требуется вход');
    let claims;
    try {
      claims = await this.ctx.tokens.verifyAccess(header.slice(7));
    } catch {
      throw new ApiError(401, 'token_invalid', 'Сессия истекла, войдите снова');
    }
    const principal = await this.ctx.principals.load(claims.sub, claims.sid);
    if (!principal) throw new ApiError(401, 'session_revoked', 'Сессия завершена');
    principal.ip = req.ip;
    req.principal = principal;
    const perms = this.reflector.getAllAndOverride<string[] | undefined>(PERMS, targets);
    if (perms?.length && !perms.some((p) => principal.permissions.has(p))) {
      throw new ApiError(403, 'forbidden', 'Недостаточно прав');
    }
    return true;
  }

  /** Публичный API (Ф9): только ключ API; сессия сотрудника здесь не принимается. */
  private async byKey(req: Req, targets: Parameters<Reflector['getAllAndOverride']>[1]): Promise<boolean> {
    const key = keyFromRequest(req);
    if (!key) throw new ApiError(401, 'unauthorized', 'Требуется ключ API (Authorization: Bearer cck_…)');
    const k = await apiKeys(this.ctx).resolve(key);
    if (!k) throw new ApiError(401, 'key_invalid', 'Ключ API недействителен или отозван');
    if (!this.keyLimiter.allow(k.keyId))
      throw new ApiError(429, 'rate_limited', 'Слишком много запросов с этим ключом, повторите позже');
    k.ip = req.ip;
    req.apiKey = k;
    const perms = this.reflector.getAllAndOverride<string[] | undefined>(KEY_PERMS_METADATA, targets);
    if (perms?.length && !perms.some((p) => k.permissions.has(p)))
      throw new ApiError(403, 'forbidden', `У ключа нет права: ${perms.join(' или ')}`);
    return true;
  }
}

export function hasPerm(p: Principal, ...perms: string[]): boolean {
  return perms.some((x) => p.permissions.has(x));
}
