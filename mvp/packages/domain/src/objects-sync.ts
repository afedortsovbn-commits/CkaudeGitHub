import {
  makeEvent,
  newId,
  type ObjectFeedItem,
  ObjectFeedItemSchema,
  type ObjectSyncSettings,
  ObjectSyncSettingsSchema,
} from '@cc/contracts';
import { enqueueEvent, isSealed, openSecret } from '@cc/service-kit';
import Papa from 'papaparse';
import type { Pool, PoolClient } from 'pg';
import { localDate, localTime } from './ticket-time';

/**
 * Ежедневная синхронизация справочника объектов из внешней системы заказчика (Ф13, M-ORG-06, В-42): новые объекты
 * добавляются, изменённые обновляются, исчезнувшие из выгрузки (или помеченные закрытыми) деактивируются; каждый
 * запуск — строка журнала `object_sync_run` с перечнем изменений. Синхронизируемые объекты (`source = 'sync'`)
 * вручную не правятся (api), объекты, заведённые вручную или импортом, с тем же кодом переходят под синхронизацию.
 *
 * Формат выгрузки — контракт-заглушка (описание источника от заказчика не получено): HTTP GET, JSON-массив объектов
 * (или `{items: [...]}`) либо CSV с колонками ручного импорта. Разбор — `parseObjectFeed`; при получении описания
 * меняется только он и загрузка (`fetchObjectFeed`).
 */

export const OBJECT_SYNC_SETTING = 'objects.sync';
const LOCK = 'objects-sync';
const MAX_FEED_BYTES = 50 * 1024 * 1024;
const MAX_CHANGES = 5000;
const MAX_PROBLEMS = 500;
/** Плановый запуск после ошибки повторяется не чаще раза в столько минут (до конца суток). */
const RETRY_AFTER_MIN = 60;

export interface ObjectSyncChange {
  code: string;
  name: string;
  action: 'added' | 'updated' | 'deactivated' | 'reactivated';
  /** Изменённые поля: было → стало. */
  fields?: Record<string, { from: unknown; to: unknown }>;
}

export interface ObjectSyncProblem {
  /** Номер строки выгрузки (с 1; для CSV — с учётом заголовка). */
  line?: number;
  code?: string;
  message: string;
}

export interface ObjectSyncResult {
  runId: string | null;
  status: 'ok' | 'error' | 'skipped';
  dryRun: boolean;
  /** Почему пропущено (выключено, не время, уже выполняется). */
  reason?: string;
  total: number;
  added: number;
  updated: number;
  deactivated: number;
  reactivated: number;
  skipped: number;
  error?: string;
  changes: ObjectSyncChange[];
  problems: ObjectSyncProblem[];
}

// ------------------------------------------------------------------ разбор выгрузки

/** Имена полей выгрузки: snake_case (как в CSV-импорте) и camelCase. */
const ALIASES: Record<string, string> = {
  enterpriseCode: 'enterprise_code',
  enterprise: 'enterprise_code',
  externalIds: 'external_ids',
  isActive: 'is_active',
  active: 'is_active',
};
const FALSE = new Set(['0', 'false', 'нет', 'no', 'n', 'closed', 'inactive']);

function normalize(raw: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const ext: Record<string, string> = {};
  for (const [k0, v] of Object.entries(raw)) {
    const k = ALIASES[k0] ?? k0;
    if (k === 'external_ids' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ek, ev] of Object.entries(v as Record<string, unknown>))
        if (ev !== null && ev !== undefined && String(ev).trim()) ext[ek] = String(ev).trim();
    } else if (k === 'rocketdata' || k === 'rocketdata_id' || k.startsWith('ext_')) {
      // CSV: внешний идентификатор колонкой (rocketdata или ext_<ключ>).
      const key = k.startsWith('ext_') ? k.slice(4) : 'rocketdata';
      if (v !== null && v !== undefined && String(v).trim()) ext[key] = String(v).trim();
    } else if (k === 'is_active') {
      o[k] =
        typeof v === 'boolean'
          ? v
          : !FALSE.has(
              String(v ?? '')
                .trim()
                .toLowerCase(),
            );
    } else if (k === 'address') {
      o[k] = v === null || v === undefined || String(v).trim() === '' ? null : String(v);
    } else o[k] = typeof v === 'number' ? String(v) : v;
  }
  o.external_ids = ext;
  return o;
}

