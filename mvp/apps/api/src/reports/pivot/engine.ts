import { type Principal, scopeFilter } from '@cc/auth';
import { z } from 'zod';
import type { Db } from '../../lib/db';
import { badRequest } from '../../lib/errors';
import { slParams } from '../reports';
import {
  DIMS,
  type DimDef,
  type DimImpl,
  FACTS,
  type FactId,
  fieldDims,
  type FieldDefRow,
  MEASURES,
  type MeasureDef,
  SECTIONS,
  type SqlCtx,
} from './model';

// ------------------------------------------------------------------ запрос

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const FilterSchema = z
  .object({
    field: z.string().max(80),
    mode: z.enum(['in', 'out']).default('in'),
    values: z.array(z.string().max(300)).max(5000).default([]),
    /** Условие по показателю: оставить значения поля, у которых показатель удовлетворяет условию. */
    measure: z.string().max(80).optional(),
    op: z.enum(['>', '>=', '<', '<=', '=', '!=']).optional(),
    value: z.number().finite().optional(),
  })
  .strict();
export const PivotQuerySchema = z
  .object({
    rows: z.array(z.string().max(80)).max(6).default([]),
    cols: z.array(z.string().max(80)).max(4).default([]),
    values: z.array(z.string().max(80)).min(1, 'Добавьте показатель в «Значения»').max(20),
    filters: z.array(FilterSchema).max(30).default([]),
    from: isoDate,
    to: isoDate,
    grain: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('month'),
    compare: z.object({ from: isoDate, to: isoDate }).strict().nullable().optional(),
    /** Подытоги по уровням строк и столбцов (для перекрёстной таблицы); иначе — только общий итог. */
    subtotals: z.boolean().default(true),
  })
  .strict();
export type PivotQuery = z.infer<typeof PivotQuerySchema>;
export type PivotFilter = z.infer<typeof FilterSchema>;

const MAX_GROUPS = 20_000;
const MAX_DAYS = 1830;
export const NULL_KEY = '__null';

// ------------------------------------------------------------------ модель (поля карточки — из справочника)

export interface Model {
  dims: Map<string, DimDef>;
  measures: Map<string, MeasureDef>;
}
let cached: { at: number; model: Model } | null = null;

export async function loadModel(db: Db): Promise<Model> {
  if (cached && Date.now() - cached.at < 60_000) return cached.model;
  const defs = (
    await db.query<FieldDefRow>(
      `SELECT DISTINCT ON (key, type) key, label, type, options FROM field_def WHERE is_active ORDER BY key, type, sort_order`,
    )
  ).rows;
  const dims = new Map<string, DimDef>();
  for (const d of [...DIMS, ...fieldDims(defs)]) dims.set(d.id, d);
  const model = { dims, measures: new Map(MEASURES.map((m) => [m.id, m])) };
  cached = { at: Date.now(), model };
  return model;
}

/** Каталог для интерфейса: разделы, поля (с фактами, где они есть) и показатели. */
export function catalog(model: Model) {
  return {
    sections: SECTIONS,
    facts: Object.values(FACTS).map((f) => ({ id: f.id, label: f.label })),
    dims: [...model.dims.values()].map((d) => ({
      id: d.id,
      section: d.section,
      label: d.label,
      hint: d.hint ?? null,
      facts: Object.keys(d.facts),
      sort: d.sort ?? 'label',
      hasValues: d.values !== 'none' && d.values !== undefined,
      map: !!d.map,
    })),
    measures: [...model.measures.values()].map((m) => ({
      id: m.id,
      section: m.section,
      label: m.label,
      hint: m.hint ?? null,
      fact: m.fact,
      format: m.format,
    })),
  };
}

// ------------------------------------------------------------------ период

export interface PivotPeriod {
  from: string;
  to: string;
  t0: Date;
  t1: Date;
}

