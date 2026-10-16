import { newId } from '@cc/contracts';
import type { Pool, PoolClient } from 'pg';

/**
 * Настраиваемые уведомления о событиях (Д-012): по каждому событию правила `notify_rule` задают каналы (интерфейс,
 * почта, Telegram) и получателей (роли и/или сотрудники). События «по желанию сотрудника» (optIn) приходят только
 * тем, кто сам включил их в профиле (`user_notify_pref`). Письма и Telegram отправляет worker из очереди
 * `notification`; интерфейс (колокольчик) — сразу.
 */
export type NotifyChannel = 'ui' | 'email' | 'telegram';
export const NOTIFY_CHANNELS: NotifyChannel[] = ['ui', 'email', 'telegram'];

/**
 * Условие получения в матрице уведомлений (Д-094): «всегда» или только если сотрудник связан с объектом события —
 * ответственный или куратор тикета, создатель (передал на 2-ю линию), оператор, который ведёт обращение.
 */
export type NotifyRelation = 'all' | 'responsible' | 'curator' | 'creator' | 'assignee';
export const NOTIFY_RELATIONS: NotifyRelation[] = ['all', 'responsible', 'curator', 'creator', 'assignee'];

export interface NotifyEventDef {
  title: string;
  description: string;
  /** По желанию сотрудника: получатель — сам сотрудник, каналы — из его профиля. */
  optIn: boolean;
  group: 'line' | 'second' | 'system' | 'me';
  /** Каналы, по которым система шлёт это событие всегда (колокольчик по тикетам, тестам, рассылкам) — в профиле
   *  они не выключаются, а правила/настройки добавляют только остальные каналы. */
  fixedChannels?: NotifyChannel[];
  /** Условия, которые можно выбрать в матрице (кроме «всегда»): связь сотрудника с объектом события. */
  relations?: Exclude<NotifyRelation, 'all'>[];
}

const TICKET_RELATIONS: Exclude<NotifyRelation, 'all'>[] = ['responsible', 'curator', 'creator'];

export const NOTIFY_EVENTS: Record<string, NotifyEventDef> = {
  'operators.below_min': {
    title: 'Операторов на линии меньше минимума',
    description: 'Оператор пытается уйти с линии ниже минимума или на линии уже меньше, чем задано по часам',
    optIn: false,
    group: 'line',
  },
  'queue.long_wait': {
    title: 'Клиент ждёт в очереди дольше порога',
    description: 'Порог — «ожидание, красный» в порогах панели супервизора',
    optIn: false,
    group: 'line',
  },
  'queue.no_free': {
    title: 'В очереди есть клиенты, свободных операторов нет',
    description: 'Не чаще одного раза в 10 минут',
    optIn: false,
    group: 'line',
  },
  'conversation.overdue': {
    title: 'Просрочен срок ответа на обращение',
    description: 'Отзывы, почта, заявления в очереди дольше срока по каналу',
    optIn: false,
    group: 'line',
  },
  'review.negative': {
    title: 'Поступил негативный отзыв',
    description: 'Отзыв с низкой оценкой из канала «Отзывы с карт»',
    optIn: false,
    group: 'line',
  },
  'ticket.created': {
    title: 'Обращение передано на 2-ю линию',
    description: 'Создан тикет 2-й линии (особо важные и срочные — с пометкой)',
    optIn: false,
    group: 'second',
    relations: TICKET_RELATIONS,
  },
  'ticket.overdue': {
    title: 'Просрочен тикет 2-й линии',
    description: 'Раз в день по каждому просроченному тикету',
    optIn: false,
    group: 'second',
    relations: TICKET_RELATIONS,
  },
  'ticket.open_reminder': {
    title: 'Есть незакрытые обращения на 2-й линии',
    description: 'Утром в рабочие дни (9:00) — сколько тикетов ещё не закрыто и сколько из них просрочено',
    optIn: false,
    group: 'second',
    relations: TICKET_RELATIONS,
  },
  'break.violation': {
    title: 'Нарушение перерыва по графику',
    description: 'Оператор не ушёл на перерыв или не вернулся вовремя',
    optIn: false,
    group: 'system',
  },
  'resource.alert': {
    title: 'Ресурсы сервера на пределе',
    description: 'Диск, память, подкачка, процессор, соединения с базой',
    optIn: false,
    group: 'system',
  },
  'my.conversation': {
    title: 'Мне предложено обращение',
    description: 'Система предложила или передала мне обращение',
    optIn: true,
    group: 'me',
  },
  'my.ticket': {
    title: 'Мои обращения 2-й линии',
    description: 'Назначение, согласование, возврат, комментарии по моим тикетам',
    optIn: true,
    group: 'me',
    fixedChannels: ['ui', 'email'],
  },
  'my.test': {
    title: 'Мои тесты и обучение',
    description: 'Назначен тест или курс, приближается срок',
    optIn: true,
    group: 'me',
    fixedChannels: ['ui'],
  },
  'my.message': {
    title: 'Сообщения от руководителя',
    description: 'Рассылки сотрудникам',
    optIn: true,
    group: 'me',
    fixedChannels: ['ui'],
  },
  'my.shift': {
    title: 'Напоминание о завтрашней смене',
    description: 'Вечером накануне смены по опубликованному графику',
    optIn: true,
    group: 'me',
  },
};

