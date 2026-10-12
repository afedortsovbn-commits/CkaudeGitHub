import { SupervisorThresholdsSchema } from '@cc/contracts';
import type { Pool } from 'pg';
import { emitNotice } from './notify';
import { operatorsOnLine, staffingRequiredAt } from './staffing';
import { systemTimezone } from './tickets';

export interface AlertsResult {
  belowMin: number;
  longWait: number;
  noFree: number;
  overdue: number;
  ticketOverdue: number;
  shifts: number;
}

/**
 * Периодические проверки событий для уведомлений (Д-012, раз в минуту в worker): минимум операторов на линии
 * (Д-011), долгое ожидание в очереди, нет свободных операторов, просроченные обращения и тикеты, напоминание о
 * завтрашней смене. Получатели и каналы — по правилам «Уведомлений»; ключи идемпотентности не дают повторов при
 * нескольких экземплярах worker.
 */
export async function checkAlerts(pool: Pool, now = new Date()): Promise<AlertsResult> {
  const r: AlertsResult = { belowMin: 0, longWait: 0, noFree: 0, overdue: 0, ticketOverdue: 0, shifts: 0 };
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
    const tickets = await client.query<{ id: string; number: number; days: number }>(
      `SELECT id, number, ($1::date - due_date)::int AS days FROM ticket
        WHERE status IN ('new', 'in_work', 'rework') AND due_date < $1::date ORDER BY due_date LIMIT 100`,
      [today],
    );
    for (const t of tickets.rows)
      r.ticketOverdue += await emitNotice(client, {
        event: 'ticket.overdue',
        subject: `Важно! Просрочен тикет №${t.number} на ${t.days} дн.`,
        data: { path: `/tickets/${t.id}`, ticketId: t.id, priority: 'high' },
        dedupe: `ticket_overdue:${t.id}:${today}`,
        high: true,
      });

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
