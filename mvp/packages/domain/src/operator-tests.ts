import { newId } from '@cc/contracts';
import type { Pool } from 'pg';
import { daysBetween, localDate, localTime } from './ticket-time';

/** Вариант ответа на вопрос теста. */
export interface TestOption {
  id: string;
  text: string;
  correct: boolean;
}

/** Ответ правильный, если отмечены ровно все правильные варианты (для вопроса с одним правильным — он один). */
export function isAnswerCorrect(options: TestOption[], chosen: string[]): boolean {
  const right = new Set(options.filter((o) => o.correct).map((o) => o.id));
  const picked = new Set(chosen);
  if (!right.size || right.size !== picked.size) return false;
  for (const id of picked) if (!right.has(id)) return false;
  return true;
}

/** Оценка попытки: % правильных (округление), пройдено ли по проходному баллу. */
export function gradeAttempt(
  correct: number,
  total: number,
  passScore: number,
): { score: number; passed: boolean } {
  const score = total ? Math.round((correct * 100) / total) : 0;
  return { score, passed: total > 0 && score >= passScore };
}

/** Кто получает сводку о сроках тестов (кроме назначившего). */
export const TEST_MANAGER_PERMS = ['tests.manage'];

const ddmm = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

/** Состояние назначения на дату: пройдено, отменено, просрочено на N дней или осталось N дней. */
export function assignmentState(
  a: { passedAt: unknown; cancelledAt: unknown; dueDate: string },
  today: string,
): { status: 'passed' | 'cancelled' | 'overdue' | 'open'; daysLeft: number } {
  const daysLeft = daysBetween(today, a.dueDate);
  if (a.cancelledAt) return { status: 'cancelled', daysLeft };
  if (a.passedAt) return { status: 'passed', daysLeft };
  return { status: daysLeft < 0 ? 'overdue' : 'open', daysLeft };
}

/**
 * Напоминания о сроке тестов (раз в день, не раньше времени ежедневной рассылки): первое — когда до срока
 * осталось 3 дня или меньше, затем — каждый день просрочки. Сотруднику — уведомление по каждому тесту;
 * назначившему и сотрудникам с правом «Тестирование» — одна сводка в день. Идемпотентно: отметка
 * (назначение, день) уникальна — повтор задачи и два экземпляра worker не дают дублей.
 */
export async function remindTestDeadlines(
  pool: Pool,
  now = new Date(),
): Promise<{ skipped: boolean; operators: number; managers: number }> {
  const setting = async (key: string) =>
    (await pool.query<{ v: string }>(`SELECT value #>> '{}' AS v FROM system_setting WHERE key = $1`, [key]))
      .rows[0]?.v ?? null;
  const tz = (await setting('system.timezone')) ?? 'Europe/Minsk';
  const at = (await setting('ticket.daily_notification_time')) ?? '08:00';
  const today = localDate(now, tz);
  if (localTime(now, tz) < at) return { skipped: true, operators: 0, managers: 0 };

  const client = await pool.connect();
  let operators = 0;
  let managers = 0;
  try {
    await client.query('BEGIN');
    type Row = {
      id: string;
      user_id: string;
      full_name: string;
      title: string;
      due: string;
      assigned_by: string | null;
    };
    // Открытые назначения: осталось ≤ 3 дней и напоминаний ещё не было, или просрочено (каждый день).
    const due = await client.query<Row>(
      `WITH cand AS (
         SELECT a.id, a.user_id, u.full_name, t.title, to_char(a.due_date, 'YYYY-MM-DD') AS due, a.assigned_by
           FROM test_assignment a JOIN knowledge_test t ON t.id = a.test_id
           JOIN app_user u ON u.id = a.user_id AND u.is_active AND u.can_login
          WHERE a.cancelled_at IS NULL AND a.passed_at IS NULL
            AND (a.due_date < $1::date
                 OR (a.due_date - $1::date <= 3 AND NOT EXISTS (SELECT 1 FROM test_reminder r WHERE r.assignment_id = a.id))))
       , ins AS (
         INSERT INTO test_reminder (assignment_id, day) SELECT id, $1::date FROM cand
         ON CONFLICT DO NOTHING RETURNING assignment_id)
       SELECT c.* FROM cand c JOIN ins ON ins.assignment_id = c.id ORDER BY c.full_name, c.due`,
      [today],
    );
    const note = async (userId: string, dedupe: string, subject: string, body: string, data: object) => {
      const r = await client.query(
        `INSERT INTO notification (id, user_id, kind, channel, dedupe_key, subject, body, data, status, sent_at)
         VALUES ($1, $2, 'test', 'ui', $3, $4, $5, $6, 'sent', $7) ON CONFLICT (dedupe_key) DO NOTHING`,
        [newId(), userId, dedupe, subject, body, JSON.stringify(data), now],
      );
      return r.rowCount ?? 0;
    };
    const lines: string[] = [];
    const assigners = new Set<string>();
    for (const a of due.rows) {
      const left = daysBetween(today, a.due);
      const subject =
        left < 0
          ? `Тест «${a.title}» просрочен на ${-left} дн. — пройдите его`
          : left === 0
            ? `Сегодня последний день: тест «${a.title}»`
            : `Тест «${a.title}»: осталось ${left} дн. (до ${ddmm(a.due)})`;
      operators += await note(a.user_id, `test:${a.id}:${today}`, subject, '', {
        priority: left < 0 ? 'high' : 'normal',
        path: '/my-tests',
      });
      lines.push(
        `${a.full_name} — «${a.title}»: ${left < 0 ? `просрочен на ${-left} дн.` : `срок ${ddmm(a.due)}`}`,
      );
      if (a.assigned_by) assigners.add(a.assigned_by);
    }
    if (lines.length) {
      const late = due.rows.filter((a) => daysBetween(today, a.due) < 0).length;
      const soon = due.rows.length - late;
      const mgr = await client.query<{ id: string }>(
        `SELECT u.id FROM app_user u WHERE u.is_active AND u.can_login AND (u.id = ANY($2::uuid[]) OR EXISTS (
            SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
             WHERE ur.user_id = u.id AND r.permissions && $1::text[]))`,
        [TEST_MANAGER_PERMS, [...assigners]],
      );
      const subject = `Тесты сотрудников: просрочено — ${late}, срок через 3 дня или меньше — ${soon}`;
      for (const m of mgr.rows)
        managers += await note(m.id, `test-digest:${m.id}:${today}`, subject, lines.join('\n'), {
          priority: late ? 'high' : 'normal',
          path: '/tests?tab=assignments',
        });
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { skipped: false, operators, managers };
}