export interface NoticeInput {
  event: string;
  subject: string;
  body?: string;
  data?: Record<string, unknown>;
  /** Основа ключа идемпотентности; к ней добавляются канал и получатель. */
  dedupe: string;
  /** Кому лично (события «по желанию» — по их настройкам; прочие — дополнительно к правилам). */
  targetUserIds?: string[];
  /** Нет правил по событию — получатели по правам (прежнее поведение), только в интерфейс. */
  fallbackPerms?: string[];
  high?: boolean;
  /** Кто связан с объектом события (для условий матрицы, Д-094): ответственные, кураторы, создатель, оператор. */
  relations?: Partial<Record<Exclude<NotifyRelation, 'all'>, string[]>>;
  /** Ограничить получателей (личная сводка, например напоминание о незакрытых тикетах). */
  onlyUserIds?: string[];
}

/** Подходит ли строка матрицы под событие: «всегда» или сотрудник связан с объектом нужным образом. */
export function matrixMatches(
  conditions: string[],
  userId: string,
  relations: NoticeInput['relations'] = {},
): boolean {
  if (!conditions.length || conditions.includes('all')) return true;
  return conditions.some((c) => (relations[c as Exclude<NotifyRelation, 'all'>] ?? []).includes(userId));
}

/**
 * Чат Telegram сотрудника: привязанный кодом из профиля, иначе номер чата, указанный в справочнике сотрудников
 * (Д-094; «@имя» боту недостаточно — бот не может написать первым, нужен номер чата или привязка).
 */
export const TELEGRAM_CHAT_SQL = `COALESCE(telegram_chat_id, CASE WHEN telegram_contact ~ '^-?[0-9]{5,}$' THEN telegram_contact END)`;

