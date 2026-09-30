import type { Principal } from '@cc/auth';
import {
  REPORT_CATALOG,
  type ReportColumn,
  type ReportFilter,
  type ReportGroup,
  type ReportKind,
  type ReportResult,
} from '@cc/contracts';
import type { Db } from '../lib/db';
import { badRequest } from '../lib/errors';
import {
  channelName,
  CONV_DIMS,
  convCtes,
  dimWhere,
  groupLabels,
  localDay,
  Params,
  type Period,
  resolvePeriod,
  TRANSITION_CTES,
} from './query';

/**
 * Упрощённая аналитика (Ф10, M-REP-03). Все отчёты, кроме реестра просроченных, считаются по журналу `event`
 * (M-REP-01): история статусов обращения восстанавливается по событиям (каждое несёт статус и измерения после
 * изменения), статусы операторов — по `agent.status_changed`, 2-я линия — по `ticket.*`. Реестр просроченных —
 * текущее состояние тикетов. Данные ограничены областью видимости сотрудника (scopeFilter).
 */
export interface ReportCtx {
  db: Db;
  principal: Principal;
  filter: ReportFilter;
  now?: Date;
}

type Row = Record<string, unknown>;

const col = (key: string, label: string, type: ReportColumn['type'] = 'int'): ReportColumn => ({
  key,
  label,
  type,
});

const GROUP_TITLES: Record<ReportGroup, string> = {
  channel: 'Канал',
  queue: 'Очередь',
  operator: 'Оператор',
  topic: 'Тема',
  subtopic: 'Тема / подтема',
  result: 'Результат обработки',
  enterprise: 'Предприятие',
  department: 'Предприятие / подразделение',
  object: 'Объект',
  day: 'Дата',
  assignee: 'Ответственный / куратор',
  rating: 'Оценка',
  platform: 'Площадка',
};

async function settingNum(db: Db, key: string, def: number): Promise<number> {
  const { rows } = await db.query<{ v: string | null }>(
    `SELECT value #>> '{}' AS v FROM system_setting WHERE key = $1`,
    [key],
  );
  const n = Number(rows[0]?.v);
  return Number.isFinite(n) && rows[0]?.v !== null && rows[0]?.v !== undefined ? n : def;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Строки с GROUPING SETS ((gkey), ()): подписи, сортировка и строка «Итого». */
async function finish(
  db: Db,
  group: ReportGroup,
  raw: Row[],
  metricKeys: string[],
): Promise<{ rows: Row[]; totals: Row | null }> {
  const data = raw.filter((r) => !r.is_total);
  const total = raw.find((r) => r.is_total);
  const keys = data.map((r) => (r.gkey === null ? '' : String(r.gkey)));
  const labels = await groupLabels(db, group, keys);
  const conv = (r: Row): Row => {
    const o: Row = {};
    for (const k of metricKeys) o[k] = r[k] === null || r[k] === undefined ? null : Number(r[k]);
    return o;
  };
  const rows = data.map((r) => {
    const key = r.gkey === null ? '' : String(r.gkey);
    return {
      key,
      label: key ? (labels.get(key) ?? key) : GROUP_EMPTY[group],
      ...conv(r),
    };
  });
  if (group === 'day') rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => String(a.label).localeCompare(String(b.label), 'ru'));
  return { rows, totals: total ? { key: '', label: 'Итого', ...conv(total) } : null };
}

const GROUP_EMPTY: Record<ReportGroup, string> = {
  channel: 'Не указан',
  queue: 'Без очереди',
  operator: 'Без оператора',
  topic: 'Без темы',
  subtopic: 'Без темы',
  result: '—',
  enterprise: 'Не указано',
  department: 'Не указано',
  object: 'Без объекта',
  day: '—',
  assignee: '—',
  rating: 'Без оценки',
  platform: 'Не указана',
};

function pickGroup(kind: ReportKind, g: ReportGroup | undefined): ReportGroup | null {
  const allowed = REPORT_CATALOG[kind].groups;
  if (!allowed.length) return null;
  if (!g) return allowed[0]!;
  if (!allowed.includes(g)) throw badRequest(`Разрез «${GROUP_TITLES[g]}» недоступен для этого отчёта`);
  return g;
}

export async function buildReport(kind: ReportKind, ctx: ReportCtx): Promise<ReportResult> {
  const period = await resolvePeriod(ctx.db, ctx.filter, ctx.now);
  const group = pickGroup(kind, ctx.filter.groupBy);
  const base = {
    kind,
    title: REPORT_CATALOG[kind].title,
    from: period.from,
    to: period.to,
    timezone: period.timezone,
    groupBy: group,
  };
  const labelCol = group ? [col('label', GROUP_TITLES[group], 'text')] : [];
  let r: Omit<ReportResult, keyof typeof base>;
  switch (kind) {
    case 'conversations':
      r = await conversationsReport(ctx, period, group!);
      break;
    case 'service-level':
      r = await serviceLevelReport(ctx, period, group!);
      break;
    case 'handling':
      r = await handlingReport(ctx, period, group!);
      break;
    case 'first-response':
      r = await firstResponseReport(ctx, period, group!);
      break;
    case 'agents':
      r = await agentsReport(ctx, period);
      break;
    case 'csat':
      r = await csatReport(ctx, period, group!);
      break;
    case 'second-line':
      r = await secondLineReport(ctx, period, group!);
      break;
    case 'overdue':
      r = await overdueReport(ctx, period);
      break;
    case 'reviews':
      r = await reviewsReport(ctx, period, group!);
      break;
  }
  return { ...base, ...r, columns: [...labelCol, ...r.columns] };
}

// ------------------------------------------------------------------ обращения по каналам, темам, результатам

