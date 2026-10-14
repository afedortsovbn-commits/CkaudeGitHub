/**
 * Д-041. Конструктор отчётов: типы, быстрые периоды и раскладка результата сервера в таблицу (прямую или
 * перекрёстную с подытогами). Итоги и подытоги считает база (GROUPING SETS), здесь — только расстановка.
 */

import { t } from '../../lib/i18n';

export type Format = 'int' | 'num' | 'pct' | 'dur' | 'hours' | 'rating';
export type Zone = 'filters' | 'rows' | 'cols' | 'values';
export type ViewKind =
  | 'flat'
  | 'cross'
  | 'bar'
  | 'stacked'
  | 'hbar'
  | 'line'
  | 'area'
  | 'combo'
  | 'pie'
  | 'heatmap';
export const TABLE_VIEWS: ViewKind[] = ['flat', 'cross'];
export const CHART_VIEWS: ViewKind[] = ['bar', 'stacked', 'hbar', 'line', 'area', 'combo', 'pie', 'heatmap'];

export interface DimInfo {
  id: string;
  section: string;
  label: string;
  hint: string | null;
  facts: string[];
  sort: 'key' | 'label';
  hasValues: boolean;
  map: boolean;
}
export interface MeasureInfo {
  id: string;
  section: string;
  label: string;
  hint: string | null;
  fact: string;
  format: Format;
}
export interface Catalog {
  sections: { id: string; label: string }[];
  facts: { id: string; label: string }[];
  dims: DimInfo[];
  measures: MeasureInfo[];
}

export interface Filter {
  field: string;
  mode: 'in' | 'out';
  values: string[];
  /** Подписи выбранных значений — только для интерфейса, на сервер не отправляются. */
  labels?: string[];
  measure?: string;
  op?: string;
  value?: number;
}

export interface Config {
  rows: string[];
  cols: string[];
  values: string[];
  filters: Filter[];
  preset: string | null;
  from: string;
  to: string;
  grain: 'day' | 'week' | 'month' | 'quarter' | 'year';
  compare: 'none' | 'prev' | 'year' | 'custom';
  compareFrom?: string;
  compareTo?: string;
  view: ViewKind;
  subtotals: boolean;
  /** Длинные подписи в таблице: полностью, сокращать до 25 символов или переносить по 25 (Д-053). */
  textMode?: 'full' | 'cut' | 'wrap';
  sort?: { col: string; dir: 'asc' | 'desc' } | null;
}

export interface ResultRow {
  g: number;
  k: (string | null)[];
  l: (string | null)[];
  v: (number | null)[];
  c?: (number | null)[];
}
export interface Estimate {
  sourceRows: number;
  groups: number;
  measures: number;
  facts: number;
  periods: number;
  seconds: number;
  heavy: boolean;
  warnSeconds: number;
  timeoutSeconds: number;
}
export interface Result {
  needConfirm: false;
  dims: { id: string; label: string; sort: 'key' | 'label' }[];
  measures: { id: string; label: string; format: Format }[];
  rows: ResultRow[];
  period: { from: string; to: string };
  compare: { from: string; to: string } | null;
  warnings: string[];
  truncated: boolean;
  estimate: Estimate;
  ms: number;
}
export type RunResponse = Result | { needConfirm: true; estimate: Estimate };

// ------------------------------------------------------------------ даты

/** Дата по Минску (единый часовой пояс отчётов). */
export const minskToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Minsk' });
const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};
const addMonths = (iso: string, n: number) => {
  const d = parse(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fmt(d);
};
export const daysBetween = (a: string, b: string) =>
  Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);

export const PRESETS = [
  'today',
  'yesterday',
  'd7',
  'd30',
  'month',
  'prevMonth',
  'quarter',
  'year',
  'prevYear',
  'y1',
];

export function presetRange(p: string, today = minskToday()): { from: string; to: string } {
  const y = today.slice(0, 4);
  const m = Number(today.slice(5, 7));
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'd7':
      return { from: addDays(today, -6), to: today };
    case 'd30':
      return { from: addDays(today, -29), to: today };
    case 'month':
      return { from: monthStart, to: today };
    case 'prevMonth':
      return { from: addMonths(monthStart, -1), to: addDays(monthStart, -1) };
    case 'quarter': {
      const qm = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: `${y}-${String(qm).padStart(2, '0')}-01`, to: today };
    }
    case 'year':
      return { from: `${y}-01-01`, to: today };
    case 'prevYear':
      return { from: `${Number(y) - 1}-01-01`, to: `${Number(y) - 1}-12-31` };
    case 'y1':
      return { from: addDays(addMonths(today, -12), 1), to: today };
    default:
      return { from: addDays(today, -6), to: today };
  }
}

