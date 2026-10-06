import { newId } from '@cc/contracts';
import { inScope, type ScopeRule, type ScopeSubject } from '@cc/auth';
import type { Pool, PoolClient } from 'pg';
import { deadlinePhrase, daysBetween, formatDate, localDate, localTime } from './ticket-time';

type Db = Pool | PoolClient;

/** Ссылка на тикет: worker подставляет адрес системы при отправке (PUBLIC_BASE_URL), не хранит его в письме. */
export const LINK_PLACEHOLDER = '{{link}}';

export type NotificationKind =
  | 'assigned'
  | 'daily'
  | 'rework'
  | 'approval_request'
  | 'approval_reminder'
  | 'approved'
  | 'redirected'
  | 'client_message'
  | 'comment'
  | 'needs_reassign'
  | 'assignees_changed'
  | 'opened'
  | 'unassigned'
  | 'extension_request'
  | 'extension_declined';

/** Карточка тикета для текста писем и уведомлений. */
export interface TicketCard {
  id: string;
  number: number;
  status: string;
  summary: string;
  due: string;
  isImportant: boolean;
  topicNames: string[];
  enterpriseName: string;
  departmentName: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
}

export async function loadCard(db: Db, ticketId: string): Promise<TicketCard> {
  const { rows } = await db.query(
    `SELECT t.id, t.number, t.status, t.summary, to_char(t.due_date, 'YYYY-MM-DD') AS due, t.is_important,
            e.name AS enterprise_name, d.name AS department_name,
            (SELECT array_agg(x.name ORDER BY array_position(t.topic_path, x.id)) FROM topic x WHERE x.id = ANY(t.topic_path)) AS topic_names,
            ct.display_name, ct.phone, ct.email
       FROM ticket t
       JOIN enterprise e ON e.id = t.enterprise_id
       JOIN department d ON d.id = t.department_id
       JOIN conversation c ON c.id = t.conversation_id
       JOIN contact ct ON ct.id = c.contact_id
      WHERE t.id = $1`,
    [ticketId],
  );
  const r = rows[0];
  if (!r) throw new Error(`тикет ${ticketId} не найден`);
  return {
    id: r.id,
    number: Number(r.number),
    status: r.status,
    summary: r.summary,
    due: r.due,
    isImportant: r.is_important,
    topicNames: r.topic_names ?? [],
    enterpriseName: r.enterprise_name,
    departmentName: r.department_name,
    contactName: r.display_name,
    contactPhone: r.phone,
    contactEmail: r.email,
  };
}

export interface MailText {
  subject: string;
  body: string;
  /** Письма ответственным и кураторам — «Важно!» с высоким приоритетом (M-TKT-04). */
  high: boolean;
}

export interface MailExtra {
  /** Срок − сегодня, дней. */
  daysLeft?: number;
  comment?: string;
  actorName?: string;
}

const topicLine = (c: TicketCard) => c.topicNames.join(' / ') || 'без темы';

function cardText(c: TicketCard, extra: MailExtra): string {
  const lines = [
    `Обращение (2 линия) №${c.number}${c.isImportant ? ' (особо важное)' : ''}`,
    `Тема: ${topicLine(c)}`,
    `Предприятие: ${c.enterpriseName}; подразделение: ${c.departmentName}`,
    `Суть обращения: ${c.summary}`,
    `Клиент: ${[c.contactName, c.contactPhone, c.contactEmail].filter(Boolean).join(', ') || 'нет данных'}`,
    `Срок ответа: ${formatDate(c.due)}${extra.daysLeft !== undefined ? ` (${deadlinePhrase(extra.daysLeft)})` : ''}`,
  ];
  if (extra.comment)
    lines.push(`Комментарий${extra.actorName ? ` (${extra.actorName})` : ''}: ${extra.comment}`);
  lines.push(`Открыть в системе: ${LINK_PLACEHOLDER}`);
  return lines.join('\n');
}

/**
 * Тема и текст письма по виду уведомления (M-TKT-04, M-TKT-07..09). Чистая функция — покрыта тестами.
 */