async function resolve(db: Db, tz: string, from: string, to: string): Promise<PivotPeriod> {
  const r = (
    await db.query<{ t0: Date; t1: Date; days: number }>(
      `SELECT $1::date::timestamp AT TIME ZONE $3::text AS t0, ($2::date + 1)::timestamp AT TIME ZONE $3::text AS t1,
              $2::date - $1::date + 1 AS days`,
      [from, to, tz],
    )
  ).rows[0]!;
  if (r.days < 1) throw badRequest('Начало периода позже конца');
  if (r.days > MAX_DAYS) throw badRequest('Период отчёта — не больше 5 лет');
  return { from, to, t0: r.t0, t1: r.t1 };
}

/**
 * Сдвиг дат периода сравнения к основному периоду: столбцы «Период», «Месяц», «Дата» совпадают. Те же месяц и
 * день — сдвиг на целые годы, тот же день месяца — на месяцы, иначе — на дни.
 */
export function shiftOf(main: string, cmp: string): string | null {
  if (main === cmp) return null;
  const [y1, m1, d1] = main.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = cmp.split('-').map(Number) as [number, number, number];
  if (m1 === m2 && d1 === d2) return `${y1 - y2} years`;
  if (d1 === d2) return `${(y1 - y2) * 12 + (m1 - m2)} months`;
  const days = Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86_400_000);
  return `${days} days`;
}

// ------------------------------------------------------------------ построение SQL одного факта

interface Env {
  tz: string;
  today: string;
  sl: { voice: number; text: number; short: number };
  principal: Principal;
}

interface Built {
  fact: FactId;
  sql: string;
  params: unknown[];
  measures: MeasureDef[];
}

class Sql implements SqlCtx {
  readonly list: unknown[] = [];
  private readonly named = new Map<string, string>();
  t0: string;
  t1: string;
  constructor(
    private readonly env: Env,
    period: PivotPeriod,
    private readonly shift: string | null,
    readonly grain: string,
  ) {
    this.t0 = this.p(period.t0);
    this.t1 = this.p(period.t1);
  }
  p(v: unknown): string {
    this.list.push(v);
    return `$${this.list.length}`;
  }
  lazy(name: string, fallback: unknown): string {
    const known: Record<string, unknown> = {
      slv: this.env.sl.voice,
      slt: this.env.sl.text,
      short: this.env.sl.short,
      tz: this.env.tz,
      today: this.env.today,
      shift: this.shift,
      me: this.env.principal.id,
    };
    let ph = this.named.get(name);
    if (!ph) {
      ph = this.p(name in known ? known[name] : fallback);
      this.named.set(name, ph);
    }
    return ph;
  }
  get today() {
    return this.lazy('today', null);
  }
  get me() {
    return this.lazy('me', null);
  }
  local(expr: string): string {
    const shifted = this.shift ? `((${expr}) + ${this.lazy('shift', null)}::interval)` : `(${expr})`;
    return `(${shifted} AT TIME ZONE ${this.lazy('tz', 'Europe/Minsk')}::text)`;
  }
}

const implOf = (d: DimDef, fact: FactId, c: SqlCtx): DimImpl | null => {
  const f = d.facts[fact];
  if (!f) return null;
  return typeof f === 'function' ? f(c) : f;
};

/** Связи факта в порядке объявления, с зависимостями. */
function joinSql(fact: FactId, names: Set<string>): string {
  const def = FACTS[fact].joins;
  const need = new Set<string>();
  const add = (n: string) => {
    if (need.has(n)) return;
    const j = def[n];
    if (!j) throw new Error(`pivot: нет связи ${n} у факта ${fact}`);
    j.needs?.forEach(add);
    need.add(n);
  };
  names.forEach(add);
  return Object.keys(def)
    .filter((n) => need.has(n))
    .map((n) => def[n]!.sql)
    .join('\n');
}

const OPS: Record<string, string> = { '>': '>', '>=': '>=', '<': '<', '<=': '<=', '=': '=', '!=': '<>' };

/**
 * SQL факта: ключи полей считаются в LATERAL (`dd.k0…`), итоги и подытоги — `GROUPING SETS` (средние и доли в
 * итогах считает база, поэтому они верные). `g` — битовая маска GROUPING: 1 — поле свёрнуто (итог по нему).
 */
