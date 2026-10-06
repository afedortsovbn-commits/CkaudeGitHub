import { newId } from '@cc/contracts';
import type { Pool } from 'pg';
import { LINK_PLACEHOLDER } from './ticket-notify';

/**
 * Контроль ресурсов сервера: диск, память, подключения к БД, задержка служебных событий и отправки писем.
 * worker проверяет каждые 5 минут; при выходе за порог администраторам и супервизорам — уведомление в
 * колокольчике и письмо (важное — с высоким приоритетом), пока проблема не устранена — напоминание раз в сутки,
 * после устранения — «снова в норме». Последний замер — в `system_setting` (`resource.last`), его показывает
 * страница «Ресурсы сервера».
 */

export type ResourceLevel = 'ok' | 'warn' | 'crit';

export interface ResourceProbe {
  /** Диск, на котором Docker хранит данные (замер из контейнера worker). */
  disk?: { totalBytes: number; freeBytes: number };
  /** Память сервера (виртуальной машины), а не лимит контейнера. */
  memory?: { totalBytes: number; availableBytes: number };
}

export interface DbStats {
  connections: number;
  maxConnections: number;
  /** Сколько секунд ждёт самое старое неотправленное служебное событие (outbox); null — очередь пуста. */
  outboxOldestS: number | null;
  /** Письма, которые не удаётся отправить с нескольких попыток. */
  emailStuck: number;
}

export interface ResourceThresholds {
  warnPct: number;
  critPct: number;
}

export interface ResourceSample {
  key: 'disk' | 'memory' | 'db_connections' | 'outbox' | 'email';
  level: ResourceLevel;
  /** Занято, % (для очередей — null). */
  usedPct: number | null;
  detail: string;
}

export const RESOURCE_LABEL: Record<ResourceSample['key'], string> = {
  disk: 'Место на диске',
  memory: 'Оперативная память',
  db_connections: 'Подключения к базе данных',
  outbox: 'Доставка служебных событий',
  email: 'Отправка писем',
};

const ADVICE: Record<ResourceSample['key'], string> = {
  disk: 'освободить место (старые образы Docker — docker image prune, журналы) или увеличить диск сервера.',
  memory:
    'посмотреть, какой сервис занимает память (docker stats), при необходимости перезапустить его или добавить серверу памяти.',
  db_connections:
    'проверить число экземпляров сервисов и долгие запросы; при необходимости увеличить max_connections PostgreSQL.',
  outbox:
    'проверить шину событий NATS и worker (docker ps, журналы worker): сообщения клиентам и уведомления задерживаются.',
  email: 'проверить почтовый сервер (SMTP_HOST и доступ к нему): письма сотрудникам не уходят.',
};

/** Пороги для очередей: событие ждёт дольше 5 мин — внимание, 30 мин — критично. */
const OUTBOX_WARN_S = 300;
const OUTBOX_CRIT_S = 1800;
const EMAIL_CRIT = 20;
/** Пока проблема не устранена — напоминание не чаще раза в сутки. */
const REMIND_MS = 24 * 3600_000;

const RANK: Record<ResourceLevel, number> = { ok: 0, warn: 1, crit: 2 };
const gb = (b: number) => (b / 1024 ** 3).toFixed(1).replace('.', ',');
const byPct = (pct: number, th: ResourceThresholds): ResourceLevel =>
  pct >= th.critPct ? 'crit' : pct >= th.warnPct ? 'warn' : 'ok';