/** Отправить уведомление по правилам события. Возвращает число созданных записей. */
export async function emitNotice(db: Pool | PoolClient, n: NoticeInput): Promise<number> {
  const def = NOTIFY_EVENTS[n.event];
  const plan = new Map<string, Set<NotifyChannel>>();
  const add = (userId: string, channels: string[]) => {
    const set = plan.get(userId) ?? new Set<NotifyChannel>();
    for (const c of channels) if ((NOTIFY_CHANNELS as string[]).includes(c)) set.add(c as NotifyChannel);
    plan.set(userId, set);
  };
  if (!def?.optIn) {
    const rules = await db.query<{ channels: string[]; role_codes: string[]; user_ids: string[] }>(
      `SELECT channels, role_codes, user_ids FROM notify_rule WHERE event = $1 AND is_active`,
      [n.event],
    );
    if (rules.rows.length) {
      for (const r of rules.rows) {
        const users = await db.query<{ id: string }>(
          `SELECT u.id FROM app_user u
            WHERE u.is_active AND u.can_login AND (u.id = ANY($1::uuid[])
               OR EXISTS (SELECT 1 FROM user_role ur WHERE ur.user_id = u.id AND ur.role_code = ANY($2::text[])))`,
          [r.user_ids, r.role_codes],
        );
        for (const u of users.rows) add(u.id, r.channels);
      }
    } else if (n.fallbackPerms?.length) {
      const users = await db.query<{ id: string }>(
        `SELECT u.id FROM app_user u
          WHERE u.is_active AND u.can_login AND EXISTS (
            SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
             WHERE ur.user_id = u.id AND r.permissions && $1::text[])`,
        [n.fallbackPerms],
      );
      for (const u of users.rows) add(u.id, ['ui']);
    }
    // Д-094: матрица «сотрудник × событие» — каналы и условия у каждого сотрудника.
    const matrix = await db.query<{ user_id: string; channels: string[]; conditions: string[] }>(
      `SELECT m.user_id, m.channels, m.conditions FROM notify_matrix m JOIN app_user u ON u.id = m.user_id
        WHERE m.event = $1 AND cardinality(m.channels) > 0 AND u.is_active AND u.can_login`,
      [n.event],
    );
    for (const m of matrix.rows)
      if (matrixMatches(m.conditions, m.user_id, n.relations)) add(m.user_id, m.channels);
  }
  if (n.targetUserIds?.length) {
    const prefs = await db.query<{ user_id: string; channels: string[] }>(
      `SELECT user_id, channels FROM user_notify_pref WHERE event = $1 AND user_id = ANY($2::uuid[])`,
      [n.event, [...new Set(n.targetUserIds)]],
    );
    // Каналы, по которым система уже уведомила сама (fixedChannels), здесь не повторяются.
    const fixed = new Set<string>(def?.fixedChannels ?? []);
    for (const p of prefs.rows)
      add(
        p.user_id,
        p.channels.filter((c) => !fixed.has(c)),
      );
    // Д-094: каналы, назначенные сотруднику в матрице для события «по желанию», — вдобавок к его настройкам.
    const matrix = await db.query<{ user_id: string; channels: string[] }>(
      `SELECT user_id, channels FROM notify_matrix WHERE event = $1 AND user_id = ANY($2::uuid[])`,
      [n.event, [...new Set(n.targetUserIds)]],
    );
    for (const m of matrix.rows)
      add(
        m.user_id,
        m.channels.filter((c) => !fixed.has(c)),
      );
  }
  if (n.onlyUserIds) {
    const only = new Set(n.onlyUserIds);
    for (const id of [...plan.keys()]) if (!only.has(id)) plan.delete(id);
  }
  if (!plan.size) return 0;
  const users = await db.query<{
    id: string;
    email: string | null;
    telegram_chat_id: string | null;
    email_unsubscribed_at: string | null;
  }>(
    `SELECT id, email, ${TELEGRAM_CHAT_SQL} AS telegram_chat_id, email_unsubscribed_at FROM app_user WHERE id = ANY($1::uuid[])`,
    [[...plan.keys()]],
  );
  let created = 0;
  for (const u of users.rows) {
    for (const channel of plan.get(u.id) ?? []) {
      if (channel === 'email' && (!u.email || u.email_unsubscribed_at)) continue;
      if (channel === 'telegram' && !u.telegram_chat_id) continue;
      const r = await db.query(
        `INSERT INTO notification (id, user_id, kind, channel, dedupe_key, subject, body, data, status, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          newId(),
          u.id,
          n.event,
          channel,
          `${n.dedupe}:${channel}:${u.id}`,
          channel === 'ui' ? n.subject.replace(/^Важно! /, '') : n.subject,
          n.body ?? '',
          JSON.stringify({ priority: n.high ? 'high' : 'normal', ...(n.data ?? {}) }),
          channel === 'ui' ? 'sent' : 'pending',
          channel === 'ui' ? new Date() : null,
        ],
      );
      created += r.rowCount ?? 0;
    }
  }
  return created;
}

/** Настройки бота Telegram для сотрудников (`notify.telegram`). */
export interface StaffTelegramSettings {
  botToken: string | null;
  apiRoot: string;
  miniAppUrl: string | null;
  botUsername: string | null;
}

export async function loadStaffTelegram(db: Pool | PoolClient): Promise<StaffTelegramSettings> {
  const r = await db.query<{ value: Record<string, unknown> }>(
    `SELECT value FROM system_setting WHERE key = 'notify.telegram'`,
  );
  const v = r.rows[0]?.value ?? {};
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  return {
    botToken: str(v.botToken),
    apiRoot: str(v.apiRoot) ?? 'https://api.telegram.org',
    miniAppUrl: str(v.miniAppUrl),
    botUsername: str(v.botUsername),
  };
}

/**
 * Очередь уведомлений в Telegram (worker): запись арендуется (SKIP LOCKED + сдвиг next_attempt_at), после успешной
 * отправки — sent; сбой — повтор с нарастающей задержкой, после maxAttempts — failed. Сотрудник без привязанного
 * Telegram — skipped.
 */
export async function processTelegramQueue(
  pool: Pool,
  o: {
    send: (chatId: string, text: string) => Promise<void>;
    batch?: number;
    maxAttempts?: number;
    leaseSeconds?: number;
    shouldStop?: () => boolean;
  },
): Promise<number> {
  const maxAttempts = o.maxAttempts ?? 6;
  let sent = 0;
  await pool.query(
    `UPDATE notification n SET status = 'skipped', last_error = 'Telegram не привязан'
       FROM app_user u WHERE u.id = n.user_id AND n.channel = 'telegram' AND n.status = 'pending'
        AND ${TELEGRAM_CHAT_SQL.replace(/telegram_/g, 'u.telegram_')} IS NULL`,
  );
  for (;;) {
    if (o.shouldStop?.()) break;
    const claimed = await pool.query<{
      id: string;
      subject: string;
      body: string;
      attempts: number;
      chat: string;
    }>(
      `UPDATE notification n SET attempts = n.attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
         FROM app_user u
        WHERE n.id IN (SELECT id FROM notification
                        WHERE channel = 'telegram' AND status = 'pending' AND next_attempt_at <= now()
                        ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
          AND u.id = n.user_id AND ${TELEGRAM_CHAT_SQL.replace(/telegram_/g, 'u.telegram_')} IS NOT NULL
        RETURNING n.id, n.subject, n.body, n.attempts, ${TELEGRAM_CHAT_SQL.replace(/telegram_/g, 'u.telegram_')} AS chat`,
      [o.batch ?? 20, o.leaseSeconds ?? 120],
    );
    if (!claimed.rows.length) break;
    for (const m of claimed.rows) {
      if (o.shouldStop?.()) return sent;
      try {
        await o.send(m.chat, m.body ? `${m.subject}\n\n${m.body}` : m.subject);
        await pool.query(
          `UPDATE notification SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`,
          [m.id],
        );
        sent++;
      } catch (err) {
        const failed = m.attempts >= maxAttempts;
        await pool.query(
          `UPDATE notification SET status = $2, last_error = $3,
                  next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [
            m.id,
            failed ? 'failed' : 'pending',
            String(err).slice(0, 500),
            Math.min(60 * 2 ** m.attempts, 3600),
          ],
        );
      }
    }
  }
  return sent;
}
