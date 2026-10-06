import type { Pool } from 'pg';
import { expandPermissions } from './permissions';
import type { ScopeRule, ScopeSubject } from './scope';

export const PERMISSIONS = [
  'scope.all',
  /** Видит неклассифицированные обращения (без предприятия и темы) при ограниченной области (В-52). */
  'scope.unclassified',
  'admin.users',
  'admin.directories',
  'admin.matrix',
  'admin.settings',
  'admin.audit',
  'matrix.view',
  'conversations.work',
  'tickets.work',
  'tickets.edit',
  'supervisor.monitor',
  'supervisor.approvals',
  'reports.view',
  /** Ручное слияние дублей клиентов (M-CARD-01, Ф12b). */
  'contacts.merge',
  /** Ф14 (M-TEL-10): суфлирование — супервизора слышит только оператор. */
  'calls.whisper',
  /** Ф14: вмешательство — супервизор в разговоре, его слышат оба. */
  'calls.barge',
  /** Ф14: перехват обращения (звонок или чат переходит к супервизору). */
  'conversations.takeover',
  /** Ф14: подсказка оператору в чате — скрытое сообщение, клиенту не уходит. */
  'conversations.hint',
  // Дробные права по разделам (п.1 требований): каталог — permissions.ts; admin.directories и admin.settings
  // раскрываются в них автоматически.
  'channels.manage',
  'ivr.manage',
  'bots.manage',
  'announcements.manage',
  'autoreplies.manage',
  'templates.manage',
  'kb.manage',
  'assist.manage',
  'integrations.manage',
  'org.manage',
  'objects.manage',
  'dictionaries.manage',
  'settings.manage',
  'apikeys.manage',
  'webhooks.manage',
  'config.transfer',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface Principal {
  id: string;
  sessionId: string;
  fullName: string;
  email: string;
  roles: string[];
  permissions: Set<string>;
  scope: ScopeSubject;
  ip?: string;
}

interface CacheEntry {
  value: Principal | null;
  expires: number;
}

/**
 * Загружает сотрудника, его роли, права и области. Кэш на несколько секунд: изменения прав
 * вступают в силу почти сразу без перезапуска и без запроса к БД на каждый вызов API.
 */
export class PrincipalLoader {
  private readonly cache = new Map<string, CacheEntry>();
  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = 5000,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  async load(userId: string, sessionId: string): Promise<Principal | null> {
    const key = `${userId}:${sessionId}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await this.fetch(userId, sessionId);
    this.cache.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.cache.size > 5000) this.cache.clear();
    return value;
  }

  private async fetch(userId: string, sessionId: string): Promise<Principal | null> {
    const { rows } = await this.pool.query<{
      id: string;
      full_name: string;
      email: string;
      roles: string[] | null;
      permissions: string[] | null;
      sees_unclassified: boolean | null;
    }>(
      `SELECT u.id, u.full_name, u.email, u.sees_unclassified,
              array_remove(array_agg(DISTINCT ur.role_code), NULL) AS roles,
              (SELECT array_agg(DISTINCT p) FROM user_role ur2 JOIN role r ON r.code = ur2.role_code,
                      unnest(r.permissions) p WHERE ur2.user_id = u.id) AS permissions
         FROM app_user u
         JOIN auth_session s ON s.id = $2 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()
         LEFT JOIN user_role ur ON ur.user_id = u.id
        WHERE u.id = $1 AND u.is_active AND u.can_login
        GROUP BY u.id`,
      [userId, sessionId],
    );
    const u = rows[0];
    if (!u) return null;
    const permissions = expandPermissions(u.permissions ?? []);
    const scopes = await this.pool.query<{
      enterprise_ids: string[] | null;
      department_ids: string[] | null;
      topic_ids: string[] | null;
    }>('SELECT enterprise_ids, department_ids, topic_ids FROM access_scope WHERE user_id = $1', [userId]);
    const rules: ScopeRule[] = scopes.rows.map((r) => ({
      enterpriseIds: r.enterprise_ids,
      departmentIds: r.department_ids,
      topicIds: r.topic_ids,
    }));
    return {
      id: u.id,
      sessionId,
      fullName: u.full_name,
      email: u.email,
      roles: u.roles ?? [],
      permissions,
      scope: {
        all: permissions.has('scope.all'),
        rules,
        // Отметка у сотрудника важнее роли: null — как в ролях (В-52).
        unclassified: u.sees_unclassified ?? permissions.has('scope.unclassified'),
      },
    };
  }
}