/** Оценка замера по порогам (без обращения к БД — проверяется unit-тестами). */
export function evaluateResources(
  probe: ResourceProbe,
  db: DbStats,
  th: ResourceThresholds,
): ResourceSample[] {
  const out: ResourceSample[] = [];
  if (probe.disk && probe.disk.totalBytes > 0) {
    const pct = Math.round((1 - probe.disk.freeBytes / probe.disk.totalBytes) * 100);
    out.push({
      key: 'disk',
      level: byPct(pct, th),
      usedPct: pct,
      detail: `занято ${pct}%, свободно ${gb(probe.disk.freeBytes)} ГБ из ${gb(probe.disk.totalBytes)} ГБ`,
    });
  }
  if (probe.memory && probe.memory.totalBytes > 0) {
    const pct = Math.round((1 - probe.memory.availableBytes / probe.memory.totalBytes) * 100);
    out.push({
      key: 'memory',
      level: byPct(pct, th),
      usedPct: pct,
      detail: `занято ${pct}%, свободно ${gb(probe.memory.availableBytes)} ГБ из ${gb(probe.memory.totalBytes)} ГБ`,
    });
  }
  if (db.maxConnections > 0) {
    const pct = Math.round((db.connections / db.maxConnections) * 100);
    out.push({
      key: 'db_connections',
      level: byPct(pct, th),
      usedPct: pct,
      detail: `${db.connections} из ${db.maxConnections}`,
    });
  }
  const age = db.outboxOldestS;
  out.push({
    key: 'outbox',
    level: age === null ? 'ok' : age >= OUTBOX_CRIT_S ? 'crit' : age >= OUTBOX_WARN_S ? 'warn' : 'ok',
    usedPct: null,
    detail:
      age === null || age < 60
        ? 'события уходят без задержки'
        : `самое старое неотправленное событие ждёт ${Math.round(age / 60)} мин`,
  });
  out.push({
    key: 'email',
    level: db.emailStuck >= EMAIL_CRIT ? 'crit' : db.emailStuck > 0 ? 'warn' : 'ok',
    usedPct: null,
    detail: db.emailStuck ? `не удаётся отправить писем: ${db.emailStuck}` : 'письма уходят',
  });
  return out;
}

export interface ResourceState {
  [key: string]: { level: ResourceLevel; notifiedAt?: string };
}

export type AlertKind = 'worse' | 'reminder' | 'recovered';

/** Кому и о чём сообщать по сравнению с прошлым замером (без обращения к БД). */
export function resourceAlerts(
  samples: ResourceSample[],
  prev: ResourceState,
  now: Date,
): { alerts: { sample: ResourceSample; kind: AlertKind }[]; state: ResourceState } {
  const alerts: { sample: ResourceSample; kind: AlertKind }[] = [];
  const state: ResourceState = { ...prev };
  for (const s of samples) {
    const p = prev[s.key] ?? { level: 'ok' as ResourceLevel };
    let kind: AlertKind | null = null;
    if (RANK[s.level] > RANK[p.level]) kind = 'worse';
    else if (s.level !== 'ok' && s.level === p.level) {
      const last = p.notifiedAt ? Date.parse(p.notifiedAt) : 0;
      if (now.getTime() - last >= REMIND_MS) kind = 'reminder';
    } else if (s.level === 'ok' && p.level !== 'ok') kind = 'recovered';
    if (kind) alerts.push({ sample: s, kind });
    state[s.key] = { level: s.level, notifiedAt: kind ? now.toISOString() : p.notifiedAt };
  }
  return { alerts, state };
}

/** Права, по которым сотрудник получает уведомления о ресурсах: администраторы и супервизоры. */
export const RESOURCE_RECIPIENT_PERMS = [
  'admin.settings',
  'settings.manage',
  'admin.users',
  'supervisor.monitor',
];

async function setting<T>(pool: Pool, key: string): Promise<T | null> {
  const r = await pool.query<{ value: T }>('SELECT value FROM system_setting WHERE key = $1', [key]);
  return r.rows[0]?.value ?? null;
}

export async function resourceThresholds(pool: Pool): Promise<ResourceThresholds> {
  const warn = Number(await setting(pool, 'resource.warn_pct')) || 80;
  const crit = Number(await setting(pool, 'resource.crit_pct')) || 90;
  return { warnPct: Math.min(warn, crit), critPct: Math.max(warn, crit) };
}

