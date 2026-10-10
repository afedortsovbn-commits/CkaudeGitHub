import type { Pool, PoolClient } from 'pg';
import { VOICE_BUSY } from './ivr';
import { type CalendarOverride, defaultDayKind } from './work-calendar';

/**
 * Политика распределения обращений (доработки 07.10.2026; Д-017 «по загрузке» 10.10.2026).
 *
 * Режим `standard` — по группам каналов: звонки, почта, остальное — текстовые (чат, Telegram, приложение,
 * отзывы, API).
 * - Режим группы: `auto` — назначать оператору (кто дольше без обращений по стратегии очереди); `pull` —
 *   показывать всем в очереди, кто первый взял. Звонки — всегда `auto` (звонок не может ждать в списке).
 * - `idleScope`: `combined` — «дольше без обращений» считается по всем каналам вместе; `split` — отдельно по
 *   группе канала (текстовые, голосовые, почта).
 *
 * Режим `load` — «по загрузке» (Д-017): звонки и чаты (ранги 1–3) система назначает сама по свободной ёмкости
 * оператора (100 единиц: звонок 100, чат с ожиданием ответа 40, чат с молчащим клиентом 10, постобработка 100);
 * отзывы, почта и согласования (ранги 4–5) ждут в неспешной очереди — оператор берёт верхнее кнопкой «Взять
 * следующее». У неспешных обращений есть срок (`conversation.due_at`); когда израсходовано `agingThreshold`
 * срока, обращение поднимается на ранг выше (не выше 3).
 *
 * `sticky` (во всех режимах): новое обращение клиента сначала предлагается оператору, который вёл этого клиента
 * последним (за `stickyDays` дней), — если он на линии, «Готов» и свободен; иначе — как обычно.
 */
export type ChannelGroup = 'text' | 'voice' | 'email';
export type RoutingMode = 'standard' | 'load';

export interface LoadPolicy {
  /** Ёмкость оператора — 100; стоимость занятости в единицах. */
  cost: { voice: number; chatWaitingAgent: number; chatWaitingClient: number; wrapUp: number };
  /** Минимум свободной ёмкости, чтобы взять неспешное обращение кнопкой. */
  pullMinFree: number;
  /** Негативный отзыв (ранг 4) после старения назначать автоматически (В-017-1; по умолчанию — ждать кнопки). */
  pushUrgent: boolean;
  /** Доля срока (0…1), после которой неспешное обращение поднимается на ранг выше. */
  agingThreshold: number;
}

export interface RoutingPolicy {
  mode: RoutingMode;
  text: 'auto' | 'pull';
  voice: 'auto';
  email: 'auto' | 'pull';
  idleScope: 'combined' | 'split';
  sticky: boolean;
  stickyDays: number;
  load: LoadPolicy;
  /** Постобработка после звонка в режиме «по загрузке»: таймер и кнопка «+2 мин» (В-017-2: повторно — можно). */
  wrapUp: { seconds: number; extendSeconds: number; extendRepeat: boolean };
  /** Молчание клиента в чате: через `silenceCloseMin` минут чат закрывается с сообщением клиенту. */
  chat: { silenceCloseMin: number; silenceCloseText: string };
  /** Отзывы: «только оценка без текста» — шаблонный ответ или без ответа (В-017-4); сроки ответа, ч (В-017-3). */
  reviews: {
    ratingOnly: 'template' | 'none';
    ratingOnlyText: string;
    positiveDueHours: number;
    negativeDueHours: number;
  };
  /** Срок ответа на письмо, рабочих дней (по производственному календарю). */
  emailDueBusinessDays: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  mode: 'standard',
  text: 'auto',
  voice: 'auto',
  email: 'auto',
  idleScope: 'combined',
  sticky: false,
  stickyDays: 30,
  load: {
    cost: { voice: 100, chatWaitingAgent: 40, chatWaitingClient: 10, wrapUp: 100 },
    pullMinFree: 40,
    pushUrgent: false,
    agingThreshold: 0.8,
  },
  wrapUp: { seconds: 60, extendSeconds: 120, extendRepeat: true },
  chat: {
    silenceCloseMin: 15,
    silenceCloseText:
      'Мы закрываем диалог, так как давно не получали от вас ответа. Если остались вопросы — напишите, мы ответим.',
  },
  reviews: {
    ratingOnly: 'template',
    ratingOnlyText:
      'Спасибо за вашу оценку! Если у вас есть вопросы или пожелания — напишите нам, мы обязательно ответим.',
    positiveDueHours: 24,
    negativeDueHours: 8,
  },
  emailDueBusinessDays: 1,
};