export function renderMail(kind: NotificationKind, c: TicketCard, extra: MailExtra = {}): MailText {
  const n = c.number;
  const high = ![
    'approval_request',
    'approval_reminder',
    'approved',
    'client_message',
    'comment',
    'opened',
    'unassigned',
    'assignees_changed',
    'extension_request',
    'extension_declined',
  ].includes(kind);
  const withImportant = (s: string) => (high ? `Важно! ${s}` : s);
  let subject: string;
  switch (kind) {
    case 'assigned':
    case 'redirected':
      subject = withImportant(`Вам назначено обращение (2 линия) №${n}: ${topicLine(c)}`);
      break;
    case 'assignees_changed':
      subject = `Обращение (2 линия) №${n}: изменены ответственные или тема`;
      break;
    case 'extension_request':
      subject = `Обращение (2 линия) №${n}: запрошено продление срока`;
      break;
    case 'extension_declined':
      subject = `Обращение (2 линия) №${n}: в продлении срока отказано`;
      break;
    case 'opened':
      subject = `Обращение (2 линия) №${n} взято в работу`;
      break;
    case 'unassigned':
      subject = `Вы сняты с обращения (2 линия) №${n}`;
      break;
    case 'daily':
      subject = withImportant(`Обращение (2 линия) №${n}: ${deadlinePhrase(extra.daysLeft ?? 0)}`);
      break;
    case 'rework':
      subject = withImportant(`Обращение (2 линия) №${n} возвращено на доработку`);
      break;
    case 'approval_request':
      subject = `Обращение (2 линия) №${n} ожидает согласования`;
      break;
    case 'approval_reminder':
      subject = `Напоминание: обращение (2 линия) №${n} ожидает согласования`;
      break;
    case 'approved':
      subject = `Обращение (2 линия) №${n}: ответ принят, обращение закрыто`;
      break;
    case 'needs_reassign':
      subject = withImportant(`Обращение (2 линия) №${n} требует переназначения`);
      break;
    case 'client_message':
      subject = `Новое сообщение клиента по обращению (2 линия) №${n}`;
      break;
    default:
      subject = `Обращение (2 линия) №${n}: новый комментарий`;
  }
  return { subject, body: cardText(c, extra), high };
}

export interface NotifyInput {
  ticketId: string;
  userIds: string[];
  kind: NotificationKind;
  /** Основа ключа идемпотентности; к ней добавляются канал и получатель. */
  dedupe: string;
  card: TicketCard;
  extra?: MailExtra;
  /** Дублировать письмом (иначе только уведомление в интерфейсе). */
  email: boolean;
  /** Пишем ли уведомление в интерфейсе (у ежедневной рассылки — нет). */
  ui?: boolean;
}

/**
 * Ставит уведомления получателям: интерфейс (колокольчик) и/или email в очередь отправки.
 * Уникальный ключ — повторный вызов (повтор задачи, перезапуск worker) ничего не дублирует.
 * Возвращает число реально созданных записей.
 */
export async function queueNotifications(tx: PoolClient, n: NotifyInput): Promise<number> {
  const ids = [...new Set(n.userIds)];
  if (!ids.length) return 0;
  const users = await tx.query<{ id: string; email: string }>(
    'SELECT id, email FROM app_user WHERE id = ANY($1) AND is_active',
    [ids],
  );
  const mail = renderMail(n.kind, n.card, n.extra);
  let created = 0;
  for (const u of users.rows) {
    if (n.ui !== false) {
      const r = await tx.query(
        `INSERT INTO notification (id, user_id, ticket_id, kind, channel, dedupe_key, subject, body, data, status, sent_at)
         VALUES ($1, $2, $3, $4, 'ui', $5, $6, $7, $8, 'sent', now()) ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          newId(),
          u.id,
          n.ticketId,
          n.kind,
          `${n.dedupe}:ui:${u.id}`,
          mail.subject.replace(/^Важно! /, ''),
          '',
          JSON.stringify({ ticketNumber: n.card.number }),
        ],
      );
      created += r.rowCount ?? 0;
    }
    if (n.email && u.email) {
      const r = await tx.query(
        `INSERT INTO notification (id, user_id, ticket_id, kind, channel, dedupe_key, subject, body, data)
         VALUES ($1, $2, $3, $4, 'email', $5, $6, $7, $8) ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          newId(),
          u.id,
          n.ticketId,
          n.kind,
          `${n.dedupe}:email:${u.id}`,
          mail.subject,
          mail.body,
          JSON.stringify({ priority: mail.high ? 'high' : 'normal', ticketNumber: n.card.number }),
        ],
      );
      created += r.rowCount ?? 0;
    }
  }
  return created;
}

