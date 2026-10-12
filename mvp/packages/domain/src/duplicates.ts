import type { Pool, PoolClient } from 'pg';

/**
 * Похожие обращения (Д-019): у полей темы с отметкой «проверять на повтор» (`field_def.check_duplicates`)
 * значения сравниваются с прежними обращениями той же корневой темы без учёта регистра, пробелов и знаков
 * (номер карты «2000 0116 00000» = «2000011600000»). Оператор видит предупреждение при открытии обращения; позже
 * сюда же подключится сравнение документов нейросетью.
 */
export interface DuplicateMatch {
  id: string;
  createdAt: string;
  closedAt: string | null;
  status: string;
  assigneeName: string | null;
  /** Ключи совпавших полей. */
  matched: string[];
  fields: Record<string, unknown>;
}

export interface DuplicateKey {
  key: string;
  label: string;
}

/** Нормализация значения для сравнения: строчные буквы, только буквы и цифры (латиница и кириллица). */
export const normalizeDupValue = (v: unknown): string =>
  String(v ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]/g, '');

export async function findDuplicates(
  db: Pool | PoolClient,
  conversationId: string,
): Promise<{ keys: DuplicateKey[]; matches: DuplicateMatch[] }> {
  const conv = await db.query<{
    topic_id: string | null;
    topic_path: string[];
    fields: Record<string, unknown>;
  }>(`SELECT topic_id, topic_path, fields FROM conversation WHERE id = $1`, [conversationId]);
  const c = conv.rows[0];
  if (!c?.topic_id || !c.topic_path?.length) return { keys: [], matches: [] };
  const defs = await db.query<DuplicateKey>(
    `SELECT f.key, f.label FROM topic t JOIN field_def f ON f.topic_id = ANY(t.path) AND f.is_active AND f.check_duplicates
      WHERE t.id = $1 ORDER BY f.sort_order`,
    [c.topic_id],
  );
  const pairs = defs.rows
    .map((d) => [d.key, normalizeDupValue(c.fields?.[d.key])] as const)
    .filter(([, v]) => v.length >= 3);
  if (!pairs.length) return { keys: defs.rows, matches: [] };
  const r = await db.query<{
    id: string;
    created_at: string;
    closed_at: string | null;
    status: string;
    assignee_name: string | null;
    fields: Record<string, unknown>;
    matched: string[];
  }>(
    `SELECT c.id, c.created_at, c.closed_at, c.status, u.full_name AS assignee_name, c.fields,
            array_agg(k.key ORDER BY k.key) AS matched
       FROM conversation c
       LEFT JOIN app_user u ON u.id = c.assignee_id
       JOIN unnest($2::text[], $3::text[]) AS k(key, val)
         ON regexp_replace(replace(lower(COALESCE(c.fields ->> k.key, '')), 'ё', 'е'), '[^0-9a-zа-я]', '', 'g') = k.val
      WHERE c.id <> $1 AND c.topic_path[1] = $4::uuid
      GROUP BY c.id, u.full_name ORDER BY c.created_at DESC LIMIT 20`,
    [conversationId, pairs.map((p) => p[0]), pairs.map((p) => p[1]), c.topic_path[0]],
  );
  return {
    keys: defs.rows,
    matches: r.rows.map((m) => ({
      id: m.id,
      createdAt: new Date(m.created_at).toISOString(),
      closedAt: m.closed_at ? new Date(m.closed_at).toISOString() : null,
      status: m.status,
      assigneeName: m.assignee_name,
      matched: m.matched,
      fields: m.fields ?? {},
    })),
  };
}
