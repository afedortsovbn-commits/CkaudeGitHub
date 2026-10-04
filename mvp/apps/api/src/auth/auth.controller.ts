import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { newId } from '@cc/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mergeRoleUi } from '../org/roles.controller';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, withTx } from '../lib/db';
import { ApiError, parse } from '../lib/errors';
import { CurrentUser, Public } from './guard';
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from './passwords';
import type { Principal } from '@cc/auth';
import { hashToken, newRefreshToken, newTotpSecret, otpauthUrl, verifyTotp } from '@cc/auth';
import { openSecret, sealSecret } from '@cc/service-kit';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const COOKIE = 'cc_rt';
const COOKIE_PATH = '/api/v1/auth';
/** Сколько секунд после ротации ещё принимается предыдущий refresh-токен (ответ с новым мог потеряться). */
const REFRESH_GRACE_S = 120;

const LoginBody = z.object({ email: z.string().trim().min(3), password: z.string().min(1) });
const TotpLoginBody = z.object({ mfaToken: z.string().min(10), code: z.string().trim().min(6).max(8) });
const CodeBody = z.object({ code: z.string().trim().min(6).max(8) });
const TOTP_ISSUER = 'Контакт-центр';

interface LoginUser {
  id: string;
  email: string;
  full_name: string;
  password_hash: string | null;
  is_active: boolean;
  can_login: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: string | null;
}

/** Отпечаток хэша пароля в промежуточном токене: после смены пароля токен второй ступени недействителен. */
const pwdPrint = (hash: string | null) =>
  createHash('sha256')
    .update(hash ?? '')
    .digest('base64url')
    .slice(0, 16);