function buildFact(
  model: Model,
  env: Env,
  fact: FactId,
  q: PivotQuery,
  measures: MeasureDef[],
  dims: string[],
  sets: number[][],
  filters: PivotFilter[],
  period: PivotPeriod,
  shift: string | null,
  having?: { measure: MeasureDef; op: string; value: number },
): Built {
  const c = new Sql(env, period, shift, q.grain);
  const f = FACTS[fact];
  const joins = new Set<string>(f.scope.joins);
  const keyCols: string[] = [];
  dims.forEach((id, i) => {
    const impl = implOf(model.dims.get(id)!, fact, c)!;
    impl.joins?.forEach((j) => joins.add(j));
    keyCols.push(`(${impl.key})::text AS k${i}`, `(${impl.label ?? 'NULL'})::text AS l${i}`);
  });
  const where: string[] = [f.period ? f.period(c) : `${f.date} >= ${c.t0} AND ${f.date} < ${c.t1}`];
  for (const flt of filters) {
    const impl = implOf(model.dims.get(flt.field)!, fact, c);
    if (!impl) continue;
    impl.joins?.forEach((j) => joins.add(j));
    const cond = `COALESCE((${impl.key})::text, '${NULL_KEY}') = ANY(${c.p(flt.values)}::text[])`;
    where.push(flt.mode === 'out' ? `NOT (${cond})` : cond);
  }
  // Область видимости сотрудника (единый предикат, M-ORG-07); на 2-й линии назначенный видит свои тикеты.
  const sc = scopeFilter(
    env.principal.scope,
    { enterprise: f.scope.enterprise, department: f.scope.department, topicPath: f.scope.topicPath },
    c.list.length + 1,
  );
  c.list.push(...sc.params);
  where.push(f.scope.mine ? `(${sc.sql} OR ${c.me}::uuid = ANY(${f.scope.mine}))` : sc.sql);

  const mcols = measures.map((m, i) => {
    m.joins?.forEach((j) => joins.add(j));
    return `${m.sql(c)} AS m${i}`;
  });
  let havingSql = '';
  if (having) {
    having.measure.joins?.forEach((j) => joins.add(j));
    havingSql = `HAVING (${having.measure.sql(c)}) ${OPS[having.op]} ${c.p(having.value)}`;
  }
  const from = `${f.from}\n${joinSql(fact, joins)}`;
  const lateral = dims.length ? `\nCROSS JOIN LATERAL (SELECT ${keyCols.join(', ')}) dd` : '';
  const k = dims.map((_, i) => `dd.k${i}`);
  let sql: string;
  if (!dims.length)
    sql = `SELECT 0 AS g, ${mcols.join(', ')} FROM ${from}${lateral} WHERE ${where.join(' AND ')} ${havingSql}`;
  else {
    const g = `GROUPING(${k.join(', ')})`;
    const labels = dims.map((_, i) => `min(dd.l${i}) AS l${i}`);
    const groupSets = sets.map((s) => `(${s.map((i) => `dd.k${i}`).join(', ')})`).join(', ');
    sql = `SELECT ${g} AS g, ${k.join(', ')}, ${labels.join(', ')}${mcols.length ? `, ${mcols.join(', ')}` : ''}
             FROM ${from}${lateral}
            WHERE ${where.join(' AND ')}
            GROUP BY GROUPING SETS (${groupSets})
            ${havingSql}
            ORDER BY 1 DESC
            LIMIT ${MAX_GROUPS + 1}`;
  }
  return { fact, sql, params: c.list, measures };
}

// ------------------------------------------------------------------ план запроса (без выполнения)

export interface Estimate {
  /** Сколько строк данных база прочитает (оценка планировщика). */
  sourceRows: number;
  /** Сколько групп (строк результата) получится. */
  groups: number;
  measures: number;
  facts: number;
  periods: number;
  /** Примерное время, секунды. */
  seconds: number;
  heavy: boolean;
  warnSeconds: number;
  timeoutSeconds: number;
}

