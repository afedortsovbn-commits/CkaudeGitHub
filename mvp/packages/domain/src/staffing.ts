import type { Pool, PoolClient } from 'pg';
import { systemTimezone } from './tickets';

/**
 * Минимум операторов на линии (Д-011): по дням недели и часам (`staffing_minimum`). «На линии» — статус «Готов»
 * или «Постобработка» у сотрудников с правом работы с обращениями. Если оператор ставит статус, не обслуживающий
 * клиентов, и на линии станет меньше минимума — переход запрещён и уведомляются руководитель и супервизор
 * (событие `operators.below_min`, настраивается в «Уведомлениях»).
 */
export interface StaffingCell {
  weekday: number;
  hour: number;
  required: number;
}

export async function staffingRequiredAt(db: Pool | PoolClient, now = new Date()): Promise<number> {
  const tz = await systemTimezone(db);
  const r = await db.query<{ required: number }>(
    `SELECT required FROM staffing_minimum
      WHERE weekday = EXTRACT(ISODOW FROM ($1::timestamptz AT TIME ZONE $2))::int
        AND hour = EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE $2))::int`,
    [now, tz],
  );
  return Number(r.rows[0]?.required ?? 0);
}

/** Сколько сотрудников сейчас на линии (без указанного — например, того, кто собирается уйти). */
export async function operatorsOnLine(db: Pool | PoolClient, excludeUserId?: string | null): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_status a JOIN app_user u ON u.id = a.user_id
      WHERE a.status IN ('ready', 'wrap_up') AND u.is_active AND u.can_login AND ($1::uuid IS NULL OR u.id <> $1)
        AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                     WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))`,
    [excludeUserId ?? null],
  );
  return r.rows[0]?.n ?? 0;
}

export interface StaffingCheck {
  required: number;
  /** На линии сейчас (включая проверяемого). */
  online: number;
  /** Останется, если проверяемый уйдёт. */
  after: number;
  allowed: boolean;
}

/** Можно ли сотруднику уйти с линии прямо сейчас. */
export async function staffingAfterLeave(
  db: Pool | PoolClient,
  userId: string,
  now = new Date(),
): Promise<StaffingCheck> {
  const required = await staffingRequiredAt(db, now);
  const after = await operatorsOnLine(db, userId);
  const online = await operatorsOnLine(db);
  // Уйти нельзя, только если сам уход опускает линию ниже минимума (если уже ниже — это задача руководителя).
  const allowed = required === 0 || online < required || after >= required;
  return { required, online, after, allowed };
}

export async function loadStaffingMinimum(db: Pool | PoolClient): Promise<StaffingCell[]> {
  const r = await db.query<StaffingCell>(
    `SELECT weekday, hour, required FROM staffing_minimum ORDER BY weekday, hour`,
  );
  return r.rows.map((c) => ({
    weekday: Number(c.weekday),
    hour: Number(c.hour),
    required: Number(c.required),
  }));
}

/** Полная замена таблицы минимума (ячейки с нулём не хранятся). */
export async function saveStaffingMinimum(tx: PoolClient, cells: StaffingCell[]): Promise<void> {
  await tx.query(`DELETE FROM staffing_minimum`);
  const rows = cells.filter((c) => c.required > 0);
  if (!rows.length) return;
  await tx.query(
    `INSERT INTO staffing_minimum (weekday, hour, required)
     SELECT * FROM unnest($1::int[], $2::int[], $3::int[])`,
    [rows.map((c) => c.weekday), rows.map((c) => c.hour), rows.map((c) => c.required)],
  );
}