async function conversationsReport(ctx: ReportCtx, period: Period, group: ReportGroup) {
  const q = new Params();
  const ctes = convCtes(q, period.t0, period.t1);
  const t0 = q.p(period.t0);
  const tz = q.lazy(period.timezone);
  const where = dimWhere(q, { ...CONV_DIMS, operator: 'c.assignee_id' }, ctx.filter, ctx.principal);
  const gexpr: Record<string, () => string> = {
    channel: () => 'c.channel',
    topic: () => '(c.topic_path[1])::text',
    subtopic: () => 'c.topic_id::text',
    result: () => 'x.result',
    enterprise: () => 'c.enterprise_id::text',
    department: () => 'c.department_id::text',
    object: () => 'c.object_id::text',
    day: () => localDay('cr.created_at', tz),
  };
  const sql = `WITH ${ctes},
    created AS (SELECT cid, min(at) AS created_at FROM cev WHERE type = 'conversation.created' GROUP BY cid),
    closed_last AS (
      SELECT DISTINCT ON (cid) cid, data ->> 'disposition' AS disp, data ->> 'dispositionKind' AS dkind,
             data ->> 'dispositionId' AS did
        FROM cev WHERE type = 'conversation.updated' AND data ->> 'action' = 'closed'
       ORDER BY cid, at DESC, id DESC),
    b AS (
      SELECT ${gexpr[group]!()} AS gkey, c.status, c.is_important, x.kind
        FROM conv c
        JOIN created cr ON cr.cid = c.cid AND cr.created_at >= ${t0}
        LEFT JOIN closed_last cl ON cl.cid = c.cid
        LEFT JOIN disposition d ON d.id = (cl.did)::uuid
        CROSS JOIN LATERAL (SELECT
          CASE WHEN c.status = 'closed' THEN COALESCE(cl.disp, 'Автозакрытие')
               WHEN c.status = 'waiting_2nd_line' THEN '__2nd' ELSE '__open' END AS result,
          CASE WHEN c.status <> 'closed' THEN NULL
               ELSE COALESCE(cl.dkind, d.behavior,
                 (SELECT d2.behavior FROM disposition d2 WHERE d2.name = cl.disp LIMIT 1),
                 CASE cl.disp WHEN 'IVR' THEN 'self_service' WHEN 'Пропущенный звонок' THEN 'abandoned'
                              WHEN 'Передать на 2-ю линию' THEN 'escalate' END,
                 CASE WHEN cl.disp IS NULL THEN 'auto_closed' END) END AS kind) x
       WHERE ${where.join(' AND ')})
    SELECT GROUPING(gkey) = 1 AS is_total, gkey,
           count(*) AS received,
           count(*) FILTER (WHERE status = 'closed') AS closed,
           count(*) FILTER (WHERE kind = 'resolved') AS resolved,
           count(*) FILTER (WHERE kind = 'escalate' OR status = 'waiting_2nd_line') AS escalated,
           count(*) FILTER (WHERE kind = 'postponed') AS postponed,
           count(*) FILTER (WHERE kind IN ('no_reply_needed', 'duplicate')) AS no_reply,
           count(*) FILTER (WHERE kind = 'self_service') AS self_service,
           count(*) FILTER (WHERE kind = 'abandoned') AS abandoned,
           count(*) FILTER (WHERE kind = 'auto_closed') AS auto_closed,
           count(*) FILTER (WHERE status NOT IN ('closed', 'waiting_2nd_line')) AS open,
           count(*) FILTER (WHERE is_important) AS important
      FROM b GROUP BY GROUPING SETS ((gkey), ())`;
  const raw = (await ctx.db.query(sql, q.list)).rows;
  const metrics = [
    'received',
    'closed',
    'resolved',
    'escalated',
    'postponed',
    'no_reply',
    'self_service',
    'abandoned',
    'auto_closed',
    'open',
    'important',
  ];
  const { rows, totals } = await finish(ctx.db, group, raw, metrics);
  return {
    columns: [
      col('received', 'Поступило'),
      col('closed', 'Закрыто'),
      col('resolved', 'Решено'),
      col('escalated', 'Передано на 2-ю линию'),
      col('postponed', 'Отложено'),
      col('no_reply', 'Без ответа / дубли'),
      col('self_service', 'Самообслуживание (IVR)'),
      col('abandoned', 'Пропущено'),
      col('auto_closed', 'Автозакрыто'),
      col('open', 'Не закрыто'),
      col('important', 'Особо важных'),
    ],
    rows,
    totals,
    notes: [
      'Обращения, созданные в периоде; тема, результат и измерения — на конец периода.',
      'Результат «Передано на 2-ю линию» включает обращения, ожидающие закрытия тикета.',
    ],
  };
}

// ------------------------------------------------------------------ SL и пропущенные

async function settingJson<T>(db: Db, key: string, def: T): Promise<T> {
  const { rows } = await db.query<{ value: unknown }>(`SELECT value FROM system_setting WHERE key = $1`, [
    key,
  ]);
  return rows[0] && rows[0].value !== null && rows[0].value !== undefined ? (rows[0].value as T) : def;
}

/**
 * Параметры расчёта SL (В-51, «Настройки», без перезапуска): общие пороги ответа по голосу и тексту, порог по
 * очереди (перекрывает общий), короткий сброс, учитывать ли короткие сбросы и возвраты в IVR/бот в знаменателе,
 * считать ли постановку после перевода новым поступлением.
 */
export async function slParams(db: Db) {
  return {
    voice: await settingNum(db, 'report.sl_voice_s', 20),
    text: await settingNum(db, 'report.sl_text_s', 60),
    short: await settingNum(db, 'report.short_abandon_s', 5),
    queues: await settingJson<Record<string, { voiceS?: number | null; textS?: number | null }>>(
      db,
      'report.sl_queue_thresholds',
      {},
    ),
    countShort: await settingJson(db, 'report.sl_count_short_abandons', false),
    countOther: await settingJson(db, 'report.sl_count_ivr_returns', false),
    transferNew: await settingJson(db, 'report.sl_transfer_new_arrival', true),
  };
}

/** SQL эпизодов ожидания периода с измерениями — общий для отчёта SL и панели супервизора. */
async function slQuery(
  ctx: ReportCtx,
  period: Period,
  gexprOf: (tz: () => string) => Record<string, () => string>,
  group: string,
) {
  const sl = await slParams(ctx.db);
  const q = new Params();
  const ctes = convCtes(q, period.t0, period.t1);
  const t0 = q.p(period.t0);
  const tz = q.lazy(period.timezone);
  const slv = q.p(sl.voice);
  const slt = q.p(sl.text);
  const short = q.p(sl.short);
  const perQueue = q.p(JSON.stringify(sl.queues));
  const countShort = q.p(!!sl.countShort);
  const countOther = q.p(!!sl.countOther);
  const transferNew = q.p(sl.transferNew !== false);
  const where = dimWhere(
    q,
    { ...CONV_DIMS, queue: 'ep.queue_id', operator: 'ep.end_asg' },
    ctx.filter,
    ctx.principal,
  );
  // Знаменатель SL и доли пропущенных: отвеченные + пропущенные (+ короткие сбросы, + возвраты в IVR/бот —
  // если так настроено).
  const denom = `answered + abandoned + CASE WHEN ${countOther}::boolean THEN other ELSE 0 END`;
  const sql = `WITH ${ctes}, ${TRANSITION_CTES},
    b AS (
      SELECT ${gexprOf(tz)[group]!()} AS gkey, ep.outcome, ep.wait_s,
             CASE WHEN c.channel = 'voice'
                  THEN COALESCE((${perQueue}::jsonb -> ep.queue_id::text ->> 'voiceS')::float8, ${slv}::float8)
                  ELSE COALESCE((${perQueue}::jsonb -> ep.queue_id::text ->> 'textS')::float8, ${slt}::float8)
             END AS sl_s
        FROM ep JOIN conv c ON c.cid = ep.cid
       WHERE ep.start_at >= ${t0} AND ep.outcome <> 'open'
         AND (${transferNew}::boolean OR NOT ep.after_transfer) AND ${where.join(' AND ')}),
    a AS (
      SELECT GROUPING(gkey) = 1 AS is_total, gkey,
             count(*) AS entered,
             count(*) FILTER (WHERE outcome = 'answered') AS answered,
             count(*) FILTER (WHERE outcome = 'answered' AND wait_s <= sl_s) AS within_sl,
             count(*) FILTER (WHERE outcome = 'abandoned'
                                AND (wait_s >= ${short}::float8 OR ${countShort}::boolean)) AS abandoned,
             count(*) FILTER (WHERE outcome = 'abandoned' AND wait_s < ${short}::float8) AS short_abandoned,
             count(*) FILTER (WHERE outcome = 'other') AS other,
             avg(wait_s) FILTER (WHERE outcome = 'answered') AS asa,
             max(wait_s) FILTER (WHERE outcome IN ('answered', 'abandoned')) AS max_wait
        FROM b GROUP BY GROUPING SETS ((gkey), ()))
    SELECT a.*,
           round(100.0 * within_sl / NULLIF(${denom}, 0), 1) AS sl_pct,
           round(100.0 * abandoned / NULLIF(${denom}, 0), 1) AS missed_pct
      FROM a`;
  return { raw: (await ctx.db.query(sql, q.list)).rows, sl };
}

