import type { Pool, PoolClient } from 'pg';
import { badRequest } from '../lib/errors';
import type { Storage } from '../lib/storage';

/**
 * Экспорт/импорт конфигурации (Ф9, M-ADM-05): перенос настроек между стендами без привязки к поставщику.
 *
 * Формат — JSON: `{format, version, exportedAt, sections: {<раздел>: [строки]}}`. Строки — как в БД
 * (`to_jsonb`), обратно — `jsonb_populate_record`: типы (даты, массивы, jsonb) PostgreSQL переводит сам, а
 * столбцы, которых нет в файле (файл из прежней версии), получают значения по умолчанию, — формат совместим
 * между версиями так же, как схема БД (только добавления). Идентификаторы сохраняются: повторный импорт
 * обновляет, а не дублирует. Если в целевой системе запись с тем же естественным ключом (код, название)
 * уже есть под другим id — ссылки файла перенаправляются на неё (замена id во всём документе).
 *
 * Не переносятся: сотрудники, оргструктура и матрица, каналы, ключи API и webhooks (у каждого стенда свои
 * адреса и секреты), личные шаблоны, журналы и обращения. Секреты интеграционных операций не выгружаются —
 * после импорта их нужно ввести заново (в отчёте — предупреждение).
 */

export const CONFIG_FORMAT = 'cc-config';
export const CONFIG_VERSION = 1;

interface Section {
  key: string;
  title: string;
  table: string;
  /** Условие отбора при экспорте (алиас t). */
  where?: string;
  order: string;
  /** Столбцы естественного ключа для сопоставления с существующими записями. */
  natural?: string[];
  naturalWhere?: string;
  /** Самоссылка: при вставке сначала NULL, затем второй проход. */
  selfRef?: string;
  /** Столбцы ссылок на сотрудников — в другом стенде таких нет: при импорте — импортирующий администратор. */
  userCols?: string[];
  /** Не выгружаются (служебное состояние). */
  exclude?: string[];
  /** Ключ конфликта (по умолчанию id). */
  pk?: string;
  /** Неизменяемые строки (версии сценариев): существующие не обновляются. */
  immutable?: boolean;
}

export const SECTIONS: Section[] = [
  {
    key: 'settings',
    title: 'Настройки',
    table: 'system_setting',
    order: 'key',
    pk: 'key',
    // Источник синхронизации объектов (адрес и токен, Ф13) — свой у каждого стенда.
    where: `t.key NOT IN ('ticket.digest_last_date', 'objects.sync')`,
    exclude: ['updated_at'],
  },
  { key: 'schedules', title: 'Расписания', table: 'schedule', order: 'name', natural: ['name'] },
  { key: 'topics', title: 'Темы', table: 'topic', order: 'level, sort_order, name', exclude: ['path'] },
  {
    key: 'fields',
    title: 'Поля тем',
    table: 'field_def',
    order: 'topic_id, sort_order',
    natural: ['topic_id', 'key'],
  },
  { key: 'skills', title: 'Навыки', table: 'skill', order: 'name', natural: ['name'] },
  {
    key: 'queues',
    title: 'Очереди',
    table: 'queue',
    order: 'name',
    natural: ['name'],
    selfRef: 'overflow_queue_id',
  },
  {
    key: 'dispositions',
    title: 'Результаты обработки',
    table: 'disposition',
    order: 'sort_order, code',
    natural: ['code'],
  },
  {
    key: 'answerMethods',
    title: 'Способы ответа',
    table: 'answer_method',
    order: 'sort_order, code',
    natural: ['code'],
  },
  { key: 'tags', title: 'Теги', table: 'tag', order: 'name', natural: ['name'] },
  {
    key: 'breakReasons',
    title: 'Причины перерывов',
    table: 'break_reason',
    order: 'name',
    natural: ['name'],
  },
  {
    key: 'segmentPriority',
    title: 'Приоритеты сегментов',
    table: 'segment_priority',
    order: 'segment',
    natural: ['segment'],
  },
  { key: 'routingRules', title: 'Правила маршрутизации', table: 'routing_rule', order: 'sort_order, name' },
  {
    key: 'integrations',
    title: 'Интеграционные операции',
    table: 'integration_op',
    order: 'code',
    natural: ['code'],
  },
  {
    key: 'audio',
    title: 'Аудиобиблиотека',
    table: 'audio_file',
    order: 'created_at',
    where: 't.is_active',
    natural: ['fragment_key'],
    naturalWhere: `kind = 'fragment' AND is_active`,
    userCols: ['created_by'],
    exclude: ['storage_key'],
  },
  {
    key: 'flows',
    title: 'Сценарии IVR и боты',
    table: 'flow',
    order: 'kind, name',
    selfRef: 'published_version_id',
    userCols: ['draft_updated_by'],
  },
  {
    key: 'flowVersions',
    title: 'Версии сценариев',
    table: 'flow_version',
    order: 'flow_id, version',
    natural: ['flow_id', 'version'],
    userCols: ['created_by'],
    immutable: true,
  },
  { key: 'announcements', title: 'Объявления о сбоях', table: 'announcement', order: 'sort_order, name' },
  {
    key: 'autoReplies',
    title: 'Правила автоответов',
    table: 'auto_reply_rule',
    order: 'kind, sort_order, name',
  },
  {
    key: 'templates',
    title: 'Общие шаблоны ответов',
    table: 'reply_template',
    order: 'title',
    where: 't.owner_user_id IS NULL',
    userCols: ['created_by'],
    exclude: ['usage_count'],
  },
  {
    key: 'kbCategories',
    title: 'Рубрики базы знаний',
    table: 'kb_category',
    order: 'sort_order, name',
    selfRef: 'parent_id',
  },
  {
    key: 'kbArticles',
    title: 'Статьи базы знаний',
    table: 'kb_article',
    order: 'title',
    userCols: ['created_by', 'updated_by'],
  },
];

