import { CONVERSATION_EVENTS, newId } from '@cc/contracts';
import { emitConversation, loadRef } from '@cc/domain';
import type { Pool, PoolClient } from 'pg';
import { rows } from '../lib/db';
import { type Cell, type SheetSpec, XS } from '../lib/xlsx';

/**
 * Пакетная загрузка и правка обращений из Excel (Д-064).
 *
 * Шаблон — колонки обращения и все поля карточки из справочника тем (подписи как в карточке). Загрузка в два шага:
 * проверка (что будет создано, какие поля изменятся, дубли, ошибки по ячейкам — без записи в базу) и применение
 * (только строки без ошибок; дубли пропускаются). Строка находит существующее обращение по «ID обращения» (из
 * выгрузки для правки) или по «Коду во внешней системе»; иначе — новое обращение. Пустая ячейка у существующего
 * обращения значение не меняет, «-» — очищает.
 */

type Db = Pool | PoolClient;

export const CHANNELS: Record<string, string> = {
  voice: 'Телефон',
  webchat: 'Чат на сайте',
  app: 'Мобильное приложение',
  telegram: 'Telegram',
  email: 'E-mail',
  review: 'Отзыв на картах',
  api: 'Внешняя система',
};
const CHANNEL_ALIASES: Record<string, string> = {
  звонок: 'voice',
  телефон: 'voice',
  голос: 'voice',
  сайт: 'webchat',
  чат: 'webchat',
  'сайт бн': 'webchat',
  приложение: 'app',
  'мп белоруснефть': 'app',
  почта: 'email',
  email: 'email',
  'e-mail': 'email',
  'электронная почта': 'email',
  отзыв: 'review',
  'картографический ресурс(отзывы)': 'review',
  'контакт-центр': 'voice',
  'социальные сети': 'telegram',
  'официальное письмо': 'email',
};
export const STATUSES: Record<string, string> = {
  closed: 'Закрыто',
  queued: 'В очереди',
  active: 'В работе',
  waiting_2nd_line: 'На 2-й линии',
};
export const TICKET_STATUSES: Record<string, string> = {
  new: 'Новое',
  in_work: 'В работе',
  approval: 'На согласовании',
  rework: 'На доработке',
  closed: 'Закрыто',
};
export const MEASURES: Record<string, string> = {
  none: 'Не применялись',
  remark: 'Замечание',
  reprimand: 'Выговор',
  depremium: 'Депремирование',
  dismissal: 'Увольнение',
};

export interface Col {
  key: string;
  header: string;
  required?: boolean;
  /** Что писать в ячейку (лист «Описание полей»). */
  hint: string;
  values?: string[];
  example?: string;
  /** Поле карточки (ключ в conversation.fields) и его тип. */
  field?: { key: string; type: string };
  /** Колонку можно менять у существующего обращения. */
  editable: boolean;
  /** Другие названия колонки (выгрузки прежней системы заказчика). */
  aliases?: string[];
  /** Служебная колонка — только для чтения чужих выгрузок, в шаблоне её нет. */
  hidden?: boolean;
}

interface FieldDef {
  key: string;
  label: string;
  type: string;
  options: string[];
}

/** Справочники для проверки: всё нужное загружается одним заходом, дальше — поиск в памяти. */
export interface Dicts {
  tz: string;
  channels: Map<string, string>; // kind → id канала
  queues: Map<string, string>; // kind → очередь по умолчанию
  topics: { id: string; parent: string | null; name: string; path: string[] }[];
  fields: FieldDef[];
  objects: {
    id: string;
    kind: string;
    name: string;
    code: string;
    enterpriseId: string;
    enterprise: string;
  }[];
  users: { id: string; name: string; email: string }[];
  dispositions: { id: string; name: string; behavior: string }[];
  enterprises: { id: string; name: string }[];
  eds: { id: string; enterpriseId: string; departmentId: string; department: string }[];
  answerMethods: { id: string; name: string }[];
}

/** Сравнение «по буквам»: без пробелов, кавычек и знаков препинания. */
const loose = (s: string) => norm(s).replace(/[^a-zа-я0-9]/g, '');
/** Подсказка в ошибке: самое похожее значение справочника (по общим словам), если есть. */
function hint(v: string, list: string[]): string {
  const words = (x: string) =>
    new Set(
      norm(x)
        .split(/[^a-zа-я0-9]+/)
        .filter((w) => w.length > 2)
        .map((w) => w.slice(0, 5)),
    );
  const a = words(v);
  let best = { name: '', score: 0 };
  for (const name of list) {
    const b = words(name);
    const common = [...a].filter((w) => b.has(w)).length;
    const score = common / Math.max(1, new Set([...a, ...b]).size);
    if (score > best.score) best = { name, score };
  }
  return best.score >= 0.34 ? `. Похоже на «${best.name}»` : '';
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export async function loadDicts(db: Db, tz: string): Promise<Dicts> {
  const ch = await rows<{ id: string; kind: string; queue: string | null }>(
    db,
    `SELECT DISTINCT ON (c.kind) c.id, c.kind,
            (SELECT q.id FROM queue q WHERE q.is_active AND c.kind = ANY(q.channels)
              ORDER BY q.name = 'Общая' DESC, q.name LIMIT 1) AS queue
       FROM channel c WHERE c.is_active ORDER BY c.kind, c.created_at`,
  );
  const topics = await rows<{ id: string; parent_id: string | null; name: string; path: string[] }>(
    db,
    'SELECT id, parent_id, name, path FROM topic WHERE is_active ORDER BY level, sort_order, name',
  );
  const fields = await rows<{ key: string; label: string; type: string; options: string[] | null }>(
    db,
    `SELECT f.key, (array_agg(f.label ORDER BY f.sort_order))[1] AS label, (array_agg(f.type))[1] AS type,
            (SELECT array_agg(DISTINCT o) FROM field_def g CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(g.options) = 'array' THEN g.options ELSE '[]' END) o
              WHERE g.key = f.key AND g.is_active) AS options,
            min(f.sort_order) AS so, count(*) AS n
       FROM field_def f JOIN topic t ON t.id = f.topic_id AND t.is_active
      WHERE f.is_active GROUP BY f.key ORDER BY count(*) DESC, min(f.sort_order), f.key`,
  );
  const objects = await rows<{
    id: string;
    kind: string;
    name: string;
    code: string;
    enterprise_id: string;
    enterprise: string;
  }>(
    db,
    `SELECT o.id, o.kind, o.name, o.code, o.enterprise_id, e.name AS enterprise
       FROM service_object o JOIN enterprise e ON e.id = o.enterprise_id WHERE o.is_active`,
  );
  const users = await rows<{ id: string; full_name: string; email: string | null }>(
    db,
    'SELECT id, full_name, email FROM app_user WHERE is_active',
  );
  const disp = await rows<{ id: string; name: string; behavior: string }>(
    db,
    'SELECT id, name, behavior FROM disposition WHERE is_active ORDER BY sort_order',
  );
  const ents = await rows<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM enterprise WHERE is_active ORDER BY name',
  );
  const eds = await rows<{ id: string; enterprise_id: string; department_id: string; department: string }>(
    db,
    `SELECT ed.id, ed.enterprise_id, ed.department_id, d.name AS department FROM enterprise_department ed
       JOIN department d ON d.id = ed.department_id AND d.is_active WHERE ed.is_active`,
  );
  const am = await rows<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM answer_method WHERE is_active ORDER BY sort_order',
  );
  return {
    tz,
    channels: new Map(ch.map((c) => [c.kind, c.id])),
    queues: new Map(ch.filter((c) => c.queue).map((c) => [c.kind, c.queue!])),
    topics: topics.map((t) => ({ id: t.id, parent: t.parent_id, name: t.name, path: t.path })),
    fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options ?? [] })),
    objects: objects.map((o) => ({
      id: o.id,
      kind: o.kind,
      name: o.name,
      code: o.code,
      enterpriseId: o.enterprise_id,
      enterprise: o.enterprise,
    })),
    users: users.map((u) => ({ id: u.id, name: u.full_name, email: (u.email ?? '').toLowerCase() })),
    dispositions: disp,
    enterprises: ents,
    eds: eds.map((e) => ({
      id: e.id,
      enterpriseId: e.enterprise_id,
      departmentId: e.department_id,
      department: e.department,
    })),
    answerMethods: am,
  };
}