// ------------------------------------------------------------------ получатели

export interface UserWithScope {
  id: string;
  email: string;
  scope: ScopeSubject;
}

/** Активные сотрудники с правом (через роль) и их область видимости. */
export async function usersWithPermission(db: Db, perm: string): Promise<UserWithScope[]> {
  const { rows } = await db.query<{ id: string; email: string; all_scope: boolean }>(
    `SELECT u.id, u.email,
            EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                     WHERE ur.user_id = u.id AND 'scope.all' = ANY(r.permissions)) AS all_scope
       FROM app_user u
      WHERE u.is_active AND u.can_login
        AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                     WHERE ur.user_id = u.id AND $1 = ANY(r.permissions))`,
    [perm],
  );
  if (!rows.length) return [];
  const sc = await db.query<{
    user_id: string;
    enterprise_ids: string[] | null;
    department_ids: string[] | null;
    topic_ids: string[] | null;
  }>('SELECT user_id, enterprise_ids, department_ids, topic_ids FROM access_scope WHERE user_id = ANY($1)', [
    rows.map((r) => r.id),
  ]);
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    scope: {
      all: u.all_scope,
      rules: sc.rows
        .filter((s) => s.user_id === u.id)
        .map<ScopeRule>((s) => ({
          enterpriseIds: s.enterprise_ids,
          departmentIds: s.department_ids,
          topicIds: s.topic_ids,
        })),
    },
  }));
}

export interface TicketDims {
  enterprise_id: string;
  department_id: string;
  topic_path: string[];
  created_by: string;
}

export interface ApprovalContext {
  mode: 'creator' | 'supervisor';
  creatorActive: boolean;
  /** Действующие сегодня заместители создателя. */
  substituteIds: string[];
}

export async function loadApprovalContext(
  db: Db,
  t: { created_by: string },
  today: string,
): Promise<ApprovalContext> {
  const mode = await db.query<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM system_setting WHERE key = 'ticket.approval_mode'`,
  );
  // Уволенный или лишённый входа создатель не согласует — его тикеты у супервизоров (M-TKT-09).
  const creator = await db.query<{ is_active: boolean }>(
    'SELECT is_active AND can_login AS is_active FROM app_user WHERE id = $1',
    [t.created_by],
  );
  const subs = await db.query<{ substitute_id: string }>(
    `SELECT s.substitute_id FROM approval_substitute s JOIN app_user u ON u.id = s.substitute_id AND u.is_active AND u.can_login
      WHERE s.user_id = $1 AND s.is_active
        AND (s.valid_from IS NULL OR s.valid_from <= $2::date) AND (s.valid_to IS NULL OR s.valid_to >= $2::date)`,
    [t.created_by, today],
  );
  return {
    mode: mode.rows[0]?.value === 'supervisor' ? 'supervisor' : 'creator',
    creatorActive: creator.rows[0]?.is_active ?? false,
    substituteIds: subs.rows.map((r) => r.substitute_id),
  };
}

/**
 * Кто может принять или вернуть тикет (M-TKT-09). `creator`: создатель, его заместитель, супервизор в области;
 * `supervisor`: только супервизор в области. Тикеты уволенного создателя попадают супервизорам.
 * Чистая функция — переключение режима без доработки покрыто тестами.
 */
export function canApprove(
  ctx: ApprovalContext,
  t: TicketDims,
  user: { id: string; canSupervise: boolean; scope: ScopeSubject },
): boolean {
  const supervises =
    user.canSupervise &&
    inScope(user.scope, {
      enterpriseId: t.enterprise_id,
      departmentId: t.department_id,
      topicPath: t.topic_path,
    });
  if (supervises) return true;
  if (ctx.mode === 'supervisor') return false;
  return (t.created_by === user.id && ctx.creatorActive) || ctx.substituteIds.includes(user.id);
}

/** Супервизоры (право `supervisor.approvals`), в чью область видимости попадает тикет. */
export async function supervisorsFor(db: Db, t: Omit<TicketDims, 'created_by'>): Promise<string[]> {
  return (await usersWithPermission(db, 'supervisor.approvals'))
    .filter((u) =>
      inScope(u.scope, {
        enterpriseId: t.enterprise_id,
        departmentId: t.department_id,
        topicPath: t.topic_path,
      }),
    )
    .map((u) => u.id);
}

/** Получатели уведомлений о согласовании: `main` — письмо и интерфейс, `uiOnly` — только интерфейс. */
export async function approvalRecipients(
  db: Db,
  t: TicketDims,
  today: string,
): Promise<{ main: string[]; uiOnly: string[] }> {
  const ctx = await loadApprovalContext(db, t, today);
  const sups = await supervisorsFor(db, t);
  if (ctx.mode === 'supervisor' || !ctx.creatorActive) {
    // Создатель не согласует (режим или увольнение): тикет у супервизоров, заместитель — если действует.
    const main = ctx.mode === 'supervisor' ? sups : [...sups, ...ctx.substituteIds];
    return { main: [...new Set(main)], uiOnly: [] };
  }
  const main = [t.created_by, ...ctx.substituteIds];
  return { main: [...new Set(main)], uiOnly: sups.filter((s) => !main.includes(s)) };
}

// ------------------------------------------------------------------ ежедневная рассылка

export const DIGEST_MARKER = 'ticket.digest_last_date';

async function setting(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.query<{ v: string | null }>(
    `SELECT value #>> '{}' AS v FROM system_setting WHERE key = $1`,
    [key],
  );
  return rows[0]?.v ?? null;
}