const COMMON_EXCLUDE = ['created_at', 'updated_at'];

export interface ConfigDocument {
  format: string;
  version: number;
  exportedAt: string;
  sections: Record<string, Record<string, unknown>[]>;
  /** Содержимое аудиофайлов: id → base64 WAV. */
  files?: Record<string, string>;
}

async function columns(db: Pool | PoolClient, table: string): Promise<Set<string>> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'NEVER'`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

export async function exportConfig(
  pool: Pool,
  storage: Storage,
  o: { includeAudio?: boolean } = {},
): Promise<ConfigDocument> {
  const sections: ConfigDocument['sections'] = {};
  for (const s of SECTIONS) {
    const cols = await columns(pool, s.table);
    const skip = new Set([...COMMON_EXCLUDE, ...(s.exclude ?? [])]);
    const { rows } = await pool.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t.*) AS row FROM ${s.table} t ${s.where ? `WHERE ${s.where}` : ''} ORDER BY ${s.order}`,
    );
    sections[s.key] = rows.map(({ row }) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) if (cols.has(k) && !skip.has(k)) out[k] = v;
      for (const u of s.userCols ?? []) if (u in out) out[u] = null;
      if (s.table === 'reply_template') out.owner_user_id = null;
      if (s.table === 'integration_op' && out.auth && typeof out.auth === 'object') {
        const auth = { ...(out.auth as Record<string, unknown>) };
        if (auth.secret) {
          delete auth.secret;
          auth.secretRemoved = true;
        }
        out.auth = auth;
      }
      return out;
    });
  }
  const files: Record<string, string> = {};
  if (o.includeAudio !== false) {
    const { rows } = await pool.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM audio_file WHERE is_active`,
    );
    for (const r of rows) {
      const obj = await storage.get(r.storage_key);
      files[r.id] = (await streamToBuffer(obj.body)).toString('base64');
    }
  }
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: new Date().toISOString(),
    sections,
    files,
  };
}

export interface ImportReport {
  dryRun: boolean;
  sections: { key: string; title: string; created: number; updated: number; unchanged: number }[];
  remapped: number;
  warnings: string[];
}

/**
 * Импорт в транзакции вызывающего: всё или ничего. dryRun — те же проверки и подсчёт, затем откат
 * (транзакцию откатывает вызывающий).
 */
export async function importConfig(
  tx: PoolClient,
  storage: Storage,
  raw: unknown,
  o: { actorId: string; dryRun: boolean },
): Promise<ImportReport> {
  const doc0 = raw as ConfigDocument;
  if (!doc0 || typeof doc0 !== 'object' || doc0.format !== CONFIG_FORMAT || typeof doc0.sections !== 'object')
    throw badRequest('Это не файл конфигурации контакт-центра');
  if (doc0.version > CONFIG_VERSION)
    throw badRequest(`Файл из более новой версии системы (формат ${doc0.version}) — обновите систему`);
  const warnings: string[] = [];

  // 1) Сопоставление по естественным ключам: id файла → id существующей записи.
  const remap = new Map<string, string>();
  for (const s of SECTIONS) {
    if (!s.natural) continue;
    for (const row of doc0.sections[s.key] ?? []) {
      const id = String(row.id);
      if (s.natural.some((c) => row[c] === null || row[c] === undefined)) continue;
      const vals = s.natural.map((c) => {
        const v = row[c];
        return typeof v === 'string' && remap.has(v) ? remap.get(v)! : v;
      });
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM ${s.table} WHERE ${s.natural.map((c, i) => `${c}::text = $${i + 1}::text`).join(' AND ')}
           ${s.naturalWhere ? `AND ${s.naturalWhere}` : ''} AND id <> $${s.natural.length + 1} LIMIT 1`,
        [...vals, id],
      );
      if (rows[0] && !(await exists(tx, s.table, id))) remap.set(id, rows[0].id);
    }
  }
  let text = JSON.stringify(doc0);
  for (const [from, to] of remap) text = text.replaceAll(from, to);
  const doc = JSON.parse(text) as ConfigDocument;

  // 2) Запись разделов в порядке зависимостей.
  const report: ImportReport['sections'] = [];
  const deferred: { table: string; col: string; id: string; value: unknown }[] = [];
  for (const s of SECTIONS) {
    const list = doc.sections[s.key] ?? [];
    const cols = await columns(tx, s.table);
    const pk = s.pk ?? 'id';
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const src of list) {
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) if (cols.has(k) && !COMMON_EXCLUDE.includes(k)) row[k] = v;
      for (const u of s.userCols ?? []) if (cols.has(u)) row[u] = o.actorId;
      if (s.table === 'reply_template') row.owner_user_id = null;
      if (s.table === 'integration_op') {
        const auth = (row.auth ?? {}) as Record<string, unknown>;
        if (auth.secretRemoved) {
          delete auth.secretRemoved;
          const prev = await tx.query<{ auth: Record<string, unknown> }>(
            `SELECT auth FROM integration_op WHERE id = $1`,
            [row.id],
          );
          const old = prev.rows[0]?.auth;
          if (old?.secret && old.type === auth.type) auth.secret = old.secret;
          else warnings.push(`Интеграция «${String(row.name)}»: введите секрет авторизации заново`);
          row.auth = auth;
        }
      }
      if (s.table === 'audio_file') {
        const content = doc.files?.[String(row.id)];
        const cur = await tx.query<{ storage_key: string }>(
          `SELECT storage_key FROM audio_file WHERE id = $1`,
          [row.id],
        );
        if (cur.rows[0]) row.storage_key = cur.rows[0].storage_key;
        else if (content) {
          row.storage_key = `ivr-audio/${String(row.id)}.wav`;
          if (!o.dryRun)
            await storage.put(String(row.storage_key), Buffer.from(content, 'base64'), 'audio/wav');
        } else {
          warnings.push(`Аудиофайл «${String(row.name)}» без содержимого — пропущен`);
          continue;
        }
      }
      if (s.selfRef && row[s.selfRef]) {
        deferred.push({ table: s.table, col: s.selfRef, id: String(row[pk]), value: row[s.selfRef] });
        row[s.selfRef] = null;
      }
      const before = await tx.query<{ j: Record<string, unknown> }>(
        `SELECT to_jsonb(t.*) AS j FROM ${s.table} t WHERE ${pk} = $1`,
        [row[pk]],
      );
      if (before.rows[0] && s.immutable) {
        unchanged++;
        continue;
      }
      const names = Object.keys(row);
      if (before.rows[0]) {
        // Самоссылку сравниваем с отложенным значением, а не с временным NULL.
        const cmp = { ...row };
        if (s.selfRef)
          cmp[s.selfRef] =
            deferred.find((d) => d.table === s.table && d.id === String(row[pk]))?.value ?? null;
        const same = Object.entries(cmp).every(
          ([k, v]) => JSON.stringify(before.rows[0]!.j[k] ?? null) === JSON.stringify(v ?? null),
        );
        if (same) {
          unchanged++;
          if (s.selfRef)
            deferred.splice(
              deferred.findIndex((d) => d.table === s.table && d.id === String(row[pk])),
              1,
            );
          continue;
        }
        updated++;
      } else created++;
      const list2 = names.map((n) => `"${n}"`).join(', ');
      const setCols = names.filter((n) => n !== pk && !(s.selfRef === n && before.rows[0]));
      await tx.query(
        `INSERT INTO ${s.table} (${list2}) SELECT ${list2} FROM jsonb_populate_record(NULL::${s.table}, $1::jsonb)
         ON CONFLICT (${pk}) DO ${
           setCols.length
             ? `UPDATE SET ${setCols.map((n) => `"${n}" = EXCLUDED."${n}"`).join(', ')}${cols.has('updated_at') ? ', updated_at = now()' : ''}`
             : 'NOTHING'
         }`,
        [JSON.stringify(row)],
      );
    }
    report.push({ key: s.key, title: s.title, created, updated, unchanged });
  }
  for (const d of deferred)
    await tx.query(`UPDATE ${d.table} SET ${d.col} = $2 WHERE id = $1`, [d.id, d.value]);
  return { dryRun: o.dryRun, sections: report, remapped: remap.size, warnings };
}

async function exists(tx: PoolClient, table: string, id: string): Promise<boolean> {
  const r = await tx.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return !!r.rowCount;
}
