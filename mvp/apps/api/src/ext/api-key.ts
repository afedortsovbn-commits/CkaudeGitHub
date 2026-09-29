import { createHash, randomBytes } from 'node:crypto';
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { API_KEY_PREFIX } from '@cc/contracts';
import type { ScopeRule, ScopeSubject } from '@cc/auth';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ApiError } from '../lib/errors';

/**
 * Ключи публичного API (Ф9, M-INT-01): `cck_<случайные 32 байта>`; в БД — только SHA-256 и начало ключа.
 * Ключ — не сотрудник: у него свои права (API_KEY_PERMISSIONS) и область видимости (правила как у сотрудника).
 */
export interface KeyPrincipal {
  keyId: string;
  name: string;
  permissions: Set<string>;
  scope: ScopeSubject;
  channelId: string | null;
  ip?: string;
}

const EXT = 'cc:ext';
const KEY_PERMS = 'cc:key-perms';
/** Эндпоинт публичного API: вход только по ключу API (заголовок Authorization: Bearer cck_… или X-API-Key). */
export const ApiKeyAuth = () => SetMetadata(EXT, true);
export const RequireKeyPerm = (...perms: string[]) => SetMetadata(KEY_PERMS, perms);
export const EXT_METADATA = EXT;
export const KEY_PERMS_METADATA = KEY_PERMS;

type Req = FastifyRequest & { apiKey?: KeyPrincipal };

export const CurrentKey = createParamDecorator((_: unknown, ctx: ExecutionContext): KeyPrincipal => {
  const k = ctx.switchToHttp().getRequest<Req>().apiKey;
  if (!k) throw new ApiError(401, 'unauthorized', 'Требуется ключ API');
  return k;
});

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function generateKey(): { key: string; prefix: string; hash: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

/** Ключ из заголовков запроса (или undefined). */
export function keyFromRequest(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith(`Bearer ${API_KEY_PREFIX}`)) return h.slice(7).trim();
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.startsWith(API_KEY_PREFIX)) return x.trim();
  return undefined;
}

interface KeyRow {
  id: string;
  name: string;
  permissions: string[];
  scope_rules: ScopeRule[] | null;
  channel_id: string | null;
}

/**
 * Проверка ключа с кэшем на несколько секунд: отзыв ключа действует почти сразу без запроса к БД на каждый
 * вызов. Время последнего использования пишется не чаще раза в минуту.
 */
export class ApiKeyStore {
  private readonly cache = new Map<string, { value: KeyRow | null; expires: number }>();
  private readonly touched = new Map<string, number>();
  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = 5000,
  ) {}

  async resolve(key: string): Promise<KeyPrincipal | null> {
    const hash = hashKey(key);
    let hit = this.cache.get(hash);
    if (!hit || hit.expires < Date.now()) {
      const { rows } = await this.pool.query<KeyRow>(
        `SELECT id, name, permissions, scope_rules, channel_id FROM api_key
          WHERE key_hash = $1 AND is_active AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        [hash],
      );
      hit = { value: rows[0] ?? null, expires: Date.now() + this.ttlMs };
      this.cache.set(hash, hit);
      if (this.cache.size > 1000) this.cache.clear();
    }
    const k = hit.value;
    if (!k) return null;
    const last = this.touched.get(k.id) ?? 0;
    if (Date.now() - last > 60_000) {
      this.touched.set(k.id, Date.now());
      void this.pool
        .query(`UPDATE api_key SET last_used_at = now() WHERE id = $1`, [k.id])
        .catch(() => undefined);
    }
    return {
      keyId: k.id,
      name: k.name,
      permissions: new Set(k.permissions),
      scope: { all: k.scope_rules === null, rules: k.scope_rules ?? [] },
      channelId: k.channel_id,
    };
  }

  invalidate(): void {
    this.cache.clear();
  }
}