interface PlanNode {
  'Total Cost': number;
  'Plan Rows': number;
  'Node Type': string;
  Plans?: PlanNode[];
}
const scanRows = (n: PlanNode): number =>
  (/Scan$/.test(n['Node Type']) ? n['Plan Rows'] : 0) + (n.Plans ?? []).reduce((s, c) => s + scanRows(c), 0);

/**
 * Скорость базы в единицах стоимости планировщика в секунду: начальная оценка (замер на стенде 14.10.2026 —
 * ≈ 2 млн единиц в секунду, взято с запасом), затем подстраивается по
 * фактическим запускам (скользящее среднее; короткие запуски не учитываются — в них больше накладных расходов).
 */
let costPerSecond = 1_500_000;
export const calibration = {
  get costPerSecond() {
    return costPerSecond;
  },
  record(cost: number, ms: number) {
    if (ms < 300 || cost < 1000) return;
    const measured = cost / (ms / 1000);
    costPerSecond = Math.round(costPerSecond * 0.5 + measured * 0.5);
  },
};

// ------------------------------------------------------------------ выполнение

export interface PivotRow {
  g: number;
  k: (string | null)[];
  l: (string | null)[];
  v: (number | null)[];
  c?: (number | null)[];
}
export interface PivotResult {
  dims: { id: string; label: string; sort: string }[];
  measures: { id: string; label: string; format: string }[];
  rows: PivotRow[];
  period: { from: string; to: string };
  compare: { from: string; to: string } | null;
  warnings: string[];
  truncated: boolean;
  estimate: Estimate;
  ms: number;
}

