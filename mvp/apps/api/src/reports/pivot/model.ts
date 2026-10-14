import { REVIEW_PLATFORMS } from '@cc/contracts';
import { channelName } from '../query';

/**
 * Д-041. Семантическая модель конструктора отчётов: факты (что считаем), поля (по чему группируем и фильтруем)
 * и показатели (агрегаты). Поле описано для каждого факта, где имеет смысл («Оператор» есть у обращений, звонков,
 * статусов и тестов; «Ответственный» — только у 2-й линии) — так показатели разных фактов можно класть в одну
 * таблицу по общим полям. Все ключи полей — текст (NULL — «не указано»).
 */

export type FactId = 'conv' | 'ticket' | 'call' | 'status' | 'test' | 'course';
export type Format = 'int' | 'num' | 'pct' | 'dur' | 'hours' | 'rating';

/** Контекст построения SQL одного факта: параметры и границы периода. */
export interface SqlCtx {
  p(v: unknown): string;
  /** Параметр, который добавляется только при использовании (неиспользуемый $n — ошибка PostgreSQL). */
  lazy(name: string, v: unknown): string;
  /** Локальное время (часовой пояс системы) от выражения даты, со сдвигом периода сравнения. */
  local(expr: string): string;
  t0: string;
  t1: string;
  today: string;
  /** Шаг поля «Период»: day | week | month | quarter | year. */
  grain: string;
  me: string;
}

export interface FactDef {
  id: FactId;
  label: string;
  from: string;
  /** Дата, по которой факт попадает в период и раскладывается по полям «Время». */
  date: string;
  /** Условие периода; по умолчанию — дата в [t0, t1). */
  period?: (c: SqlCtx) => string;
  joins: Record<string, { sql: string; needs?: string[] }>;
  /** Область видимости: колонки для scopeFilter и, для 2-й линии, «свои» тикеты. */
  scope: { enterprise: string; department: string; topicPath?: string; mine?: string; joins: string[] };
}

export interface DimImpl {
  key: string;
  label?: string;
  joins?: string[];
}
export interface DimDef {
  id: string;
  section: string;
  label: string;
  hint?: string;
  /** Выражение ключа (и подписи) для каждого факта, где поле есть. */
  facts: Partial<Record<FactId, DimImpl | ((c: SqlCtx) => DimImpl)>>;
  /** Подписи ключей без справочника (перечисления). */
  names?: Record<string, string>;
  /** Подпись по ключу (даты, оценки). */
  labelOf?: (key: string, grain: string) => string;
  /** Откуда брать значения для фильтра: перечисление, SQL справочника (id, name) или нет списка. */
  values?: 'names' | { sql: string; params?: unknown[] } | 'none';
  /** Сортировка по умолчанию: по ключу (даты, номера) или по подписи. */
  sort?: 'key' | 'label';
  /** Поле «АЗС» — выбор на карте. */
  map?: boolean;
}

export interface MeasureDef {
  id: string;
  section: string;
  fact: FactId;
  label: string;
  hint?: string;
  format: Format;
  sql: (c: SqlCtx) => string;
  joins?: string[];
}

export interface SectionDef {
  id: string;
  label: string;
}

export const SECTIONS: SectionDef[] = [
  { id: 'time', label: 'Время' },
  { id: 'conv', label: 'Обращения 1-й линии' },
  { id: 'csat', label: 'Оценки и отзывы' },
  { id: 'org', label: 'Организация' },
  { id: 'topic', label: 'Темы' },
  { id: 'obj', label: 'АЗС и ЭЗС' },
  { id: 'fields', label: 'Поля карточки обращения' },
  { id: 'call', label: 'Звонки и IVR' },
  { id: 'ticket', label: '2-я линия' },
  { id: 'staff', label: 'Работа операторов' },
  { id: 'learn', label: 'Обучение и тесты' },
];

// ------------------------------------------------------------------ факты

const topicJoins = (path: string) => ({
  tp1: { sql: `LEFT JOIN topic tp1 ON tp1.id = (${path})[1]` },
  tp2: { sql: `LEFT JOIN topic tp2 ON tp2.id = (${path})[2]` },
});

const convLike = (a: string) => ({
  q: { sql: `LEFT JOIN queue q ON q.id = ${a}.queue_id` },
  so: { sql: `LEFT JOIN service_object so ON so.id = ${a}.object_id` },
  soent: { sql: `LEFT JOIN enterprise soent ON soent.id = so.enterprise_id`, needs: ['so'] },
});

