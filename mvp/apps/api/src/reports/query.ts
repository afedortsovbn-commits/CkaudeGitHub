import { type Principal, scopeFilter } from '@cc/auth';
import type { ReportFilter, ReportGroup } from '@cc/contracts';
import type { Db } from '../lib/db';
import { badRequest } from '../lib/errors';

/** Параметры SQL-запроса: `q.p(v)` добавляет значение и возвращает `$n`. */
export class Params {
  readonly list: unknown[] = [];
  p(v: unknown): string {
    this.list.push(v);
    return `$${this.list.length}`;
  }
  /** Параметр добавляется, только если выражение действительно попало в запрос (неиспользуемый $n — ошибка). */
  lazy(v: unknown): () => string {
    let ph: string | undefined;
    return () => (ph ??= this.p(v));
  }
}

export interface Period {
  /** Локальные даты периода (включительно) — для заголовка отчёта и CSV. */
  from: string;
  to: string;
  /** Границы [t0, t1) в UTC: полночь начала `from` и полночь после `to` по часовому поясу системы. */
  t0: Date;
  t1: Date;
  timezone: string;
  /** Сегодня (локальная дата) — для «просрочено на сегодня». */
  today: string;
}

const MAX_DAYS = 366;

/**
 * Период отчёта по часовому поясу системы (M-REP-03: единый часовой пояс, Europe/Minsk). Без дат — последние
 * 7 дней, включая сегодня.
 */
export async function resolvePeriod(db: Db, f: ReportFilter, now = new Date()): Promise<Period> {
  const tzRow = await db.query<{ v: string | null }>(
    `SELECT value #>> '{}' AS v FROM system_setting WHERE key = 'system.timezone'`,
  );
  const timezone = tzRow.rows[0]?.v || 'Europe/Minsk';
  const { rows } = await db.query<{
    today: string;
    from: string;
    to: string;
    t0: Date;
    t1: Date;
    days: number;
  }>(
    `WITH d AS (
       SELECT (($3::timestamptz) AT TIME ZONE $4::text)::date AS today)
     SELECT to_char(d.today, 'YYYY-MM-DD') AS today,
            to_char(COALESCE($1::date, COALESCE($2::date, d.today) - 6), 'YYYY-MM-DD') AS "from",
            to_char(COALESCE($2::date, d.today), 'YYYY-MM-DD') AS "to",
            (COALESCE($1::date, COALESCE($2::date, d.today) - 6))::timestamp AT TIME ZONE $4::text AS t0,
            (COALESCE($2::date, d.today) + 1)::timestamp AT TIME ZONE $4::text AS t1,
            COALESCE($2::date, d.today) - COALESCE($1::date, COALESCE($2::date, d.today) - 6) + 1 AS days
       FROM d`,
    [f.from ?? null, f.to ?? null, now, timezone],
  );
  const r = rows[0]!;
  if (r.days < 1) throw badRequest('Начало периода позже конца');
  if (r.days > MAX_DAYS) throw badRequest(`Период отчёта — не больше ${MAX_DAYS} дней`);
  return { from: r.from, to: r.to, t0: r.t0, t1: r.t1, timezone, today: r.today };
}

/** Столбцы строки с измерениями обращения/тикета (SQL-выражения). */
export interface DimCols {
  channel?: string;
  queue?: string;
  enterprise: string;
  department: string;
  topicPath: string;
  object?: string;
  important: string;
  /** Оператор (для фильтра «оператор»), если применим. */
  operator?: string;
  /** Выражение uuid[] назначенных тикета (ответственные и кураторы) — для фильтра и области видимости. */
  ticketAssignees?: string;
  /** id обращения (text) — для фильтра «ответственный/куратор» через тикеты обращения. */
  conversationId?: string;
}

/**
 * Условия фильтров отчёта и области видимости сотрудника (единый предикат scopeFilter из @cc/auth,
 * M-ORG-07). Назначенный ответственный или куратор видит «свои» тикеты независимо от области.
 */