/** Период сравнения: предыдущий такой же длины (целые месяцы — предыдущие месяцы) или год назад. */
export function compareRange(c: Config): { from: string; to: string } | null {
  if (c.compare === 'none') return null;
  if (c.compare === 'custom')
    return c.compareFrom && c.compareTo ? { from: c.compareFrom, to: c.compareTo } : null;
  if (c.compare === 'year') return { from: addMonths(c.from, -12), to: addMonths(c.to, -12) };
  const wholeMonths =
    c.from.endsWith('-01') && addDays(c.to, 1).endsWith('-01') && daysBetween(c.from, c.to) >= 27;
  if (wholeMonths) {
    const months =
      (Number(c.to.slice(0, 4)) - Number(c.from.slice(0, 4))) * 12 +
      Number(c.to.slice(5, 7)) -
      Number(c.from.slice(5, 7)) +
      1;
    return { from: addMonths(c.from, -months), to: addDays(c.from, -1) };
  }
  const n = daysBetween(c.from, c.to) + 1;
  return { from: addDays(c.from, -n), to: addDays(c.from, -1) };
}

export const ruDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

// ------------------------------------------------------------------ формат значений

const pad = (n: number) => String(n).padStart(2, '0');
export function formatValue(v: number | null | undefined, f: Format): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  switch (f) {
    case 'dur': {
      const s = Math.round(v);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
    }
    case 'hours':
      return `${(v / 3600).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${t.pivot.unitH}`;
    case 'pct':
      return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`;
    case 'num':
    case 'rating':
      return v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    default:
      return Math.round(v).toLocaleString('ru-RU');
  }
}
/** Значение для Excel: числа — числом (часы — в часах), длительности — текстом «м:сс». */
export function excelValue(v: number | null | undefined, f: Format): string | number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  if (f === 'dur') return formatValue(v, f);
  if (f === 'hours') return Math.round((v / 3600) * 100) / 100;
  return v;
}
/** Значение для оси графика: длительности — в минутах, часы — в часах. */
export function chartValue(v: number | null | undefined, f: Format): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  if (f === 'dur') return Math.round((v / 60) * 10) / 10;
  if (f === 'hours') return Math.round((v / 3600) * 10) / 10;
  return v;
}
export const deltaPct = (cur: number | null | undefined, prev: number | null | undefined) =>
  cur === null || cur === undefined || prev === null || prev === undefined || prev === 0
    ? null
    : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;

// ------------------------------------------------------------------ раскладка в таблицу

/** Столбец значений таблицы: показатель, его вариант (текущий, сравнение, изменение) и путь по столбцам. */
export interface GridCol {
  id: string;
  measure: number;
  part: 'v' | 'c' | 'd';
  /** Ключи полей столбцов (до уровня подытога). */
  colKeys: (string | null)[];
  colLevel: number;
  format: Format;
  header: string[];
}
export interface GridRow {
  id: string;
  kind: 'leaf' | 'group' | 'total';
  level: number;
  /** Подписи в ячейках-заголовках строк (по числу полей строк). */
  labels: string[];
  cells: (number | null)[];
  hasChildren: boolean;
  /** id групп-предков (для сворачивания). */
  parents: string[];
}
export interface Grid {
  rowHeaders: string[];
  /** Строки шапки: ячейки с объединением по ширине и высоте. */
  head: { text: string; span: number; rowSpan: number; colId?: string }[][];
  cols: GridCol[];
  rows: GridRow[];
}

const SEP = '\u0001';
const NUL = '\u0000';
const keyStr = (k: (string | null)[]) => k.map((x) => x ?? NUL).join(SEP);

export interface GridLabels {
  empty: string;
  total: string;
  totalOf(s: string): string;
  cmp: string;
  delta: string;
  cur: string;
}

/** Сравнение ключей поля: по ключу (даты, номера) или по подписи; «не указано» — в конце. */
function cmpBy(sort: 'key' | 'label', labelOf: (k: string | null) => string) {
  return (a: string | null, b: string | null) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (sort === 'key') return a < b ? -1 : 1;
    return labelOf(a).localeCompare(labelOf(b), 'ru', { numeric: true });
  };
}

function labelMapsOf(res: Result) {
  const maps = res.dims.map(() => new Map<string, string>());
  for (const r of res.rows)
    r.k.forEach((k, i) => {
      if (k !== null && r.l[i]) maps[i]!.set(k, r.l[i]!);
    });
  return maps;
}

/**
 * Раскладка результата. Прямая таблица — все поля в строках, без подытогов. Перекрёстная — дерево строк
 * (группы с подытогами перед детьми, итог внизу) × дерево столбцов (подытоги после детей, итог справа).
 */
export function buildGrid(
  res: Result,
  nRows: number,
  view: 'flat' | 'cross',
  L: GridLabels,
  sort: Config['sort'],
): Grid {
  const nDims = res.dims.length;
  const nCols = view === 'flat' ? 0 : nDims - nRows;
  const rDims = view === 'flat' ? nDims : nRows;
  const hasCmp = !!res.compare;
  const bit = (i: number) => 1 << (nDims - 1 - i);
  // Уровень строки результата: сколько первых полей (строк или столбцов) не свёрнуто.
  const levelOf = (g: number, from: number, count: number) => {
    let n = 0;
    while (n < count && !(g & bit(from + n))) n++;
    return n;
  };
  const maps = labelMapsOf(res);
  const lab = (i: number, k: string | null) => (k === null ? L.empty : (maps[i]!.get(k) ?? k));

  // Индекс ячеек: (уровень строк, ключи строк, уровень столбцов, ключи столбцов) → строка результата.
  // После уровня все поля должны быть свёрнуты (наборы — префиксы); иные строки — не из этой раскладки.
  const folded = (g: number, from: number, count: number, lvl: number) => {
    for (let i = lvl; i < count; i++) if (!(g & bit(from + i))) return false;
    return true;
  };
  const cell = new Map<string, ResultRow>();
  for (const r of res.rows) {
    const rl = levelOf(r.g, 0, rDims);
    const cl = levelOf(r.g, rDims, nCols);
    if (!folded(r.g, 0, rDims, rl) || !folded(r.g, rDims, nCols, cl)) continue;
    cell.set(`${rl}|${keyStr(r.k.slice(0, rl))}|${cl}|${keyStr(r.k.slice(rDims, rDims + cl))}`, r);
  }

  // Столбцы: листья дерева полей столбцов по порядку; подытог группы — после её детей; итог — справа.
  type ColNode = { keys: (string | null)[]; level: number };
  const colNodes: ColNode[] = [];
  if (nCols === 0) colNodes.push({ keys: [], level: 0 });
  else {
    const prefixes = new Map<string, (string | null)[]>();
    for (const r of res.rows)
      if (levelOf(r.g, rDims, nCols) === nCols) prefixes.set(keyStr(r.k.slice(rDims)), r.k.slice(rDims));
    const cmps = res.dims.slice(rDims).map((d, i) => cmpBy(d.sort, (k) => lab(rDims + i, k)));
    const leaves = [...prefixes.values()].sort((a, b) => {
      for (let i = 0; i < nCols; i++) {
        const c = cmps[i]!(a[i]!, b[i]!);
        if (c) return c;
      }
      return 0;
    });
    for (let i = 0; i < leaves.length; i++) {
      colNodes.push({ keys: leaves[i]!, level: nCols });
      for (let lvl = nCols - 1; lvl >= 1; lvl--) {
        const cur = leaves[i]!.slice(0, lvl);
        const next = leaves[i + 1]?.slice(0, lvl);
        if (!next || keyStr(next) !== keyStr(cur)) colNodes.push({ keys: cur, level: lvl });
      }
    }
    colNodes.push({ keys: [], level: 0 });
  }

  const parts: ('v' | 'c' | 'd')[] = hasCmp ? ['v', 'c', 'd'] : ['v'];
  const oneMeasure = nCols > 0 && res.measures.length === 1;
  const cols: GridCol[] = [];
  for (const node of colNodes)
    res.measures.forEach((m, mi) =>
      parts.forEach((part) => {
        const colLabels = node.keys.map((k, i) => lab(rDims + i, k));
        const path =
          nCols === 0
            ? []
            : node.level === 0
              ? [L.total]
              : node.level < nCols
                ? [...colLabels.slice(0, -1), L.totalOf(colLabels[colLabels.length - 1]!)]
                : colLabels;
        // Один показатель при полях в столбцах — его имя не повторяется под каждым столбцом.
        const header = oneMeasure ? [...path] : [...path, m.label];
        if (hasCmp) header.push(part === 'v' ? L.cur : part === 'c' ? L.cmp : L.delta);
        cols.push({
          id: `${node.level}|${keyStr(node.keys)}|${mi}|${part}`,
          measure: mi,
          part,
          colKeys: node.keys,
          colLevel: node.level,
          format: part === 'd' ? 'pct' : m.format,
          header,
        });
      }),
    );

  // Шапка: уровни столбцов (короткий путь подытога занимает оставшиеся уровни по высоте) + показатель
  // (+ вариант сравнения). Соседние ячейки с одинаковым путём объединяются по ширине.
  const tailLen = (hasCmp ? 1 : 0) + (oneMeasure ? 0 : 1);
  const depth = nCols + tailLen;
  const head: Grid['head'] = [];
  for (let d = 0; d < depth; d++) {
    const row: Grid['head'][number] = [];
    let prevIdent: string | null = null;
    for (const c of cols) {
      const pl = c.header.length - tailLen;
      let text: string;
      let rowSpan = 1;
      if (d < nCols) {
        if (d >= pl) {
          prevIdent = null;
          continue;
        }
        text = c.header[d]!;
        if (d === pl - 1) rowSpan = nCols - pl + 1;
      } else text = c.header[pl + d - nCols]!;
      const upto = d < nCols ? d + 1 : pl + d - nCols + 1;
      const ident = `${rowSpan}|${c.header.slice(0, upto).join(SEP)}`;
      const last = row[row.length - 1];
      if (last && ident === prevIdent && d < depth - 1) last.span++;
      else row.push({ text, span: 1, rowSpan, colId: d === depth - 1 ? c.id : undefined });
      prevIdent = ident;
    }
    head.push(row);
  }

  // Строки.
  const valueOf = (rl: number, rk: (string | null)[], c: GridCol): number | null => {
    const r = cell.get(`${rl}|${keyStr(rk)}|${c.colLevel}|${keyStr(c.colKeys)}`);
    if (!r) return null;
    if (c.part === 'v') return r.v[c.measure] ?? null;
    if (c.part === 'c') return r.c?.[c.measure] ?? null;
    return deltaPct(r.v[c.measure], r.c?.[c.measure]);
  };
  const leafRows = new Map<string, (string | null)[]>();
  for (const r of res.rows)
    if (levelOf(r.g, 0, rDims) === rDims && rDims > 0)
      leafRows.set(keyStr(r.k.slice(0, rDims)), r.k.slice(0, rDims));
  const rcmps = res.dims.slice(0, rDims).map((d, i) => cmpBy(d.sort, (k) => lab(i, k)));
  const sortCol = sort ? cols.find((c) => c.id === sort.col) : undefined;
  // Сортировка по столбцу — внутри каждой группы (по значению группы на своём уровне).
  const byValue = (va: number | null, vb: number | null) => {
    if (va === vb) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return sort!.dir === 'asc' ? va - vb : vb - va;
  };
  const cmpRows = (a: (string | null)[], b: (string | null)[]) => {
    // Прямая таблица: подытогов нет — сортировка по значению строки целиком.
    if (view === 'flat' && sortCol) {
      const c = byValue(valueOf(rDims, a, sortCol), valueOf(rDims, b, sortCol));
      if (c) return c;
    }
    for (let i = 0; i < rDims; i++) {
      if (a[i] === b[i]) continue;
      if (sortCol && view === 'cross') {
        const c = byValue(
          valueOf(i + 1, a.slice(0, i + 1), sortCol),
          valueOf(i + 1, b.slice(0, i + 1), sortCol),
        );
        if (c) return c;
      }
      const c = rcmps[i]!(a[i]!, b[i]!);
      if (c) return c;
    }
    return 0;
  };
  const leaves = [...leafRows.values()].sort(cmpRows);
  const rows: GridRow[] = [];
  const rowValues = (rl: number, rk: (string | null)[]) => cols.map((c) => valueOf(rl, rk, c));
  const blank = (n: number) => Array<string>(n).fill('');
  if (view === 'flat') {
    for (const k of leaves)
      rows.push({
        id: `L${keyStr(k)}`,
        kind: 'leaf',
        level: rDims,
        labels: k.map((x, i) => lab(i, x)),
        cells: rowValues(rDims, k),
        hasChildren: false,
        parents: [],
      });
  } else {
    // Группы уровней 1…rDims-1 — строка с подытогом перед детьми (сворачивается щелчком).
    let prev: (string | null)[] | null = null;
    for (const k of leaves) {
      const parents: string[] = [];
      for (let lvl = 1; lvl < rDims; lvl++) {
        const gk = k.slice(0, lvl);
        const gid = `G${lvl}|${keyStr(gk)}`;
        if (!prev || keyStr(prev.slice(0, lvl)) !== keyStr(gk)) {
          const labels = blank(rDims);
          labels[lvl - 1] = lab(lvl - 1, gk[lvl - 1]!);
          rows.push({
            id: gid,
            kind: 'group',
            level: lvl,
            labels,
            cells: rowValues(lvl, gk),
            hasChildren: true,
            parents: [...parents],
          });
        }
        parents.push(gid);
      }
      const labels = blank(rDims);
      labels[rDims - 1] = lab(rDims - 1, k[rDims - 1]!);
      rows.push({
        id: `L${keyStr(k)}`,
        kind: 'leaf',
        level: rDims,
        labels,
        cells: rowValues(rDims, k),
        hasChildren: false,
        parents,
      });
      prev = k;
    }
  }
  // Общий итог — если сервер посчитал набор без полей строк.
  const totalCells = rowValues(0, []);
  if (totalCells.some((v) => v !== null) || rDims === 0) {
    const labels = blank(Math.max(rDims, 1));
    labels[0] = L.total;
    rows.push({
      id: 'T',
      kind: 'total',
      level: 0,
      labels,
      cells: totalCells,
      hasChildren: false,
      parents: [],
    });
  }
  const rowHeaders = res.dims.slice(0, rDims).map((d) => d.label);
  return { rowHeaders: rowHeaders.length ? rowHeaders : [''], head, cols, rows };
}

/** Листья для графиков: категория (поля строк), серия (поля столбцов) и значения. */
export function chartData(res: Result, nRows: number) {
  const nDims = res.dims.length;
  const leaves = res.rows.filter((r) => r.g === 0);
  const maps = labelMapsOf(res);
  const lab = (i: number, k: string | null) => (k === null ? '—' : (maps[i]!.get(k) ?? k));
  const cmps = res.dims.map((d, i) => cmpBy(d.sort, (k) => lab(i, k)));
  const collect = (from: number, to: number) => {
    const m = new Map<string, (string | null)[]>();
    for (const r of leaves) m.set(keyStr(r.k.slice(from, to)), r.k.slice(from, to));
    return [...m.entries()]
      .sort((a, b) => {
        for (let i = 0; i < to - from; i++) {
          const c = cmps[from + i]!(a[1][i]!, b[1][i]!);
          if (c) return c;
        }
        return 0;
      })
      .map(([key, keys]) => ({ key, label: keys.map((k, i) => lab(from + i, k)).join(' / ') }));
  };
  const index = new Map<string, ResultRow>();
  for (const r of leaves) index.set(`${keyStr(r.k.slice(0, nRows))}|${keyStr(r.k.slice(nRows))}`, r);
  return {
    categories: collect(0, nRows),
    series: collect(nRows, nDims),
    value(cat: string, ser: string, m: number, part: 'v' | 'c' = 'v'): number | null {
      const r = index.get(`${cat}|${ser}`);
      if (!r) return null;
      return part === 'v' ? (r.v[m] ?? null) : (r.c?.[m] ?? null);
    },
  };
}

/** Запрос на сервер из настроек (подписи значений фильтров не отправляются). */
export function toQuery(c: Config) {
  const cmp = compareRange(c);
  return {
    rows: c.view === 'flat' ? [...c.rows, ...c.cols] : c.rows,
    cols: c.view === 'flat' ? [] : c.cols,
    values: c.values,
    filters: c.filters
      .filter((f) => f.values.length || (f.measure && f.op && f.value !== undefined))
      .map((f) =>
        f.measure && f.op && f.value !== undefined
          ? { field: f.field, mode: 'in' as const, values: [], measure: f.measure, op: f.op, value: f.value }
          : { field: f.field, mode: f.mode, values: f.values },
      ),
    from: c.from,
    to: c.to,
    grain: c.grain,
    compare: cmp,
    subtotals: c.view === 'cross',
  };
}