export const FACTS: Record<FactId, FactDef> = {
  conv: {
    id: 'conv',
    label: 'Обращения 1-й линии',
    from: 'conversation c',
    date: 'c.created_at',
    joins: {
      ...convLike('c'),
      op: { sql: `LEFT JOIN app_user op ON op.id = c.assignee_id` },
      ent: { sql: `LEFT JOIN enterprise ent ON ent.id = c.enterprise_id` },
      dep: { sql: `LEFT JOIN department dep ON dep.id = c.department_id` },
      tpl: { sql: `LEFT JOIN topic tpl ON tpl.id = c.topic_id` },
      ...topicJoins('c.topic_path'),
      disp: { sql: `LEFT JOIN disposition disp ON disp.id = c.disposition_id` },
      cs: {
        sql: `LEFT JOIN LATERAL (SELECT avg(r.score)::float8 AS score FROM csat_rating r WHERE r.conversation_id = c.id) cs ON true`,
      },
      tk: {
        sql: `LEFT JOIN LATERAL (SELECT count(*) AS n FROM ticket t2 WHERE t2.conversation_id = c.id) tk ON true`,
      },
      // Звонок обращения попадал в очередь (событие queued); без него — завершён в IVR.
      cq: {
        sql: `LEFT JOIN LATERAL (SELECT min(qe.at) AS at FROM call qc JOIN call_event qe ON qe.call_id = qc.id
                AND qe.type = 'queued' WHERE qc.conversation_id = c.id) cq ON true`,
      },
      rp: {
        sql: `LEFT JOIN LATERAL (SELECT 1 AS yes FROM conversation p WHERE p.contact_id = c.contact_id AND p.id <> c.id
                AND p.created_at < c.created_at AND p.created_at >= c.created_at - interval '30 days' LIMIT 1) rp ON true`,
      },
    },
    scope: {
      enterprise: 'c.enterprise_id',
      department: 'c.department_id',
      topicPath: 'c.topic_path',
      joins: [],
    },
  },
  ticket: {
    id: 'ticket',
    label: '2-я линия',
    from: 'ticket t',
    date: 't.created_at',
    joins: {
      tc: { sql: `LEFT JOIN conversation tc ON tc.id = t.conversation_id` },
      q: { sql: `LEFT JOIN queue q ON q.id = tc.queue_id`, needs: ['tc'] },
      so: { sql: `LEFT JOIN service_object so ON so.id = tc.object_id`, needs: ['tc'] },
      soent: { sql: `LEFT JOIN enterprise soent ON soent.id = so.enterprise_id`, needs: ['so'] },
      op: { sql: `LEFT JOIN app_user op ON op.id = t.created_by` },
      ent: { sql: `LEFT JOIN enterprise ent ON ent.id = t.enterprise_id` },
      dep: { sql: `LEFT JOIN department dep ON dep.id = t.department_id` },
      tpl: { sql: `LEFT JOIN topic tpl ON tpl.id = t.topic_id` },
      ...topicJoins('t.topic_path'),
      resp: {
        sql: `LEFT JOIN LATERAL (SELECT a.user_id, u.full_name FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id
                WHERE a.ticket_id = t.id AND a.kind = 'responsible' ORDER BY a.is_active DESC, a.added_at LIMIT 1) resp ON true`,
      },
      cur: {
        sql: `LEFT JOIN LATERAL (SELECT a.user_id, u.full_name FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id
                WHERE a.ticket_id = t.id AND a.kind = 'curator' ORDER BY a.is_active DESC, a.added_at LIMIT 1) cur ON true`,
      },
      am: { sql: `LEFT JOIN answer_method am ON am.id = t.answer_method_id` },
    },
    scope: {
      enterprise: 't.enterprise_id',
      department: 't.department_id',
      topicPath: 't.topic_path',
      mine: `ARRAY(SELECT sa.user_id FROM ticket_assignee sa WHERE sa.ticket_id = t.id)`,
      joins: [],
    },
  },
  call: {
    id: 'call',
    label: 'Звонки',
    from: 'call cl',
    date: 'cl.started_at',
    joins: {
      cc: { sql: `LEFT JOIN conversation cc ON cc.id = cl.conversation_id` },
      q: { sql: `LEFT JOIN queue q ON q.id = cc.queue_id`, needs: ['cc'] },
      so: { sql: `LEFT JOIN service_object so ON so.id = cc.object_id`, needs: ['cc'] },
      soent: { sql: `LEFT JOIN enterprise soent ON soent.id = so.enterprise_id`, needs: ['so'] },
      op: { sql: `LEFT JOIN app_user op ON op.id = cl.agent_user_id` },
      ent: { sql: `LEFT JOIN enterprise ent ON ent.id = cc.enterprise_id`, needs: ['cc'] },
      dep: { sql: `LEFT JOIN department dep ON dep.id = cc.department_id`, needs: ['cc'] },
      tpl: { sql: `LEFT JOIN topic tpl ON tpl.id = cc.topic_id`, needs: ['cc'] },
      tp1: { sql: `LEFT JOIN topic tp1 ON tp1.id = cc.topic_path[1]`, needs: ['cc'] },
      tp2: { sql: `LEFT JOIN topic tp2 ON tp2.id = cc.topic_path[2]`, needs: ['cc'] },
      fv: { sql: `LEFT JOIN flow_version fv ON fv.id = cl.flow_version_id` },
      qe: {
        sql: `LEFT JOIN LATERAL (SELECT min(e.at) AS at FROM call_event e WHERE e.call_id = cl.id AND e.type = 'queued') qe ON true`,
      },
    },
    scope: {
      enterprise: 'cc.enterprise_id',
      department: 'cc.department_id',
      topicPath: 'cc.topic_path',
      joins: ['cc'],
    },
  },
  status: {
    id: 'status',
    label: 'Статусы операторов',
    from: 'agent_status_log s',
    date: 's.started_at',
    // Отрезок статуса попадает в период, если пересекается с ним (длительность считается только внутри периода).
    period: (c) => `s.started_at < ${c.t1} AND COALESCE(s.ended_at, now()) > ${c.t0}`,
    joins: {
      op: { sql: `LEFT JOIN app_user op ON op.id = s.user_id` },
      br: { sql: `LEFT JOIN break_reason br ON br.id = s.reason_id` },
    },
    scope: { enterprise: 'op.primary_enterprise_id', department: 'op.primary_department_id', joins: ['op'] },
  },
  test: {
    id: 'test',
    label: 'Тесты',
    from: 'test_attempt ta',
    date: 'ta.finished_at',
    joins: {
      op: { sql: `LEFT JOIN app_user op ON op.id = ta.user_id` },
      kt: { sql: `LEFT JOIN knowledge_test kt ON kt.id = ta.test_id` },
    },
    scope: { enterprise: 'op.primary_enterprise_id', department: 'op.primary_department_id', joins: ['op'] },
  },
  course: {
    id: 'course',
    label: 'Курсы',
    from: 'course_assignment ca',
    date: 'ca.created_at',
    joins: {
      op: { sql: `LEFT JOIN app_user op ON op.id = ca.user_id` },
      crs: { sql: `LEFT JOIN course crs ON crs.id = ca.course_id` },
    },
    scope: { enterprise: 'op.primary_enterprise_id', department: 'op.primary_department_id', joins: ['op'] },
  },
};

// ------------------------------------------------------------------ подписи

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];
const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const dmy = (iso: string) => `${ddmm(iso)}.${iso.slice(0, 4)}`;