/** Замер, оценка, уведомления; возвращает замер и число созданных уведомлений. */
export async function runResourceCheck(
  pool: Pool,
  probe: ResourceProbe,
  now = new Date(),
): Promise<{ samples: ResourceSample[]; notified: number }> {
  const th = await resourceThresholds(pool);
  const st = await pool.query<{ connections: number; max: number; oldest: number | null; stuck: number }>(
    `SELECT (SELECT count(*)::int FROM pg_stat_activity) AS connections,
            current_setting('max_connections')::int AS max,
            (SELECT extract(epoch FROM $1::timestamptz - min(created_at))::int FROM outbox WHERE published_at IS NULL) AS oldest,
            (SELECT count(*)::int FROM notification
              WHERE channel = 'email' AND (status = 'failed' AND created_at > $1::timestamptz - interval '1 day'
                                           OR status = 'pending' AND attempts >= 3)) AS stuck`,
    [now],
  );
  const r = st.rows[0]!;
  const samples = evaluateResources(
    probe,
    { connections: r.connections, maxConnections: r.max, outboxOldestS: r.oldest, emailStuck: r.stuck },
    th,
  );
  const client = await pool.connect();
  let notified = 0;
  try {
    await client.query('BEGIN');
    // Один проверяющий за раз (несколько экземпляров worker).
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('resource.check')) AS ok`,
    );
    if (!lock.rows[0]!.ok) {
      await client.query('ROLLBACK');
      return { samples, notified: 0 };
    }
    const prevRow = await client.query<{ value: ResourceState }>(
      `SELECT value FROM system_setting WHERE key = 'resource.state' FOR UPDATE`,
    );
    const { alerts, state } = resourceAlerts(samples, prevRow.rows[0]?.value ?? {}, now);
    if (alerts.length) {
      const users = await client.query<{ id: string }>(
        `SELECT u.id FROM app_user u
          WHERE u.is_active AND u.can_login AND EXISTS (
            SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
             WHERE ur.user_id = u.id AND r.permissions && $1::text[])`,
        [RESOURCE_RECIPIENT_PERMS],
      );
      for (const a of alerts) {
        const { subject, body, high } = resourceMessage(a.sample, a.kind, th);
        const base = `resource:${a.sample.key}:${a.sample.level}:${a.kind}:${now.toISOString()}`;
        const data = JSON.stringify({
          priority: high ? 'high' : 'normal',
          path: '/resources',
          resource: a.sample.key,
          level: a.sample.level,
        });
        for (const u of users.rows)
          for (const channel of ['ui', 'email'] as const) {
            const ins = await client.query(
              `INSERT INTO notification (id, user_id, kind, channel, dedupe_key, subject, body, data, status, sent_at)
               VALUES ($1, $2, 'resource', $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (dedupe_key) DO NOTHING`,
              [
                newId(),
                u.id,
                channel,
                `${base}:${channel}:${u.id}`,
                channel === 'ui' ? subject.replace(/^Важно! /, '') : subject,
                body,
                data,
                channel === 'ui' ? 'sent' : 'pending',
                channel === 'ui' ? now : null,
              ],
            );
            notified += ins.rowCount ?? 0;
          }
      }
    }
    await client.query(
      `INSERT INTO system_setting (key, value) VALUES ('resource.state', $1), ('resource.last', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(state), JSON.stringify({ at: now.toISOString(), thresholds: th, samples })],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { samples, notified };
}

export function resourceMessage(
  s: ResourceSample,
  kind: AlertKind,
  th: ResourceThresholds,
): { subject: string; body: string; high: boolean } {
  const label = RESOURCE_LABEL[s.key];
  if (kind === 'recovered')
    return {
      subject: `Ресурсы сервера: ${label} — снова в норме`,
      body: `${label}: ${s.detail}.\n\nСтраница «Ресурсы сервера»: ${LINK_PLACEHOLDER}/resources`,
      high: false,
    };
  const crit = s.level === 'crit';
  const what = crit ? 'критично' : 'внимание';
  const pct = s.usedPct !== null ? ` (${s.usedPct}%)` : '';
  const again = kind === 'reminder' ? ' — проблема не устранена' : '';
  return {
    subject: `${crit ? 'Важно! ' : ''}Ресурсы сервера: ${label} — ${what}${pct}${again}`,
    body:
      `${label}: ${s.detail}.\n` +
      (s.usedPct !== null ? `Пороги: «внимание» — ${th.warnPct}%, «критично» — ${th.critPct}%.\n` : '') +
      `\nЧто сделать: ${ADVICE[s.key]}\n\nСтраница «Ресурсы сервера»: ${LINK_PLACEHOLDER}/resources`,
    high: crit,
  };
}

/** Чистка служебной очереди: отправленные события старше `days` дней (журнал `event` не трогается). */
export async function pruneOutbox(pool: Pool, days = 30, batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await pool.query(
      `DELETE FROM outbox WHERE id IN (
         SELECT id FROM outbox WHERE published_at IS NOT NULL AND published_at < now() - make_interval(days => $1)
          LIMIT $2)`,
      [days, batch],
    );
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < batch) return total;
  }
}