/** Ёмкость оператора в режиме «по загрузке». */
export const LOAD_CAPACITY = 100;

export const channelGroup = (kind: string): ChannelGroup =>
  kind === 'voice' ? 'voice' : kind === 'email' ? 'email' : 'text';

/** Столбец «когда последний раз назначали» для ранжирования по политике. */
export const idleColumn = (p: RoutingPolicy, group: ChannelGroup): string =>
  p.idleScope === 'split' ? `last_${group}_at` : 'last_assigned_at';

const int = (v: unknown, def: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const str = (v: unknown, def: string, max = 2000): string =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : def;

/** Разбор сохранённого значения настройки `routing.policy` с умолчаниями и границами (для любых старых записей). */
export function parseRoutingPolicy(raw: unknown): RoutingPolicy {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const D = DEFAULT_ROUTING_POLICY;
  const load = (v.load ?? {}) as Record<string, unknown>;
  const cost = (load.cost ?? {}) as Record<string, unknown>;
  const wrapUp = (v.wrapUp ?? {}) as Record<string, unknown>;
  const chat = (v.chat ?? {}) as Record<string, unknown>;
  const reviews = (v.reviews ?? {}) as Record<string, unknown>;
  const aging = Number(load.agingThreshold);
  return {
    mode: v.mode === 'load' ? 'load' : 'standard',
    text: v.text === 'pull' ? 'pull' : 'auto',
    voice: 'auto',
    email: v.email === 'pull' ? 'pull' : 'auto',
    idleScope: v.idleScope === 'split' ? 'split' : 'combined',
    sticky: v.sticky === true,
    stickyDays: int(v.stickyDays, D.stickyDays, 1, 365),
    load: {
      cost: {
        voice: int(cost.voice, D.load.cost.voice, 0, LOAD_CAPACITY),
        chatWaitingAgent: int(cost.chatWaitingAgent, D.load.cost.chatWaitingAgent, 1, LOAD_CAPACITY),
        chatWaitingClient: int(cost.chatWaitingClient, D.load.cost.chatWaitingClient, 0, LOAD_CAPACITY),
        wrapUp: int(cost.wrapUp, D.load.cost.wrapUp, 0, LOAD_CAPACITY),
      },
      pullMinFree: int(load.pullMinFree, D.load.pullMinFree, 0, LOAD_CAPACITY),
      pushUrgent: load.pushUrgent === true,
      agingThreshold:
        Number.isFinite(aging) && aging >= 0 && aging <= 1
          ? Math.round(aging * 100) / 100
          : D.load.agingThreshold,
    },
    wrapUp: {
      seconds: int(wrapUp.seconds, D.wrapUp.seconds, 0, 3600),
      extendSeconds: int(wrapUp.extendSeconds, D.wrapUp.extendSeconds, 10, 3600),
      extendRepeat: wrapUp.extendRepeat !== false,
    },
    chat: {
      silenceCloseMin: int(chat.silenceCloseMin, D.chat.silenceCloseMin, 0, 1440),
      silenceCloseText: str(chat.silenceCloseText, D.chat.silenceCloseText),
    },
    reviews: {
      ratingOnly: reviews.ratingOnly === 'none' ? 'none' : 'template',
      ratingOnlyText: str(reviews.ratingOnlyText, D.reviews.ratingOnlyText),
      positiveDueHours: int(reviews.positiveDueHours, D.reviews.positiveDueHours, 1, 720),
      negativeDueHours: int(reviews.negativeDueHours, D.reviews.negativeDueHours, 1, 720),
    },
    emailDueBusinessDays: int(v.emailDueBusinessDays, D.emailDueBusinessDays, 1, 30),
  };
}

export async function loadRoutingPolicy(db: Pool | PoolClient): Promise<RoutingPolicy> {
  const r = await db.query<{ value: unknown }>(
    `SELECT value FROM system_setting WHERE key = 'routing.policy'`,
  );
  return parseRoutingPolicy(r.rows[0]?.value);
}

/** Отметить, что оператору назначено обращение (общая отметка и отметка группы канала). */
export async function markAssigned(
  db: Pool | PoolClient,
  userId: string,
  channelKind: string,
): Promise<void> {
  const col = `last_${channelGroup(channelKind)}_at`;
  await db.query(
    `UPDATE agent_status SET last_assigned_at = now(), ${col} = now(), updated_at = now() WHERE user_id = $1`,
    [userId],
  );
}

// ------------------------------------------------------------------ режим «по загрузке» (Д-017)

/** Каналы чата (ранг 3): всё текстовое, кроме почты и отзывов. */
export const CHAT_KINDS_SQL = `NOT IN ('voice', 'email', 'review')`;

/**
 * Базовый ранг обращения в очереди (п.2 спецификации Д-017), выражение над псевдонимом `c`: 1 — звонок, 3 — чат,
 * 4 — негативный отзыв / «Срочное» / «Особо важное» (флаги ставят правила маршрутизации, низкая оценка отзыва и
 * сотрудник), 5 — почта, положительные отзывы, прочее неспешное. Ранг 2 (ответ клиента в открытом чате) в очередь
 * не попадает — он учитывается в ёмкости оператора.
 */
export const BASE_RANK_SQL = `CASE WHEN c.channel_kind = 'voice' THEN 1
  WHEN c.channel_kind ${CHAT_KINDS_SQL} THEN 3
  WHEN c.is_urgent OR c.is_important THEN 4 ELSE 5 END`;

export interface QueuedItem {
  id: string;
  queueId: string | null;
  baseRank: number;
  priority: number;
  queuedAt: string | Date;
  dueAt: string | Date | null;
}

/** Эффективный ранг со старением: ранги 4–5 поднимаются на один, когда израсходована доля срока (не выше 3). */
export function effectiveRank(item: QueuedItem, policy: RoutingPolicy, now = new Date()): number {
  if (item.baseRank < 4 || !item.dueAt) return item.baseRank;
  const q = new Date(item.queuedAt).getTime();
  const d = new Date(item.dueAt).getTime();
  const spent = d <= q ? 1 : (now.getTime() - q) / (d - q);
  return spent >= policy.load.agingThreshold ? Math.max(3, item.baseRank - 1) : item.baseRank;
}

/** Назначается системой (push): звонки и чаты; негативный отзыв после старения — только при `pushUrgent`. */
export const isPushItem = (item: QueuedItem, policy: RoutingPolicy, now = new Date()): boolean =>
  item.baseRank <= 3 ||
  (policy.load.pushUrgent && item.baseRank === 4 && effectiveRank(item, policy, now) === 3);

/** Неспешная очередь (pull): берётся кнопкой «Взять следующее». */
export const isPullItem = (item: QueuedItem): boolean => item.baseRank >= 4;

/** Порядок выдачи: эффективный ранг, затем приоритет (выше — раньше), затем кто дольше ждёт. */
export function sortByUrgency<T extends QueuedItem>(
  items: T[],
  policy: RoutingPolicy,
  now = new Date(),
): T[] {
  const rank = new Map(items.map((i) => [i.id, effectiveRank(i, policy, now)]));
  return [...items].sort(
    (a, b) =>
      rank.get(a.id)! - rank.get(b.id)! ||
      b.priority - a.priority ||
      new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime(),
  );
}

export const QUEUED_ITEM_COLS = `c.id, c.queue_id, ${BASE_RANK_SQL} AS base_rank, c.priority, c.queued_at, c.due_at`;
export const toQueuedItem = (r: {
  id: string;
  queue_id: string | null;
  base_rank: number;
  priority: number;
  queued_at: string | Date;
  due_at: string | Date | null;
}): QueuedItem => ({
  id: r.id,
  queueId: r.queue_id,
  baseRank: Number(r.base_rank),
  priority: Number(r.priority),
  queuedAt: r.queued_at,
  dueAt: r.due_at,
});

/**
 * Занятость оператора в единицах ёмкости (п.4 Д-017) — выражение над столбцом внешнего запроса `ref` (он должен
 * называться `user_id`, как требует VOICE_BUSY, и быть квалифицирован псевдонимом — `cand.user_id`): звонок,
 * постобработка, чаты (клиент ждёт ответа — последнее сообщение от клиента или обращение только предложено;
 * иначе оператор ждёт клиента). Отзывы и почта в работе ёмкость не расходуют.
 */
export function loadSql(p: RoutingPolicy, ref: string): string {
  const c = p.load.cost;
  return `((CASE WHEN ${VOICE_BUSY} THEN ${c.voice} ELSE 0 END)
    + (CASE WHEN (SELECT a2.status FROM agent_status a2 WHERE a2.user_id = ${ref}) = 'wrap_up' THEN ${c.wrapUp} ELSE 0 END)
    + COALESCE((SELECT sum(CASE WHEN cv.status = 'offered'
                 OR (SELECT m.direction FROM message m WHERE m.conversation_id = cv.id AND m.direction IN ('in', 'out')
                      ORDER BY m.sent_at DESC, m.seq DESC LIMIT 1) = 'in' THEN ${c.chatWaitingAgent}
                 ELSE ${c.chatWaitingClient} END)
          FROM conversation cv WHERE cv.assignee_id = ${ref} AND cv.status IN ('active', 'hold', 'offered')
            AND cv.channel_kind ${CHAT_KINDS_SQL}), 0))`;
}

/** Занятость одного оператора (единиц). */
export async function operatorLoad(db: Pool | PoolClient, userId: string, p: RoutingPolicy): Promise<number> {
  const r = await db.query<{ load: number }>(
    `SELECT ${loadSql(p, 'u.user_id')}::int AS load FROM (SELECT $1::uuid AS user_id) u`,
    [userId],
  );
  return Number(r.rows[0]?.load ?? 0);
}

/**
 * Срок ответа при постановке в очередь (п.8 Д-017): отзыв — `negativeDueHours` (низкая оценка) или
 * `positiveDueHours`; письмо — `emailDueBusinessDays` рабочих дней по производственному календарю; остальное — без
 * срока.
 */
export async function dueAtFor(
  db: Pool | PoolClient,
  p: RoutingPolicy,
  channelKind: string,
  review: { urgent?: boolean } | null,
  now = new Date(),
): Promise<Date | null> {
  if (channelKind === 'review')
    return new Date(
      now.getTime() + (review?.urgent ? p.reviews.negativeDueHours : p.reviews.positiveDueHours) * 3600_000,
    );
  if (channelKind !== 'email') return null;
  const from = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
  const ov = await db.query<CalendarOverride>(
    `SELECT to_char(on_date, 'YYYY-MM-DD') AS date, kind, note FROM work_calendar_day WHERE on_date BETWEEN $1 AND $2`,
    [from, horizon],
  );
  const kinds = new Map(ov.rows.map((o) => [o.date, o.kind]));
  const due = new Date(now);
  let left = p.emailDueBusinessDays;
  for (let i = 0; i < 60 && left > 0; i++) {
    due.setUTCDate(due.getUTCDate() + 1);
    const date = due.toISOString().slice(0, 10);
    const kind = kinds.get(date) ?? defaultDayKind(date);
    if (kind === 'work' || kind === 'short') left--;
  }
  return due;
}