/** Сотрудник с любым административным правом (admin.*) — для него 2FA может быть обязательной. */
export async function isAdminUser(db: Pool | PoolClient, userId: string): Promise<boolean> {
  const r = await one<{ a: boolean }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code, unnest(r.permissions) p
                     WHERE ur.user_id = $1 AND (p LIKE 'admin.%' OR p LIKE '%.manage' OR p = 'config.transfer')) AS a`,
    [userId],
  );
  return !!r?.a;
}

/** Обязательна ли 2FA администраторам (настройка `security.admin_2fa_required`, без перезапуска). */
export async function admin2faRequired(db: Pool | PoolClient): Promise<boolean> {
  const r = await one<{ v: unknown }>(
    db,
    `SELECT value AS v FROM system_setting WHERE key = 'security.admin_2fa_required'`,
  );
  return r?.v === true;
}

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
    const user = await one<LoginUser>(
      this.ctx.pool,
      'SELECT * FROM app_user WHERE lower(email) = lower($1)',
      [email],
    );
    const invalid = new ApiError(401, 'invalid_credentials', 'Неверный email или пароль');
    if (!user || !user.is_active || !user.can_login) {
      await verifyPassword(password, null); // выравнивание времени ответа
      throw invalid;
    }
    this.ensureNotLocked(user);
    if (!(await verifyPassword(password, user.password_hash))) {
      await this.loginFailed(user, req, 'login.failed');
      throw invalid;
    }
    // Вторая ступень (M-NFR-03): у сотрудника включена 2FA — нужен код; администратору, для которого 2FA
    // обязательна, но ещё не настроена, — выдаётся секрет, и первый верный код её включает.
    if (user.totp_enabled_at) {
      return {
        mfaRequired: true,
        mfaToken: await this.ctx.tokens.signMfa(user.id, pwdPrint(user.password_hash)),
      };
    }
    if ((await admin2faRequired(this.ctx.pool)) && (await isAdminUser(this.ctx.pool, user.id))) {
      const secret = newTotpSecret();
      await this.ctx.pool.query('UPDATE app_user SET totp_pending_secret = $2 WHERE id = $1', [
        user.id,
        sealSecret(secret, this.secretsKey),
      ]);
      return {
        mfaSetupRequired: true,
        mfaToken: await this.ctx.tokens.signMfa(user.id, pwdPrint(user.password_hash)),
        secret,
        otpauthUrl: otpauthUrl(secret, user.email, TOTP_ISSUER),
      };
    }
    return this.startSession(user.id, req, res, 'login.success');
  }

  /**
   * Демо-стенд: вход в один клик под демо-учёткой (страница /demo-login?as=<email>, ссылки «Войти» на странице
   * ссылок стенда). Пароль известен api из окружения стенда и в браузер не передаётся; дальше — обычный вход.
   */
  @Public()
  @Post('demo-login')
  @HttpCode(200)
  async demoLogin(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: CookieReply,
  ) {
    const cfg = this.ctx.config;
    if (cfg.DEMO_QUICK_LOGIN !== 'true') throw new ApiError(404, 'not_found', 'Страница не найдена');
    const { email } = parse(z.object({ email: z.string().trim().email() }).strict(), body);
    const e = email.toLowerCase();
    const password =
      e === cfg.DEMO_ADMIN_EMAIL.toLowerCase()
        ? cfg.DEMO_ADMIN_PASSWORD
        : e.endsWith('@demo.local')
          ? cfg.DEMO_PASSWORD
          : undefined;
    if (!password)
      throw new ApiError(403, 'demo_login_forbidden', 'Быстрый вход — только для демо-учёток стенда');
    return this.login({ email, password }, req, res);
  }

  /** Вход, шаг 2: код из приложения-аутентификатора (или первый код при обязательной настройке 2FA). */
  @Public()
  @Post('login/totp')
  @HttpCode(200)
  async loginTotp(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: CookieReply,
  ) {
    const b = parse(TotpLoginBody, body);
    const expired = new ApiError(401, 'mfa_expired', 'Время на ввод кода истекло — войдите снова');
    const claims = await this.ctx.tokens.verifyMfa(b.mfaToken).catch(() => null);
    if (!claims) throw expired;
    const user = await one<LoginUser>(this.ctx.pool, 'SELECT * FROM app_user WHERE id = $1', [claims.userId]);
    if (!user || !user.is_active || !user.can_login || pwdPrint(user.password_hash) !== claims.pwd)
      throw expired;
    this.ensureNotLocked(user);
    const setup = !user.totp_enabled_at;
    const sealed = setup ? user.totp_pending_secret : user.totp_secret;
    if (!sealed) throw expired;
    const step = verifyTotp(openSecret(sealed, this.secretsKey), b.code, {
      lastStep: user.totp_last_step === null ? null : Number(user.totp_last_step),
    });
    if (step === null) {
      await this.loginFailed(user, req, 'login.totp_failed');
      throw new ApiError(401, 'invalid_code', 'Неверный код подтверждения');
    }
    await this.ctx.pool.query(
      setup
        ? `UPDATE app_user SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = now(),
                  totp_last_step = $2 WHERE id = $1`
        : 'UPDATE app_user SET totp_last_step = $2 WHERE id = $1',
      [user.id, step],
    );
    return this.startSession(user.id, req, res, setup ? 'login.success_totp_enabled' : 'login.success_totp');
  }

  // ---------- 2FA: настройка сотрудником ----------

  @Get('totp')
  async totpStatus(@CurrentUser() p: Principal) {
    const u = await one<{ totp_enabled_at: Date | null }>(
      this.ctx.pool,
      'SELECT totp_enabled_at FROM app_user WHERE id = $1',
      [p.id],
    );
    return {
      enabled: !!u?.totp_enabled_at,
      enabledAt: u?.totp_enabled_at ?? null,
      required: (await admin2faRequired(this.ctx.pool)) && (await isAdminUser(this.ctx.pool, p.id)),
    };
  }

  /** Новый секрет (ожидает подтверждения кодом); включённая 2FA при этом продолжает действовать. */
  @Post('totp/setup')
  @HttpCode(200)
  async totpSetup(@CurrentUser() p: Principal) {
    const secret = newTotpSecret();
    await this.ctx.pool.query('UPDATE app_user SET totp_pending_secret = $2 WHERE id = $1', [
      p.id,
      sealSecret(secret, this.secretsKey),
    ]);
    return { secret, otpauthUrl: otpauthUrl(secret, p.email, TOTP_ISSUER) };
  }

  @Post('totp/enable')
  @HttpCode(200)
  async totpEnable(@CurrentUser() p: Principal, @Body() body: unknown) {
    const { code } = parse(CodeBody, body);
    const u = await one<{ totp_pending_secret: string | null }>(
      this.ctx.pool,
      'SELECT totp_pending_secret FROM app_user WHERE id = $1',
      [p.id],
    );
    if (!u?.totp_pending_secret) throw new ApiError(400, 'no_setup', 'Сначала получите новый секрет');
    const step = verifyTotp(openSecret(u.totp_pending_secret, this.secretsKey), code);
    if (step === null) throw new ApiError(400, 'invalid_code', 'Неверный код подтверждения');
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query(
        `UPDATE app_user SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = now(),
                totp_last_step = $2 WHERE id = $1`,
        [p.id, step],
      );
      await audit(tx, p, 'totp.enabled', 'app_user', p.id, null, null, { configChanged: false });
    });
    return this.totpStatus(p);
  }

  @Post('totp/disable')
  @HttpCode(200)
  async totpDisable(@CurrentUser() p: Principal, @Body() body: unknown) {
    const { code } = parse(CodeBody, body);
    if ((await admin2faRequired(this.ctx.pool)) && (await isAdminUser(this.ctx.pool, p.id)))
      throw new ApiError(400, 'totp_required', 'Для администраторов вход с кодом обязателен');
    const u = await one<{ totp_secret: string | null; totp_last_step: string | null }>(
      this.ctx.pool,
      'SELECT totp_secret, totp_last_step FROM app_user WHERE id = $1',
      [p.id],
    );
    if (!u?.totp_secret) return this.totpStatus(p);
    const step = verifyTotp(openSecret(u.totp_secret, this.secretsKey), code, {
      lastStep: u.totp_last_step === null ? null : Number(u.totp_last_step),
    });
    if (step === null) throw new ApiError(400, 'invalid_code', 'Неверный код подтверждения');
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query(
        `UPDATE app_user SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL,
                totp_last_step = NULL WHERE id = $1`,
        [p.id],
      );
      await audit(tx, p, 'totp.disabled', 'app_user', p.id, null, null, { configChanged: false });
    });
    return this.totpStatus(p);
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
      // Ротация при каждом обновлении. Предыдущий токен ещё REFRESH_GRACE_S принимается: ответ с новым мог не дойти
      // до браузера (смена сети, обрыв соединения при замене экземпляров) — иначе оператора выбросит на вход.
      `UPDATE auth_session s
          SET refresh_hash = $2, expires_at = now() + make_interval(days => $3),
              prev_refresh_hash = CASE WHEN s.refresh_hash = $1 THEN s.refresh_hash ELSE s.prev_refresh_hash END,
              rotated_at = CASE WHEN s.refresh_hash = $1 THEN now() ELSE s.rotated_at END
         FROM app_user u
        WHERE (s.refresh_hash = $1
               OR (s.prev_refresh_hash = $1 AND s.rotated_at > now() - make_interval(secs => $4)))
          AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.id = s.user_id AND u.is_active AND u.can_login
        RETURNING s.id, s.user_id`,
      [hashToken(token), hashToken(next), this.ctx.config.REFRESH_TOKEN_TTL_DAYS, REFRESH_GRACE_S],
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
      await this.ctx.pool.query(
        'UPDATE auth_session SET revoked_at = now() WHERE refresh_hash = $1 OR prev_refresh_hash = $1',
        [hashToken(token)],
      );
      this.ctx.principals.invalidate();
    }
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @Get('me')
  async me(@CurrentUser() p: Principal) {
    // Роли сотрудника по порядку: названия (для созданных администратором ролей) и интерфейс по умолчанию (п.1).
    const roleRows = await rows<{ code: string; name: string; ui: unknown }>(
      this.ctx.pool,
      `SELECT code, name, ui FROM role WHERE code = ANY($1) ORDER BY sort_order, name`,
      [p.roles],
    );
    return {
      id: p.id,
      fullName: p.fullName,
      email: p.email,
      roles: p.roles,
      roleNames: Object.fromEntries(roleRows.map((r) => [r.code, r.name])),
      permissions: [...p.permissions].sort(),
      scope: p.scope,
      ui: mergeRoleUi(roleRows),
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

  private get secretsKey(): string {
    return this.ctx.config.SECRETS_KEY ?? this.ctx.config.JWT_SECRET;
  }

  private ensureNotLocked(user: LoginUser): void {
    if (user.locked_until && user.locked_until > new Date()) {
      throw new ApiError(423, 'locked', 'Вход временно заблокирован из-за неудачных попыток', {
        lockedUntil: user.locked_until,
      });
    }
  }

  /** Неудачная попытка (пароль или код): счётчик и блокировка после LOGIN_MAX_ATTEMPTS, запись в аудит. */
  private async loginFailed(user: LoginUser, req: FastifyRequest, action: string): Promise<void> {
    const { config } = this.ctx;
    await withTx(this.ctx.pool, async (tx) => {
      const r = await one<{ n: number }>(
        tx,
        'SELECT failed_login_attempts AS n FROM app_user WHERE id = $1 FOR UPDATE',
        [user.id],
      );
      const attempts = (r?.n ?? 0) + 1;
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
        lock ? 'login.locked' : action,
        'app_user',
        user.id,
        null,
        null,
        {
          configChanged: false,
        },
      );
    });
  }

  private async startSession(userId: string, req: FastifyRequest, res: CookieReply, action: string) {
    const refresh = newRefreshToken();
    const sessionId = newId();
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('UPDATE app_user SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [
        userId,
      ]);
      await tx.query(
        `INSERT INTO auth_session (id, user_id, refresh_hash, expires_at, user_agent, ip)
         VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6)`,
        [
          sessionId,
          userId,
          hashToken(refresh),
          this.ctx.config.REFRESH_TOKEN_TTL_DAYS,
          req.headers['user-agent'] ?? null,
          req.ip,
        ],
      );
      await audit(tx, { id: userId, ip: req.ip }, action, 'app_user', userId, null, null, {
        configChanged: false,
      });
    });
    this.setCookie(res, refresh);
    return this.tokenResponse(userId, sessionId);
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