const DT_HINT = 'ДД.ММ.ГГГГ ЧЧ:ММ или ДД.ММ.ГГГГ ЧЧ:ММ:СС (время — минское)';
const YES_NO = ['Да', 'Нет'];

/** Колонки шаблона: обращение, 2-я линия, затем все поля карточки из справочника тем. */
export function columns(d: Dicts): Col[] {
  const topLevel = d.topics.filter((t) => !t.parent);
  const cols: Col[] = [
    {
      key: 'id',
      header: 'ID обращения',
      hint: 'Заполнено в выгрузке для правки — по нему меняется существующее обращение. Для новых обращений оставьте пустым',
      editable: false,
    },
    {
      key: 'external_code',
      header: 'Код во внешней системе',
      hint: 'Номер обращения в прежней системе. При повторной загрузке того же кода обращение правится, а не создаётся заново',
      example: '803048',
      editable: true,
    },
    {
      key: 'channel',
      header: 'Канал',
      required: true,
      hint: 'Откуда поступило обращение',
      values: Object.values(CHANNELS),
      example: 'Телефон',
      editable: false,
    },
    {
      key: 'created_at',
      header: 'Дата и время поступления',
      required: true,
      hint: DT_HINT,
      example: '15.09.2026 14:23',
      editable: true,
    },
    {
      key: 'status',
      header: 'Статус',
      hint: 'Пусто — «Закрыто». «В очереди» — обращение попадёт в очередь 1-й линии; «В работе» — нужен оператор; «На 2-й линии» — нужны колонки 2-й линии. У существующих обращений статус не меняется',
      values: Object.values(STATUSES),
      example: 'Закрыто',
      editable: false,
    },
    {
      key: 'closed_at',
      header: 'Дата и время закрытия',
      hint: `${DT_HINT}. Пусто у закрытого — время поступления`,
      example: '15.09.2026 14:31',
      editable: true,
    },
    {
      key: 'operator',
      header: 'Оператор',
      hint: 'ФИО или e-mail сотрудника из справочника сотрудников',
      values: d.users.map((u) => u.name),
      example: d.users[0]?.name,
      editable: false,
    },
    {
      key: 'client_email',
      header: 'E-mail клиента',
      hint: 'Клиент ищется по телефону или e-mail; не найден — создаётся',
      editable: false,
    },
    {
      key: 'topic',
      header: 'Тема',
      required: true,
      hint: 'Название темы из справочника тем',
      values: topLevel.map((t) => t.name),
      example: topLevel[0]?.name,
      editable: true,
    },
    {
      key: 'subtopic',
      header: 'Подтема',
      hint: 'Название подтемы выбранной темы (если у темы есть подтемы — обязательно)',
      example: d.topics.find((t) => t.parent === topLevel[0]?.id)?.name,
      editable: true,
    },
    {
      key: 'object',
      header: 'АЗС / ЭЗС',
      hint: 'Номер АЗС (например, 11 или «АЗС №11») или название ЭЗС, как в справочнике объектов',
      example: '11',
      editable: true,
    },
    {
      key: 'object_enterprise',
      header: 'Предприятие АЗС',
      hint: 'Нужно, если АЗС с таким номером есть у нескольких предприятий',
      values: d.enterprises.map((e) => e.name),
      editable: true,
    },
    {
      key: 'important',
      header: 'Особо важное',
      hint: 'Да или Нет',
      values: YES_NO,
      editable: true,
    },
    { key: 'urgent', header: 'Срочное', hint: 'Да или Нет', values: YES_NO, editable: true },
    {
      key: 'disposition',
      header: 'Итог',
      hint: 'Итог обращения на 1-й линии',
      values: d.dispositions.map((x) => x.name),
      example: d.dispositions[0]?.name,
      editable: true,
    },
    {
      key: 't_enterprise',
      header: '2-я линия: предприятие',
      hint: 'Заполните, если обращение передавалось на 2-ю линию. У существующих обращений колонки 2-й линии не меняются',
      values: d.enterprises.map((e) => e.name),
      editable: false,
    },
    {
      key: 't_department',
      header: '2-я линия: подразделение',
      hint: 'Подразделение выбранного предприятия',
      editable: false,
    },
    {
      key: 't_status',
      header: '2-я линия: статус',
      hint: 'Пусто — «Закрыто»',
      values: Object.values(TICKET_STATUSES),
      editable: false,
    },
    {
      key: 't_due',
      header: '2-я линия: контрольная дата',
      hint: 'ДД.ММ.ГГГГ. Пусто — через 5 дней после поступления',
      editable: false,
    },
    { key: 't_responsible', header: '2-я линия: ответственный', hint: 'ФИО сотрудника', editable: false },
    { key: 't_answer', header: '2-я линия: ответ клиенту', hint: 'Суть ответа', editable: false },
    {
      key: 't_answer_method',
      header: '2-я линия: способ ответа',
      values: d.answerMethods.map((a) => a.name),
      hint: 'Как ответили клиенту',
      editable: false,
    },
    { key: 't_closed_at', header: '2-я линия: дата закрытия', hint: DT_HINT, editable: false },
    {
      key: 't_guilty',
      header: '2-я линия: вина работника',
      hint: 'Да или Нет',
      values: YES_NO,
      editable: false,
    },
    {
      key: 't_measures',
      header: '2-я линия: принятые меры',
      hint: 'Через запятую',
      values: Object.values(MEASURES),
      editable: false,
    },
  ];
  for (const f of d.fields)
    cols.push({
      key: `f:${f.key}`,
      header: f.label,
      hint:
        f.type === 'date'
          ? 'Поле карточки, дата ДД.ММ.ГГГГ'
          : f.options.length
            ? 'Поле карточки, одно из значений'
            : 'Поле карточки, текст',
      values: f.options.length ? f.options : undefined,
      field: { key: f.key, type: f.type },
      editable: true,
    });
  // Колонки выгрузки прежней системы: дата и время отдельно, «Источник», «Код обращения» и т. п.
  const ALIASES: Record<string, string[]> = {
    external_code: ['Код обращения', 'Номер обращения'],
    channel: ['Источник', 'Источник обращения'],
    client_email: ['E-mail', 'Email', 'Электронная почта'],
    'f:azs_number': ['Номер АЗС'],
    'f:azs_region': ['Область и район, в которых расположена АЗС', 'Область АЗС'],
  };
  for (const c of cols) c.aliases = ALIASES[c.key];
  for (const [key, header, aliases] of [
    ['created_date', 'Дата поступления', ['Дата поступления обращения']],
    ['created_time', 'Время поступления', ['Время поступления обращения']],
    ['closed_date', 'Дата закрытия', ['Дата закрытия обращения']],
    ['closed_time', 'Время закрытия', ['Время закрытия обращения']],
  ] as const)
    cols.push({ key, header, hint: '', editable: true, hidden: true, aliases: [...aliases] });
  return cols;
}