/** Разбор выгрузки справочника: корректные строки и замечания по некорректным (они пропускаются). */
export function parseObjectFeed(
  body: string,
  format: 'json' | 'csv',
): { items: (ObjectFeedItem & { line: number })[]; problems: ObjectSyncProblem[] } {
  let raw: unknown[];
  let lineOf = (i: number) => i + 1;
  if (format === 'json') {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch (e) {
      throw new Error(`выгрузка — не JSON: ${String(e).slice(0, 200)}`);
    }
    const list = Array.isArray(data) ? data : (data as { items?: unknown })?.items;
    if (!Array.isArray(list))
      throw new Error('выгрузка JSON: ожидается массив объектов или {"items": [...]}');
    raw = list;
  } else {
    const parsed = Papa.parse<Record<string, string>>(body.replace(/^\uFEFF/, '').trim(), {
      header: true,
      skipEmptyLines: true,
      delimitersToGuess: [';', ',', '\t'],
      transformHeader: (h) => h.trim().toLowerCase(),
    });
    if (!parsed.meta.fields?.includes('code'))
      throw new Error('выгрузка CSV: нет колонки code (нужны code, name, address, enterprise_code)');
    raw = parsed.data;
    lineOf = (i) => i + 2;
  }
  const items: (ObjectFeedItem & { line: number })[] = [];
  const problems: ObjectSyncProblem[] = [];
  raw.forEach((r, i) => {
    const line = lineOf(i);
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      problems.push({ line, message: 'строка — не объект' });
      return;
    }
    const p = ObjectFeedItemSchema.safeParse(normalize(r as Record<string, unknown>));
    if (!p.success) {
      const code = (r as Record<string, unknown>).code;
      problems.push({
        line,
        ...(code ? { code: String(code) } : {}),
        message: p.error.issues.map((x) => `${x.path.join('.') || 'строка'}: ${x.message}`).join('; '),
      });
      return;
    }
    items.push({ ...p.data, line });
  });
  return { items, problems };
}

// ------------------------------------------------------------------ настройки и загрузка

type Db = Pool | PoolClient;

export async function objectSyncSettings(db: Db): Promise<ObjectSyncSettings> {
  const { rows } = await db.query<{ value: unknown }>(`SELECT value FROM system_setting WHERE key = $1`, [
    OBJECT_SYNC_SETTING,
  ]);
  const r = ObjectSyncSettingsSchema.safeParse(rows[0]?.value ?? {});
  return r.success ? r.data : ObjectSyncSettingsSchema.parse({});
}

