import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, withTx } from '../lib/db';
import { badRequest, parse } from '../lib/errors';

const KEY = 'ui.external_apps';

export interface ExternalApp {
  id: string;
  name: string;
  url: string;
  /** embed — в окне системы (iframe), tab — в новой вкладке браузера. */
  mode: 'embed' | 'tab';
  /** Коды ролей, которым показывать; пусто — всем. */
  roles: string[];
}

const AppBody = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
    name: z.string().trim().min(1, 'Укажите название приложения').max(60),
    url: z.string().trim().min(1, 'Укажите адрес приложения').max(500),
    mode: z.enum(['embed', 'tab']).default('embed'),
    roles: z.array(z.string().max(40)).max(50).default([]),
  })
  .strict();
const Body_ = z.object({ apps: z.array(AppBody).max(30) }).strict();

/** Адрес без схемы («crm.example.by») — считаем https (правило владельца: нормализовать, а не отклонять). */
export function normalizeAppUrl(raw: string): string {
  const v = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw badRequest(`Неверный адрес приложения: ${raw}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw badRequest(`Адрес должен начинаться с https://: ${raw}`);
  return u.toString();
}

export async function loadExternalApps(db: Pool | PoolClient): Promise<ExternalApp[]> {
  const r = await one<{ value: unknown }>(db, `SELECT value FROM system_setting WHERE key = $1`, [KEY]);
  return Array.isArray(r?.value) ? (r.value as ExternalApp[]) : [];
}

/** Приложения, которые видит сотрудник (по его ролям). */
export async function externalAppsFor(db: Pool | PoolClient, roles: string[]) {
  return (await loadExternalApps(db))
    .filter((a) => !a.roles?.length || a.roles.some((r) => roles.includes(r)))
    .map(({ id, name, url, mode }) => ({ id, name, url, mode }));
}

/**
 * Внешние приложения (сторонние сайты и PWA) в окне системы: администратор задаёт список, сотрудники видят их в
 * меню (группа «Приложения») по своим ролям. Хранится в системной настройке ui.external_apps.
 */
@Controller('api/v1/external-apps')
@RequirePerm('settings.manage')
export class ExternalAppsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get()
  async list() {
    const roles = await rows<{ code: string; name: string }>(
      this.ctx.pool,
      `SELECT code, name FROM role ORDER BY sort_order, name`,
    );
    return { apps: await loadExternalApps(this.ctx.pool), roles };
  }

  @Put()
  async save(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(Body_, body);
    const apps: ExternalApp[] = b.apps.map((a) => ({
      id: a.id ?? randomBytes(4).toString('hex'),
      name: a.name,
      url: normalizeAppUrl(a.url),
      mode: a.mode,
      roles: [...new Set(a.roles)],
    }));
    await withTx(this.ctx.pool, async (tx) => {
      const before = await loadExternalApps(tx);
      await tx.query(
        `INSERT INTO system_setting (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [KEY, JSON.stringify(apps)],
      );
      await audit(tx, p, 'update', 'external_apps', null, before, apps);
    });
    return this.list();
  }
}