/** Подпись значения поля «Период» по шагу: ключ — дата начала шага (YYYY-MM-DD). */
export function periodLabel(key: string, grain: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  const y = key.slice(0, 4);
  const m = Number(key.slice(5, 7));
  switch (grain) {
    case 'year':
      return y;
    case 'quarter':
      return `${Math.floor((m - 1) / 3) + 1} кв. ${y}`;
    case 'month':
      return `${MONTHS[m - 1]} ${y}`;
    case 'week': {
      const end = new Date(`${key}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 6);
      return `${ddmm(key)}–${dmy(end.toISOString().slice(0, 10))}`;
    }
    default:
      return dmy(key);
  }
}

const yesNo = { '1': 'Да', '0': 'Нет' };
const boolKey = (e: string) => `CASE WHEN ${e} THEN '1' ELSE '0' END`;
const idName = (id: string, name: string, joins: string[]): DimImpl => ({
  key: `${id}::text`,
  label: name,
  joins,
});
const grainOf = (g: string) => (['day', 'week', 'month', 'quarter', 'year'].includes(g) ? g : 'month');

const usersSql = (perm?: string) => ({
  sql: perm
    ? `SELECT u.id::text AS id, u.full_name AS name FROM app_user u WHERE EXISTS (SELECT 1 FROM user_role ur
         JOIN role r ON r.code = ur.role_code WHERE ur.user_id = u.id AND $1 = ANY(r.permissions)) ORDER BY 2`
    : `SELECT u.id::text AS id, u.full_name AS name FROM app_user u WHERE u.is_active ORDER BY 2`,
  params: perm ? [perm] : [],
});

/** Поле «Время» — одно выражение от даты факта (у каждого факта своя дата). */
function timeDim(
  id: string,
  label: string,
  expr: (local: string, c: SqlCtx) => string,
  extra: Partial<DimDef> = {},
) {
  const facts: DimDef['facts'] = {};
  for (const f of Object.values(FACTS)) facts[f.id] = (c) => ({ key: expr(c.local(f.date), c) });
  return { id, section: 'time', label, facts, sort: 'key', ...extra } as DimDef;
}

/** Поле, одинаковое у фактов с одинаковыми псевдонимами связей (op, ent, dep, tp1 …). */
function shared(ids: FactId[], impl: DimImpl): DimDef['facts'] {
  return Object.fromEntries(ids.map((f) => [f, impl]));
}

const CONV_STATUS: Record<string, string> = {
  new: 'Новое',
  bot: 'У бота',
  queued: 'В очереди',
  offered: 'Предложено оператору',
  active: 'В работе',
  hold: 'На удержании',
  wrap_up: 'Постобработка',
  waiting_customer: 'Ждёт клиента',
  waiting_2nd_line: 'Ждёт 2-ю линию',
  closed: 'Закрыто',
};
const TICKET_STATUS: Record<string, string> = {
  new: 'Новое',
  in_work: 'В работе',
  approval: 'На согласовании',
  rework: 'На доработке',
  closed: 'Закрыто',
};
const MEASURES_NAMES: Record<string, string> = {
  none: 'Не применялись',
  remark: 'Замечание',
  reprimand: 'Выговор',
  depremium: 'Депремирование',
  dismissal: 'Увольнение',
};
export const AGENT_STATUS: Record<string, string> = {
  ready: 'Готов',
  break: 'Перерыв',
  wrap_up: 'Постобработка',
  offline: 'Не на линии',
  busy: 'Занят',
};
const CHANNELS = ['voice', 'webchat', 'app', 'telegram', 'email', 'api', 'review'];

/**
 * Обращение обслужено без очереди: звонок завершён в IVR (нет события queued) или чат закрыт ботом без
 * предложения оператору. Время постановки в очередь у обращения есть всегда (по умолчанию — время создания).
 */
const SELF = `((c.channel_kind = 'voice' AND cq.at IS NULL) OR (c.bot_flow_version_id IS NOT NULL AND c.offered_at IS NULL))`;
/** Ответ на обращение: принято оператором, пропущено в очереди, обработано без очереди (бот, IVR), открыто. */
const answerKey = `CASE WHEN c.assigned_at IS NOT NULL THEN 'answered'
        WHEN c.status <> 'closed' THEN 'open'
        WHEN ${SELF} THEN 'self'
        ELSE 'missed' END`;

// ------------------------------------------------------------------ поля

export const DIMS: DimDef[] = [
  timeDim(
    'time.period',
    'Период (по шагу)',
    (l, c) => `to_char(date_trunc('${grainOf(c.grain)}', ${l}), 'YYYY-MM-DD')`,
    {
      hint: 'Дни, недели, месяцы, кварталы или годы — выбирается переключателем «Шаг» над таблицей',
      labelOf: periodLabel,
      values: 'none',
    },
  ),
  timeDim('time.year', 'Год', (l) => `to_char(${l}, 'YYYY')`, {
    values: { sql: `SELECT y::text AS id, y::text AS name FROM generate_series(2024, 2035) y` },
  }),
  timeDim('time.quarter', 'Квартал', (l) => `to_char(${l}, 'Q')`, {
    names: { '1': '1 квартал', '2': '2 квартал', '3': '3 квартал', '4': '4 квартал' },
    values: 'names',
  }),
  timeDim('time.month', 'Месяц', (l) => `to_char(${l}, 'MM')`, {
    names: Object.fromEntries(MONTHS.map((m, i) => [String(i + 1).padStart(2, '0'), m])),
    values: 'names',
  }),
  timeDim('time.week', 'Неделя года', (l) => `to_char(${l}, 'IW')`, {
    labelOf: (k) => `Неделя ${Number(k)}`,
    values: {
      sql: `SELECT lpad(w::text, 2, '0') AS id, 'Неделя ' || w AS name FROM generate_series(1, 53) w`,
    },
  }),
  timeDim('time.date', 'Дата', (l) => `to_char(${l}, 'YYYY-MM-DD')`, { labelOf: dmy, values: 'none' }),
  timeDim('time.weekday', 'День недели', (l) => `to_char(${l}, 'ID')`, {
    names: Object.fromEntries(WEEKDAYS.map((d, i) => [String(i + 1), d])),
    values: 'names',
  }),
  timeDim('time.hour', 'Час', (l) => `to_char(${l}, 'HH24')`, {
    labelOf: (k) => `${k}:00`,
    values: {
      sql: `SELECT lpad(h::text, 2, '0') AS id, lpad(h::text, 2, '0') || ':00' AS name FROM generate_series(0, 23) h`,
    },
  }),
  timeDim('time.dom', 'День месяца', (l) => `to_char(${l}, 'DD')`, {
    labelOf: (k) => String(Number(k)),
    values: {
      sql: `SELECT lpad(d::text, 2, '0') AS id, d::text AS name FROM generate_series(1, 31) d`,
    },
  }),

  // --- обращения
  {
    id: 'conv.channel',
    section: 'conv',
    label: 'Канал (источник)',
    facts: {
      conv: { key: 'c.channel_kind' },
      ticket: { key: 'tc.channel_kind', joins: ['tc'] },
      call: { key: `'voice'` },
    },
    names: Object.fromEntries(CHANNELS.map((k) => [k, channelName(k)])),
    values: 'names',
    sort: 'label',
  },
  {
    id: 'conv.status',
    section: 'conv',
    label: 'Статус обращения',
    facts: { conv: { key: 'c.status' } },
    names: CONV_STATUS,
    values: 'names',
  },
  {
    id: 'conv.queue',
    section: 'conv',
    label: 'Очередь',
    facts: shared(['conv', 'ticket', 'call'], idName('q.id', 'q.name', ['q'])),
    values: { sql: `SELECT id::text AS id, name FROM queue ORDER BY name` },
    sort: 'label',
  },
  {
    id: 'staff.operator',
    section: 'conv',
    label: 'Оператор (ФИО)',
    hint: 'Обращения — кто вёл; 2-я линия — кто передал; звонки — кто разговаривал; статусы, тесты, курсы — сотрудник',
    facts: shared(
      ['conv', 'ticket', 'call', 'status', 'test', 'course'],
      idName('op.id', 'op.full_name', ['op']),
    ),
    values: usersSql(),
    sort: 'label',
  },
  {
    id: 'conv.answer',
    section: 'conv',
    label: 'Принято оператором',
    hint: 'Принято; пропущено (закрыто в очереди); без очереди (бот, IVR, автоответ); ещё открыто',
    facts: { conv: { key: answerKey, joins: ['cq'] } },
    names: { answered: 'Принято', missed: 'Пропущено', self: 'Без очереди', open: 'Открыто' },
    values: 'names',
  },
  {
    id: 'conv.result',
    section: 'conv',
    label: 'Результат обработки',
    facts: { conv: idName('disp.id', 'disp.name', ['disp']) },
    values: { sql: `SELECT id::text AS id, name FROM disposition ORDER BY sort_order, name` },
    sort: 'label',
  },
  {
    id: 'conv.important',
    section: 'conv',
    label: 'Особо важное',
    facts: {
      conv: { key: boolKey('c.is_important') },
      ticket: { key: boolKey('t.is_important') },
    },
    names: yesNo,
    values: 'names',
  },
  {
    id: 'conv.urgent',
    section: 'conv',
    label: 'Срочное',
    facts: { conv: { key: boolKey('c.is_urgent') }, ticket: { key: boolKey('tc.is_urgent'), joins: ['tc'] } },
    names: yesNo,
    values: 'names',
  },
  {
    id: 'conv.escalated',
    section: 'conv',
    label: 'Передано на 2-ю линию',
    facts: { conv: { key: boolKey('(c.escalated OR tk.n > 0)'), joins: ['tk'] } },
    names: yesNo,
    values: 'names',
  },
  {
    id: 'conv.callback',
    section: 'conv',
    label: 'Требовался перезвон клиенту',
    facts: { conv: { key: boolKey('c.callback_requested') } },
    names: yesNo,
    values: 'names',
  },
  {
    id: 'conv.repeat',
    section: 'conv',
    label: 'Повторное (клиент обращался за 30 дней)',
    facts: { conv: { key: boolKey('rp.yes IS NOT NULL'), joins: ['rp'] } },
    names: yesNo,
    values: 'names',
  },
  {
    id: 'conv.bonusCard',
    section: 'conv',
    label: 'Указана бонусная карта',
    hint: 'В карточке заполнен № бонусной карты «Заправка»',
    facts: { conv: { key: boolKey(`COALESCE(c.fields ->> 'bonus_card', '') <> ''`) } },
    names: yesNo,
    values: 'names',
  },
  {
    id: 'conv.company',
    section: 'conv',
    label: 'Клиент — компания',
    hint: 'В карточке указано наименование компании или № договора',
    facts: {
      conv: {
        key: boolKey(
          `COALESCE(c.fields ->> 'company_name', '') <> '' OR COALESCE(c.fields ->> 'contract_no', '') <> ''`,
        ),
      },
    },
    names: yesNo,
    values: 'names',
  },

  // --- оценки
  {
    id: 'csat.score',
    section: 'csat',
    label: 'Оценка клиента',
    facts: { conv: { key: 'round(cs.score)::int::text', joins: ['cs'] } },
    labelOf: (k) => `${'★'.repeat(Number(k))}${'☆'.repeat(Math.max(0, 5 - Number(k)))} (${k})`,
    values: { sql: `SELECT s::text AS id, s::text AS name FROM generate_series(1, 5) s` },
  },
  {
    id: 'review.platform',
    section: 'csat',
    label: 'Площадка отзыва',
    facts: { conv: { key: `c.channel_meta -> 'review' ->> 'platform'` } },
    names: REVIEW_PLATFORMS,
    values: 'names',
    sort: 'label',
  },
  {
    id: 'review.rating',
    section: 'csat',
    label: 'Оценка в отзыве',
    facts: { conv: { key: `round((c.channel_meta -> 'review' ->> 'rating')::numeric)::int::text` } },
    labelOf: (k) => `${'★'.repeat(Number(k))}${'☆'.repeat(Math.max(0, 5 - Number(k)))} (${k})`,
    values: { sql: `SELECT s::text AS id, s::text AS name FROM generate_series(1, 5) s` },
  },

  // --- организация и темы
  {
    id: 'org.enterprise',
    section: 'org',
    label: 'Предприятие',
    hint: 'Обращения и звонки — предприятие из карточки; 2-я линия — ответственное предприятие',
    facts: shared(['conv', 'ticket', 'call'], idName('ent.id', 'ent.name', ['ent'])),
    values: { sql: `SELECT id::text AS id, name FROM enterprise WHERE is_active ORDER BY name` },
    sort: 'label',
  },
  {
    id: 'org.department',
    section: 'org',
    label: 'Подразделение',
    facts: shared(['conv', 'ticket', 'call'], idName('dep.id', 'dep.name', ['dep'])),
    values: { sql: `SELECT id::text AS id, name FROM department WHERE is_active ORDER BY name` },
    sort: 'label',
  },
  {
    id: 'topic.l1',
    section: 'topic',
    label: 'Тема',
    facts: shared(['conv', 'ticket', 'call'], idName('tp1.id', 'tp1.name', ['tp1'])),
    values: {
      sql: `SELECT id::text AS id, name FROM topic WHERE level = 1 AND is_active ORDER BY sort_order, name`,
    },
    sort: 'label',
  },
  {
    id: 'topic.l2',
    section: 'topic',
    label: 'Подтема',
    facts: shared(['conv', 'ticket', 'call'], idName('tp2.id', 'tp2.name', ['tp2'])),
    values: {
      sql: `SELECT t.id::text AS id, p.name || ' / ' || t.name AS name FROM topic t JOIN topic p ON p.id = t.parent_id
             WHERE t.level = 2 AND t.is_active ORDER BY 2`,
    },
    sort: 'label',
  },
  {
    id: 'topic.leaf',
    section: 'topic',
    label: 'Тема (последний уровень)',
    facts: shared(['conv', 'ticket', 'call'], idName('tpl.id', 'tpl.name', ['tpl'])),
    values: { sql: `SELECT id::text AS id, name FROM topic WHERE is_active ORDER BY name` },
    sort: 'label',
  },

  // --- АЗС и ЭЗС
  {
    id: 'obj.station',
    section: 'obj',
    label: 'АЗС / ЭЗС',
    hint: 'Можно выбрать на карте — обвести область',
    facts: shared(
      ['conv', 'ticket', 'call'],
      idName(
        'so.id',
        `CASE WHEN so.kind = 'ezs' THEN so.name ELSE so.name || COALESCE(', ' || NULLIF(so.address, ''), '') END`,
        ['so'],
      ),
    ),
    values: {
      sql: `SELECT so.id::text AS id, so.name || COALESCE(', ' || NULLIF(so.address, ''), '') AS name
              FROM service_object so JOIN enterprise e ON e.id = so.enterprise_id AND e.is_active
             WHERE so.is_active ORDER BY so.kind, NULLIF(substring(so.name from '[0-9]+'), '')::int NULLS LAST, so.name LIMIT 3000`,
    },
    sort: 'label',
    map: true,
  },
  {
    id: 'obj.kind',
    section: 'obj',
    label: 'Вид станции',
    facts: shared(['conv', 'ticket', 'call'], {
      key: `CASE WHEN so.kind = 'ezs' THEN 'ezs' WHEN so.id IS NOT NULL THEN 'azs' END`,
      joins: ['so'],
    }),
    names: { azs: 'АЗС', ezs: 'ЭЗС' },
    values: 'names',
  },
  {
    id: 'obj.owner',
    section: 'obj',
    label: 'Предприятие — владелец станции',
    facts: shared(['conv', 'ticket', 'call'], idName('soent.id', 'soent.name', ['soent'])),
    values: { sql: `SELECT id::text AS id, name FROM enterprise WHERE is_active ORDER BY name` },
    sort: 'label',
  },

  // --- звонки
  {
    id: 'call.direction',
    section: 'call',
    label: 'Направление звонка',
    facts: { call: { key: 'cl.direction' } },
    names: { in: 'Входящий', out: 'Исходящий' },
    values: 'names',
  },
  {
    id: 'call.result',
    section: 'call',
    label: 'Итог звонка',
    hint: 'Отвечен оператором; завершён в IVR (без очереди); короткий сброс в очереди; пропущен',
    facts: {
      call: (c) => ({
        key: `CASE WHEN cl.agent_user_id IS NOT NULL THEN 'answered'
                   WHEN cl.ended_at IS NULL THEN 'live'
                   WHEN qe.at IS NULL THEN 'ivr'
                   WHEN EXTRACT(EPOCH FROM cl.ended_at - qe.at) < ${c.lazy('short', 5)}::int THEN 'short'
                   ELSE 'missed' END`,
        joins: ['qe'],
      }),
    },
    names: {
      answered: 'Отвечен',
      ivr: 'Завершён в IVR',
      short: 'Короткий сброс',
      missed: 'Пропущен',
      live: 'Идёт сейчас',
    },
    values: 'names',
  },
  {
    id: 'call.endReason',
    section: 'call',
    label: 'Кто завершил звонок',
    facts: { call: { key: 'cl.end_reason' } },
    names: {
      client_hangup: 'Клиент',
      agent_hangup: 'Оператор',
      transfer: 'Переведён',
      timeout: 'По времени',
      error: 'Ошибка связи',
    },
    values: 'names',
  },
  {
    id: 'call.ivrBranch',
    section: 'call',
    label: 'Ветка голосового меню',
    hint: 'Пункт главного меню, который выбрал клиент',
    facts: {
      call: {
        key: `COALESCE(cl.ivr_state -> 'flow' -> 'menuStack' ->> 1, cl.ivr_state -> 'flow' ->> 'node')`,
        label: `(SELECT n ->> 'name' FROM jsonb_array_elements(fv.graph -> 'nodes') n
                  WHERE n ->> 'id' = COALESCE(cl.ivr_state -> 'flow' -> 'menuStack' ->> 1, cl.ivr_state -> 'flow' ->> 'node') LIMIT 1)`,
        joins: ['fv'],
      },
    },
    values: 'none',
    sort: 'label',
  },

  // --- 2-я линия
  {
    id: 'ticket.status',
    section: 'ticket',
    label: 'Статус на 2-й линии',
    facts: { ticket: { key: 't.status' } },
    names: TICKET_STATUS,
    values: 'names',
  },
  {
    id: 'ticket.responsible',
    section: 'ticket',
    label: 'Ответственный',
    facts: { ticket: idName('resp.user_id', 'resp.full_name', ['resp']) },
    values: usersSql('tickets.work'),
    sort: 'label',
  },
  {
    id: 'ticket.curator',
    section: 'ticket',
    label: 'Куратор',
    facts: { ticket: idName('cur.user_id', 'cur.full_name', ['cur']) },
    values: usersSql('tickets.work'),
    sort: 'label',
  },
  {
    id: 'ticket.answerMethod',
    section: 'ticket',
    label: 'Способ ответа клиенту',
    facts: { ticket: idName('am.id', 'am.name', ['am']) },
    values: { sql: `SELECT id::text AS id, name FROM answer_method ORDER BY sort_order, name` },
    sort: 'label',
  },
  {
    id: 'ticket.guilt',
    section: 'ticket',
    label: 'Вина работника',
    facts: { ticket: { key: `CASE WHEN t.staff_guilty THEN '1' WHEN t.staff_guilty = false THEN '0' END` } },
    names: { '1': 'Есть', '0': 'Нет' },
    values: 'names',
  },
  {
    id: 'ticket.measures',
    section: 'ticket',
    label: 'Принятые меры',
    facts: { ticket: { key: `NULLIF(array_to_string(t.measures, ','), '')` } },
    labelOf: (k) =>
      k
        .split(',')
        .map((m) => MEASURES_NAMES[m] ?? m)
        .join(', '),
    values: 'names',
    names: MEASURES_NAMES,
  },
  {
    id: 'ticket.inTime',
    section: 'ticket',
    label: 'Закрыто в срок',
    facts: {
      ticket: (c) => ({
        key: `CASE WHEN t.status = 'closed' THEN CASE WHEN t.closed_in_time THEN 'ok' ELSE 'late' END
                   WHEN t.due_date < ${c.today}::date THEN 'overdue' ELSE 'open' END`,
      }),
    },
    names: {
      ok: 'В срок',
      late: 'С нарушением срока',
      overdue: 'Не закрыто, просрочено',
      open: 'Не закрыто, в срок',
    },
    values: 'names',
  },

  // --- операторы
  {
    id: 'staff.status',
    section: 'staff',
    label: 'Статус оператора',
    facts: { status: { key: 's.status' } },
    names: AGENT_STATUS,
    values: 'names',
  },
  {
    id: 'staff.breakReason',
    section: 'staff',
    label: 'Причина перерыва',
    facts: { status: idName('br.id', 'br.name', ['br']) },
    values: { sql: `SELECT id::text AS id, name FROM break_reason ORDER BY name` },
    sort: 'label',
  },

  // --- обучение
  {
    id: 'learn.test',
    section: 'learn',
    label: 'Тест',
    facts: { test: idName('kt.id', 'kt.title', ['kt']) },
    values: { sql: `SELECT id::text AS id, title AS name FROM knowledge_test ORDER BY title` },
    sort: 'label',
  },
  {
    id: 'learn.passed',
    section: 'learn',
    label: 'Тест сдан',
    facts: { test: { key: boolKey('ta.passed') } },
    names: yesNo,
    values: 'names',
  },
  {
    id: 'learn.course',
    section: 'learn',
    label: 'Курс',
    facts: { course: idName('crs.id', 'crs.title', ['crs']) },
    values: { sql: `SELECT id::text AS id, title AS name FROM course ORDER BY sort_order, title` },
    sort: 'label',
  },
  {
    id: 'learn.courseState',
    section: 'learn',
    label: 'Состояние курса',
    facts: {
      course: (c) => ({
        key: `CASE WHEN ca.completed_at IS NOT NULL THEN 'done' WHEN ca.cancelled_at IS NOT NULL THEN 'cancelled'
                   WHEN ca.due_date < ${c.today}::date THEN 'overdue' ELSE 'assigned' END`,
      }),
    },
    names: { done: 'Пройден', assigned: 'Назначен', overdue: 'Просрочен', cancelled: 'Отменён' },
    values: 'names',
  },
];

// ------------------------------------------------------------------ показатели

const secs = (a: string, b: string) => `EXTRACT(EPOCH FROM (${a}) - (${b}))`;
const pct = (num: string, den: string) => `round(100.0 * (${num}) / NULLIF(${den}, 0), 1)`;
/** Порог SL обращения: голос — свой, текстовые каналы — свой (настройки отчётов, В-51). */
const slThr = (c: SqlCtx, ch: string) =>
  `CASE WHEN ${ch} = 'voice' THEN ${c.lazy('slv', 20)}::int ELSE ${c.lazy('slt', 60)}::int END`;
const ANSWERED = `c.assigned_at IS NOT NULL`;
const MISSED = `c.status = 'closed' AND c.assigned_at IS NULL AND NOT ${SELF}`;
const WAIT = secs('c.assigned_at', 'COALESCE(c.queued_at, c.created_at)');
const CALL_ANS = `cl.agent_user_id IS NOT NULL`;
const CALL_QUEUED_MISS = `cl.agent_user_id IS NULL AND cl.ended_at IS NOT NULL AND qe.at IS NOT NULL`;
/** Длительность отрезка статуса внутри периода. */
const STATUS_S = (c: SqlCtx) =>
  `GREATEST(0, EXTRACT(EPOCH FROM LEAST(COALESCE(s.ended_at, now()), ${c.t1}) - GREATEST(s.started_at, ${c.t0})))`;

export const MEASURES: MeasureDef[] = [
  // --- обращения
  {
    id: 'conv.count',
    section: 'conv',
    fact: 'conv',
    label: 'Обращений',
    format: 'int',
    sql: () => 'count(*)',
  },
  {
    id: 'conv.closed',
    section: 'conv',
    fact: 'conv',
    label: 'Закрыто',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE c.status = 'closed')`,
  },
  {
    id: 'conv.open',
    section: 'conv',
    fact: 'conv',
    label: 'Не закрыто',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE c.status <> 'closed')`,
  },
  {
    id: 'conv.answered',
    section: 'conv',
    fact: 'conv',
    label: 'Принято оператором',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE ${ANSWERED})`,
  },
  {
    id: 'conv.missed',
    section: 'conv',
    fact: 'conv',
    label: 'Пропущено',
    hint: 'Закрыто в очереди, оператор не принял',
    joins: ['cq'],
    format: 'int',
    sql: () => `count(*) FILTER (WHERE ${MISSED})`,
  },
  {
    id: 'conv.answeredPct',
    section: 'conv',
    fact: 'conv',
    label: 'Доля отвеченных, %',
    hint: 'Принятые / (принятые + пропущенные)',
    joins: ['cq'],
    format: 'pct',
    sql: () => pct(`count(*) FILTER (WHERE ${ANSWERED})`, `count(*) FILTER (WHERE ${ANSWERED} OR ${MISSED})`),
  },
  {
    id: 'conv.missedPct',
    section: 'conv',
    fact: 'conv',
    label: 'Доля пропущенных, %',
    joins: ['cq'],
    format: 'pct',
    sql: () => pct(`count(*) FILTER (WHERE ${MISSED})`, `count(*) FILTER (WHERE ${ANSWERED} OR ${MISSED})`),
  },
  {
    id: 'conv.sl',
    section: 'conv',
    fact: 'conv',
    label: 'SL, %',
    hint: 'Принято за порог (голос и текст — из настроек отчётов) / (принятые + пропущенные)',
    joins: ['cq'],
    format: 'pct',
    sql: (c) =>
      pct(
        `count(*) FILTER (WHERE ${ANSWERED} AND ${WAIT} <= ${slThr(c, 'c.channel_kind')})`,
        `count(*) FILTER (WHERE ${ANSWERED} OR ${MISSED})`,
      ),
  },
  {
    id: 'conv.shortAbandon',
    section: 'conv',
    fact: 'conv',
    label: 'Короткие сбросы',
    hint: 'Пропущенные, ожидавшие меньше порога короткого сброса',
    joins: ['cq'],
    format: 'int',
    sql: (c) =>
      `count(*) FILTER (WHERE ${MISSED} AND ${secs('c.closed_at', 'c.queued_at')} < ${c.lazy('short', 5)}::int)`,
  },
  {
    id: 'conv.waitAvg',
    section: 'conv',
    fact: 'conv',
    label: 'Среднее время ожидания',
    format: 'dur',
    sql: () => `avg(${WAIT}) FILTER (WHERE ${ANSWERED})`,
  },
  {
    id: 'conv.waitMax',
    section: 'conv',
    fact: 'conv',
    label: 'Максимальное время ожидания',
    format: 'dur',
    sql: () => `max(${WAIT}) FILTER (WHERE ${ANSWERED})`,
  },
  {
    id: 'conv.firstResponse',
    section: 'conv',
    fact: 'conv',
    label: 'Время до первого ответа',
    format: 'dur',
    sql: () =>
      `avg(${secs('c.first_response_at', 'c.created_at')}) FILTER (WHERE c.first_response_at IS NOT NULL)`,
  },
  {
    id: 'conv.handleAvg',
    section: 'conv',
    fact: 'conv',
    label: 'Длительность обработки (средняя)',
    hint: 'От принятия оператором до закрытия',
    format: 'dur',
    sql: () =>
      `avg(${secs('c.closed_at', 'c.assigned_at')}) FILTER (WHERE c.closed_at IS NOT NULL AND ${ANSWERED})`,
  },
  {
    id: 'conv.handleSum',
    section: 'conv',
    fact: 'conv',
    label: 'Время обработки (всего)',
    format: 'hours',
    sql: () =>
      `sum(${secs('c.closed_at', 'c.assigned_at')}) FILTER (WHERE c.closed_at IS NOT NULL AND ${ANSWERED})`,
  },
  {
    id: 'conv.escalated',
    section: 'conv',
    fact: 'conv',
    label: 'Передано на 2-ю линию',
    format: 'int',
    joins: ['tk'],
    sql: () => `count(*) FILTER (WHERE c.escalated OR tk.n > 0)`,
  },
  {
    id: 'conv.escalatedPct',
    section: 'conv',
    fact: 'conv',
    label: 'Доля переданных на 2-ю линию, %',
    format: 'pct',
    joins: ['tk'],
    sql: () => pct(`count(*) FILTER (WHERE c.escalated OR tk.n > 0)`, 'count(*)'),
  },
  {
    id: 'conv.important',
    section: 'conv',
    fact: 'conv',
    label: 'Особо важных',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE c.is_important)`,
  },
  {
    id: 'conv.urgent',
    section: 'conv',
    fact: 'conv',
    label: 'Срочных',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE c.is_urgent)`,
  },
  {
    id: 'conv.callback',
    section: 'conv',
    fact: 'conv',
    label: 'Требовался перезвон',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE c.callback_requested)`,
  },
  {
    id: 'conv.clients',
    section: 'conv',
    fact: 'conv',
    label: 'Клиентов (разных)',
    format: 'int',
    sql: () => `count(DISTINCT c.contact_id)`,
  },
  {
    id: 'conv.perClient',
    section: 'conv',
    fact: 'conv',
    label: 'Обращений на одного клиента',
    format: 'num',
    sql: () => `round(count(*)::numeric / NULLIF(count(DISTINCT c.contact_id), 0), 2)`,
  },
  {
    id: 'conv.repeat',
    section: 'conv',
    fact: 'conv',
    label: 'Повторных обращений (за 30 дней)',
    format: 'int',
    joins: ['rp'],
    sql: () => `count(*) FILTER (WHERE rp.yes IS NOT NULL)`,
  },

  // --- оценки
  {
    id: 'csat.avg',
    section: 'csat',
    fact: 'conv',
    label: 'Средняя оценка клиента',
    format: 'rating',
    joins: ['cs'],
    sql: () => `round(avg(cs.score)::numeric, 2)`,
  },
  {
    id: 'csat.count',
    section: 'csat',
    fact: 'conv',
    label: 'Оценок клиентов',
    format: 'int',
    joins: ['cs'],
    sql: () => `count(cs.score)`,
  },
  {
    id: 'csat.goodPct',
    section: 'csat',
    fact: 'conv',
    label: 'Доля оценок 4–5, %',
    format: 'pct',
    joins: ['cs'],
    sql: () => pct(`count(*) FILTER (WHERE cs.score >= 4)`, 'count(cs.score)'),
  },
  {
    id: 'review.count',
    section: 'csat',
    fact: 'conv',
    label: 'Отзывов',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE c.channel_kind = 'review')`,
  },
  {
    id: 'review.avg',
    section: 'csat',
    fact: 'conv',
    label: 'Средняя оценка в отзывах',
    format: 'rating',
    sql: () =>
      `round(avg((c.channel_meta -> 'review' ->> 'rating')::numeric) FILTER (WHERE c.channel_kind = 'review'), 2)`,
  },
  {
    id: 'review.negative',
    section: 'csat',
    fact: 'conv',
    label: 'Негативных отзывов (1–2)',
    format: 'int',
    sql: () =>
      `count(*) FILTER (WHERE c.channel_kind = 'review' AND (c.channel_meta -> 'review' ->> 'rating')::numeric <= 2)`,
  },

  // --- звонки
  { id: 'call.count', section: 'call', fact: 'call', label: 'Звонков', format: 'int', sql: () => 'count(*)' },
  {
    id: 'call.answered',
    section: 'call',
    fact: 'call',
    label: 'Отвечено оператором',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE ${CALL_ANS})`,
  },
  {
    id: 'call.missed',
    section: 'call',
    fact: 'call',
    label: 'Пропущено в очереди',
    format: 'int',
    joins: ['qe'],
    sql: () => `count(*) FILTER (WHERE ${CALL_QUEUED_MISS})`,
  },
  {
    id: 'call.short',
    section: 'call',
    fact: 'call',
    label: 'Короткие сбросы',
    format: 'int',
    joins: ['qe'],
    sql: (c) =>
      `count(*) FILTER (WHERE ${CALL_QUEUED_MISS} AND ${secs('cl.ended_at', 'qe.at')} < ${c.lazy('short', 5)}::int)`,
  },
  {
    id: 'call.ivrOnly',
    section: 'call',
    fact: 'call',
    label: 'Завершено в IVR',
    hint: 'Клиент получил ответ в голосовом меню, в очередь не попал',
    format: 'int',
    joins: ['qe'],
    sql: () =>
      `count(*) FILTER (WHERE cl.direction = 'in' AND cl.agent_user_id IS NULL AND cl.ended_at IS NOT NULL AND qe.at IS NULL)`,
  },
  {
    id: 'call.answeredPct',
    section: 'call',
    fact: 'call',
    label: 'Доля отвеченных звонков, %',
    format: 'pct',
    joins: ['qe'],
    sql: () =>
      pct(
        `count(*) FILTER (WHERE ${CALL_ANS})`,
        `count(*) FILTER (WHERE ${CALL_ANS} OR ${CALL_QUEUED_MISS})`,
      ),
  },
  {
    id: 'call.sl',
    section: 'call',
    fact: 'call',
    label: 'SL по звонкам, %',
    format: 'pct',
    joins: ['cc', 'qe'],
    sql: (c) =>
      pct(
        `count(*) FILTER (WHERE ${CALL_ANS} AND ${secs('cc.assigned_at', 'COALESCE(qe.at, cl.started_at)')} <= ${c.lazy('slv', 20)}::int)`,
        `count(*) FILTER (WHERE ${CALL_ANS} OR ${CALL_QUEUED_MISS})`,
      ),
  },
  {
    id: 'call.waitAvg',
    section: 'call',
    fact: 'call',
    label: 'Ожидание в очереди (среднее)',
    format: 'dur',
    joins: ['cc', 'qe'],
    sql: () =>
      `avg(${secs('cc.assigned_at', 'qe.at')}) FILTER (WHERE ${CALL_ANS} AND qe.at IS NOT NULL AND cc.assigned_at >= qe.at)`,
  },
  {
    id: 'call.talkAvg',
    section: 'call',
    fact: 'call',
    label: 'Разговор с оператором (средний)',
    format: 'dur',
    joins: ['cc'],
    sql: () =>
      `avg(${secs('cl.ended_at', 'COALESCE(cc.assigned_at, cl.connected_at)')}) FILTER (WHERE ${CALL_ANS} AND cl.ended_at IS NOT NULL)`,
  },
  {
    id: 'call.talkSum',
    section: 'call',
    fact: 'call',
    label: 'Разговоров всего',
    format: 'hours',
    joins: ['cc'],
    sql: () =>
      `sum(${secs('cl.ended_at', 'COALESCE(cc.assigned_at, cl.connected_at)')}) FILTER (WHERE ${CALL_ANS} AND cl.ended_at IS NOT NULL)`,
  },
  {
    id: 'call.durationAvg',
    section: 'call',
    fact: 'call',
    label: 'Длительность звонка (средняя)',
    hint: 'От поступления до завершения, включая IVR и очередь',
    format: 'dur',
    sql: () => `avg(${secs('cl.ended_at', 'cl.started_at')}) FILTER (WHERE cl.ended_at IS NOT NULL)`,
  },

  // --- 2-я линия
  {
    id: 'ticket.count',
    section: 'ticket',
    fact: 'ticket',
    label: 'Обращений на 2-й линии',
    format: 'int',
    sql: () => 'count(*)',
  },
  {
    id: 'ticket.closed',
    section: 'ticket',
    fact: 'ticket',
    label: 'Закрыто на 2-й линии',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE t.status = 'closed')`,
  },
  {
    id: 'ticket.inTime',
    section: 'ticket',
    fact: 'ticket',
    label: 'Закрыто в срок',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE t.status = 'closed' AND t.closed_in_time)`,
  },
  {
    id: 'ticket.inTimePct',
    section: 'ticket',
    fact: 'ticket',
    label: 'Доля закрытых в срок, %',
    format: 'pct',
    sql: () =>
      pct(
        `count(*) FILTER (WHERE t.status = 'closed' AND t.closed_in_time)`,
        `count(*) FILTER (WHERE t.status = 'closed')`,
      ),
  },
  {
    id: 'ticket.overdue',
    section: 'ticket',
    fact: 'ticket',
    label: 'Просрочено (не закрыто)',
    hint: 'Открытые, у которых контрольная дата уже прошла',
    format: 'int',
    sql: (c) => `count(*) FILTER (WHERE t.status <> 'closed' AND t.due_date < ${c.today}::date)`,
  },
  {
    id: 'ticket.answerAvg',
    section: 'ticket',
    fact: 'ticket',
    label: 'Время до ответа (среднее)',
    format: 'dur',
    sql: () => `avg(${secs('t.answered_at', 't.created_at')}) FILTER (WHERE t.answered_at IS NOT NULL)`,
  },
  {
    id: 'ticket.closeAvg',
    section: 'ticket',
    fact: 'ticket',
    label: 'Время до закрытия (среднее)',
    format: 'dur',
    sql: () => `avg(${secs('t.closed_at', 't.created_at')}) FILTER (WHERE t.closed_at IS NOT NULL)`,
  },
  {
    id: 'ticket.returns',
    section: 'ticket',
    fact: 'ticket',
    label: 'Возвратов на доработку',
    format: 'int',
    sql: () => `COALESCE(sum(t.returns_count), 0)`,
  },
  {
    id: 'ticket.approvalAvg',
    section: 'ticket',
    fact: 'ticket',
    label: 'На согласовании (в среднем)',
    format: 'dur',
    sql: () => `avg(t.approval_wait_s) FILTER (WHERE t.approval_wait_s > 0)`,
  },
  {
    id: 'ticket.guilty',
    section: 'ticket',
    fact: 'ticket',
    label: 'С виной работника',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE t.staff_guilty)`,
  },

  // --- операторы
  {
    id: 'staff.time',
    section: 'staff',
    fact: 'status',
    label: 'Время в статусе',
    hint: 'Положите поле «Статус оператора» в строки или столбцы',
    format: 'hours',
    sql: (c) => `sum(${STATUS_S(c)})`,
  },
  {
    id: 'staff.worked',
    section: 'staff',
    fact: 'status',
    label: 'Отработано времени',
    hint: 'Всё время на линии (кроме «Не на линии»)',
    format: 'hours',
    sql: (c) => `COALESCE(sum(${STATUS_S(c)}) FILTER (WHERE s.status <> 'offline'), 0)`,
  },
  {
    id: 'staff.ready',
    section: 'staff',
    fact: 'status',
    label: 'Время в статусе «Готов»',
    format: 'hours',
    sql: (c) => `COALESCE(sum(${STATUS_S(c)}) FILTER (WHERE s.status = 'ready'), 0)`,
  },
  {
    id: 'staff.break',
    section: 'staff',
    fact: 'status',
    label: 'Время на перерывах',
    format: 'hours',
    sql: (c) => `COALESCE(sum(${STATUS_S(c)}) FILTER (WHERE s.status = 'break'), 0)`,
  },
  {
    id: 'staff.shifts',
    section: 'staff',
    fact: 'status',
    label: 'Отработано смен',
    hint: 'Дней, когда сотрудник выходил на линию',
    format: 'int',
    sql: (c) =>
      `count(DISTINCT (s.user_id, (s.started_at AT TIME ZONE ${c.lazy('tz', 'Europe/Minsk')}::text)::date)) FILTER (WHERE s.status <> 'offline')`,
  },
  {
    id: 'staff.breaks',
    section: 'staff',
    fact: 'status',
    label: 'Перерывов',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE s.status = 'break')`,
  },

  // --- обучение
  {
    id: 'learn.attempts',
    section: 'learn',
    fact: 'test',
    label: 'Попыток тестов',
    format: 'int',
    sql: () => 'count(*)',
  },
  {
    id: 'learn.passed',
    section: 'learn',
    fact: 'test',
    label: 'Сдано тестов',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE ta.passed)`,
  },
  {
    id: 'learn.avgScore',
    section: 'learn',
    fact: 'test',
    label: 'Оценка по тестам (средний балл), %',
    format: 'pct',
    sql: () => `round(avg(ta.score)::numeric, 1)`,
  },
  {
    id: 'learn.passedPct',
    section: 'learn',
    fact: 'test',
    label: 'Доля сданных тестов, %',
    format: 'pct',
    sql: () => pct(`count(*) FILTER (WHERE ta.passed)`, 'count(*)'),
  },
  {
    id: 'learn.assigned',
    section: 'learn',
    fact: 'course',
    label: 'Назначено курсов',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE ca.cancelled_at IS NULL)`,
  },
  {
    id: 'learn.completed',
    section: 'learn',
    fact: 'course',
    label: 'Пройдено курсов',
    format: 'int',
    sql: () => `count(*) FILTER (WHERE ca.completed_at IS NOT NULL)`,
  },
  {
    id: 'learn.courseOverdue',
    section: 'learn',
    fact: 'course',
    label: 'Курсов просрочено',
    format: 'int',
    sql: (c) =>
      `count(*) FILTER (WHERE ca.completed_at IS NULL AND ca.cancelled_at IS NULL AND ca.due_date < ${c.today}::date)`,
  },
];

/**
 * Поля карточки (справочник `field_def`): списки, даты и флажки — как поля конструктора (ключ — значение из
 * `fields` обращения). Текстовые поля (ФИО, телефоны, номера карт) в разрезы не выводятся: это ПДн и у каждого
 * обращения своё значение.
 */
export interface FieldDefRow {
  key: string;
  label: string;
  type: string;
  options: unknown;
}
const FIELD_KEY_RE = /^[\p{L}\p{N}_ .-]{1,64}$/u;

export function fieldDims(defs: FieldDefRow[]): DimDef[] {
  const byKey = new Map<string, FieldDefRow[]>();
  for (const d of defs) {
    if (!['select', 'date', 'bool', 'boolean', 'checkbox', 'number'].includes(d.type)) continue;
    if (!FIELD_KEY_RE.test(d.key)) continue;
    byKey.set(d.key, [...(byKey.get(d.key) ?? []), d]);
  }
  return [...byKey.entries()].map(([key, list]) => {
    const first = list[0]!;
    const lit = `'${key.replace(/'/g, "''")}'`;
    const isBool = ['bool', 'boolean', 'checkbox'].includes(first.type);
    const options = [
      ...new Set(list.flatMap((d) => (Array.isArray(d.options) ? d.options.map((o) => String(o)) : []))),
    ];
    const dim: DimDef = {
      id: `field.${key}`,
      section: 'fields',
      label: first.label.length > 60 ? `${first.label.slice(0, 57)}…` : first.label,
      hint: first.label.length > 60 ? first.label : undefined,
      facts: {
        conv: { key: `NULLIF(c.fields ->> ${lit}, '')` },
        ticket: { key: `NULLIF(tc.fields ->> ${lit}, '')`, joins: ['tc'] },
        call: { key: `NULLIF(cc.fields ->> ${lit}, '')`, joins: ['cc'] },
      },
      sort: first.type === 'date' ? 'key' : 'label',
      values: options.length ? 'names' : 'none',
      names: isBool ? { true: 'Да', false: 'Нет' } : Object.fromEntries(options.map((o) => [o, o])),
    };
    if (first.type === 'date') dim.labelOf = (k) => (/^\d{4}-\d{2}-\d{2}/.test(k) ? dmy(k) : k);
    return dim;
  });
}
