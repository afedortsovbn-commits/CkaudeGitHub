import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { newId } from '@cc/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, withTx } from '../lib/db';
import { ApiError, parse } from '../lib/errors';
import { CurrentUser, Public } from './guard';
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from './passwords';
import type { Principal } from './principal';
import { hashToken, newRefreshToken } from './tokens';

const COOKIE = 'cc_rt';
const COOKIE_PATH = '/api/v1/auth';

const LoginBody = z.object({ email: z.string().trim().min(3), password: z.string().min(1) });
const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH, `Пароль — не короче ${PASSWORD_MIN_LENGTH} символов`),
});

type Cookies = { cookies?: Record<string, string | undefined> };
type CookieReply = FastifyReply & {
  setCookie(name: string, value: string, opts: Record<string, unknown>): FastifyReply;
  clearCookie(name: string, opts: Record<string, unknown>): FastifyReply;
};

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: CookieReply,
  ) {
    const { email, password } = parse(LoginBody, body);
    const { config } = this.ctx;
    const user = await one<{
      id: string;
      full_name: string;
      password_hash: string | null;
      is_active: boolean;
      can_login: boolean;
      failed_login_attempts: number;
      locked_until: Date | null;
    }>(this.ctx.pool, 'SELECT * FROM app_user WHERE lower(email) = lower($1)', [email]);
    const invalid = new ApiError(401, 'invalid_credentials', 'Неверный email или пароль');
    if (!user || !user.is_active || !user.can_login) {
      await verifyPassword(password, null); // выравнивание времени ответа
      throw invalid;
    }
    if (user.locked_until && user.locked_until > new Date()) {
      throw new ApiError(423, 'locked', 'Вход временно заблокирован из-за неудачных попыток', {
        lockedUntil: user.locked_until,
      });
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      await withTx(this.ctx.pool, async (tx) => {
        const attempts = user.failed_login_attempts + 1;
        const lock = attempts >= config.LOGIN_MAX_ATTEMPTS;
        await tx.query(
          `UPDATE app_user SET failed_login_attempts = $2,
             locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
           WHERE id = $1`,
          [user.id, lock ? 0 : attempts, lock, config.LOGIN_LOCK_MINUTES],
        );
        await audit(
          tx,
          { id: user.id, ip: req.ip },
          lock ? 'login.locked' : 'login.failed',
          'app_user',
          user.id,
          null,
          null,
          {
            configChanged: false,
          },
        );
      });
      throw invalid;
    }
    const refresh = newRefreshToken();
    const sessionId = newId();
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('UPDATE app_user SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [
        user.id,
      ]);
      await tx.query(
        `INSERT INTO auth_session (id, user_id, refresh_hash, expires_at, user_agent, ip)
         VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6)`,
        [
          sessionId,
          user.id,
          hashToken(refresh),
          config.REFRESH_TOKEN_TTL_DAYS,
          req.headers['user-agent'] ?? null,
          req.ip,
        ],
      );
      await audit(tx, { id: user.id, ip: req.ip }, 'login.success', 'app_user', user.id, null, null, {
        configChanged: false,
      });
    });
    this.setCookie(res, refresh);
    return this.tokenResponse(user.id, sessionId);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest & Cookies, @Res({ passthrough: true }) res: CookieReply) {
    const token = req.cookies?.[COOKIE];
    if (!token) throw new ApiError(401, 'no_session', 'Сессия не найдена');
    const next = newRefreshToken();
    const session = await one<{ id: string; user_id: string }>(
      this.ctx.pool,
      `UPDATE auth_session s SET refresh_hash = $2, expires_at = now() + make_interval(days => $3)
         FROM app_user u
        WHERE s.refresh_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.id = s.user_id AND u.is_active AND u.can_login
        RETURNING s.id, s.user_id`,
      [hashToken(token), hashToken(next), this.ctx.config.REFRESH_TOKEN_TTL_DAYS],
    );
    if (!session) {
      res.clearCookie(COOKIE, { path: COOKIE_PATH });
      throw new ApiError(401, 'no_session', 'Сессия истекла, войдите снова');
    }
    this.setCookie(res, next);
    return this.tokenResponse(session.user_id, session.id);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest & Cookies, @Res({ passthrough: true }) res: CookieReply) {
    const token = req.cookies?.[COOKIE];
    if (token) {
      await this.ctx.pool.query('UPDATE auth_session SET revoked_at = now() WHERE refresh_hash = $1', [
        hashToken(token),
      ]);
      this.ctx.principals.invalidate();
    }
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @Get('me')
  me(@CurrentUser() p: Principal) {
    return {
      id: p.id,
      fullName: p.fullName,
      email: p.email,
      roles: p.roles,
      permissions: [...p.permissions].sort(),
      scope: p.scope,
    };
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(ChangePasswordBody, body);
    const u = await one<{ password_hash: string | null }>(
      this.ctx.pool,
      'SELECT password_hash FROM app_user WHERE id = $1',
      [p.id],
    );
    if (!(await verifyPassword(b.currentPassword, u?.password_hash ?? null))) {
      throw new ApiError(400, 'invalid_password', 'Текущий пароль указан неверно');
    }
    const hash = await hashPassword(b.newPassword);
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('UPDATE app_user SET password_hash = $2, updated_at = now() WHERE id = $1', [
        p.id,
        hash,
      ]);
      await tx.query(
        'UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
        [p.id, p.sessionId],
      );
      await audit(tx, p, 'password.changed', 'app_user', p.id, null, null, { configChanged: false });
    });
    this.ctx.principals.invalidate();
  }

  private setCookie(res: CookieReply, token: string): void {
    res.setCookie(COOKIE, token, {
      httpOnly: true,
      secure: this.ctx.config.COOKIE_SECURE === 'true',
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: this.ctx.config.REFRESH_TOKEN_TTL_DAYS * 86400,
    });
  }

  private async tokenResponse(userId: string, sessionId: string) {
    const accessToken = await this.ctx.tokens.signAccess({ sub: userId, sid: sessionId });
    return { accessToken, expiresIn: this.ctx.tokens.accessTtl };
  }
}
