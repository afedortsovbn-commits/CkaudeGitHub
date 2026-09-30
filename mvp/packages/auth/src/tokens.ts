import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

export interface AccessClaims {
  sub: string;
  sid: string;
}

/** Токен клиента виджета/приложения: привязан к клиенту и каналу, без прав сотрудника. */
export interface ClientClaims {
  contactId: string;
  channelId: string;
  sessionKey: string;
}

export class TokenService {
  private readonly key: Uint8Array;
  constructor(
    secret: string,
    private readonly accessTtlSec: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  get accessTtl(): number {
    return this.accessTtlSec;
  }

  async signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setIssuer('cc-api')
      .setExpirationTime(`${this.accessTtlSec}s`)
      .sign(this.key);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'cc-api', algorithms: ['HS256'] });
    if (payload.typ !== undefined || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new Error('bad token');
    }
    return { sub: payload.sub, sid: payload.sid };
  }

  /**
   * Промежуточный токен входа со второй ступенью (TOTP): пароль проверен, сессии ещё нет. Короткий срок,
   * не принимается как токен доступа. `pwd` — отпечаток хэша пароля: смена пароля делает токен недействительным.
   */
  async signMfa(userId: string, pwd: string, ttlSec = 300): Promise<string> {
    return new SignJWT({ typ: 'mfa', pwd })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setIssuer('cc-api')
      .setExpirationTime(`${ttlSec}s`)
      .sign(this.key);
  }

  async verifyMfa(token: string): Promise<{ userId: string; pwd: string }> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'cc-api', algorithms: ['HS256'] });
    if (payload.typ !== 'mfa' || typeof payload.sub !== 'string' || typeof payload.pwd !== 'string') {
      throw new Error('bad token');
    }
    return { userId: payload.sub, pwd: payload.pwd };
  }

  async signClient(claims: ClientClaims, ttlSec = 30 * 86400): Promise<string> {
    return new SignJWT({ typ: 'client', ch: claims.channelId, sk: claims.sessionKey })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.contactId)
      .setIssuedAt()
      .setIssuer('cc-api')
      .setExpirationTime(`${ttlSec}s`)
      .sign(this.key);
  }

  async verifyClient(token: string): Promise<ClientClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'cc-api', algorithms: ['HS256'] });
    if (payload.typ !== 'client' || typeof payload.sub !== 'string' || typeof payload.ch !== 'string') {
      throw new Error('bad token');
    }
    return { contactId: payload.sub, channelId: payload.ch, sessionKey: String(payload.sk ?? '') };
  }
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