/** Книга-шаблон: лист «Обращения» (заголовки; можно с выгруженными обращениями) и лист «Описание полей». */
export function templateSheets(all: Col[], data: Cell[][] = []): SheetSpec[] {
  const cols = all.filter((c) => !c.hidden);
  return [
    {
      name: 'Обращения',
      header: cols.map((c) => c.header),
      rows: data,
      headerStyle: (ci) => (cols[ci]!.required ? XS.headerRequired : XS.header),
      widths: cols.map((c) => Math.min(40, Math.max(14, c.header.length + 2))),
    },
    {
      name: 'Описание полей',
      header: ['Колонка', 'Обязательно', 'Что писать', 'Допустимые значения', 'Пример'],
      rows: [
        ...cols.map((c) => [
          c.header,
          c.required ? 'Да' : '',
          c.hint,
          (c.values ?? []).slice(0, 60).join('; ') + ((c.values?.length ?? 0) > 60 ? '; …' : ''),
          c.example ?? '',
        ]),
        [],
        [
          'Общие правила',
          '',
          'Первая строка листа «Обращения» — заголовки. Порядок колонок любой, лишние колонки пропускаются',
        ],
        [
          '',
          '',
          'Пустая ячейка или «-» — нет значения. У существующего обращения пустая ячейка значение не меняет, «-» — очищает',
        ],
        [
          '',
          '',
          'Перед загрузкой система покажет: сколько обращений создаётся и меняется, какие поля, дубли и ошибки',
        ],
        [
          '',
          '',
          'Строки с ошибками и полные дубли не загружаются; файл с отметками (ошибки — красным, изменения — жёлтым) можно скачать',
        ],
      ],
      style: (_ri, ci) => (ci === 2 || ci === 3 ? XS.wrap : XS.normal),
      widths: [34, 12, 70, 60, 24],
      filter: false,
    },
  ];
}

// ---------------------------------------------------------------- разбор значений

const EMPTY = new Set(['', '-', '—', '–']);
const isClear = (v: string) => v.trim() !== '' && EMPTY.has(v.trim());
const blank = (v: string | undefined) => EMPTY.has((v ?? '').trim());