const SL_METRICS = [
  'entered',
  'answered',
  'within_sl',
  'abandoned',
  'short_abandoned',
  'other',
  'sl_pct',
  'missed_pct',
  'asa',
  'max_wait',
];

const slGroups = (tz: () => string): Record<string, () => string> => ({
  queue: () => 'ep.queue_id::text',
  channel: () => 'c.channel',
  day: () => localDay('ep.start_at', tz),
});

async function serviceLevelReport(ctx: ReportCtx, period: Period, group: ReportGroup) {
  const { raw, sl } = await slQuery(ctx, period, slGroups, group);
  const { rows, totals } = await finish(ctx.db, group, raw, SL_METRICS);
  return {
    columns: [
      col('entered', 'Поступило в очередь'),
      col('answered', 'Отвечено'),
      col('within_sl', 'Отвечено в пределах SL'),
      col('abandoned', 'Пропущено'),
      col('short_abandoned', 'Короткие сбросы'),
      col('other', 'Возврат в IVR/бот'),
      col('sl_pct', 'SL, %', 'pct'),
      col('missed_pct', 'Доля пропущенных, %', 'pct'),
      col('asa', 'Среднее ожидание (ASA)', 'dur'),
      col('max_wait', 'Макс. ожидание', 'dur'),
    ],
    rows,
    totals,
    notes: slNotes(sl),
  };
}

/** Пояснения к отчёту SL — по действующим настройкам (В-51). */
export function slNotes(sl: Awaited<ReturnType<typeof slParams>>): string[] {
  const overrides = Object.keys(sl.queues ?? {}).length;
  const denom = ['отвеченных', 'пропущенных', ...(sl.countOther ? ['вернувшихся в IVR/бот'] : [])];
  return [
    `SL — доля отвеченных за ${sl.voice} с (голос) / ${sl.text} с (текстовые каналы) среди ${denom.join(', ')}` +
      (overrides ? `; для части очередей (${overrides}) задан свой порог.` : '.'),
    sl.countShort
      ? `Пропущенное — клиент ушёл из очереди до ответа; сбросы быстрее ${sl.short} с учитываются как пропущенные.`
      : `Пропущенное — клиент ушёл из очереди до ответа; сбросы быстрее ${sl.short} с не учитываются.`,
    sl.transferNew !== false
      ? 'Каждая постановка в очередь (в т.ч. после перевода) — отдельный эпизод. Длительности в CSV — в секундах.'
      : 'Постановка в очередь после перевода не считается новым поступлением и в расчёт не входит. Длительности в CSV — в секундах.',
  ];
}

/** Сводка SL за сегодня по очередям — для панели супервизора (M-REP-02). */
export async function todayServiceLevel(db: Db, principal: Principal, now = new Date()) {
  const ctx: ReportCtx = { db, principal, filter: {}, now };
  const today = await resolvePeriod(db, {}, now);
  const period = await resolvePeriod(db, { from: today.today, to: today.today }, now);
  const { raw } = await slQuery(ctx, period, slGroups, 'queue');
  return raw
    .filter((r) => !r.is_total)
    .map((r) => ({
      queueId: r.gkey as string | null,
      answered: Number(r.answered),
      abandoned: Number(r.abandoned),
      slPct: num(r.sl_pct),
      asa: num(r.asa),
    }));
}

// ------------------------------------------------------------------ ASA/AHT

async function handlingReport(ctx: ReportCtx, period: Period, group: ReportGroup) {
  const q = new Params();
  const ctes = convCtes(q, period.t0, period.t1);
  const t0 = q.p(period.t0);
  const tz = q.lazy(period.timezone);
  const where = dimWhere(
    q,
    { ...CONV_DIMS, queue: 'f.queue_id', operator: 'f.user_id' },
    ctx.filter,
    ctx.principal,
  );
  const gexpr: Record<string, () => string> = {
    operator: () => 'f.user_id::text',
    queue: () => 'f.queue_id::text',
    channel: () => 'c.channel',
    day: () => localDay('f.at', tz),
  };
  const sql = `WITH ${ctes}, ${TRANSITION_CTES},
    f AS (
      SELECT 'ep' AS t, cid, start_at AS at, end_asg AS user_id, queue_id, wait_s AS v FROM ep
       WHERE outcome = 'answered' AND start_at >= ${t0}
      UNION ALL
      SELECT 'seg', cid, start_at, user_id, queue_id, dur_s FROM seg
       WHERE end_at IS NOT NULL AND start_at >= ${t0}),
    b AS (SELECT ${gexpr[group]!()} AS gkey, f.t, f.v FROM f JOIN conv c ON c.cid = f.cid WHERE ${where.join(' AND ')})
    SELECT GROUPING(gkey) = 1 AS is_total, gkey,
           count(*) FILTER (WHERE t = 'ep') AS answered,
           avg(v) FILTER (WHERE t = 'ep') AS asa,
           max(v) FILTER (WHERE t = 'ep') AS max_wait,
           count(*) FILTER (WHERE t = 'seg') AS handled,
           avg(v) FILTER (WHERE t = 'seg') AS aht,
           sum(v) FILTER (WHERE t = 'seg') AS handle_total
      FROM b GROUP BY GROUPING SETS ((gkey), ())`;
  const raw = (await ctx.db.query(sql, q.list)).rows;
  const { rows, totals } = await finish(ctx.db, group, raw, [
    'answered',
    'asa',
    'max_wait',
    'handled',
    'aht',
    'handle_total',
  ]);
  return {
    columns: [
      col('answered', 'Принято из очереди'),
      col('asa', 'ASA (среднее ожидание)', 'dur'),
      col('max_wait', 'Макс. ожидание', 'dur'),
      col('handled', 'Завершено обработок'),
      col('aht', 'AHT (среднее время обработки)', 'dur'),
      col('handle_total', 'Время обработки всего', 'dur'),
    ],
    rows,
    totals,
    notes: [
      'ASA — от постановки в очередь до принятия оператором. AHT — от принятия до закрытия, передачи или ' +
        'перевода (для звонка включает разговор и постобработку до закрытия карточки).',
      'Длительности в CSV — в секундах.',
    ],
  };
}

// ------------------------------------------------------------------ первый ответ в чатах

