import { SupervisorThresholdsSchema } from '@cc/contracts';
import type { Pool, PoolClient } from 'pg';
import { emitNotice, matrixMatches } from './notify';
import { operatorsOnLine, staffingRequiredAt } from './staffing';
import { systemTimezone } from './tickets';

export interface AlertsResult {
  belowMin: number;
  longWait: number;
  noFree: number;
  overdue: number;
  ticketOverdue: number;
  shifts: number;
  openReminders: number;
}

/**
 * Периодические проверки событий для уведомлений (Д-012, раз в минуту в worker): минимум операторов на линии
 * (Д-011), долгое ожидание в очереди, нет свободных операторов, просроченные обращения и тикеты, напоминание о
 * завтрашней смене. Получатели и каналы — по правилам «Уведомлений»; ключи идемпотентности не дают повторов при
 * нескольких экземплярах worker.
 */
export async function checkAlerts(pool: Pool, now = new Date()): Promise<AlertsResult> {
  const r: AlertsResult = {
    belowMin: 0,
    longWait: 0,
    noFree: 0,
    overdue: 0,
    ticketOverdue: 0,
    shifts: 0,
    openReminders: 0,
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('notify.alerts')) AS ok`,
    );
    if (!lock.rows[0]?.ok) {
      await client.query('ROLLBACK');
      return r;
    }
    const tz = await systemTimezone(client);
    const thRow = await client.query<{ value: unknown }>(
      `SELECT value FROM system_setting WHERE key = 'supervisor.thresholds'`,
    );
    const parsed = SupervisorThresholdsSchema.safeParse(thRow.rows[0]?.value ?? {});
    const th = parsed.success ? parsed.data : SupervisorThresholdsSchema.parse({});
    const hourKey = now.toISOString().slice(0, 13);

    // Д-011: на линии меньше минимума (раз в час, пока длится).
    const required = await staffingRequiredAt(client, now);
    if (required > 0) {
      const online = await operatorsOnLine(client);
      if (online < required)
        r.belowMin += await emitNotice(client, {
          event: 'operators.below_min',
          subject: `Важно! На линии ${online} операторов при минимуме ${required}`,
          body: `Минимум операторов на линии задан в «Уведомлениях → Минимум операторов». Сейчас на линии ${online}.`,
          data: { path: '/supervisor', online, required },
          dedupe: `below_min:${hourKey}`,
          high: true,
        });
    }

    // Долгое ожидание: красный порог панели супервизора, один раз на обращение.
    const waiting = await client.query<{
      id: string;
      wait_s: number;
      channel_kind: string;
      queue: string | null;
    }>(
      `SELECT c.id, extract(epoch FROM $1::timestamptz - c.queued_at)::int AS wait_s, c.channel_kind, q.name AS queue
         FROM conversation c LEFT JOIN queue q ON q.id = c.queue_id
        WHERE c.status = 'queued' AND c.channel_kind <> 'email' AND c.channel_kind <> 'review'
          AND c.queued_at <= $1::timestamptz - make_interval(secs => $2) ORDER BY c.queued_at LIMIT 50`,
      [now, th.waitCritS],
    );
    for (const w of waiting.rows)
      r.longWait += await emitNotice(client, {
        event: 'queue.long_wait',
        subject: `Клиент ждёт в очереди ${Math.round(w.wait_s / 60)} мин`,
        body: `Канал: ${w.channel_kind}${w.queue ? `, очередь «${w.queue}»` : ''}.`,
        data: { path: '/supervisor', conversationId: w.id },
        dedupe: `long_wait:${w.id}`,
        high: true,
      });

    // В очереди есть клиенты, свободных нет (не чаще раза в 10 минут).
    const q = await client.query<{ queued: number; free: number }>(
      `SELECT (SELECT count(*)::int FROM conversation WHERE status = 'queued') AS queued,
              (SELECT count(*)::int FROM agent_status a JOIN app_user u ON u.id = a.user_id
                WHERE a.status = 'ready' AND u.is_active AND u.can_login) AS free`,
    );
    if ((q.rows[0]?.queued ?? 0) > 0 && (q.rows[0]?.free ?? 0) === 0) {
      const bucket = `${hourKey}:${Math.floor(now.getUTCMinutes() / 10)}`;
      r.noFree += await emitNotice(client, {
        event: 'queue.no_free',
        subject: `В очереди ${q.rows[0]!.queued}, свободных операторов нет`,
        data: { path: '/supervisor' },
        dedupe: `no_free:${bucket}`,
        high: true,
      });
    }

    // Просрочен срок ответа (отзывы, почта, заявления) — один раз на обращение.
    const overdue = await client.query<{ id: string; channel_kind: string; topic: string | null }>(
      `SELECT c.id, c.channel_kind, t.name AS topic FROM conversation c LEFT JOIN topic t ON t.id = c.topic_id
        WHERE c.status = 'queued' AND c.due_at IS NOT NULL AND c.due_at < $1::timestamptz ORDER BY c.due_at LIMIT 50`,
      [now],
    );
    for (const o of overdue.rows)
      r.overdue += await emitNotice(client, {
        event: 'conversation.overdue',
        subject: `Просрочен срок ответа: ${o.topic ?? o.channel_kind}`,
        body: 'Обращение всё ещё ждёт в очереди.',
        data: { path: '/workspace', conversationId: o.id },
        dedupe: `conv_overdue:${o.id}`,
      });

    // Просроченные тикеты 2-й линии — раз в день на тикет.
    const today = (
      await client.query<{ d: string }>(
        `SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS d`,
        [now, tz],
      )
    ).rows[0]!.d;
    const tickets = await client.query<{
      id: string;
      number: number;
      days: number;
      created_by: string;
      responsible: string[];
      curator: string[];
    }>(
      `SELECT t.id, t.number, ($1::date - t.due_date)::int AS days, t.created_by,
              COALESCE(array_agg(a.user_id) FILTER (WHERE a.kind = 'responsible'), '{}') AS responsible,
              COALESCE(array_agg(a.user_id) FILTER (WHERE a.kind = 'curator'), '{}') AS curator
         FROM ticket t LEFT JOIN ticket_assignee a ON a.ticket_id = t.id AND a.is_active
        WHERE t.status IN ('new', 'in_work', 'rework') AND t.due_date < $1::date
        GROUP BY t.id ORDER BY t.due_date LIMIT 100`,
      [today],
    );
    for (const t of tickets.rows)
      r.ticketOverdue += await emitNotice(client, {
        event: 'ticket.overdue',
        subject: `Важно! Просрочен тикет №${t.number} на ${t.days} дн.`,
        data: { path: `/tickets/${t.id}`, ticketId: t.id, priority: 'high' },
        dedupe: `ticket_overdue:${t.id}:${today}`,
        high: true,
        relations: { responsible: t.responsible, curator: t.curator, creator: [t.created_by] },
      });

    // Д-094: утром в рабочие дни (с 9:00) — сводка «есть незакрытые обращения на 2-й линии» каждому получателю.
    const nowLocal = (
      await client.query<{ h: number; dow: number }>(
        `SELECT EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE $2))::int AS h,
                EXTRACT(ISODOW FROM ($1::timestamptz AT TIME ZONE $2))::int AS dow`,
        [now, tz],
      )
    ).rows[0]!;
    if (nowLocal.h >= 9 && nowLocal.dow <= 5) r.openReminders += await remindOpenTickets(client, today);

    // Напоминание о завтрашней смене — вечером (18:00 по времени системы), по опубликованному графику.
    const hour = Number(
      (
        await client.query<{ h: number }>(
          `SELECT EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE $2))::int AS h`,
          [now, tz],
        )
      ).rows[0]?.h ?? 0,
    );
    if (hour >= 18) {
      const shifts = await client.query<{
        id: string;
        user_id: string;
        start: string;
        finish: string;
        d: string;
      }>(
        `SELECT s.id, s.user_id, to_char(s.start_at AT TIME ZONE $2, 'HH24:MI') AS start,
                to_char(s.end_at AT TIME ZONE $2, 'HH24:MI') AS finish, to_char(s.on_date, 'DD.MM') AS d
           FROM schedule_shift s JOIN schedule_month m ON m.month = s.month AND m.status = 'published'
          WHERE s.on_date = ($1::timestamptz AT TIME ZONE $2)::date + 1`,
        [now, tz],
      );
      for (const s of shifts.rows)
        r.shifts += await emitNotice(client, {
          event: 'my.shift',
          subject: `Завтра (${s.d}) смена ${s.start}–${s.finish}`,
          data: { path: '/workspace' },
          dedupe: `shift:${s.id}`,
          targetUserIds: [s.user_id],
        });
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return r;
}

/**
 * Д-094: сводка о незакрытых тикетах 2-й линии — раз в день каждому получателю события `ticket.open_reminder`.
 * Получатель по правилу (роли) или с условием «всегда» видит все незакрытые тикеты; с условиями «ответственный /
 * куратор / создатель» — только свои. Нет таких тикетов — нет напоминания.
 */
export async function remindOpenTickets(client: PoolClient, today: string): Promise<number> {
  const open = await client.query<{
    id: string;
    overdue: boolean;
    created_by: string;
    responsible: string[];
    curator: string[];
  }>(
    `SELECT t.id, t.due_date < $1::date AS overdue, t.created_by,
            COALESCE(array_agg(a.user_id) FILTER (WHERE a.kind = 'responsible'), '{}') AS responsible,
            COALESCE(array_agg(a.user_id) FILTER (WHERE a.kind = 'curator'), '{}') AS curator
       FROM ticket t LEFT JOIN ticket_assignee a ON a.ticket_id = t.id AND a.is_active
      WHERE t.status <> 'closed' GROUP BY t.id`,
    [today],
  );
  // Раз в день: отметка дня в настройках (несколько экземпляров worker уже разведены advisory-блокировкой).
  const mark = await client.query(
    `INSERT INTO system_setting (key, value) VALUES ('notify.open_reminder_day', to_jsonb($1::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE system_setting.value IS DISTINCT FROM EXCLUDED.value`,
    [today],
  );
  if (!mark.rowCount || !open.rows.length) return 0;
  const recipients = new Map<string, string[]>(); // сотрудник → условия (['all'] — все тикеты)
  const rules = await client.query<{ id: string }>(
    `SELECT DISTINCT u.id FROM notify_rule r JOIN app_user u ON u.is_active AND u.can_login
        AND (u.id = ANY(r.user_ids) OR EXISTS (SELECT 1 FROM user_role ur WHERE ur.user_id = u.id AND ur.role_code = ANY(r.role_codes)))
      WHERE r.event = 'ticket.open_reminder' AND r.is_active`,
  );
  for (const u of rules.rows) recipients.set(u.id, ['all']);
  const matrix = await client.query<{ user_id: string; conditions: string[] }>(
    `SELECT user_id, conditions FROM notify_matrix WHERE event = 'ticket.open_reminder' AND cardinality(channels) > 0`,
  );
  for (const m of matrix.rows)
    if (!recipients.get(m.user_id)?.includes('all'))
      recipients.set(m.user_id, [...(recipients.get(m.user_id) ?? []), ...m.conditions]);
  let created = 0;
  for (const [userId, conditions] of recipients) {
    const mine = open.rows.filter((t) =>
      matrixMatches(conditions, userId, {
        responsible: t.responsible,
        curator: t.curator,
        creator: [t.created_by],
      }),
    );
    if (!mine.length) continue;
    const overdue = mine.filter((t) => t.overdue).length;
    created += await emitNotice(client, {
      event: 'ticket.open_reminder',
      subject: `На 2-й линии не закрыто обращений: ${mine.length}${overdue ? `, из них просрочено: ${overdue}` : ''}`,
      body: 'Откройте раздел «Обращения на 2-й линии», чтобы посмотреть список.',
      data: { path: '/tickets', count: mine.length, overdue },
      dedupe: `open_reminder:${today}`,
      high: overdue > 0,
      onlyUserIds: [userId],
      // Условия получателя уже учтены при отборе тикетов — для отправки он «связан» со всеми своими тикетами.
      relations: { responsible: [userId], curator: [userId], creator: [userId], assignee: [userId] },
    });
  }
  return created;
}