/** Дата и время → «ГГГГ-ММ-ДД ЧЧ:ММ:СС» (местное время) или null. */
export function parseDateTime(v: string, dateOnly = false): string | null {
  const s = v.trim().replace(/\s+/g, ' ');
  let m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let y: number,
    mo: number,
    d: number,
    h = 0,
    mi = 0,
    se = 0;
  if (m) {
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    [h, mi, se] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  } else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return null;
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    [h, mi, se] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  }
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
  if (y < 2000 || y > 2100) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${y}-${p(mo)}-${p(d)}`;
  return dateOnly ? date : `${date} ${p(h)}:${p(mi)}:${p(se)}`;
}
const parseYesNo = (v: string): boolean | null => {
  const s = norm(v);
  if (['да', 'yes', '1', 'true', '+', 'истина'].includes(s)) return true;
  if (['нет', 'no', '0', 'false', 'ложь'].includes(s)) return false;
  return null;
};
const phoneDigits = (v: string) => v.replace(/\D/g, '').slice(-9);

/** Найти строку заголовков (в выгрузках над ней бывает название отчёта) и сопоставить колонки. */
export function mapHeader(sheet: string[][], cols: Col[]) {
  const byName = new Map<string, Col>();
  for (const c of cols) {
    byName.set(norm(c.header), c);
    // Подпись поля без пояснения в скобках («Суть обращения (…)» → «Суть обращения»).
    const short = norm(c.header.replace(/\s*\(.*$/, ''));
    if (short && !byName.has(short)) byName.set(short, c);
    if (c.field) byName.set(norm(c.field.key), c);
  }
  for (const c of cols) for (const a of c.aliases ?? []) byName.set(norm(a), c);
  let best = { row: 0, hits: -1 };
  for (let r = 0; r < Math.min(15, sheet.length); r++) {
    const hits = (sheet[r] ?? []).filter((h) => byName.has(norm(h))).length;
    if (hits > best.hits) best = { row: r, hits };
  }
  const head = sheet[best.row] ?? [];
  const map: (Col | null)[] = head.map((h) => byName.get(norm(h)) ?? null);
  // Одна колонка шаблона — один раз (повтор — пропускается).
  const seen = new Set<string>();
  for (let i = 0; i < map.length; i++) {
    const c = map[i];
    if (c && seen.has(c.key)) map[i] = null;
    else if (c) seen.add(c.key);
  }
  return {
    headerRow: best.row,
    header: head,
    map,
    unknown: head.filter((h, i) => h.trim() && !map[i]),
    missingRequired: cols
      .filter((c) => c.required && !seen.has(c.key) && !(c.key === 'created_at' && seen.has('created_date')))
      .map((c) => c.header),
  };
}

// ---------------------------------------------------------------- проверка строк

export interface Norm {
  externalCode?: string | null;
  channelKind?: string;
  createdAt?: string;
  status?: string;
  closedAt?: string | null;
  operatorId?: string | null;
  email?: string | null;
  topicId?: string | null;
  objectId?: string | null;
  enterpriseId?: string | null;
  important?: boolean;
  urgent?: boolean;
  dispositionId?: string | null;
  fields: Record<string, string | null>;
  ticket?: {
    edId: string;
    enterpriseId: string;
    departmentId: string;
    status: string;
    due: string | null;
    responsibleId: string | null;
    answer: string | null;
    answerMethodId: string | null;
    closedAt: string | null;
    guilty: boolean | null;
    measures: string[];
  };
}

export interface PlanRow {
  /** Номер строки в Excel. */
  row: number;
  action: 'create' | 'update' | 'same' | 'duplicate' | 'error';
  /** Существующее обращение (правка, без изменений, дубль). */
  id?: string;
  /** Дубль строки файла с этим номером. */
  dupOfRow?: number;
  values: string[];
  errors: { col: number; msg: string }[];
  /** Изменённые колонки (номер в файле). */
  changed: number[];
  data?: Norm;
}

export interface Summary {
  fileName: string;
  headerRow: number;
  rows: number;
  create: number;
  update: number;
  same: number;
  duplicate: number;
  error: number;
  changes: { column: string; count: number }[];
  errors: { reason: string; count: number }[];
  sameIds: string[];
  duplicateIds: string[];
  unknownColumns: string[];
  missingRequired: string[];
}

interface Existing {
  id: string;
  external_code: string | null;
  channel_kind: string;
  status: string;
  created_local: string;
  closed_local: string | null;
  topic_id: string | null;
  object_id: string | null;
  enterprise_id: string | null;
  is_important: boolean;
  is_urgent: boolean;
  disposition_id: string | null;
  fields: Record<string, unknown>;
  phone: string | null;
  email: string | null;
}

const EXISTING_SQL = (tz: string) => `
  SELECT c.id, c.external_code, c.channel_kind, c.status,
         to_char(c.created_at AT TIME ZONE '${tz}', 'YYYY-MM-DD HH24:MI:SS') AS created_local,
         to_char(c.closed_at AT TIME ZONE '${tz}', 'YYYY-MM-DD HH24:MI:SS') AS closed_local,
         c.topic_id, c.object_id, c.enterprise_id, c.is_important, c.is_urgent, c.disposition_id, c.fields,
         ct.phone, ct.email
    FROM conversation c JOIN contact ct ON ct.id = c.contact_id`;

const MAX_ROWS = 20000;

/** Проверить лист: план по каждой строке и сводка. В базу ничего не пишется. */
export async function analyze(
  db: Db,
  d: Dicts,
  sheet: string[][],
  fileName: string,
  /** Только добавить новые: найденные существующие обращения не меняются (повторная загрузка тестовых данных). */
  onlyNew = false,
): Promise<{ summary: Summary; plan: PlanRow[]; header: string[] }> {
  const cols = columns(d);
  const h = mapHeader(sheet, cols);
  const idx = new Map<string, number>();
  h.map.forEach((c, i) => c && idx.set(c.key, i));
  const body = sheet
    .slice(h.headerRow + 1)
    .map((values, i) => ({ row: h.headerRow + 2 + i, values }))
    .filter((r) => r.values.some((v) => v.trim()));
  if (body.length > MAX_ROWS) throw new Error(`too_many:${MAX_ROWS}`);

  const tzSafe = d.tz.replace(/'/g, '');
  // Существующие обращения: по ID и по коду во внешней системе.
  const ids = body
    .map((r) => (r.values[idx.get('id') ?? -1] ?? '').trim())
    .filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  const codes = body
    .map((r) => (r.values[idx.get('external_code') ?? -1] ?? '').trim())
    .filter((v) => v && !blank(v));
  const existing = await rows<Existing>(
    db,
    `${EXISTING_SQL(tzSafe)} WHERE c.id = ANY($1::uuid[]) OR c.external_code = ANY($2::text[])`,
    [ids, codes],
  );
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byCode = new Map(existing.filter((e) => e.external_code).map((e) => [e.external_code!, e]));

  // Темы сравниваются без учёта пробелов, кавычек и знаков препинания (в выгрузках их часто по-разному).
  const topicsTop = new Map(d.topics.filter((t) => !t.parent).map((t) => [loose(t.name), t]));
  const subOf = (parent: string, name: string) =>
    d.topics.find((t) => t.parent === parent && loose(t.name) === loose(name));
  const hasSubs = (id: string) => d.topics.some((t) => t.parent === id);
  const userBy = (v: string) => {
    const s = norm(v);
    return d.users.find((u) => u.email === s) ?? d.users.find((u) => norm(u.name) === s);
  };
  const channelBy = (v: string) => {
    const s = norm(v);
    const kind =
      Object.entries(CHANNELS).find(([, l]) => norm(l) === s)?.[0] ??
      (CHANNELS[s] ? s : undefined) ??
      CHANNEL_ALIASES[s];
    return kind && d.channels.has(kind) ? kind : undefined;
  };
  const entBy = (v: string) => d.enterprises.find((e) => norm(e.name) === norm(v));

  const plan: PlanRow[] = [];
  const seenCode = new Map<string, number>();
  const contentKey = new Map<string, number>();
  for (const r of body) {
    const errors: { col: number; msg: string }[] = [];
    const cell = (key: string) => {
      const i = idx.get(key);
      return i === undefined ? undefined : (r.values[i] ?? '');
    };
    const err = (key: string, msg: string) => errors.push({ col: idx.get(key) ?? -1, msg });
    const idv = (cell('id') ?? '').trim();
    const code = blank(cell('external_code')) ? '' : cell('external_code')!.trim();
    let ex: Existing | undefined;
    if (idv) {
      ex = byId.get(idv);
      if (!ex) err('id', 'Обращение с таким ID не найдено');
    } else if (code) ex = byCode.get(code);
    if (code) {
      if (seenCode.has(code)) err('external_code', `Код повторяется в файле (строка ${seenCode.get(code)})`);
      else seenCode.set(code, r.row);
      const other = byCode.get(code);
      if (ex && other && other.id !== ex.id) err('external_code', 'Этот код уже у другого обращения');
    }
    const isNew = !ex && !idv;
    const n: Norm = { fields: {} };
    // Значение колонки: undefined — не трогать (нет колонки или пусто у существующего), null — очистить.
    const val = (key: string): string | null | undefined => {
      const v = cell(key);
      if (v === undefined) return undefined;
      if (isClear(v)) return null;
      if (!v.trim()) return isNew ? null : undefined;
      return v.trim();
    };

    if (code) n.externalCode = code;
    // Канал
    const chv = val('channel');
    if (isNew) {
      if (!chv) err('channel', 'Не указан канал');
      else {
        const k = channelBy(chv);
        if (!k) err('channel', `Неизвестный канал «${chv}»`);
        else n.channelKind = k;
      }
    }
    // Даты
    // Дата и время одной колонкой или отдельными («Дата поступления» + «Время поступления»).
    const joined = (date: string, time: string) => {
      const dv = val(date);
      if (!dv) return dv;
      let tv = val(time);
      // Время числом (доля суток), если формат ячейки в файле не «время».
      if (tv && /^\d*\.?\d+(e-?\d+)?$/i.test(tv) && Number(tv) < 1) {
        const sec = Math.round(Number(tv) * 86400);
        const p2 = (x: number) => String(x).padStart(2, '0');
        tv = `${p2(Math.floor(sec / 3600))}:${p2(Math.floor(sec / 60) % 60)}:${p2(sec % 60)}`;
      }
      return tv && !/\d:\d/.test(dv) ? `${dv} ${tv}` : dv;
    };
    const cr = val('created_at') ?? joined('created_date', 'created_time');
    if (cr) {
      const p = parseDateTime(cr);
      if (!p) err('created_at', `Не дата и время: «${cr}»`);
      else n.createdAt = p;
    } else if (isNew) err('created_at', 'Не указаны дата и время поступления');
    const cl = val('closed_at') ?? joined('closed_date', 'closed_time');
    if (cl) {
      const p = parseDateTime(cl);
      if (!p) err('closed_at', `Не дата и время: «${cl}»`);
      else n.closedAt = p;
    } else if (cl === null && !isNew) n.closedAt = null;
    // Статус (только у новых)
    const st = val('status');
    n.status = 'closed';
    if (isNew && st) {
      const s = Object.entries(STATUSES).find(([, l]) => norm(l) === norm(st))?.[0];
      if (!s) err('status', `Неизвестный статус «${st}»`);
      else n.status = s;
    }
    // Оператор
    const op = val('operator');
    if (isNew && op) {
      const u = userBy(op);
      if (!u) err('operator', `Сотрудник «${op}» не найден`);
      else n.operatorId = u.id;
    }
    if (isNew && n.status === 'active' && !n.operatorId && !errors.some((e) => e.col === idx.get('operator')))
      err('operator', 'Для статуса «В работе» укажите оператора');
    // Клиент
    const em = val('client_email');
    if (isNew && em) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) err('client_email', `Не e-mail: «${em}»`);
      else n.email = em.toLowerCase();
    }
    // Тема и подтема
    const tv = val('topic');
    const sv = val('subtopic');
    if (tv) {
      const t = topicsTop.get(loose(tv));
      if (!t)
        err(
          'topic',
          `Темы «${tv}» нет в справочнике${hint(
            tv,
            d.topics.filter((x) => !x.parent).map((x) => x.name),
          )}`,
        );
      else if (sv) {
        const s = subOf(t.id, sv);
        if (!s)
          err(
            'subtopic',
            `У темы «${t.name}» нет подтемы «${sv}»${hint(
              sv,
              d.topics.filter((x) => x.parent === t.id).map((x) => x.name),
            )}`,
          );
        else n.topicId = s.id;
      } else if (hasSubs(t.id) && (isNew || sv !== undefined)) err('subtopic', 'Укажите подтему');
      else n.topicId = t.id;
    } else if (isNew) err('topic', 'Не указана тема');
    else if (sv) err('topic', 'Подтема без темы — укажите и тему');
    // АЗС / ЭЗС
    const ov = val('object');
    const oe = val('object_enterprise');
    if (ov) {
      // Точное название («АЗС №7», «ЭЗС Минск, …») или код объекта; иначе — номер АЗС («7», «АЗС 7»).
      let cand = d.objects.filter((o) => norm(o.name) === norm(ov) || o.code === ov.trim());
      const num = /^(?:азс\s*№?\s*)?(\d+[а-яa-z]?)$/i.exec(ov.trim())?.[1];
      if (!cand.length && num)
        cand = d.objects.filter((o) => o.kind === 'azs' && norm(o.name) === norm(`АЗС №${num}`));
      if (oe) cand = cand.filter((o) => norm(o.enterprise) === norm(oe));
      if (!cand.length) err('object', `Объект «${ov}» не найден${oe ? ` у предприятия «${oe}»` : ''}`);
      else if (cand.length > 1)
        err(
          'object',
          `«${ov}» есть у нескольких предприятий (${[...new Set(cand.map((o) => o.enterprise))].slice(0, 4).join(', ')}) — заполните «Предприятие АЗС»`,
        );
      else {
        n.objectId = cand[0]!.id;
        n.enterpriseId = cand[0]!.enterpriseId;
      }
    } else if (ov === null) {
      n.objectId = null;
      n.enterpriseId = null;
    }
    // Флаги и итог
    for (const [key, prop] of [
      ['important', 'important'],
      ['urgent', 'urgent'],
    ] as const) {
      const v = val(key);
      if (v) {
        const b = parseYesNo(v);
        if (b === null) err(key, `Нужно «Да» или «Нет», а не «${v}»`);
        else n[prop] = b;
      } else if (v === null) n[prop] = false;
    }
    const dv = val('disposition');
    if (dv) {
      const x = d.dispositions.find((x) => norm(x.name) === norm(dv));
      if (!x) err('disposition', `Неизвестный итог «${dv}»`);
      else n.dispositionId = x.id;
    } else if (dv === null && !isNew) n.dispositionId = null;
    // Поля карточки
    for (const f of d.fields) {
      const v = val(`f:${f.key}`);
      if (v === undefined) continue;
      if (v === null) {
        if (!isNew) n.fields[f.key] = null;
        continue;
      }
      if (f.type === 'date') {
        const p = parseDateTime(v, true);
        if (!p) err(`f:${f.key}`, `Не дата: «${v}»`);
        else n.fields[f.key] = p;
      } else if (f.options.length && f.type === 'select') {
        // Точное значение или значение списка в начале ячейки («Минская область» → «Минская»).
        const o =
          f.options.find((x) => loose(x) === loose(v)) ??
          f.options
            .filter((x) => loose(x).length >= 4 && loose(v).startsWith(loose(x)))
            .sort((a, b) => b.length - a.length)[0];
        if (!o) err(`f:${f.key}`, `Значения «${v}» нет в списке поля (${f.options.slice(0, 8).join(', ')})`);
        else n.fields[f.key] = o;
      } else n.fields[f.key] = v;
    }
    // 2-я линия (только у новых)
    const te = val('t_enterprise');
    if (isNew && te) {
      const e = entBy(te);
      const dep = val('t_department');
      const ed =
        e && dep ? d.eds.find((x) => x.enterpriseId === e.id && norm(x.department) === norm(dep)) : undefined;
      if (!e) err('t_enterprise', `Предприятия «${te}» нет в справочнике`);
      else if (!dep) err('t_department', 'Укажите подразделение 2-й линии');
      else if (!ed) err('t_department', `У предприятия «${e.name}» нет подразделения «${dep}»`);
      const tsv = val('t_status');
      const ts = tsv ? Object.entries(TICKET_STATUSES).find(([, l]) => norm(l) === norm(tsv))?.[0] : 'closed';
      if (!ts) err('t_status', `Неизвестный статус 2-й линии «${tsv}»`);
      const due = val('t_due');
      const dueP = due ? parseDateTime(due, true) : null;
      if (due && !dueP) err('t_due', `Не дата: «${due}»`);
      const tc = val('t_closed_at');
      const tcP = tc ? parseDateTime(tc) : null;
      if (tc && !tcP) err('t_closed_at', `Не дата и время: «${tc}»`);
      const rv = val('t_responsible');
      const resp = rv ? userBy(rv) : undefined;
      if (rv && !resp) err('t_responsible', `Сотрудник «${rv}» не найден`);
      const amv = val('t_answer_method');
      const am = amv ? d.answerMethods.find((a) => norm(a.name) === norm(amv)) : undefined;
      if (amv && !am) err('t_answer_method', `Неизвестный способ ответа «${amv}»`);
      const gv = val('t_guilty');
      const guilty = gv ? parseYesNo(gv) : null;
      if (gv && guilty === null) err('t_guilty', `Нужно «Да» или «Нет», а не «${gv}»`);
      const mv = val('t_measures');
      const measures: string[] = [];
      for (const part of (mv ?? '')
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean)) {
        const m = Object.entries(MEASURES).find(([, l]) => norm(l) === norm(part))?.[0];
        if (!m) err('t_measures', `Неизвестная мера «${part}»`);
        else measures.push(m);
      }
      if (e && ed && ts)
        n.ticket = {
          edId: ed.id,
          enterpriseId: e.id,
          departmentId: ed.departmentId,
          status: ts,
          due: dueP,
          responsibleId: resp?.id ?? null,
          answer: val('t_answer') ?? null,
          answerMethodId: am?.id ?? null,
          closedAt: tcP,
          guilty,
          measures,
        };
      if (n.ticket) n.status = n.ticket.status === 'closed' ? 'closed' : 'waiting_2nd_line';
    }
    if (
      isNew &&
      n.status === 'waiting_2nd_line' &&
      !n.ticket &&
      !errors.some((e) => e.col === idx.get('t_enterprise'))
    )
      err('t_enterprise', 'Для статуса «На 2-й линии» заполните предприятие и подразделение 2-й линии');

    const p: PlanRow = { row: r.row, action: 'create', values: r.values, errors, changed: [] };
    if (errors.length) p.action = 'error';
    else if (ex) {
      p.id = ex.id;
      p.changed = onlyNew ? [] : diff(ex, n, idx, d);
      p.action = p.changed.length ? 'update' : 'same';
      p.data = n;
    } else {
      // Полный дубль без ID и кода: то же время, тема, суть и телефон/e-mail — в файле или в базе.
      const key = [
        n.createdAt,
        n.topicId,
        norm(n.fields.issue_summary ?? ''),
        phoneDigits(n.fields.client_phone ?? ''),
        n.email ?? '',
      ].join('|');
      const prev = contentKey.get(key);
      if (prev !== undefined) {
        p.action = 'duplicate';
        p.dupOfRow = prev;
      } else contentKey.set(key, r.row);
      p.data = n;
    }
    plan.push(p);
  }

  // Дубли новых строк с уже существующими обращениями (то же время поступления — до секунды).
  const fresh = plan.filter((p) => p.action === 'create' && !p.data?.externalCode);
  if (fresh.length) {
    const times = [...new Set(fresh.map((p) => p.data!.createdAt!))];
    const same = await rows<Existing>(
      db,
      `${EXISTING_SQL(tzSafe)} WHERE c.created_at = ANY(SELECT (x::timestamp AT TIME ZONE '${tzSafe}') FROM unnest($1::text[]) x)`,
      [times],
    );
    const keyOf = (e: Existing) =>
      [
        e.created_local,
        e.topic_id,
        norm(String(e.fields.issue_summary ?? '')),
        phoneDigits(String(e.fields.client_phone ?? e.phone ?? '')),
        (e.email ?? '').toLowerCase(),
      ].join('|');
    const known = new Map(same.map((e) => [keyOf(e), e.id]));
    for (const p of fresh) {
      const n = p.data!;
      const k = [
        n.createdAt,
        n.topicId,
        norm(n.fields.issue_summary ?? ''),
        phoneDigits(n.fields.client_phone ?? ''),
        n.email ?? '',
      ].join('|');
      const id = known.get(k);
      if (id) {
        p.action = 'duplicate';
        p.id = id;
      }
    }
  }

  const count = (a: PlanRow['action']) => plan.filter((p) => p.action === a).length;
  const changes = new Map<string, number>();
  for (const p of plan)
    if (p.action === 'update')
      for (const c of p.changed) {
        const name = h.header[c] ?? '';
        changes.set(name, (changes.get(name) ?? 0) + 1);
      }
  const reasons = new Map<string, number>();
  for (const p of plan)
    for (const e of p.errors) {
      const reason = `${h.header[e.col] ?? ''}: ${e.msg.replace(/«[^»]*»/g, '«…»')}`;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  return {
    header: h.header,
    plan,
    summary: {
      fileName,
      headerRow: h.headerRow + 1,
      rows: plan.length,
      create: count('create'),
      update: count('update'),
      same: count('same'),
      duplicate: count('duplicate'),
      error: count('error'),
      changes: [...changes].map(([column, n]) => ({ column, count: n })).sort((a, b) => b.count - a.count),
      errors: [...reasons].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
      sameIds: plan
        .filter((p) => p.action === 'same')
        .map((p) => p.id!)
        .slice(0, 1000),
      duplicateIds: [
        ...new Set(plan.filter((p) => p.action === 'duplicate' && p.id).map((p) => p.id!)),
      ].slice(0, 1000),
      unknownColumns: h.unknown,
      missingRequired: h.missingRequired,
    },
  };
}

/** Какие колонки меняют существующее обращение. */
function diff(ex: Existing, n: Norm, idx: Map<string, number>, d: Dicts): number[] {
  const out: number[] = [];
  const mark = (key: string, changed: boolean) => {
    const i = idx.get(key);
    if (changed && i !== undefined) out.push(i);
  };
  if (n.externalCode !== undefined) mark('external_code', n.externalCode !== ex.external_code);
  if (n.createdAt) mark('created_at', n.createdAt !== ex.created_local);
  if (n.closedAt !== undefined && ex.status === 'closed') mark('closed_at', n.closedAt !== ex.closed_local);
  if (n.topicId !== undefined) {
    const t = d.topics.find((x) => x.id === n.topicId);
    const exT = d.topics.find((x) => x.id === ex.topic_id);
    const topChanged = (t?.parent ?? t?.id) !== (exT?.parent ?? exT?.id);
    mark('topic', topChanged);
    mark('subtopic', n.topicId !== ex.topic_id && (!!t?.parent || !topChanged));
  }
  if (n.objectId !== undefined) mark('object', n.objectId !== ex.object_id);
  if (n.important !== undefined) mark('important', n.important !== ex.is_important);
  if (n.urgent !== undefined) mark('urgent', n.urgent !== ex.is_urgent);
  if (n.dispositionId !== undefined) mark('disposition', n.dispositionId !== ex.disposition_id);
  for (const [k, v] of Object.entries(n.fields)) {
    const old = ex.fields[k];
    const was = old === undefined || old === null || old === '' ? null : String(old);
    mark(`f:${k}`, (v ?? null) !== was);
  }
  return out;
}

// ---------------------------------------------------------------- применение

/** Записать строки плана (create / update) — пачками в отдельных транзакциях. */
export async function applyPlan(
  d: Dicts,
  plan: PlanRow[],
  actorId: string,
  batchId: string,
  withTx: <T>(fn: (tx: PoolClient) => Promise<T>) => Promise<T>,
): Promise<{ created: number; updated: number; tickets: number; contacts: number }> {
  const res = { created: 0, updated: 0, tickets: 0, contacts: 0 };
  const tz = d.tz.replace(/'/g, '');
  const todo = plan.filter((p) => p.action === 'create' || p.action === 'update');
  for (let i = 0; i < todo.length; i += 500) {
    const chunk = todo.slice(i, i + 500);
    await withTx(async (tx) => {
      // Клиенты новых обращений: по телефону или e-mail, иначе — новый клиент.
      const creates = chunk.filter((p) => p.action === 'create');
      const phones = [
        ...new Set(
          creates.map((p) => phoneDigits(p.data!.fields.client_phone ?? '')).filter((x) => x.length >= 7),
        ),
      ];
      const emails = [...new Set(creates.map((p) => p.data!.email).filter(Boolean) as string[])];
      const found = await rows<{ id: string; phone: string | null; email: string | null }>(
        tx,
        `SELECT id, phone, lower(email) AS email FROM contact
          WHERE merged_into_id IS NULL AND anonymized_at IS NULL
            AND (right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 9) = ANY($1::text[]) OR lower(email) = ANY($2::text[]))`,
        [phones, emails],
      );
      const byPhone = new Map(found.filter((c) => c.phone).map((c) => [phoneDigits(c.phone!), c.id]));
      const byEmail = new Map(found.filter((c) => c.email).map((c) => [c.email!, c.id]));
      const newContacts: { id: string; name: string | null; phone: string | null; email: string | null }[] =
        [];
      const convs: Record<string, unknown>[] = [];
      const msgs: Record<string, unknown>[] = [];
      const tickets: Record<string, unknown>[] = [];
      const assignees: Record<string, unknown>[] = [];
      for (const p of creates) {
        const n = p.data!;
        const ph = phoneDigits(n.fields.client_phone ?? '');
        let contactId = (ph.length >= 7 && byPhone.get(ph)) || (n.email && byEmail.get(n.email)) || undefined;
        if (!contactId) {
          contactId = newId();
          newContacts.push({
            id: contactId,
            name: n.fields.client_name ?? null,
            phone: n.fields.client_phone ?? null,
            email: n.email ?? null,
          });
          if (ph.length >= 7) byPhone.set(ph, contactId);
          if (n.email) byEmail.set(n.email, contactId);
        }
        const id = newId();
        const t = d.topics.find((x) => x.id === n.topicId);
        const closed = n.status === 'closed';
        const fields = Object.fromEntries(Object.entries(n.fields).filter(([, v]) => v !== null));
        convs.push({
          id,
          channel_id: d.channels.get(n.channelKind!),
          channel_kind: n.channelKind,
          contact_id: contactId,
          status: n.status,
          queue_id:
            n.status === 'queued' || n.status === 'active' ? (d.queues.get(n.channelKind!) ?? null) : null,
          assignee_id: n.status === 'queued' ? null : (n.operatorId ?? null),
          topic_id: n.topicId ?? null,
          topic_path: t?.path ?? [],
          enterprise_id: n.ticket?.enterpriseId ?? n.enterpriseId ?? null,
          department_id: n.ticket?.departmentId ?? null,
          object_id: n.objectId ?? null,
          is_important: !!n.important,
          is_urgent: !!n.urgent,
          fields,
          disposition_id:
            n.dispositionId ??
            (n.ticket ? (d.dispositions.find((x) => x.behavior === 'escalate')?.id ?? null) : null),
          created_local: n.createdAt,
          closed_local: closed ? (n.closedAt ?? n.ticket?.closedAt ?? n.createdAt) : null,
          closed_by: closed ? (n.operatorId ?? null) : null,
          external_code: n.externalCode ?? null,
          has_msg: !!n.fields.issue_summary && n.channelKind !== 'voice',
          batch: batchId,
        });
        if (n.fields.issue_summary && n.channelKind !== 'voice')
          msgs.push({
            id: newId(),
            conversation_id: id,
            body: n.fields.issue_summary,
            kind: n.channelKind,
            at: n.createdAt,
          });
        if (n.ticket && t) {
          const tk = n.ticket;
          const tid = newId();
          const tClosed = tk.status === 'closed';
          tickets.push({
            id: tid,
            conversation_id: id,
            ed: tk.edId,
            enterprise_id: tk.enterpriseId,
            department_id: tk.departmentId,
            topic_id: t.id,
            topic_path: t.path,
            is_important: !!n.important,
            status: tk.status,
            summary: n.fields.issue_summary ?? '—',
            due: tk.due,
            created_by: n.operatorId ?? actorId,
            created_local: n.createdAt,
            answer: tk.answer,
            answer_method_id: tk.answerMethodId,
            answered_local:
              tk.answer && ['approval', 'closed'].includes(tk.status) ? (tk.closedAt ?? n.createdAt) : null,
            closed_local: tClosed ? (tk.closedAt ?? n.closedAt ?? n.createdAt) : null,
            guilty: tClosed ? tk.guilty : null,
            measures: tClosed ? (tk.measures.length ? tk.measures : tk.guilty ? [] : ['none']) : [],
          });
          if (tk.responsibleId)
            assignees.push({ ticket_id: tid, user_id: tk.responsibleId, at: n.createdAt });
        }
      }
      if (newContacts.length)
        await tx.query(
          `INSERT INTO contact (id, display_name, phone, email)
           SELECT x.id, x.name, x.phone, x.email FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, name text, phone text, email text)`,
          [JSON.stringify(newContacts)],
        );
      if (convs.length)
        await tx.query(
          `INSERT INTO conversation (id, channel_id, channel_kind, contact_id, status, queue_id, assignee_id, topic_id,
             topic_path, enterprise_id, department_id, object_id, is_important, important_manual, is_urgent, fields,
             disposition_id, created_at, updated_at, queued_at, assigned_at, last_message_at, closed_at, closed_by,
             external_code, seq, channel_meta)
           SELECT x.id, x.channel_id, x.channel_kind, x.contact_id, x.status, x.queue_id, x.assignee_id, x.topic_id,
                  x.topic_path, x.enterprise_id, x.department_id, x.object_id, x.is_important, x.is_important, x.is_urgent,
                  x.fields, x.disposition_id, (x.created_local::timestamp AT TIME ZONE '${tz}'),
                  coalesce(x.closed_local, x.created_local)::timestamp AT TIME ZONE '${tz}',
                  (x.created_local::timestamp AT TIME ZONE '${tz}'),
                  CASE WHEN x.assignee_id IS NOT NULL THEN x.created_local::timestamp AT TIME ZONE '${tz}' END,
                  (x.created_local::timestamp AT TIME ZONE '${tz}'),
                  (x.closed_local::timestamp AT TIME ZONE '${tz}'), x.closed_by, x.external_code,
                  CASE WHEN x.has_msg THEN 1 ELSE 0 END, jsonb_build_object('importBatch', x.batch)
             FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, channel_id uuid, channel_kind text, contact_id uuid,
                  status text, queue_id uuid, assignee_id uuid, topic_id uuid, topic_path uuid[], enterprise_id uuid,
                  department_id uuid, object_id uuid, is_important boolean, is_urgent boolean, fields jsonb,
                  disposition_id uuid, created_local text, closed_local text, closed_by uuid, external_code text,
                  has_msg boolean, batch text)`,
          [JSON.stringify(convs)],
        );
      if (msgs.length)
        await tx.query(
          `INSERT INTO message (id, conversation_id, seq, direction, body, channel_kind, sent_at, created_at, meta)
           SELECT x.id, x.conversation_id, 1, 'in', x.body, x.kind, x.at::timestamp AT TIME ZONE '${tz}',
                  x.at::timestamp AT TIME ZONE '${tz}', '{"imported": true}'
             FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, conversation_id uuid, body text, kind text, at text)`,
          [JSON.stringify(msgs)],
        );
      if (tickets.length)
        await tx.query(
          `INSERT INTO ticket (id, conversation_id, enterprise_department_id, enterprise_id, department_id, topic_id,
             topic_path, is_important, important_manual, status, summary, due_date, created_by, created_at, updated_at,
             answer_summary, answer_method_id, answered_at, closed_at, closed_in_time, staff_guilty, measures)
           SELECT x.id, x.conversation_id, x.ed, x.enterprise_id, x.department_id, x.topic_id, x.topic_path,
                  x.is_important, x.is_important, x.status, x.summary,
                  coalesce(x.due::date, (x.created_local::timestamp)::date + 5), x.created_by,
                  x.created_local::timestamp AT TIME ZONE '${tz}',
                  coalesce(x.closed_local, x.created_local)::timestamp AT TIME ZONE '${tz}',
                  x.answer, x.answer_method_id, x.answered_local::timestamp AT TIME ZONE '${tz}',
                  x.closed_local::timestamp AT TIME ZONE '${tz}',
                  CASE WHEN x.closed_local IS NOT NULL THEN (x.closed_local::timestamp)::date <=
                       coalesce(x.due::date, (x.created_local::timestamp)::date + 5) END,
                  x.guilty, x.measures
             FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, conversation_id uuid, ed uuid, enterprise_id uuid,
                  department_id uuid, topic_id uuid, topic_path uuid[], is_important boolean, status text, summary text,
                  due text, created_by uuid, created_local text, answer text, answer_method_id uuid,
                  answered_local text, closed_local text, guilty boolean, measures text[])`,
          [JSON.stringify(tickets)],
        );
      if (assignees.length)
        await tx.query(
          `INSERT INTO ticket_assignee (ticket_id, user_id, kind, is_active, added_at, added_by)
           SELECT x.ticket_id, x.user_id, 'responsible', true, x.at::timestamp AT TIME ZONE '${tz}', $2
             FROM jsonb_to_recordset($1::jsonb) AS x(ticket_id uuid, user_id uuid, at text)`,
          [JSON.stringify(assignees), actorId],
        );
      // Правка существующих: только изменённые значения.
      for (const p of chunk.filter((x) => x.action === 'update')) {
        const n = p.data!;
        const t = n.topicId ? d.topics.find((x) => x.id === n.topicId) : undefined;
        const set = Object.fromEntries(Object.entries(n.fields).filter(([, v]) => v !== null));
        const unset = Object.entries(n.fields)
          .filter(([, v]) => v === null)
          .map(([k]) => k);
        await tx.query(
          `UPDATE conversation SET
             external_code = CASE WHEN $2::boolean THEN $3 ELSE external_code END,
             created_at = coalesce($4::timestamp AT TIME ZONE '${tz}', created_at),
             closed_at = CASE WHEN status = 'closed' AND $5::boolean THEN coalesce($6::timestamp AT TIME ZONE '${tz}', created_at) ELSE closed_at END,
             topic_id = coalesce($7, topic_id), topic_path = coalesce($8, topic_path),
             object_id = CASE WHEN $9::boolean THEN $10 ELSE object_id END,
             enterprise_id = CASE WHEN $9::boolean AND status <> 'waiting_2nd_line' THEN $11 ELSE enterprise_id END,
             is_important = coalesce($12, is_important), is_urgent = coalesce($13, is_urgent),
             disposition_id = CASE WHEN $14::boolean THEN $15 ELSE disposition_id END,
             fields = (fields - $16::text[]) || $17::jsonb,
             version = version + 1, updated_at = now()
           WHERE id = $1`,
          [
            p.id,
            n.externalCode !== undefined,
            n.externalCode ?? null,
            n.createdAt ?? null,
            n.closedAt !== undefined,
            n.closedAt ?? null,
            n.topicId ?? null,
            t?.path ?? null,
            n.objectId !== undefined,
            n.objectId ?? null,
            n.enterpriseId ?? null,
            n.important ?? null,
            n.urgent ?? null,
            n.dispositionId !== undefined,
            n.dispositionId ?? null,
            unset,
            JSON.stringify(set),
          ],
        );
      }
      // События: «живые» обращения (очередь, в работе, 2-я линия) — как новые, чтобы их увидели списки и
      // распределение; изменённые — обновление. Закрытая история — без событий (не рассылать тысячи уведомлений
      // во внешние системы; конструктор отчётов читает таблицы, а не журнал).
      for (const c of convs.filter((x) => x.status !== 'closed'))
        await emitConversation(tx, CONVERSATION_EVENTS.created, await loadRef(tx, String(c.id)), {
          imported: batchId,
        });
      for (const p of chunk.filter((x) => x.action === 'update'))
        await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, p.id!), {
          action: 'imported',
          imported: batchId,
        });
      res.created += convs.length;
      res.updated += chunk.length - convs.length;
      res.tickets += tickets.length;
      res.contacts += newContacts.length;
    });
  }
  return res;
}

// ---------------------------------------------------------------- файл с отметками

const ACTION_LABEL: Record<PlanRow['action'], string> = {
  create: 'Новое',
  update: 'Изменение',
  same: 'Без изменений (полный дубль)',
  duplicate: 'Дубль — не загружается',
  error: 'Ошибка — не загружается',
};

/** Загружаемый файл с колонкой «Результат проверки»: ошибки — красным, изменения — жёлтым, новые — зелёным. */
export function markedSheets(header: string[], plan: PlanRow[]): SheetSpec[] {
  const width = Math.max(header.length, ...plan.map((p) => p.values.length));
  const head = [...header, ...Array(width - header.length).fill('')];
  return [
    {
      name: 'Проверка',
      header: ['Строка', 'Результат проверки', ...head],
      rows: plan.map((p) => [
        p.row,
        [
          ACTION_LABEL[p.action],
          p.id && p.action !== 'create' ? `ID ${p.id}` : '',
          p.dupOfRow ? `повторяет строку ${p.dupOfRow}` : '',
          ...p.errors.map((e) => (e.col >= 0 ? `${header[e.col]}: ${e.msg}` : e.msg)),
        ]
          .filter(Boolean)
          .join('; '),
        ...Array.from({ length: width }, (_, i) => p.values[i] ?? ''),
      ]),
      style: (ri, ci) => {
        const p = plan[ri]!;
        if (ci === 1)
          return p.action === 'error' || p.action === 'duplicate'
            ? XS.error
            : p.action === 'update'
              ? XS.changed
              : p.action === 'create'
                ? XS.ok
                : XS.normal;
        if (ci < 2) return XS.normal;
        const col = ci - 2;
        if (p.errors.some((e) => e.col === col)) return XS.error;
        if (p.changed.includes(col)) return XS.changed;
        return XS.normal;
      },
    },
  ];
}

/** Существующие обращения строками шаблона (выгрузка для правки). */
export async function exportRows(
  db: Db,
  d: Dicts,
  from: string,
  to: string,
  limit: number,
): Promise<Cell[][]> {
  const tz = d.tz.replace(/'/g, '');
  const cols = columns(d).filter((c) => !c.hidden);
  const list = await rows<Existing & { operator: string | null; t_ent: string | null; t_dep: string | null }>(
    db,
    `${EXISTING_SQL(tz).replace('FROM conversation c', `, u.full_name AS operator FROM conversation c LEFT JOIN app_user u ON u.id = coalesce(c.closed_by, c.assignee_id)`)}
      WHERE c.created_at >= ($1::date::timestamp AT TIME ZONE '${tz}') AND c.created_at < (($2::date + 1)::timestamp AT TIME ZONE '${tz}')
      ORDER BY c.created_at LIMIT $3`,
    [from, to, limit],
  );
  const topic = new Map(d.topics.map((t) => [t.id, t]));
  const obj = new Map(d.objects.map((o) => [o.id, o]));
  const disp = new Map(d.dispositions.map((x) => [x.id, x.name]));
  const dt = (s: string | null) =>
    s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 19)}` : '';
  const yn = (b: boolean) => (b ? 'Да' : 'Нет');
  return list.map((e) => {
    const t = e.topic_id ? topic.get(e.topic_id) : undefined;
    const parent = t?.parent ? topic.get(t.parent) : t;
    const o = e.object_id ? obj.get(e.object_id) : undefined;
    return cols.map((c): Cell => {
      switch (c.key) {
        case 'id':
          return e.id;
        case 'external_code':
          return e.external_code ?? '';
        case 'channel':
          return CHANNELS[e.channel_kind] ?? e.channel_kind;
        case 'created_at':
          return dt(e.created_local);
        case 'status':
          return STATUSES[e.status] ?? e.status;
        case 'closed_at':
          return dt(e.closed_local);
        case 'operator':
          return e.operator ?? '';
        case 'client_email':
          return e.email ?? '';
        case 'topic':
          return parent?.name ?? '';
        case 'subtopic':
          return t?.parent ? t.name : '';
        case 'object':
          return o?.name ?? '';
        case 'object_enterprise':
          return o?.kind === 'azs' ? o.enterprise : '';
        case 'important':
          return yn(e.is_important);
        case 'urgent':
          return yn(e.is_urgent);
        case 'disposition':
          return e.disposition_id ? (disp.get(e.disposition_id) ?? '') : '';
        default: {
          if (!c.field) return '';
          const v = e.fields[c.field.key];
          if (v === undefined || v === null) return '';
          if (c.field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v)))
            return `${String(v).slice(8, 10)}.${String(v).slice(5, 7)}.${String(v).slice(0, 4)}`;
          return typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
      }
    });
  });
}