async function setting(db: Db, key: string, def: number): Promise<number> {
  const r = await db.query<{ v: string | null }>(
    `SELECT value #>> '{}' AS v FROM system_setting WHERE key = $1`,
    [key],
  );
  const n = Number(r.rows[0]?.v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Наборы группировки: префиксы строк × префиксы столбцов (подытоги) или только полный набор и общий итог. */
function groupingSets(nRows: number, nCols: number, subtotals: boolean): number[][] {
  const all = [...Array(nRows + nCols).keys()];
  if (!subtotals) return all.length ? [all, []] : [[]];
  const sets: number[][] = [];
  for (let i = 0; i <= nRows; i++)
    for (let j = 0; j <= nCols; j++) sets.push([...all.slice(0, i), ...all.slice(nRows, nRows + j)]);
  return sets;
}

/**
 * Построение отчёта. `confirm=false` и оценка дольше порога — только оценка (интерфейс спросит пользователя).
 * Вызывается внутри транзакции READ ONLY с ограничениями тяжёлого запроса.
 */
export async function runPivot(
  db: Db,
  principal: Principal,
  q: PivotQuery,
  opts: { confirm: boolean },
): Promise<{ needConfirm: true; estimate: Estimate } | ({ needConfirm: false } & PivotResult)> {
  const started = Date.now();
  const model = await loadModel(db);
  const dims = [...q.rows, ...q.cols];
  if (new Set(dims).size !== dims.length) throw badRequest('Одно поле положено и в строки, и в столбцы');
  for (const id of [...dims, ...q.filters.map((f) => f.field)])
    if (!model.dims.has(id)) throw badRequest(`Неизвестное поле: ${id}`);
  const measures = q.values.map((id) => {
    const m = model.measures.get(id);
    if (!m) throw badRequest(`Неизвестный показатель: ${id}`);
    return m;
  });
  for (const f of q.filters)
    if (f.measure && (!model.measures.has(f.measure) || !f.op || f.value === undefined))
      throw badRequest('Условие по показателю заполнено не полностью');

  const tz =
    (
      await db.query<{ v: string | null }>(
        `SELECT value #>> '{}' AS v FROM system_setting WHERE key = 'system.timezone'`,
      )
    ).rows[0]?.v || 'Europe/Minsk';
  const today = (
    await db.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1::text)::date, 'YYYY-MM-DD') AS d`, [
      tz,
    ])
  ).rows[0]!.d;
  const sl = await slParams(db);
  const env: Env = { tz, today, sl, principal };
  const warnSeconds = await setting(db, 'report.pivot_warn_s', 5);
  const timeoutSeconds = await setting(db, 'report.pivot_timeout_s', 60);
  const main = await resolve(db, tz, q.from, q.to);
  const cmp = q.compare ? await resolve(db, tz, q.compare.from, q.compare.to) : null;
  const shift = cmp ? shiftOf(q.from, cmp.from) : null;
  const warnings: string[] = [];
  const label = (id: string) => model.dims.get(id)?.label ?? model.measures.get(id)?.label ?? id;

  // Показатели по фактам; показатель, который нельзя разложить по выбранным полям, — пустой.
  const byFact = new Map<FactId, MeasureDef[]>();
  for (const m of measures) {
    const missing = dims.filter((d) => !model.dims.get(d)!.facts[m.fact]);
    if (missing.length) {
      warnings.push(
        `«${m.label}» нельзя разложить по полю ${missing.map((d) => `«${label(d)}»`).join(', ')} — показатель пустой`,
      );
      continue;
    }
    byFact.set(m.fact, [...(byFact.get(m.fact) ?? []), m]);
  }
  const valueFilters = q.filters.filter((f) => !f.measure && f.values.length);
  for (const fact of byFact.keys())
    for (const f of valueFilters)
      if (!model.dims.get(f.field)!.facts[fact])
        warnings.push(`Фильтр «${label(f.field)}» не действует на показатели «${FACTS[fact].label}»`);

  const sets = groupingSets(q.rows.length, q.cols.length, q.subtotals);
  const plans = async (list: Built[]) => {
    let cost = 0;
    let rowsSrc = 0;
    let groups = 0;
    for (const b of list) {
      const r = await db.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (FORMAT JSON) ${b.sql}`,
        b.params,
      );
      const plan = r.rows[0]!['QUERY PLAN'][0]!.Plan;
      cost += plan['Total Cost'];
      rowsSrc += scanRows(plan);
      // Верхний узел — LIMIT (ограничение строк ответа): число групп — у узла под ним.
      const top = plan['Node Type'] === 'Limit' && plan.Plans?.[0] ? plan.Plans[0] : plan;
      groups = Math.max(groups, top['Plan Rows']);
    }
    return { cost, rowsSrc, groups };
  };

  // Условия по показателям: сначала узнаём, какие значения поля проходят условие (отдельный запрос).
  const condFilters = q.filters.filter((f) => f.measure);
  const condBuilt = condFilters.flatMap((f) => {
    const m = model.measures.get(f.measure!)!;
    if (!model.dims.get(f.field)!.facts[m.fact]) {
      warnings.push(
        `Условие «${label(f.field)}: ${m.label}» не применено — поле и показатель из разных данных`,
      );
      return [];
    }
    return [
      {
        f,
        b: buildFact(model, env, m.fact, q, [], [f.field], [[0]], valueFilters, main, null, {
          measure: m,
          op: f.op!,
          value: f.value!,
        }),
      },
    ];
  });

  const build = (filters: PivotFilter[], period: PivotPeriod, sh: string | null) =>
    [...byFact.entries()].map(([fact, ms]) =>
      buildFact(model, env, fact, q, ms, dims, sets, filters, period, sh),
    );
  const draft = build(valueFilters, main, null);
  const p1 = await plans([...draft, ...condBuilt.map((x) => x.b)]);
  const periods = cmp ? 2 : 1;
  const totalCost = p1.cost * periods;
  const rawSeconds = totalCost / calibration.costPerSecond;
  const seconds = Math.round(rawSeconds * 10) / 10;
  const estimate: Estimate = {
    sourceRows: Math.round(p1.rowsSrc * periods),
    groups: Math.round(p1.groups),
    measures: measures.length,
    facts: byFact.size,
    periods,
    seconds,
    heavy: rawSeconds > warnSeconds,
    warnSeconds,
    timeoutSeconds,
  };
  if (estimate.heavy && !opts.confirm) return { needConfirm: true, estimate };

  const t0 = Date.now();
  const filters = [...valueFilters];
  for (const { f, b } of condBuilt) {
    const keys = (await db.query<{ k0: string | null }>(b.sql, b.params)).rows.map((r) => r.k0 ?? NULL_KEY);
    filters.push({ field: f.field, mode: 'in', values: keys.slice(0, 5000) });
  }
  const mainBuilt = build(filters, main, null);
  const cmpBuilt = cmp ? build(filters, cmp, shift) : [];

  // Объединение фактов по ключам полей.
  const out = new Map<string, PivotRow>();
  const mIndex = new Map(measures.map((m, i) => [m, i]));
  let truncated = false;
  const merge = async (list: Built[], target: 'v' | 'c') => {
    for (const b of list) {
      const res = await db.query<Record<string, unknown>>(b.sql, b.params);
      if (res.rows.length > MAX_GROUPS) truncated = true;
      for (const r of res.rows.slice(0, MAX_GROUPS)) {
        const g = Number(r.g);
        const k = dims.map((_, i) => (r[`k${i}`] as string | null) ?? null);
        const key = `${g}|${k.map((x) => x ?? '\u0000').join('\u0001')}`;
        let row = out.get(key);
        if (!row) {
          row = {
            g,
            k,
            l: dims.map((_, i) => (r[`l${i}`] as string | null) ?? null),
            v: measures.map(() => null),
          };
          if (cmp) row.c = measures.map(() => null);
          out.set(key, row);
        }
        b.measures.forEach((m, i) => {
          const val = r[`m${i}`];
          (row![target] as (number | null)[])[mIndex.get(m)!] =
            val === null || val === undefined ? null : Number(val);
        });
      }
    }
  };
  await merge(mainBuilt, 'v');
  await merge(cmpBuilt, 'c');
  calibration.record(totalCost, Date.now() - t0);
  if (truncated)
    warnings.push(
      `Слишком много строк — показаны первые ${MAX_GROUPS.toLocaleString('ru-RU')}. Добавьте фильтр`,
    );

  // Подписи: справочник (SQL), перечисление или по ключу.
  const rows = [...out.values()];
  dims.forEach((id, i) => {
    const d = model.dims.get(id)!;
    for (const r of rows) {
      const key = r.k[i];
      if (key === null || key === undefined) {
        r.l[i] = null;
        continue;
      }
      r.l[i] = r.l[i] ?? d.names?.[key] ?? (d.labelOf ? d.labelOf(key, q.grain) : key);
    }
  });
  return {
    needConfirm: false,
    dims: dims.map((id) => ({ id, label: label(id), sort: model.dims.get(id)!.sort ?? 'label' })),
    measures: measures.map((m) => ({ id: m.id, label: m.label, format: m.format })),
    rows,
    period: { from: main.from, to: main.to },
    compare: cmp ? { from: cmp.from, to: cmp.to } : null,
    warnings,
    truncated,
    estimate,
    ms: Date.now() - started,
  };
}

/** Значения поля для фильтра: справочник или перечисление; поиск по подстроке. */
export async function dimValues(db: Db, id: string, search: string): Promise<{ id: string; name: string }[]> {
  const model = await loadModel(db);
  const d = model.dims.get(id);
  if (!d) throw badRequest(`Неизвестное поле: ${id}`);
  let list: { id: string; name: string }[] = [];
  if (d.values === 'names') {
    list = Object.entries(d.names ?? {}).map(([k, name]) => ({ id: k, name }));
  } else if (d.values && d.values !== 'none') {
    list = (await db.query<{ id: string; name: string }>(d.values.sql, d.values.params ?? [])).rows;
  }
  const s = search.trim().toLowerCase();
  const found = s ? list.filter((r) => r.name.toLowerCase().includes(s)) : list;
  return found.slice(0, 3000);
}
