import { newId } from '@cc/contracts';
import type { Pool } from 'pg';

/** Кто получает уведомления о нарушении перерывов. */
export const BREAK_RECIPIENT_PERMS = ['supervisor.monitor'];

const hhmm = (d: Date) => {
  const m = new Date(d.getTime() + 3 * 3600_000);
  return `${String(m.getUTCHours()).padStart(2, '0')}:${String(m.getUTCMinutes()).padStart(2, '0')}`;
};

/**
 * Контроль перерывов по опубликованному графику (раз в минуту). Каждый перерыв проверяется один раз:
 * через breakLateMin минут после начала — ушёл ли оператор на перерыв (если он на смене: «В работе»),
 * через breakLateMin минут после конца — вернулся ли. Нарушение — уведомление супервизорам в колокольчик.
 */
export async function checkBreaks(
  pool: Pool,
  now = new Date(),
): Promise<{ lateStart: number; lateEnd: number }> {
  const r = await pool.query<{ value: { breakLateMin?: number } }>(
    `SELECT value FROM system_setting WHERE key = 'schedule.rules'`,
  );
  const late = Math.max(1, Number(r.rows[0]?.value?.breakLateMin ?? 5));
  const client = await pool.connect();
  let lateStart = 0;
  let lateEnd = 0;
  try {
    await client.query('BEGIN');
    type Row = {
      id: string;
      user_id: string;
      full_name: string;
      start_at: Date;
      end_at: Date;
      status: string | null;
      since: Date | null;
    };
    const starts = await client.query<Row>(
      `UPDATE schedule_break b SET late_start_alerted = true
         FROM schedule_shift s JOIN schedule_month m ON m.month = s.month AND m.status = 'published'
              JOIN app_user u ON u.id = s.user_id LEFT JOIN agent_status a ON a.user_id = s.user_id
        WHERE s.id = b.shift_id AND NOT b.late_start_alerted
          AND b.start_at <= $1::timestamptz - make_interval(mins => $2) AND b.start_at > $1::timestamptz - interval '1 day'
          AND b.end_at > $1::timestamptz
       RETURNING b.id, s.user_id, u.full_name, b.start_at, b.end_at, a.status, a.since`,
      [now, late],
    );
    const ends = await client.query<Row>(
      `UPDATE schedule_break b SET late_end_alerted = true
         FROM schedule_shift s JOIN schedule_month m ON m.month = s.month AND m.status = 'published'
              JOIN app_user u ON u.id = s.user_id LEFT JOIN agent_status a ON a.user_id = s.user_id
        WHERE s.id = b.shift_id AND NOT b.late_end_alerted
          AND b.end_at <= $1::timestamptz - make_interval(mins => $2) AND b.end_at > $1::timestamptz - interval '1 day'
       RETURNING b.id, s.user_id, u.full_name, b.start_at, b.end_at, a.status, a.since`,
      [now, late],
    );
    const alerts: { row: Row; kind: 'start' | 'end' }[] = [];
    // Не ушёл: на смене в работе (готов или постобработка), а перерыв уже идёт.
    for (const b of starts.rows)
      if (b.status === 'ready' || b.status === 'wrap_up') alerts.push({ row: b, kind: 'start' });
    // Не вернулся: всё ещё на перерыве, начатом до конца запланированного.
    for (const b of ends.rows)
      if (b.status === 'break' && b.since && b.since < b.end_at) alerts.push({ row: b, kind: 'end' });
    if (alerts.length) {
      const users = await client.query<{ id: string }>(
        `SELECT u.id FROM app_user u
          WHERE u.is_active AND u.can_login AND EXISTS (
            SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
             WHERE ur.user_id = u.id AND r.permissions && $1::text[])`,
        [BREAK_RECIPIENT_PERMS],
      );
      for (const a of alerts) {
        const b = a.row;
        const period = `${hhmm(b.start_at)}–${hhmm(b.end_at)}`;
        const subject =
          a.kind === 'start' ? `Перерыв не начат: ${b.full_name}` : `Перерыв затянулся: ${b.full_name}`;
        const body =
          a.kind === 'start'
            ? `Перерыв по графику ${period}, оператор по-прежнему в работе.`
            : `Перерыв по графику ${period} закончился, оператор всё ещё на перерыве.`;
        if (a.kind === 'start') lateStart++;
        else lateEnd++;
        for (const u of users.rows)
          await client.query(
            `INSERT INTO notification (id, user_id, kind, channel, dedupe_key, subject, body, data, status, sent_at)
             VALUES ($1, $2, 'break', 'ui', $3, $4, $5, $6, 'sent', $7) ON CONFLICT (dedupe_key) DO NOTHING`,
            [
              newId(),
              u.id,
              `break:${b.id}:${a.kind}:${u.id}`,
              subject,
              body,
              JSON.stringify({ priority: 'high', path: '/supervisor', userId: b.user_id }),
              now,
            ],
          );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { lateStart, lateEnd };
}