export function dimWhere(q: Params, cols: DimCols, f: ReportFilter, principal: Principal): string[] {
  const w: string[] = [];
  if (f.channel && cols.channel) w.push(`${cols.channel} = ${q.p(f.channel)}`);
  if (f.queueId && cols.queue) w.push(`${cols.queue} = ${q.p(f.queueId)}::uuid`);
  if (f.enterpriseId) w.push(`${cols.enterprise} = ${q.p(f.enterpriseId)}::uuid`);
  if (f.departmentId) w.push(`${cols.department} = ${q.p(f.departmentId)}::uuid`);
  if (f.topicId) w.push(`${q.p(f.topicId)}::uuid = ANY(${cols.topicPath})`);
  if (f.objectId && cols.object) w.push(`${cols.object} = ${q.p(f.objectId)}::uuid`);
  if (f.important !== undefined) w.push(`COALESCE(${cols.important}, false) = ${q.p(f.important)}`);
  if (f.operatorId && cols.operator) w.push(`${cols.operator} = ${q.p(f.operatorId)}::uuid`);
  if (f.assigneeId) {
    if (cols.ticketAssignees) w.push(`${q.p(f.assigneeId)}::uuid = ANY(${cols.ticketAssignees})`);
    else if (cols.conversationId)
      w.push(
        `EXISTS (SELECT 1 FROM ticket tf JOIN ticket_assignee taf ON taf.ticket_id = tf.id
                  WHERE tf.conversation_id = (${cols.conversationId})::uuid AND taf.user_id = ${q.p(f.assigneeId)}::uuid)`,
      );
  }
  const sc = scopeFilter(
    principal.scope,
    { enterprise: cols.enterprise, department: cols.department, topicPath: cols.topicPath },
    q.list.length + 1,
  );
  q.list.push(...sc.params);
  if (cols.ticketAssignees)
    w.push(`(${sc.sql} OR ${q.p(principal.id)}::uuid = ANY(${cols.ticketAssignees}))`);
  else w.push(sc.sql);
  return w;
}

/**
 * Последнее состояние каждого обращения, у которого есть события в периоде (измерения — на конец периода:
 * обращение, классифицированное позже, попадает в отчёт со своей итоговой темой). CTE `cev` — все события
 * этих обращений до конца периода, `conv` — последнее состояние.
 */
export function convCtes(q: Params, t0: Date, t1: Date): string {
  const a = q.p(t0);
  const b = q.p(t1);
  return `
  conv_ids AS (
    SELECT DISTINCT e.data ->> 'conversationId' AS cid FROM event e
     WHERE e.occurred_at >= ${a} AND e.occurred_at < ${b} AND e.type LIKE 'conversation.%' AND e.data ? 'conversationId'),
  cev AS (
    SELECT e.id, e.type, e.occurred_at AS at, e.data, e.data ->> 'conversationId' AS cid
      FROM conv_ids i JOIN event e ON e.data ->> 'conversationId' = i.cid AND e.data ? 'conversationId'
     WHERE e.type LIKE 'conversation.%' AND e.occurred_at < ${b}),
  conv AS (
    SELECT DISTINCT ON (cid) cid,
           data ->> 'channelKind' AS channel, data ->> 'status' AS status,
           (data ->> 'queueId')::uuid AS queue_id, (data ->> 'assigneeId')::uuid AS assignee_id,
           (data ->> 'enterpriseId')::uuid AS enterprise_id, (data ->> 'departmentId')::uuid AS department_id,
           cc_uuid_array(data -> 'topicPath') AS topic_path,
           COALESCE((data ->> 'topicId')::uuid,
                    (cc_uuid_array(data -> 'topicPath'))[cardinality(cc_uuid_array(data -> 'topicPath'))]) AS topic_id,
           (data ->> 'objectId')::uuid AS object_id,
           COALESCE((data ->> 'isImportant')::boolean, false) AS is_important
      FROM cev ORDER BY cid, at DESC, id DESC)`;
}

/**
 * Смены статуса/оператора обращения по журналу (`tr`): каждое событие обращения несёт статус после изменения,
 * поэтому история статусов восстанавливается без отдельной таблицы. `rn` — порядковый номер смены,
 * `next_nw_rn` — номер ближайшей следующей смены на статус «вне очереди» (конец эпизода ожидания).
 */