/** Выгрузка из внешней системы: HTTP GET с токеном, таймаут, ограничение размера. */
export async function fetchObjectFeed(
  s: Pick<ObjectSyncSettings, 'url' | 'token'>,
  secretsKey: string | undefined,
  timeoutMs = 60_000,
): Promise<string> {
  if (!s.url) throw new Error('не задан адрес выгрузки справочника объектов');
  let token = s.token;
  if (token && isSealed(token)) {
    if (!secretsKey) throw new Error('токен выгрузки зашифрован, а SECRETS_KEY не задан');
    token = openSecret(token, secretsKey);
  }
  const res = await fetch(s.url, {
    headers: {
      accept: 'application/json, text/csv, */*',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`источник ответил HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_FEED_BYTES) throw new Error(`выгрузка больше ${MAX_FEED_BYTES / 1024 / 1024} МБ`);
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new Error(`выгрузка больше ${MAX_FEED_BYTES / 1024 / 1024} МБ`);
  return text;
}

// ------------------------------------------------------------------ сверка

interface ObjRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  enterprise_id: string;
  external_ids: Record<string, string>;
  source: string;
  is_active: boolean;
}

export interface ObjectSyncOptions {
  trigger: 'schedule' | 'manual';
  /** Проверка без изменений: результат и журнал — как у настоящего запуска. */
  dryRun?: boolean;
  userId?: string | null;
  secretsKey?: string;
  /** Подмена источника (тесты, загрузка файла); по умолчанию — fetchObjectFeed по настройкам. */
  feed?: () => Promise<string>;
  settings?: ObjectSyncSettings;
  now?: Date;
  /** Сервис-источник события config.changed. */
  source?: string;
}

const empty = (dryRun: boolean): ObjectSyncResult => ({
  runId: null,
  status: 'skipped',
  dryRun,
  total: 0,
  added: 0,
  updated: 0,
  deactivated: 0,
  reactivated: 0,
  skipped: 0,
  changes: [],
  problems: [],
});

/**
 * Один запуск синхронизации. Одновременно выполняется не больше одного (advisory lock на время всего запуска —
 * второй получает status = skipped, reason = busy). Изменения — одной транзакцией: ошибка или срабатывание защиты
 * от ошибочной выгрузки не меняют справочник. Возвращает итог (он же записан в журнал).
 */
export async function syncObjects(pool: Pool, o: ObjectSyncOptions): Promise<ObjectSyncResult> {
  const dryRun = !!o.dryRun;
  const now = o.now ?? new Date();
  const client = await pool.connect();
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [
      LOCK,
    ]);
    if (!got.rows[0]?.ok) return { ...empty(dryRun), reason: 'busy' };
    try {
      return await runLocked(client, o, dryRun, now);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK]);
    }
  } finally {
    client.release();
  }
}

async function runLocked(
  db: PoolClient,
  o: ObjectSyncOptions,
  dryRun: boolean,
  now: Date,
): Promise<ObjectSyncResult> {
  const settings = o.settings ?? (await objectSyncSettings(db));
  const tz = await timezone(db);
  const runId = newId();
  await db.query(
    `INSERT INTO object_sync_run (id, trigger, dry_run, started_by, started_at, local_date)
     VALUES ($1, $2, $3, $4, $5, $6::date)`,
    [runId, o.trigger, dryRun, o.userId ?? null, now, localDate(now, tz)],
  );
  const result: ObjectSyncResult = { ...empty(dryRun), runId, status: 'ok' };
  try {
    const body = await (o.feed ? o.feed() : fetchObjectFeed(settings, o.secretsKey));
    const { items, problems } = parseObjectFeed(body, settings.format);
    result.problems.push(...problems);
    result.total = items.length + problems.length;
    result.skipped = problems.length;
    await db.query('BEGIN');
    try {
      await reconcile(db, items, settings, result, now);
      if (!dryRun && result.changes.length)
        await enqueueEvent(
          db,
          makeEvent({
            type: 'config.changed',
            source: o.source ?? 'worker',
            data: { entity: 'service_object', id: null, action: 'sync' },
          }),
        );
      await db.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  } catch (e) {
    result.status = 'error';
    result.error = e instanceof Error ? e.message : String(e);
  }
  await db.query(
    `UPDATE object_sync_run SET finished_at = now(), status = $2, total = $3, added = $4, updated = $5,
        deactivated = $6, reactivated = $7, skipped = $8, error = $9, changes = $10, problems = $11
      WHERE id = $1`,
    [
      runId,
      result.status,
      result.total,
      result.added,
      result.updated,
      result.deactivated,
      result.reactivated,
      result.skipped,
      result.error?.slice(0, 2000) ?? null,
      JSON.stringify(result.changes.slice(0, MAX_CHANGES)),
      JSON.stringify(result.problems.slice(0, MAX_PROBLEMS)),
    ],
  );
  return result;
}

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a, Object.keys((a ?? {}) as object).sort()) ===
  JSON.stringify(b, Object.keys((b ?? {}) as object).sort());

async function reconcile(
  db: PoolClient,
  items: (ObjectFeedItem & { line: number })[],
  settings: ObjectSyncSettings,
  r: ObjectSyncResult,
  now: Date,
): Promise<void> {
  const ents = await db.query<{ id: string; code: string }>('SELECT id, code FROM enterprise');
  const entByCode = new Map(ents.rows.map((e) => [e.code.toLowerCase(), e.id]));
  const existing = await db.query<ObjRow>(
    `SELECT id, code, name, address, enterprise_id, external_ids, source, is_active FROM service_object FOR UPDATE`,
  );
  const byCode = new Map(existing.rows.map((x) => [x.code, x]));
  const seen = new Set<string>();

  for (const it of items) {
    if (seen.has(it.code)) {
      r.problems.push({
        line: it.line,
        code: it.code,
        message: 'код объекта повторяется в выгрузке — строка пропущена',
      });
      r.skipped++;
      continue;
    }
    seen.add(it.code);
    const enterpriseId = entByCode.get(it.enterprise_code.toLowerCase());
    if (!enterpriseId) {
      // Объект остаётся как есть (не деактивируется): ошибка данных, а не закрытие объекта.
      r.problems.push({
        line: it.line,
        code: it.code,
        message: `предприятие «${it.enterprise_code}» не найдено в справочнике — объект не изменён`,
      });
      r.skipped++;
      continue;
    }
    const cur = byCode.get(it.code);
    if (!cur) {
      await db.query(
        `INSERT INTO service_object (id, enterprise_id, code, name, address, external_ids, source, is_active, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'sync', $7, $8)`,
        [
          newId(),
          enterpriseId,
          it.code,
          it.name,
          it.address,
          JSON.stringify(it.external_ids),
          it.is_active,
          now,
        ],
      );
      r.added++;
      r.changes.push({ code: it.code, name: it.name, action: 'added' });
      continue;
    }
    // Внешние идентификаторы дополняются: ключи из выгрузки перекрывают, прочие (заданные до синхронизации) остаются.
    const ext = { ...(cur.external_ids ?? {}), ...it.external_ids };
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    if (cur.name !== it.name) fields.name = { from: cur.name, to: it.name };
    if ((cur.address ?? null) !== it.address) fields.address = { from: cur.address, to: it.address };
    if (cur.enterprise_id !== enterpriseId)
      fields.enterpriseId = { from: cur.enterprise_id, to: enterpriseId };
    if (!sameJson(cur.external_ids ?? {}, ext)) fields.externalIds = { from: cur.external_ids, to: ext };
    if (cur.source !== 'sync') fields.source = { from: cur.source, to: 'sync' };
    const activity = cur.is_active === it.is_active ? null : it.is_active ? 'reactivated' : 'deactivated';
    await db.query(
      `UPDATE service_object SET name = $2, address = $3, enterprise_id = $4, external_ids = $5, source = 'sync',
          is_active = $6, synced_at = $7, updated_at = CASE WHEN $8 THEN now() ELSE updated_at END
        WHERE id = $1`,
      [
        cur.id,
        it.name,
        it.address,
        enterpriseId,
        JSON.stringify(ext),
        it.is_active,
        now,
        !!activity || Object.keys(fields).length > 0,
      ],
    );
    if (Object.keys(fields).length) {
      r.updated++;
      r.changes.push({ code: it.code, name: it.name, action: 'updated', fields });
    }
    if (activity) {
      r[activity]++;
      r.changes.push({ code: it.code, name: it.name, action: activity });
    }
  }

  // Исчезнувшие из выгрузки синхронизируемые объекты деактивируются (объекты, заведённые вручную, — нет).
  const syncActive = existing.rows.filter((x) => x.source === 'sync' && x.is_active);
  const gone = syncActive.filter((x) => !seen.has(x.code));
  const closed = r.changes.filter((c) => c.action === 'deactivated').length;
  const willDeactivate = gone.length + closed;
  if (syncActive.length && !items.length)
    throw new Error('выгрузка пустая — справочник не изменён (защита от ошибочной выгрузки)');
  if (syncActive.length && willDeactivate / syncActive.length > settings.maxDeactivateShare)
    throw new Error(
      `выгрузка деактивировала бы ${willDeactivate} из ${syncActive.length} объектов — больше допустимой доли ` +
        `${Math.round(settings.maxDeactivateShare * 100)} %; справочник не изменён (проверьте источник или увеличьте долю)`,
    );
  for (const x of gone) {
    await db.query(`UPDATE service_object SET is_active = false, updated_at = now() WHERE id = $1`, [x.id]);
    r.deactivated++;
    r.changes.push({ code: x.code, name: x.name, action: 'deactivated' });
  }
}

async function timezone(db: Db): Promise<string> {
  const { rows } = await db.query<{ v: string | null }>(
    `SELECT value #>> '{}' AS v FROM system_setting WHERE key = 'system.timezone'`,
  );
  return rows[0]?.v || 'Europe/Minsk';
}

/**
 * Плановый запуск (worker, pg-boss раз в минуту): включено, адрес задан, наступило время дня по часовому поясу
 * системы, сегодня ещё не было успешного планового запуска и неуспешного — за последний час (повтор после ошибки).
 */
export async function runScheduledObjectSync(
  pool: Pool,
  o: { secretsKey?: string; now?: Date; feed?: () => Promise<string> } = {},
): Promise<ObjectSyncResult> {
  const now = o.now ?? new Date();
  const settings = await objectSyncSettings(pool);
  if (!settings.enabled || !settings.url) return { ...empty(false), reason: 'disabled' };
  const tz = await timezone(pool);
  if (localTime(now, tz) < settings.time) return { ...empty(false), reason: 'not_yet' };
  const { rows } = await pool.query(
    `SELECT 1 FROM object_sync_run
      WHERE trigger = 'schedule' AND NOT dry_run AND local_date = $1::date
        AND (status = 'ok' OR started_at > $2::timestamptz - make_interval(mins => $3))
      LIMIT 1`,
    [localDate(now, tz), now, RETRY_AFTER_MIN],
  );
  if (rows.length) return { ...empty(false), reason: 'done_today' };
  return syncObjects(pool, { trigger: 'schedule', secretsKey: o.secretsKey, settings, now, feed: o.feed });
}