async function firstResponseReport(ctx: ReportCtx, period: Period, group: ReportGroup) {
  const thr = await settingNum(ctx.db, 'report.first_response_s', 120);
  const q = new Params();
  const ctes = convCtes(q, period.t0, period.t1);
  const t0 = q.p(period.t0);
  const tz = q.lazy(period.timezone);
  const thrP = q.p(thr);
  const where = dimWhere(
    q,
    { ...CONV_DIMS, queue: 'fq.queue_id', operator: 'r.author' },
    ctx.filter,
    ctx.principal,
  );
  const gexpr: Record<string, () => string> = {
    channel: () => 'c.channel',
    queue: () => 'fq.queue_id::text',
    operator: () => 'r.author::text',
    day: () => localDay('cr.created_at', tz),
  };
  const sql = `WITH ${ctes}, ${TRANSITION_CTES},
    created AS (SELECT cid, min(at) AS created_at FROM cev WHERE type = 'conversation.created' GROUP BY cid),
    fq AS (SELECT DISTINCT ON (cid) cid, start_at AS q_at, queue_id FROM ep ORDER BY cid, start_at),
    r AS (
      SELECT DISTINCT ON (cid) cid, at AS reply_at, (data -> 'message' ->> 'authorUserId')::uuid AS author
        FROM cev
       WHERE type = 'conversation.message_created' AND data -> 'message' ->> 'direction' = 'out'
         AND data -> 'message' ->> 'authorUserId' IS NOT NULL
         AND NOT (COALESCE(data -> 'message' -> 'meta', '{}'::jsonb) ? 'auto')
       ORDER BY cid, at, id),
    b AS (
      SELECT ${gexpr[group]!()} AS gkey, r.reply_at,
             CASE WHEN r.reply_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM r.reply_at - fq.q_at))::float8 END AS frt_s
        FROM conv c
        JOIN created cr ON cr.cid = c.cid AND cr.created_at >= ${t0}
        JOIN fq ON fq.cid = c.cid
        LEFT JOIN r ON r.cid = c.cid
       WHERE c.channel <> 'voice' AND ${where.join(' AND ')})
    SELECT GROUPING(gkey) = 1 AS is_total, gkey,
           count(*) AS total,
           count(reply_at) AS replied,
           count(*) - count(reply_at) AS no_reply,
           avg(frt_s) AS avg_frt,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY frt_s) AS median_frt,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY frt_s) AS p90_frt,
           round(100.0 * count(*) FILTER (WHERE frt_s <= ${thrP}::float8) / NULLIF(count(reply_at), 0), 1) AS within_pct
      FROM b GROUP BY GROUPING SETS ((gkey), ())`;
  const raw = (await ctx.db.query(sql, q.list)).rows;
  const { rows, totals } = await finish(ctx.db, group, raw, [
    'total',
    'replied',
    'no_reply',
    'avg_frt',
    'median_frt',
    'p90_frt',
    'within_pct',
  ]);
  return {
    columns: [
      col('total', 'Обращений в очереди'),
      col('replied', 'С ответом оператора'),
      col('no_reply', 'Без ответа'),
      col('avg_frt', 'Среднее время первого ответа', 'dur'),
      col('median_frt', 'Медиана', 'dur'),
      col('p90_frt', '90-й перцентиль', 'dur'),
      col('within_pct', `Ответ за ${thr} с, %`, 'pct'),
    ],
    rows,
    totals,
    notes: [
      'Текстовые каналы; от первой постановки в очередь (после бота) до первого сообщения оператора. ' +
        'Автоответы и сообщения бота не считаются ответом.',
      'Длительности в CSV — в секундах.',
    ],
  };
}

// ------------------------------------------------------------------ загрузка и статусы операторов