export const TRANSITION_CTES = `
  tr_all AS (
    SELECT cid, id, at, data ->> 'status' AS st, data ->> 'assigneeId' AS asg, (data ->> 'queueId')::uuid AS qid,
           LAG(data ->> 'status') OVER w AS pst, LAG(data ->> 'assigneeId') OVER w AS pasg
      FROM cev WHERE data ? 'status'
    WINDOW w AS (PARTITION BY cid ORDER BY at, id)),
  tr0 AS (
    SELECT cid, id, at, st, asg, qid, pst, pasg,
           ROW_NUMBER() OVER (PARTITION BY cid ORDER BY at, id) AS rn
      FROM tr_all WHERE pst IS NULL OR st IS DISTINCT FROM pst OR asg IS DISTINCT FROM pasg),
  tr AS (
    SELECT tr0.*,
           MIN(CASE WHEN st NOT IN ('queued', 'offered') THEN rn END)
             OVER (PARTITION BY cid ORDER BY rn ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS next_nw_rn
      FROM tr0),
  -- Эпизод ожидания: вход в очередь (queued/offered из любого другого статуса) → первый статус вне очереди.
  -- answered — оператор принял (active), abandoned — закрыто в очереди (клиент ушёл), other — вернулось в IVR/бот.
  ep AS (
    SELECT s.cid, s.at AS start_at, e.at AS end_at, e.st AS end_st, (e.asg)::uuid AS end_asg,
           COALESCE(e.qid, s.qid) AS queue_id,
           EXTRACT(EPOCH FROM e.at - s.at)::float8 AS wait_s,
           -- Постановка после перевода: обращение попало в очередь от оператора (В-51 — настраивается, считать ли
           -- её новым поступлением).
           COALESCE(s.pst, '') IN ('active', 'hold', 'wrap_up') AS after_transfer,
           CASE WHEN e.st IS NULL THEN 'open'
                WHEN e.st IN ('active', 'hold', 'wrap_up') THEN 'answered'
                WHEN e.st = 'closed' THEN 'abandoned'
                ELSE 'other' END AS outcome
      FROM tr s LEFT JOIN tr e ON e.cid = s.cid AND e.rn = s.next_nw_rn
     WHERE s.st IN ('queued', 'offered') AND COALESCE(s.pst, '') NOT IN ('queued', 'offered')),
  -- Отрезок обработки: оператор ведёт обращение (active) до следующей смены статуса или оператора.
  seg AS (
    SELECT s.cid, s.at AS start_at, n.at AS end_at, (s.asg)::uuid AS user_id, s.qid AS queue_id,
           EXTRACT(EPOCH FROM n.at - s.at)::float8 AS dur_s
      FROM tr s LEFT JOIN tr n ON n.cid = s.cid AND n.rn = s.rn + 1
     WHERE s.st = 'active' AND s.asg IS NOT NULL)`;

/** Столбцы измерений последнего состояния обращения (`conv c`). */
export const CONV_DIMS: DimCols = {
  channel: 'c.channel',
  queue: 'c.queue_id',
  enterprise: 'c.enterprise_id',
  department: 'c.department_id',
  topicPath: 'c.topic_path',
  object: 'c.object_id',
  important: 'c.is_important',
  conversationId: 'c.cid',
};

/** Локальная дата момента (для разреза «по дням»). */
export const localDay = (expr: string, tzParam: () => string) =>
  `to_char((${expr}) AT TIME ZONE ${tzParam()}::text, 'YYYY-MM-DD')`;

const CHANNEL_NAMES: Record<string, string> = {
  voice: 'Телефон',
  webchat: 'Чат на сайте',
  app: 'Чат в приложении',
  telegram: 'Telegram',
  email: 'Email',
  api: 'Внешняя система (API)',
  review: 'Отзыв',
};
export const channelName = (k: string) => CHANNEL_NAMES[k] ?? k;

const RESULT_NAMES: Record<string, string> = {
  __open: 'Не закрыто',
  __2nd: 'На 2-й линии',
};

/** Подписи ключей разреза (названия справочников) одним запросом на измерение. */
export async function groupLabels(db: Db, group: ReportGroup, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = keys.filter((k) => /^[0-9a-f-]{36}$/i.test(k));
  const put = (list: { id: string; name: string }[]) => list.forEach((r) => out.set(r.id, r.name));
  const q = async (sql: string) => put((await db.query<{ id: string; name: string }>(sql, [ids])).rows);
  switch (group) {
    case 'channel':
      keys.forEach((k) => out.set(k, channelName(k)));
      break;
    case 'result':
      keys.forEach((k) => out.set(k, RESULT_NAMES[k] ?? k));
      break;
    case 'day':
      keys.forEach((k) => out.set(k, k));
      break;
    case 'queue':
      if (ids.length) await q(`SELECT id::text, name FROM queue WHERE id = ANY($1::uuid[])`);
      break;
    case 'operator':
      if (ids.length) await q(`SELECT id::text, full_name AS name FROM app_user WHERE id = ANY($1::uuid[])`);
      break;
    case 'enterprise':
      if (ids.length) await q(`SELECT id::text, name FROM enterprise WHERE id = ANY($1::uuid[])`);
      break;
    case 'department':
      if (ids.length) await q(`SELECT id::text, name FROM department WHERE id = ANY($1::uuid[])`);
      break;
    case 'object':
      if (ids.length) await q(`SELECT id::text, name FROM service_object WHERE id = ANY($1::uuid[])`);
      break;
    case 'topic':
    case 'subtopic':
      if (ids.length)
        await q(`SELECT t.id::text, string_agg(p.name, ' / ' ORDER BY array_position(t.path, p.id)) AS name
                   FROM topic t JOIN topic p ON p.id = ANY(t.path) WHERE t.id = ANY($1::uuid[]) GROUP BY t.id`);
      break;
    case 'assignee':
      break;
  }
  return out;
}
