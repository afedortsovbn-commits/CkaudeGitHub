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

const PUBLIC = 'cc:public';
const PERMS = 'cc:perms';

/** Эндпоинт без аутентификации. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Требует хотя бы одно из перечисленных прав. */
export const RequirePerm = (...perms: string[]) => SetMetadata(PERMS, perms);

type Req = FastifyRequest & { principal?: Principal };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const p = ctx.switchToHttp().getRequest<Req>().principal;
  if (!p) throw new ApiError(401, 'unauthorized', 'Требуется вход');
  return p;
});

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONTEXT) private readonly ctx: AppContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest<Req>();
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
}

export function hasPerm(p: Principal, ...perms: string[]): boolean {
  return perms.some((x) => p.permissions.has(x));
}