async function agentsReport(ctx: ReportCtx, period: Period) {
  const now = ctx.now ?? new Date();
  const end = period.t1.getTime() < now.getTime() ? period.t1 : now;
  const q = new Params();
  const ctes = convCtes(q, period.t0, period.t1);
  const t0 = q.p(period.t0);
  const endP = q.p(end);
  const where = dimWhere(q, { ...CONV_DIMS, operator: 'f.user_id' }, ctx.filter, ctx.principal);
  const opFilter = ctx.filter.operatorId ? `AND uid = ${q.p(ctx.filter.operatorId)}::uuid` : '';
  const sql = `WITH ${ctes}, ${TRANSITION_CTES},
    st AS (
      SELECT (data ->> 'userId')::uuid AS uid, data ->> 'status' AS status, occurred_at AS at,
             LEAD(occurred_at) OVER (PARTITION BY data ->> 'userId' ORDER BY occurred_at, id) AS nxt
        FROM event WHERE type = 'agent.status_changed' AND occurred_at < ${endP}),
    times AS (
      SELECT uid,
             sum(EXTRACT(EPOCH FROM LEAST(COALESCE(nxt, ${endP}), ${endP}) - GREATEST(at, ${t0})))
               FILTER (WHERE status = 'ready') AS ready_s,
             sum(EXTRACT(EPOCH FROM LEAST(COALESCE(nxt, ${endP}), ${endP}) - GREATEST(at, ${t0})))
               FILTER (WHERE status = 'break') AS break_s,
             sum(EXTRACT(EPOCH FROM LEAST(COALESCE(nxt, ${endP}), ${endP}) - GREATEST(at, ${t0})))
               FILTER (WHERE status = 'wrap_up') AS wrap_s
        FROM st WHERE COALESCE(nxt, ${endP}) > ${t0} GROUP BY uid),
    f AS (
      SELECT 'ep' AS t, cid, end_asg AS user_id, wait_s AS v FROM ep
       WHERE outcome = 'answered' AND start_at >= ${t0}
      UNION ALL
      SELECT 'seg', cid, user_id, dur_s FROM seg WHERE end_at IS NOT NULL AND start_at >= ${t0}
      UNION ALL
      SELECT data ->> 'action', cid, (data ->> 'userId')::uuid, NULL FROM cev
       WHERE type = 'conversation.updated' AND data ->> 'action' IN ('declined', 'offer_timeout')
         AND data ? 'userId' AND at >= ${t0}
      UNION ALL
      SELECT 'csat', cid, COALESCE((data ->> 'agentUserId')::uuid, (data ->> 'assigneeId')::uuid),
             (data ->> 'score')::float8 FROM cev
       WHERE type = 'conversation.updated' AND data ->> 'action' = 'csat' AND at >= ${t0}),
    work AS (
      SELECT f.user_id AS uid,
             count(*) FILTER (WHERE t = 'ep') AS answered,
             count(*) FILTER (WHERE t = 'declined') AS declined,
             count(*) FILTER (WHERE t = 'offer_timeout') AS missed_offers,
             count(*) FILTER (WHERE t = 'seg') AS handled,
             sum(v) FILTER (WHERE t = 'seg') AS handle_s,
             count(*) FILTER (WHERE t = 'csat') AS csat_n,
             sum(v) FILTER (WHERE t = 'csat') AS csat_sum
        FROM f JOIN conv c ON c.cid = f.cid
       WHERE f.user_id IS NOT NULL AND ${where.join(' AND ')} GROUP BY f.user_id),
    ops AS (
      SELECT u.id AS uid FROM app_user u
       WHERE u.is_active AND u.can_login AND EXISTS (
         SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
          WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))
      UNION SELECT uid FROM times UNION SELECT uid FROM work)
    SELECT ops.uid::text AS gkey, times.ready_s, times.break_s, times.wrap_s, work.*
      FROM ops LEFT JOIN times ON times.uid = ops.uid LEFT JOIN work ON work.uid = ops.uid
     WHERE TRUE ${opFilter}`;
  const raw = (await ctx.db.query(sql, q.list)).rows;
  const keys = [
    'ready_s',
    'break_s',
    'wrap_s',
    'answered',
    'declined',
    'missed_offers',
    'handled',
    'handle_s',
    'csat_n',
    'csat_sum',
  ];
  const totalsAcc: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  const shaped = raw.map((r) => {
    const o: Record<string, number> = {};
    for (const k of keys) {
      o[k] = Number(r[k] ?? 0);
      totalsAcc[k]! += o[k];
    }
    return { gkey: r.gkey as string, m: o };
  });
  const derive = (o: Record<string, number>) => ({
    ready_s: o.ready_s,
    break_s: o.break_s,
    wrap_s: o.wrap_s,
    online_s: o.ready_s! + o.break_s! + o.wrap_s!,
    answered: o.answered,
    declined: o.declined,
    missed_offers: o.missed_offers,
    handled: o.handled,
    aht: o.handled ? o.handle_s! / o.handled : null,
    handle_s: o.handle_s,
    csat_avg: o.csat_n ? Math.round((o.csat_sum! / o.csat_n) * 100) / 100 : null,
  });
  const labels = await groupLabels(
    ctx.db,
    'operator',
    shaped.map((r) => r.gkey),
  );
  const rows = shaped
    .map((r) => ({ key: r.gkey, label: labels.get(r.gkey) ?? r.gkey, ...derive(r.m) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  return {
    columns: [
      col('online_s', 'В сети', 'dur'),
      col('ready_s', 'Готов', 'dur'),
      col('break_s', 'Перерыв', 'dur'),
      col('wrap_s', 'Постобработка', 'dur'),
      col('answered', 'Принято обращений'),
      col('declined', 'Отклонено предложений'),
      col('missed_offers', 'Не принято вовремя'),
      col('handled', 'Завершено обработок'),
      col('aht', 'AHT', 'dur'),
      col('handle_s', 'Время обработки', 'dur'),
      col('csat_avg', 'Средняя оценка', 'num'),
    ],
    rows,
    totals: { key: '', label: 'Итого', ...derive(totalsAcc) },
    notes: [
      'Время в статусах — по журналу статусов операторов за период (до текущего момента). Фильтры по каналу, ' +
        'предприятию, теме и т. п. влияют на счётчики обращений, но не на время в статусах.',
      'Длительности в CSV — в секундах.',
    ],
  };
}

// ------------------------------------------------------------------ CSAT

async function csatReport(ctx: ReportCtx, period: Period, group: ReportGroup) {
  const q = new Params();
  const ctes = convCtes(q, period.t0, period.t1);
  const t0 = q.p(period.t0);
  const tz = q.lazy(period.timezone);
  const where = dimWhere(q, { ...CONV_DIMS, operator: 'cs.agent' }, ctx.filter, ctx.principal);
  const gexpr: Record<string, () => string> = {
    operator: () => 'cs.agent::text',
    channel: () => 'c.channel',
    topic: () => '(c.topic_path[1])::text',
    day: () => localDay('cs.at', tz),
  };
  const sql = `WITH ${ctes},
    cs AS (
      SELECT cid, at, (data ->> 'score')::int AS score,
             COALESCE((data ->> 'agentUserId')::uuid, (data ->> 'assigneeId')::uuid) AS agent
        FROM cev WHERE type = 'conversation.updated' AND data ->> 'action' = 'csat' AND at >= ${t0}),
    b AS (SELECT ${gexpr[group]!()} AS gkey, cs.score FROM cs JOIN conv c ON c.cid = cs.cid WHERE ${where.join(' AND ')})
    SELECT GROUPING(gkey) = 1 AS is_total, gkey,
           count(*) AS n, round(avg(score), 2) AS avg_score,
           round(100.0 * count(*) FILTER (WHERE score >= 4) / NULLIF(count(*), 0), 1) AS csat_pct,
           count(*) FILTER (WHERE score = 5) AS s5, count(*) FILTER (WHERE score = 4) AS s4,
           count(*) FILTER (WHERE score = 3) AS s3, count(*) FILTER (WHERE score = 2) AS s2,
           count(*) FILTER (WHERE score = 1) AS s1
      FROM b GROUP BY GROUPING SETS ((gkey), ())`;
  const raw = (await ctx.db.query(sql, q.list)).rows;
  const { rows, totals } = await finish(ctx.db, group, raw, [
    'n',
    'avg_score',
    'csat_pct',
    's5',
    's4',
    's3',
    's2',
    's1',
  ]);
  return {
    columns: [
      col('n', 'Оценок'),
      col('avg_score', 'Средняя оценка', 'num'),
      col('csat_pct', 'CSAT (доля 4–5), %', 'pct'),
      col('s5', '«5»'),
      col('s4', '«4»'),
      col('s3', '«3»'),
      col('s2', '«2»'),
      col('s1', '«1»'),
    ],
    rows,
    totals,
    notes: ['Оценки 1–5 после разговора (DTMF) и после чата (виджет, приложение).'],
  };
}

// ------------------------------------------------------------------ 2-я линия

const TICKET_WORK = ['new', 'in_work', 'rework'];

interface TicketFact {
  tid: string;
  enterprise_id: string | null;
  department_id: string | null;
  resp: string[];
  cur: string[];
  received: boolean;
  closed: boolean;
  in_time: boolean | null;
  late_days: number | null;
  resolve_days: number | null;
  method: string | null;
  returns: number;
  overdue_open: boolean;
  overdue_days: number | null;
  awaiting: boolean;
  wait_s: number;
  wait_n: number;
}

async function secondLineReport(ctx: ReportCtx, period: Period, group: ReportGroup) {
  const q = new Params();
  const t0 = q.p(period.t0);
  const t1 = q.p(period.t1);
  const tz = q.lazy(period.timezone);
  const toDate = q.p(period.to);
  const where = dimWhere(
    q,
    {
      channel: 'tl.channel',
      enterprise: 'tl.enterprise_id',
      department: 'tl.department_id',
      topicPath: 'tl.topic_path',
      object: 'tl.object_id',
      important: 'tl.is_important',
      operator: 'tl.created_by',
      ticketAssignees: '(tl.resp || tl.cur)',
    },
    ctx.filter,
    ctx.principal,
  );
  const work = q.p(TICKET_WORK);
  const sql = `WITH
    tev AS (
      SELECT e.id, e.type, e.occurred_at AS at, e.data, e.data ->> 'ticketId' AS tid FROM event e
       WHERE e.type LIKE 'ticket.%' AND e.occurred_at < ${t1} AND e.data ? 'ticketId'),
    tl AS (
      SELECT DISTINCT ON (tid) tid, data ->> 'status' AS status,
             (data ->> 'enterpriseId')::uuid AS enterprise_id, (data ->> 'departmentId')::uuid AS department_id,
             cc_uuid_array(data -> 'topicPath') AS topic_path,
             COALESCE((data ->> 'isImportant')::boolean, false) AS is_important,
             (data ->> 'createdBy')::uuid AS created_by, (data ->> 'dueDate')::date AS due,
             CASE WHEN data ? 'objectId' THEN (data ->> 'objectId')::uuid
                  ELSE (SELECT c.object_id FROM conversation c WHERE c.id = (data ->> 'conversationId')::uuid) END AS object_id,
             COALESCE(data ->> 'channelKind',
                      (SELECT c.channel_kind FROM conversation c WHERE c.id = (data ->> 'conversationId')::uuid)) AS channel,
             CASE WHEN data ? 'responsibleIds' THEN cc_uuid_array(data -> 'responsibleIds')
                  ELSE ARRAY(SELECT a.user_id FROM ticket_assignee a
                              WHERE a.ticket_id = tid::uuid AND a.is_active AND a.kind = 'responsible') END AS resp,
             CASE WHEN data ? 'curatorIds' THEN cc_uuid_array(data -> 'curatorIds')
                  ELSE ARRAY(SELECT a.user_id FROM ticket_assignee a
                              WHERE a.ticket_id = tid::uuid AND a.is_active AND a.kind = 'curator') END AS cur
        FROM tev ORDER BY tid, at DESC, id DESC),
    tc AS (SELECT tid, min(at) AS created_at FROM tev WHERE type = 'ticket.created' GROUP BY tid),
    ap AS (
      SELECT DISTINCT ON (tid) tid, at, (data ->> 'closedInTime')::boolean AS in_time,
             COALESCE((data ->> 'answeredAt')::timestamptz, (SELECT t.answered_at FROM ticket t WHERE t.id = tid::uuid)) AS answered_at,
             (data ->> 'dueDate')::date AS due,
             COALESCE((data ->> 'answerMethodId')::uuid, (SELECT t.answer_method_id FROM ticket t WHERE t.id = tid::uuid)) AS method
        FROM tev WHERE type = 'ticket.status_changed' AND data ->> 'action' = 'approved' AND at >= ${t0}
       ORDER BY tid, at DESC),
    rt AS (
      SELECT tid, count(*) AS n FROM tev
       WHERE type = 'ticket.status_changed' AND data ->> 'action' = 'returned' AND at >= ${t0} GROUP BY tid),
    dec AS (
      SELECT tid, at, data ->> 'action' AS action,
             LAG(at) OVER (PARTITION BY tid ORDER BY at, id) AS prev_at,
             LAG(data ->> 'action') OVER (PARTITION BY tid ORDER BY at, id) AS prev_action
        FROM tev WHERE type = 'ticket.status_changed' AND data ->> 'action' IN ('answered', 'approved', 'returned')),
    aw AS (
      SELECT tid, sum(EXTRACT(EPOCH FROM at - prev_at))::float8 AS wait_s, count(*) AS wait_n FROM dec
       WHERE action IN ('approved', 'returned') AND prev_action = 'answered' AND at >= ${t0} GROUP BY tid)
    SELECT tl.tid, tl.enterprise_id, tl.department_id, tl.resp, tl.cur,
           tc.created_at >= ${t0} AS received,
           ap.tid IS NOT NULL AS closed, ap.in_time,
           CASE WHEN ap.in_time = false THEN (ap.answered_at AT TIME ZONE ${tz()}::text)::date - ap.due END AS late_days,
           EXTRACT(EPOCH FROM ap.at - tc.created_at)::float8 / 86400 AS resolve_days,
           ap.method::text AS method,
           COALESCE(rt.n, 0)::int AS returns,
           (tl.status = ANY(${work}::text[]) AND tl.due < ${toDate}::date) AS overdue_open,
           CASE WHEN tl.status = ANY(${work}::text[]) AND tl.due < ${toDate}::date THEN ${toDate}::date - tl.due END AS overdue_days,
           tl.status = 'approval' AS awaiting,
           COALESCE(aw.wait_s, 0) AS wait_s, COALESCE(aw.wait_n, 0)::int AS wait_n
      FROM tl JOIN tc ON tc.tid = tl.tid
      LEFT JOIN ap ON ap.tid = tl.tid LEFT JOIN rt ON rt.tid = tl.tid LEFT JOIN aw ON aw.tid = tl.tid
     WHERE (tc.created_at >= ${t0} OR ap.tid IS NOT NULL OR rt.n > 0 OR aw.wait_n > 0 OR tl.status <> 'closed')
       AND ${where.join(' AND ')}`;
  const facts = (await ctx.db.query<TicketFact>(sql, q.list)).rows;

  // Прямые переводы звонка на подразделение (M-TKT-11) — отдельный показатель по адресату перевода.
  const dq = new Params();
  const dwhere = dimWhere(
    dq,
    {
      channel: `e.data ->> 'channelKind'`,
      enterprise: `(e.data ->> 'directEnterpriseId')::uuid`,
      department: `(e.data ->> 'directDepartmentId')::uuid`,
      topicPath: `cc_uuid_array(e.data -> 'topicPath')`,
      object: `(e.data ->> 'objectId')::uuid`,
      important: `(e.data ->> 'isImportant')::boolean`,
      operator: `(e.data ->> 'byUserId')::uuid`,
    },
    { ...ctx.filter, assigneeId: undefined },
    ctx.principal,
  );
  const direct =
    group === 'assignee' || ctx.filter.assigneeId
      ? []
      : (
          await ctx.db.query<{ enterprise_id: string | null; department_id: string | null; n: string }>(
            `SELECT e.data ->> 'directEnterpriseId' AS enterprise_id, e.data ->> 'directDepartmentId' AS department_id,
                    count(*) AS n
               FROM event e
              WHERE e.type = 'conversation.updated' AND e.data ->> 'action' = 'transferred'
                AND e.data ->> 'transferKind' = 'direct'
                AND e.occurred_at >= ${dq.p(period.t0)} AND e.occurred_at < ${dq.p(period.t1)}
                AND ${dwhere.join(' AND ')}
              GROUP BY 1, 2`,
            dq.list,
          )
        ).rows;

  const methods = new Map(
    (await ctx.db.query<{ id: string; name: string }>(`SELECT id::text, name FROM answer_method`)).rows.map(
      (r) => [r.id, r.name],
    ),
  );
  interface Acc {
    key: string;
    received: number;
    closed: number;
    in_time: number;
    late: number;
    late_days_sum: number;
    resolve_sum: number;
    returns: number;
    overdue_open: number;
    overdue_max: number | null;
    awaiting: number;
    wait_s: number;
    wait_n: number;
    methods: Map<string, number>;
    direct: number;
  }
  const accs = new Map<string, Acc>();
  const acc = (key: string): Acc => {
    let a = accs.get(key);
    if (!a) {
      a = {
        key,
        received: 0,
        closed: 0,
        in_time: 0,
        late: 0,
        late_days_sum: 0,
        resolve_sum: 0,
        returns: 0,
        overdue_open: 0,
        overdue_max: null,
        awaiting: 0,
        wait_s: 0,
        wait_n: 0,
        methods: new Map(),
        direct: 0,
      };
      accs.set(key, a);
    }
    return a;
  };
  const add = (a: Acc, t: TicketFact) => {
    if (t.received) a.received++;
    if (t.closed) {
      a.closed++;
      if (t.in_time === false) {
        a.late++;
        a.late_days_sum += Math.max(0, Number(t.late_days ?? 0));
      } else a.in_time++;
      a.resolve_sum += Number(t.resolve_days ?? 0);
      if (t.method) a.methods.set(t.method, (a.methods.get(t.method) ?? 0) + 1);
    }
    a.returns += t.returns;
    if (t.overdue_open) {
      a.overdue_open++;
      a.overdue_max = Math.max(a.overdue_max ?? 0, Number(t.overdue_days ?? 0));
    }
    if (t.awaiting) a.awaiting++;
    a.wait_s += Number(t.wait_s);
    a.wait_n += Number(t.wait_n);
  };
  const keyOf = (ent: string | null, dep: string | null) =>
    group === 'enterprise' ? (ent ?? '') : `${ent ?? ''}:${dep ?? ''}`;
  const total = acc('__total');
  for (const t of facts) {
    add(total, t);
    if (group === 'assignee') {
      for (const u of t.resp) add(acc(`${u}:responsible`), t);
      for (const u of t.cur) add(acc(`${u}:curator`), t);
    } else add(acc(keyOf(t.enterprise_id, t.department_id)), t);
  }
  for (const d of direct) {
    acc(keyOf(d.enterprise_id, d.department_id)).direct += Number(d.n);
    total.direct += Number(d.n);
  }
  accs.delete('__total');

  // Подписи: предприятие / подразделение, сотрудник (роль).
  const ids = new Set<string>();
  for (const k of accs.keys()) k.split(':').forEach((x) => x && /^[0-9a-f-]{36}$/.test(x) && ids.add(x));
  const names = new Map(
    (
      await ctx.db.query<{ id: string; name: string }>(
        `SELECT id::text, name FROM enterprise WHERE id = ANY($1::uuid[])
         UNION ALL SELECT id::text, name FROM department WHERE id = ANY($1::uuid[])
         UNION ALL SELECT id::text, full_name FROM app_user WHERE id = ANY($1::uuid[])`,
        [[...ids]],
      )
    ).rows.map((r) => [r.id, r.name]),
  );
  const label = (key: string) => {
    const [a, b] = key.split(':');
    if (group === 'assignee')
      return `${names.get(a!) ?? a} (${b === 'curator' ? 'куратор' : 'ответственный'})`;
    if (group === 'enterprise') return a ? (names.get(a) ?? a) : 'Не указано';
    return `${a ? (names.get(a) ?? a) : 'Не указано'} / ${b ? (names.get(b) ?? b) : 'Не указано'}`;
  };
  const shape = (a: Acc, lbl: string) => ({
    key: a.key,
    label: lbl,
    received: a.received,
    closed: a.closed,
    closed_in_time: a.in_time,
    closed_late: a.late,
    late_days_avg: a.late ? Math.round((a.late_days_sum / a.late) * 10) / 10 : null,
    overdue_open: a.overdue_open,
    overdue_max_days: a.overdue_max,
    returns: a.returns,
    resolve_days_avg: a.closed ? Math.round((a.resolve_sum / a.closed) * 10) / 10 : null,
    awaiting: a.awaiting,
    approval_wait_h: a.wait_n ? Math.round((a.wait_s / a.wait_n / 3600) * 10) / 10 : null,
    answer_methods: [...a.methods.entries()]
      .map(([id, n]) => `${methods.get(id) ?? id}: ${n}`)
      .sort()
      .join('; '),
    direct_transfers: group === 'assignee' ? null : a.direct,
  });
  const rows = [...accs.values()]
    .map((a) => shape(a, label(a.key)))
    .sort((x, y) => x.label.localeCompare(y.label, 'ru'));
  return {
    columns: [
      col('received', 'Поступило'),
      col('closed', 'Закрыто'),
      col('closed_in_time', 'Закрыто в срок'),
      col('closed_late', 'Закрыто с просрочкой'),
      col('late_days_avg', 'Средняя просрочка, дн.', 'num'),
      col('overdue_open', 'Просрочено (открытые)'),
      col('overdue_max_days', 'Макс. просрочка, дн.'),
      col('returns', 'Возвратов на доработку'),
      col('resolve_days_avg', 'Среднее время решения, дн.', 'num'),
      col('awaiting', 'Ожидают согласования'),
      col('approval_wait_h', 'Среднее ожидание согласования, ч', 'num'),
      col('answer_methods', 'Способы ответа', 'text'),
      col('direct_transfers', 'Прямые переводы звонков'),
    ],
    rows,
    totals: group === 'assignee' ? null : shape(total, 'Итого'),
    notes: [
      '«Просрочено (открытые)» и «Ожидают согласования» — на конец периода; ожидание согласования в просрочку ' +
        'ответственного не засчитывается.',
      'Прямые переводы — звонки, переведённые оператором на подразделение предприятия (очередь или внешний номер).',
      ...(group === 'assignee'
        ? ['Тикет с несколькими назначенными учитывается в строке каждого; итог не выводится.']
        : []),
    ],
  };
}

// ------------------------------------------------------------------ реестр просроченных

const TICKET_STATUS_NAMES: Record<string, string> = {
  new: 'Новый',
  in_work: 'В работе',
  approval: 'На согласовании',
  rework: 'На доработке',
  closed: 'Закрыт',
};

async function overdueReport(ctx: ReportCtx, period: Period) {
  const q = new Params();
  const today = q.p(period.today);
  const work = q.p(TICKET_WORK);
  const where = dimWhere(
    q,
    {
      channel: 'c.channel_kind',
      enterprise: 't.enterprise_id',
      department: 't.department_id',
      topicPath: 't.topic_path',
      object: 'c.object_id',
      important: 't.is_important',
      operator: 't.created_by',
      ticketAssignees: `ARRAY(SELECT a.user_id FROM ticket_assignee a WHERE a.ticket_id = t.id AND a.is_active)`,
    },
    ctx.filter,
    ctx.principal,
  );
  const { rows } = await ctx.db.query(
    `SELECT t.id::text AS key, t.number::int AS number, t.created_at, e.name AS enterprise, d.name AS department,
            (SELECT string_agg(p.name, ' / ' ORDER BY array_position(t.topic_path, p.id)) FROM topic p
              WHERE p.id = ANY(t.topic_path)) AS topic,
            t.is_important, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
            ${today}::date - t.due_date AS overdue_days,
            (SELECT string_agg(u.full_name, ', ' ORDER BY u.full_name) FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id
              WHERE a.ticket_id = t.id AND a.is_active AND a.kind = 'responsible') AS responsibles,
            (SELECT string_agg(u.full_name, ', ' ORDER BY u.full_name) FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id
              WHERE a.ticket_id = t.id AND a.is_active AND a.kind = 'curator') AS curators,
            t.returns_count
       FROM ticket t
       JOIN conversation c ON c.id = t.conversation_id
       JOIN enterprise e ON e.id = t.enterprise_id
       JOIN department d ON d.id = t.department_id
      WHERE t.status = ANY(${work}::text[]) AND t.due_date < ${today}::date AND ${where.join(' AND ')}
      ORDER BY overdue_days DESC, t.number`,
    q.list,
  );
  return {
    columns: [
      col('number', '№ тикета'),
      col('created_at', 'Создан', 'datetime'),
      col('enterprise', 'Предприятие', 'text'),
      col('department', 'Подразделение', 'text'),
      col('topic', 'Тема', 'text'),
      col('important', 'Особо важное', 'text'),
      col('status', 'Статус', 'text'),
      col('due_date', 'Срок', 'date'),
      col('overdue_days', 'Просрочено, дн.'),
      col('responsibles', 'Ответственные', 'text'),
      col('curators', 'Кураторы', 'text'),
      col('returns_count', 'Возвратов'),
    ],
    rows: rows.map((r) => ({
      ...r,
      created_at: new Date(r.created_at as string).toISOString(),
      important: r.is_important ? 'да' : '',
      status: TICKET_STATUS_NAMES[r.status as string] ?? r.status,
      overdue_days: Number(r.overdue_days),
    })),
    totals: null,
    notes: [
      `На ${period.today}: тикеты «Новый», «В работе» и «На доработке» с истёкшим сроком. Период отчёта не применяется.`,
    ],
  };
}

// ------------------------------------------------------------------ отзывы с карт (Ф13)

/**
 * Отзывы с карт (M-CH-10, M-REP-03): по объектам, предприятиям, оценкам, площадкам и дням — число отзывов, средняя
 * оценка, доля отвеченных (ответ из системы доставлен в Rocket Data) и среднее время до ответа. Строится по
 * обращениям канала «Отзыв»: у изменённого автором отзыва может быть несколько обращений — отзыв считается один раз
 * (последнее состояние), отвеченным — если ответили в любом из них. Период — по дате публикации отзыва.
 */
async function reviewsReport(ctx: ReportCtx, period: Period, group: ReportGroup) {
  const q = new Params();
  const t0 = q.p(period.t0);
  const t1 = q.p(period.t1);
  const tz = q.lazy(period.timezone);
  const where = dimWhere(
    q,
    {
      channel: 'rv.channel_kind',
      queue: 'rv.queue_id',
      enterprise: 'rv.enterprise_id',
      department: 'rv.department_id',
      topicPath: 'rv.topic_path',
      object: 'rv.object_id',
      important: 'rv.is_important',
      operator: 'rv.assignee_id',
      conversationId: 'rv.id::text',
    },
    ctx.filter,
    ctx.principal,
  );
  const gexpr: Record<string, () => string> = {
    object: () => 'rv.object_id::text',
    enterprise: () => 'rv.enterprise_id::text',
    rating: () => 'rv.rating::text',
    platform: () => 'rv.platform',
    day: () => localDay('rv.at', tz),
  };
  const sql = `WITH rv AS (
      SELECT DISTINCT ON (c.channel_id, c.channel_meta #>> '{review,id}')
             c.id, c.channel_id, c.channel_kind, c.queue_id, c.assignee_id, c.enterprise_id, c.department_id,
             c.topic_path, c.object_id, c.is_important, c.created_at,
             c.channel_meta #>> '{review,id}' AS rid,
             (c.channel_meta #>> '{review,rating}')::int AS rating,
             c.channel_meta #>> '{review,platform}' AS platform,
             COALESCE((c.channel_meta #>> '{review,publishedAt}')::timestamptz, c.created_at) AS at
        FROM conversation c
       WHERE c.channel_kind = 'review' AND c.channel_meta #>> '{review,id}' IS NOT NULL
       ORDER BY c.channel_id, c.channel_meta #>> '{review,id}', c.created_at DESC),
    first AS (
      SELECT c.channel_id, c.channel_meta #>> '{review,id}' AS rid, min(c.created_at) AS received_at
        FROM conversation c WHERE c.channel_kind = 'review' GROUP BY 1, 2),
    ans AS (
      SELECT c.channel_id, c.channel_meta #>> '{review,id}' AS rid, min(m.delivered_at) AS answered_at
        FROM conversation c
        JOIN message m ON m.conversation_id = c.id AND m.direction = 'out' AND m.delivery_status = 'sent'
       WHERE c.channel_kind = 'review' GROUP BY 1, 2),
    b AS (
      SELECT ${gexpr[group]!()} AS gkey, rv.rating, ans.answered_at,
             EXTRACT(EPOCH FROM ans.answered_at - first.received_at)::float8 AS answer_s
        FROM rv
        JOIN first ON first.channel_id = rv.channel_id AND first.rid = rv.rid
        LEFT JOIN ans ON ans.channel_id = rv.channel_id AND ans.rid = rv.rid
       WHERE rv.at >= ${t0} AND rv.at < ${t1} AND ${where.join(' AND ')})
    SELECT GROUPING(gkey) = 1 AS is_total, gkey,
           count(*) AS n, round(avg(rating), 2) AS avg_rating,
           count(*) FILTER (WHERE rating <= 2) AS negative,
           count(answered_at) AS answered,
           round(100.0 * count(answered_at) / NULLIF(count(*), 0), 1) AS answered_pct,
           round(avg(answer_s)) AS answer_s,
           count(*) FILTER (WHERE rating = 5) AS s5, count(*) FILTER (WHERE rating = 4) AS s4,
           count(*) FILTER (WHERE rating = 3) AS s3, count(*) FILTER (WHERE rating = 2) AS s2,
           count(*) FILTER (WHERE rating = 1) AS s1
      FROM b GROUP BY GROUPING SETS ((gkey), ())`;
  const raw = (await ctx.db.query(sql, q.list)).rows;
  const { rows, totals } = await finish(ctx.db, group, raw, [
    'n',
    'avg_rating',
    'negative',
    'answered',
    'answered_pct',
    'answer_s',
    's5',
    's4',
    's3',
    's2',
    's1',
  ]);
  if (group === 'rating') rows.sort((a, b) => String(b.key).localeCompare(String(a.key)));
  return {
    columns: [
      col('n', 'Отзывов'),
      col('avg_rating', 'Средняя оценка', 'num'),
      col('negative', 'С оценкой 1–2'),
      col('answered', 'Отвечено'),
      col('answered_pct', 'Доля отвеченных, %', 'pct'),
      col('answer_s', 'Среднее время до ответа', 'dur'),
      col('s5', '«5»'),
      col('s4', '«4»'),
      col('s3', '«3»'),
      col('s2', '«2»'),
      col('s1', '«1»'),
    ],
    rows,
    totals,
    notes: [
      'Отзывы с карт из Rocket Data по дате публикации; изменённый автором отзыв считается один раз (с последней оценкой).',
      'Отвеченный — ответ из системы доставлен в Rocket Data; время до ответа — от поступления отзыва в систему.',
    ],
  };
}

export { channelName };