export interface DigestResult {
  /** Рассылка сегодня уже выполнена или ещё не время. */
  skipped: boolean;
  date: string;
  daily: number;
  approvalReminders: number;
}

/**
 * Ежедневная рассылка (M-TKT-04, M-TKT-08): в заданное время (по умолчанию 08:00, включая выходные и праздники)
 * отдельное письмо по каждому незакрытому тикету каждому активному ответственному и куратору — «осталось N дней»
 * или «просрочено на N дней»; тикет «на согласовании» — напоминание согласующим. Письма прекращаются, когда
 * ответственный закрыл тикет (перевёл на согласование), и возобновляются при возврате на доработку — просто
 * потому, что выборка идёт по текущему статусу.
 *
 * Идемпотентно: ключ (тикет, получатель, дата) уникален — перезапуск worker во время рассылки, повтор задачи
 * или два экземпляра сразу не дают ни дублей, ни пропусков. `now` — для тестов с подменой времени.
 * Только записывает письма в очередь `notification`; отправляет их отдельный обработчик (processEmailQueue).
 */
export async function runDailyDigest(pool: Pool, now = new Date()): Promise<DigestResult> {
  const tz = (await setting(pool, 'system.timezone')) ?? 'Europe/Minsk';
  const at = (await setting(pool, 'ticket.daily_notification_time')) ?? '08:00';
  const today = localDate(now, tz);
  const result: DigestResult = { skipped: true, date: today, daily: 0, approvalReminders: 0 };
  if (localTime(now, tz) < at) return result;
  if ((await setting(pool, DIGEST_MARKER)) === today) return result;
  result.skipped = false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Один экземпляр за раз; второй ждёт и находит отметку «сегодня выполнено».
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ticket-daily-digest']);
    if ((await setting(client, DIGEST_MARKER)) === today) {
      await client.query('COMMIT');
      result.skipped = true;
      return result;
    }
    const work = await client.query<{ id: string }>(
      `SELECT id FROM ticket WHERE status IN ('new', 'in_work', 'rework') ORDER BY due_date, number`,
    );
    for (const { id } of work.rows) {
      const card = await loadCard(client, id);
      const to = await client.query<{ user_id: string }>(
        `SELECT a.user_id FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id AND u.is_active AND u.can_login
          WHERE a.ticket_id = $1 AND a.is_active`,
        [id],
      );
      result.daily += await queueNotifications(client, {
        ticketId: id,
        userIds: to.rows.map((r) => r.user_id),
        kind: 'daily',
        dedupe: `daily:${id}:${today}`,
        card,
        extra: { daysLeft: daysBetween(today, card.due) },
        email: true,
        ui: false,
      });
    }
    const waiting = await client.query<TicketDims & { id: string }>(
      `SELECT id, enterprise_id, department_id, topic_path, created_by FROM ticket WHERE status = 'approval' ORDER BY number`,
    );
    for (const t of waiting.rows) {
      const rec = await approvalRecipients(client, t, today);
      result.approvalReminders += await queueNotifications(client, {
        ticketId: t.id,
        userIds: rec.main,
        kind: 'approval_reminder',
        dedupe: `approval-reminder:${t.id}:${today}`,
        card: await loadCard(client, t.id),
        email: true,
        ui: false,
      });
    }
    await client.query(
      `INSERT INTO system_setting (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [DIGEST_MARKER, JSON.stringify(today)],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return result;
}

// ------------------------------------------------------------------ отправка писем

export interface OutgoingMail {
  id: string;
  ticketId: string | null;
  to: string;
  subject: string;
  body: string;
  high: boolean;
}

export interface EmailQueueOptions {
  /** Отправка одного письма; исключение — сбой SMTP (повтор с задержкой). */
  send: (mail: OutgoingMail) => Promise<void>;
  batch?: number;
  maxAttempts?: number;
  /** Аренда письма на время отправки: если экземпляр умер, письмо уйдёт повторно после её окончания. */
  leaseSeconds?: number;
  /** Остановка обработки между письмами (graceful shutdown). */
  shouldStop?: () => boolean;
}

/** Задержка перед повтором после сбоя SMTP: 1, 2, 4… минуты, не более часа. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 3600);
}

/**
 * Отправляет письма из очереди. Письмо «арендуется» (SKIP LOCKED + сдвиг next_attempt_at) и помечается
 * отправленным сразу после успешной отправки: несколько экземпляров worker делят работу без дублей.
 * Сбой SMTP — повтор с нарастающей задержкой; после maxAttempts запись получает статус failed (видна в журнале).
 * Возвращает число отправленных писем.
 */
export async function processEmailQueue(pool: Pool, o: EmailQueueOptions): Promise<number> {
  const maxAttempts = o.maxAttempts ?? 8;
  let sent = 0;
  // Ежедневные письма и напоминания, не ушедшие за сутки (SMTP долго недоступен или ещё не настроен), устарели:
  // «осталось N дней» во вчерашнем письме вводит в заблуждение — их заменит сегодняшняя рассылка.
  await pool.query(
    `UPDATE notification SET status = 'skipped', last_error = 'устарело: не отправлено за сутки'
      WHERE channel = 'email' AND status = 'pending' AND kind IN ('daily', 'approval_reminder')
        AND created_at < now() - interval '20 hours'`,
  );
  for (;;) {
    if (o.shouldStop?.()) break;
    const claimed = await pool.query<{
      id: string;
      subject: string;
      body: string;
      data: { priority?: string };
      attempts: number;
      email: string;
      ticket_id: string | null;
    }>(
      `UPDATE notification n SET attempts = n.attempts + 1,
              next_attempt_at = now() + make_interval(secs => $2)
        FROM app_user u
       WHERE n.id IN (SELECT id FROM notification
                       WHERE channel = 'email' AND status = 'pending' AND next_attempt_at <= now()
                       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
         AND u.id = n.user_id
       RETURNING n.id, n.ticket_id, n.subject, n.body, n.data, n.attempts, u.email`,
      [o.batch ?? 20, o.leaseSeconds ?? 120],
    );
    if (!claimed.rows.length) break;
    for (const [i, m] of claimed.rows.entries()) {
      if (o.shouldStop?.()) {
        // Остановка: не отправленные письма сразу возвращаются в очередь (без ожидания конца аренды).
        const rest = claimed.rows.slice(i).map((r) => r.id);
        await pool.query(
          `UPDATE notification SET attempts = attempts - 1, next_attempt_at = now() WHERE id = ANY($1)`,
          [rest],
        );
        return sent;
      }
      try {
        await o.send({
          id: m.id,
          ticketId: m.ticket_id,
          to: m.email,
          subject: m.subject,
          body: m.body,
          high: m.data.priority === 'high',
        });
        await pool.query(
          `UPDATE notification SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`,
          [m.id],
        );
        sent++;
      } catch (err) {
        const fatal = m.attempts >= maxAttempts;
        await pool.query(
          `UPDATE notification SET last_error = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END,
                  next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [m.id, String(err).slice(0, 500), fatal, retryDelaySeconds(m.attempts)],
        );
      }
    }
  }
  return sent;
}
