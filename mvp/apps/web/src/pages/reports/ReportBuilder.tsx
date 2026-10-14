import './pivot.css';
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  Menu,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconChartArea,
  IconChartBar,
  IconChartHistogram,
  IconChartLine,
  IconChartPie,
  IconClock,
  IconDeviceFloppy,
  IconEraser,
  IconFileSpreadsheet,
  IconFolderOpen,
  IconChevronDown,
  IconChevronUp,
  IconTextWrap,
  IconGridDots,
  IconLayoutGrid,
  IconStack2,
  IconTable,
  IconTrash,
} from '@tabler/icons-react';
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { del, errorText, get, post, postAbortable, postBlob, put } from '../../lib/api';
import { useAction } from '../../lib/data';
import { pref } from '../../lib/pref';
import { t } from '../../lib/i18n';
import { type DragItem, type DropTarget, PivotDnd } from './pivotDnd';
import {
  buildGrid,
  type Catalog,
  CHART_VIEWS,
  compareRange,
  type Config,
  type Estimate,
  excelValue,
  type Filter,
  PRESETS,
  presetRange,
  type Result,
  type RunResponse,
  ruDate,
  toQuery,
  type ViewKind,
} from './pivotModel';
import { FieldCatalog, FilterPopover, filterSummary, ZoneBox } from './PivotParts';
import { PivotTable } from './PivotTable';
import { StationLassoMap } from './StationLassoMap';
import { useCompactMenu } from '../../lib/focus';

const PivotChart = lazy(() => import('./PivotChart'));

const STORE_KEY = 'cc.pivot.config.v1';

interface SavedView {
  id: string;
  name: string;
  isShared: boolean;
  config: Partial<Config>;
  mine: boolean;
  ownerName: string | null;
}

const base = (p: string): Pick<Config, 'preset' | 'from' | 'to'> => ({ preset: p, ...presetRange(p) });

/** Готовые образцы (можно открыть и доработать). */
const TEMPLATES: { id: string; config: () => Partial<Config> }[] = [
  {
    id: 'channelsByMonth',
    config: () => ({
      rows: ['conv.channel'],
      cols: ['time.period'],
      values: ['conv.count'],
      grain: 'month',
      view: 'cross',
      ...base('year'),
    }),
  },
  {
    id: 'slByDay',
    config: () => ({
      rows: ['time.period'],
      cols: [],
      values: ['conv.count', 'conv.sl', 'conv.missedPct'],
      grain: 'day',
      view: 'combo',
      ...base('d30'),
    }),
  },
  {
    id: 'operators',
    config: () => ({
      rows: ['staff.operator'],
      cols: [],
      values: ['conv.answered', 'conv.handleAvg', 'staff.worked', 'staff.shifts', 'csat.avg'],
      view: 'flat',
      ...base('month'),
    }),
  },
  {
    id: 'secondLine',
    config: () => ({
      rows: ['org.enterprise'],
      cols: [],
      values: ['ticket.count', 'ticket.inTimePct', 'ticket.overdue'],
      view: 'flat',
      ...base('quarter'),
    }),
  },
  {
    id: 'topics',
    config: () => ({ rows: ['topic.l1'], cols: [], values: ['conv.count'], view: 'pie', ...base('month') }),
  },
  {
    id: 'callsHeat',
    config: () => ({
      rows: ['time.hour'],
      cols: ['time.weekday'],
      values: ['call.count'],
      view: 'heatmap',
      ...base('d30'),
    }),
  },
  {
    id: 'stations',
    config: () => ({
      rows: ['obj.station'],
      cols: [],
      values: ['conv.count', 'csat.avg', 'review.count'],
      view: 'flat',
      sort: null,
      ...base('quarter'),
    }),
  },
  {
    id: 'csat',
    config: () => ({
      rows: ['time.period'],
      cols: [],
      values: ['csat.avg', 'csat.count'],
      grain: 'month',
      view: 'combo',
      compare: 'year',
      ...base('year'),
    }),
  },
];

const DEFAULT: Config = {
  rows: ['conv.channel'],
  cols: [],
  values: ['conv.count'],
  filters: [],
  ...base('d30'),
  grain: 'day',
  compare: 'none',
  view: 'cross',
  subtotals: true,
  sort: null,
};

function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const c = { ...DEFAULT, ...(JSON.parse(raw) as Partial<Config>) };
      // Быстрый период пересчитывается на сегодня (вчерашние «последние 30 дней» — уже не те).
      return c.preset ? { ...c, ...presetRange(c.preset) } : c;
    }
  } catch {
    /* хранилище браузера недоступно — начинаем с образца */
  }
  return DEFAULT;
}

const VIEW_ICONS: Record<ViewKind, ReactNode> = {
  flat: <IconTable size={18} />,
  cross: <IconLayoutGrid size={18} />,
  bar: <IconChartBar size={18} />,
  stacked: <IconStack2 size={18} />,
  hbar: <IconChartBar size={18} style={{ transform: 'rotate(90deg) scaleY(-1)' }} />,
  line: <IconChartLine size={18} />,
  area: <IconChartArea size={18} />,
  combo: <IconChartHistogram size={18} />,
  pie: <IconChartPie size={18} />,
  heatmap: <IconGridDots size={18} />,
};

const fmtN = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${t.pivot.mln}`
    : Math.round(n).toLocaleString('ru-RU');

/**
 * Д-041. Конструктор отчётов: каталог полей и показателей → зоны «Фильтры / Строки / Столбцы / Значения» →
 * таблица или график. Лёгкие отчёты строятся сразу при изменении; сложные — после предупреждения с оценкой.
 */
export function ReportBuilder() {
  useCompactMenu();
  const catalog = useQuery({
    queryKey: ['/reports/pivot/model'],
    queryFn: () => get<Catalog>('/reports/pivot/model'),
    staleTime: 5 * 60_000,
  });
  const [cfg, setCfg] = useState<Config>(loadConfig);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState<{ key: string; estimate: Estimate } | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [mapFor, setMapFor] = useState<string | null>(null);
  const [current, setCurrent] = useState<SavedView | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [toDelete, setToDelete] = useState<SavedView | null>(null);
  const [excelBusy, setExcelBusy] = useState(false);
  // Д-051: свернуть каталог и настройки (зоны, период) — больше места таблице; запоминается в браузере.
  const [catCollapsed, setCatCollapsed] = useState<boolean>(() => pref.get('cc.pivot.catCollapsed', false));
  const [setupCollapsed, setSetupCollapsed] = useState<boolean>(() =>
    pref.get('cc.pivot.setupCollapsed', false),
  );
  const collapseCat = (v: boolean) => {
    setCatCollapsed(v);
    pref.set('cc.pivot.catCollapsed', v);
  };
  const collapseSetup = (v: boolean) => {
    setSetupCollapsed(v);
    pref.set('cc.pivot.setupCollapsed', v);
  };
  const abort = useRef<AbortController | null>(null);
  // Окно фильтра, открытое после переноса поля, не закрывается «щелчком снаружи» от того же переноса.
  const openedAt = useRef(0);
  const showFilter = useCallback((field: string | null) => {
    openedAt.current = Date.now();
    setOpenFilter(field);
  }, []);
  useEffect(() => {
    if (!openFilter) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenFilter(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [openFilter]);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
    } catch {
      /* хранилище недоступно — настройки просто не запомнятся */
    }
  }, [cfg]);

  const cat = catalog.data;
  const dimById = useMemo(() => new Map((cat?.dims ?? []).map((d) => [d.id, d])), [cat]);
  const measureById = useMemo(() => new Map((cat?.measures ?? []).map((m) => [m.id, m])), [cat]);
  // Поля и показатели, которых нет в каталоге (удалены), из сохранённых настроек убираются.
  const known = useMemo(() => {
    if (!cat) return cfg;
    return {
      ...cfg,
      rows: cfg.rows.filter((d) => dimById.has(d)),
      cols: cfg.cols.filter((d) => dimById.has(d)),
      values: cfg.values.filter((m) => measureById.has(m)),
      filters: cfg.filters.filter((f) => dimById.has(f.field)),
    };
  }, [cat, cfg, dimById, measureById]);
  const query = useMemo(() => toQuery(known), [known]);
  const queryKey = JSON.stringify(query);
  const isChart = CHART_VIEWS.includes(cfg.view);

  // Построение: через 350 мс после последнего изменения; прежний запрос отменяется (и в базе тоже).
  useEffect(() => {
    if (!cat || !query.values.length) {
      setResult(null);
      setPending(null);
      setError(null);
      return;
    }
    const confirm = confirmKey === queryKey;
    const timer = setTimeout(() => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setBusy(true);
      setError(null);
      postAbortable<RunResponse>('/reports/pivot/run', { query, confirm }, ac.signal)
        .then((r) => {
          if (ac.signal.aborted) return;
          if (r.needConfirm) {
            setPending({ key: queryKey, estimate: r.estimate });
          } else {
            setPending(null);
            setResult(r);
          }
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted || (e as { name?: string }).name === 'AbortError') return;
          setError(errorText(e));
        })
        .finally(() => {
          if (!ac.signal.aborted) setBusy(false);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [queryKey, confirmKey, cat]);
  useEffect(() => () => abort.current?.abort(), []);

  const update = useCallback((fn: (c: Config) => Config) => setCfg((c) => fn(c)), []);
  const set = <K extends keyof Config>(k: K, v: Config[K]) => update((c) => ({ ...c, [k]: v }));

  // ---------------------------------------------------------------- перетаскивание
  const onDrop = (item: DragItem, target: DropTarget | null, index: number) => {
    update((c) => {
      if (target === null) return c;
      const next: Config = {
        ...c,
        rows: [...c.rows],
        cols: [...c.cols],
        values: [...c.values],
        filters: [...c.filters],
      };
      let movedFilter: Filter | undefined;
      if (item.from) {
        if (item.from.zone === 'filters') movedFilter = next.filters.splice(item.from.index, 1)[0];
        else next[item.from.zone].splice(item.from.index, 1);
      }
      if (target === 'catalog') return item.from ? next : c;
      const ins = <T,>(list: T[], v: T) => list.splice(Math.max(0, Math.min(index, list.length)), 0, v);
      if (target === 'filters') {
        if (item.kind !== 'dim') return c;
        if (movedFilter) ins(next.filters, movedFilter);
        else if (!next.filters.some((f) => f.field === item.id)) {
          ins(next.filters, { field: item.id, mode: 'in', values: [] });
          setTimeout(() => showFilter(item.id), 50);
        } else if (!item.from) return c;
        return next;
      }
      if (target === 'rows' || target === 'cols') {
        if (item.kind !== 'dim') return c;
        next.rows = next.rows.filter((x) => x !== item.id);
        next.cols = next.cols.filter((x) => x !== item.id);
        ins(next[target], item.id);
        return next;
      }
      if (item.kind !== 'measure') return c;
      next.values = next.values.filter((x) => x !== item.id);
      ins(next.values, item.id);
      return next;
    });
  };
  const addFromCatalog = (item: DragItem) =>
    update((c) =>
      item.kind === 'dim'
        ? c.rows.includes(item.id) || c.cols.includes(item.id)
          ? c
          : { ...c, rows: [...c.rows, item.id] }
        : c.values.includes(item.id)
          ? c
          : { ...c, values: [...c.values, item.id] },
    );

  const setFilter = (field: string, f: Filter) =>
    update((c) => ({ ...c, filters: c.filters.map((x) => (x.field === field ? f : x)) }));

  // ---------------------------------------------------------------- сохранённые отчёты
  const views = useQuery({
    queryKey: ['/reports/pivot/views'],
    queryFn: () => get<SavedView[]>('/reports/pivot/views'),
  });
  const saveView = useAction(async (a: { id?: string; name: string; isShared: boolean }) => {
    const body = { name: a.name, isShared: a.isShared, config: cfg as unknown as Record<string, unknown> };
    const r = a.id
      ? await put<{ id: string }>(`/reports/pivot/views/${a.id}`, body)
      : await post<{ id: string }>('/reports/pivot/views', body);
    setCurrent({ id: r.id, name: a.name, isShared: a.isShared, config: cfg, mine: true, ownerName: null });
    setSaveOpen(false);
    return r;
  }, t.pivot.savedOk);
  const deleteView = useAction(async (v: SavedView) => {
    await del(`/reports/pivot/views/${v.id}`);
    if (current?.id === v.id) setCurrent(null);
    setToDelete(null);
  }, t.pivot.deleted);
  const openConfig = (c: Partial<Config>, view: SavedView | null) => {
    const merged = { ...DEFAULT, filters: [], cols: [], sort: null, compare: 'none' as const, ...c };
    setCfg(merged.preset ? { ...merged, ...presetRange(merged.preset) } : merged);
    setCurrent(view);
    setConfirmKey(null);
  };

  // ---------------------------------------------------------------- Excel
  const gridLabels = {
    empty: t.pivot.empty,
    total: t.pivot.total,
    totalOf: t.pivot.totalOf,
    cmp: t.pivot.cmpShort,
    delta: t.pivot.delta,
    cur: t.pivot.current,
  };
  const grid = useMemo(() => {
    if (!result) return null;
    const tableView = cfg.view === 'cross' && !isChart ? 'cross' : 'flat';
    return buildGrid(
      result,
      tableView === 'cross' ? known.rows.length : result.dims.length,
      tableView,
      gridLabels,
      cfg.sort,
    );
  }, [result, cfg.view, cfg.sort, isChart]);

  const excel = async () => {
    if (!grid || !result) return;
    setExcelBusy(true);
    try {
      const title = current?.name ?? t.pivot.reports;
      const header = [...grid.rowHeaders, ...grid.cols.map((c) => c.header.filter(Boolean).join(' / '))];
      const rows = grid.rows.map((r) => [
        ...r.labels,
        ...r.cells.map((v, i) => excelValue(v, grid.cols[i]!.format)),
      ]);
      const blob = await postBlob('/reports/pivot/xlsx', { title, header, rows });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title} ${ruDate(result.period.from)}-${ruDate(result.period.to)}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notifications.show({ color: 'green', message: t.pivot.excelOk });
    } catch (e) {
      notifications.show({ color: 'red', title: t.error, message: errorText(e), autoClose: 8000 });
    } finally {
      setExcelBusy(false);
    }
  };

  if (catalog.isLoading) return <Loader size="sm" />;
  if (catalog.isError || !cat) return <Alert color="red">{errorText(catalog.error)}</Alert>;

  const used = new Set([...cfg.rows, ...cfg.cols, ...cfg.values]);
  const dimsInUse = [...known.rows, ...known.cols];
  const incompatible = (mid: string) => {
    const m = measureById.get(mid);
    return !!m && dimsInUse.some((d) => !dimById.get(d)?.facts.includes(m.fact));
  };
  const cmp = compareRange(cfg);
  const mapFilter = mapFor ? cfg.filters.find((f) => f.field === mapFor) : undefined;

  const dimChips = (zone: 'rows' | 'cols') =>
    known[zone].map((id) => ({ id, label: dimById.get(id)!.label }));

  return (
    <PivotDnd onDrop={onDrop}>
      <div className={`pivot-layout${catCollapsed ? ' pivot-layout-mini' : ''}`}>
        <FieldCatalog
          catalog={cat}
          used={used}
          onAdd={addFromCatalog}
          collapsed={catCollapsed}
          onCollapse={collapseCat}
        />
        <Stack gap={10} style={{ minWidth: 0 }}>
          {/* Действия и вид */}
          <Group justify="space-between" gap="xs">
            <Group gap={6}>
              <Menu shadow="md" width={320} position="bottom-start">
                <Menu.Target>
                  <Button
                    variant="light"
                    size="xs"
                    leftSection={<IconFolderOpen size={16} />}
                    data-testid="pivot-open"
                  >
                    {current ? current.name : t.pivot.reports}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>{t.pivot.templates}</Menu.Label>
                  {TEMPLATES.map((tp) => (
                    <Menu.Item
                      key={tp.id}
                      onClick={() => openConfig(tp.config(), null)}
                      data-testid={`pivot-tpl-${tp.id}`}
                    >
                      {t.pivot.tpl[tp.id]}
                    </Menu.Item>
                  ))}
                  <Menu.Divider />
                  <Menu.Label>{t.pivot.myReports}</Menu.Label>
                  {(views.data ?? []).filter((v) => v.mine).length === 0 && (
                    <Menu.Item disabled>{t.pivot.noSaved}</Menu.Item>
                  )}
                  {(views.data ?? [])
                    .filter((v) => v.mine)
                    .map((v) => (
                      <Menu.Item
                        key={v.id}
                        onClick={() => openConfig(v.config, v)}
                        rightSection={
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            color="red"
                            aria-label={t.pivot.deleteReport}
                            onClick={(e) => {
                              e.stopPropagation();
                              setToDelete(v);
                            }}
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        }
                      >
                        {v.name}
                      </Menu.Item>
                    ))}
                  {(views.data ?? []).some((v) => !v.mine) && (
                    <>
                      <Menu.Divider />
                      <Menu.Label>{t.pivot.sharedReports}</Menu.Label>
                      {(views.data ?? [])
                        .filter((v) => !v.mine)
                        .map((v) => (
                          <Menu.Item key={v.id} onClick={() => openConfig(v.config, v)}>
                            <Text size="sm">{v.name}</Text>
                            {v.ownerName && (
                              <Text size="xs" c="dimmed">
                                {t.pivot.author(v.ownerName)}
                              </Text>
                            )}
                          </Menu.Item>
                        ))}
                    </>
                  )}
                </Menu.Dropdown>
              </Menu>
              <Button
                variant="default"
                size="xs"
                leftSection={<IconDeviceFloppy size={16} />}
                onClick={() => setSaveOpen(true)}
                disabled={!cfg.values.length}
                data-testid="pivot-save"
              >
                {t.pivot.save}
              </Button>
              <Button
                variant="default"
                size="xs"
                leftSection={<IconFileSpreadsheet size={16} />}
                onClick={() => void excel()}
                loading={excelBusy}
                disabled={!grid}
                data-testid="pivot-excel"
              >
                {t.pivot.excel}
              </Button>
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                leftSection={<IconEraser size={16} />}
                onClick={() => {
                  setCfg({ ...cfg, rows: [], cols: [], values: [], filters: [], sort: null });
                  setCurrent(null);
                }}
                data-testid="pivot-clear"
              >
                {t.pivot.clear}
              </Button>
            </Group>
            <Group gap={6} wrap="nowrap">
              {/* Д-053: длинные подписи — сокращать, переносить или полностью */}
              <Tooltip label={t.pivot.textModeHint} withArrow openDelay={200}>
                <Select
                  size="xs"
                  w={136}
                  leftSection={<IconTextWrap size={14} />}
                  data={(['full', 'cut', 'wrap'] as const).map((v) => ({
                    value: v,
                    label: t.pivot.textModes[v],
                  }))}
                  value={cfg.textMode ?? 'full'}
                  onChange={(v) => set('textMode', (v ?? 'full') as Config['textMode'])}
                  allowDeselect={false}
                  aria-label={t.pivot.textModeHint}
                  data-testid="pivot-text"
                />
              </Tooltip>
              <Tooltip label={setupCollapsed ? t.pivot.setupShow : t.pivot.setupHide} withArrow>
                <ActionIcon
                  variant="light"
                  color="gray"
                  size="lg"
                  onClick={() => collapseSetup(!setupCollapsed)}
                  aria-label={setupCollapsed ? t.pivot.setupShow : t.pivot.setupHide}
                  data-testid="pivot-setup-toggle"
                >
                  {setupCollapsed ? <IconChevronDown size={18} /> : <IconChevronUp size={18} />}
                </ActionIcon>
              </Tooltip>
            </Group>
            <Group gap={2} data-testid="pivot-views">
              {(Object.keys(VIEW_ICONS) as ViewKind[]).map((v) => (
                <Tooltip key={v} label={t.pivot.views[v]} withArrow openDelay={200}>
                  <ActionIcon
                    variant={cfg.view === v ? 'filled' : 'subtle'}
                    color={cfg.view === v ? 'blue' : 'gray'}
                    size="lg"
                    aria-label={t.pivot.views[v]}
                    onClick={() => set('view', v)}
                    data-testid={`pivot-view-${v}`}
                  >
                    {VIEW_ICONS[v]}
                  </ActionIcon>
                </Tooltip>
              ))}
            </Group>
          </Group>

          {/* Период, шаг, сравнение (Д-051: в одну строку, подписи «с»/«по» слева; сравнение — флажком, своя строка
              только при включённом сравнении). Свёрнутые настройки — одна строка-сводка. */}
          {setupCollapsed ? (
            <button
              type="button"
              className="pivot-setup-summary"
              onClick={() => collapseSetup(false)}
              title={t.pivot.setupShow}
              data-testid="pivot-setup-summary"
            >
              <span>
                {ruDate(cfg.from)} — {ruDate(cfg.to)} · {t.pivot.grains[cfg.grain]}
              </span>
              {(
                [
                  [t.pivot.zoneRows, known.rows.map((id) => dimById.get(id)!.label)],
                  [t.pivot.zoneCols, known.cols.map((id) => dimById.get(id)!.label)],
                  [t.pivot.zoneValues, known.values.map((id) => measureById.get(id)!.label)],
                  [t.pivot.zoneFilters, known.filters.map((f) => dimById.get(f.field)!.label)],
                ] as const
              )
                .filter(([, l]) => l.length > 0)
                .map(([title, l]) => (
                  <span key={title}>
                    <b>{title}:</b> {l.join(', ')}
                  </span>
                ))}
            </button>
          ) : (
            <>
              <Group gap="xs" align="center" wrap="wrap">
                <Select
                  size="xs"
                  w={170}
                  aria-label={t.pivot.period}
                  data={PRESETS.map((p) => ({ value: p, label: t.pivot.presets[p]! }))}
                  value={cfg.preset}
                  placeholder={t.pivot.period}
                  onChange={(p) =>
                    update((c) => (p ? { ...c, preset: p, ...presetRange(p) } : { ...c, preset: null }))
                  }
                  clearable
                  data-testid="pivot-preset"
                />
                <Group gap={4} wrap="nowrap">
                  <Text size="xs">{t.pivot.fromLower}</Text>
                  <TextInput
                    size="xs"
                    type="date"
                    aria-label={t.pivot.from}
                    value={cfg.from}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      if (v) update((c) => ({ ...c, from: v, preset: null }));
                    }}
                    data-testid="pivot-from"
                  />
                  <Text size="xs">{t.pivot.toLower}</Text>
                  <TextInput
                    size="xs"
                    type="date"
                    aria-label={t.pivot.to}
                    value={cfg.to}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      if (v) update((c) => ({ ...c, to: v, preset: null }));
                    }}
                    data-testid="pivot-to"
                  />
                </Group>
                <Tooltip label={t.pivot.grainHint} withArrow multiline w={260} openDelay={300}>
                  <Select
                    size="xs"
                    w={110}
                    aria-label={t.pivot.grain}
                    data={Object.entries(t.pivot.grains).map(([value, label]) => ({ value, label }))}
                    value={cfg.grain}
                    onChange={(v) => v && set('grain', v as Config['grain'])}
                    allowDeselect={false}
                    data-testid="pivot-grain"
                  />
                </Tooltip>
                <Checkbox
                  size="xs"
                  label={t.pivot.compareOn}
                  checked={cfg.compare !== 'none'}
                  onChange={(e) => set('compare', e.currentTarget.checked ? 'prev' : 'none')}
                  data-testid="pivot-compare-on"
                />
              </Group>
              {cfg.compare !== 'none' && (
                <Group gap="xs" align="center" className="cc-reveal" data-testid="pivot-compare-row">
                  <Text size="xs">{t.pivot.compare}</Text>
                  <Select
                    size="xs"
                    w={210}
                    aria-label={t.pivot.compare}
                    data={Object.entries(t.pivot.compares)
                      .filter(([value]) => value !== 'none')
                      .map(([value, label]) => ({ value, label }))}
                    value={cfg.compare}
                    onChange={(v) => v && set('compare', v as Config['compare'])}
                    allowDeselect={false}
                    data-testid="pivot-compare"
                  />
                  {cfg.compare === 'custom' && (
                    <Group gap={4} wrap="nowrap">
                      <Text size="xs">{t.pivot.fromLower}</Text>
                      <TextInput
                        size="xs"
                        type="date"
                        aria-label={t.pivot.from}
                        value={cfg.compareFrom ?? ''}
                        onChange={(e) => set('compareFrom', e.currentTarget.value)}
                        data-testid="pivot-compare-from"
                      />
                      <Text size="xs">{t.pivot.toLower}</Text>
                      <TextInput
                        size="xs"
                        type="date"
                        aria-label={t.pivot.to}
                        value={cfg.compareTo ?? ''}
                        onChange={(e) => set('compareTo', e.currentTarget.value)}
                        data-testid="pivot-compare-to"
                      />
                    </Group>
                  )}
                  {cmp && cfg.compare !== 'custom' && (
                    <Text size="xs" c="dimmed">
                      {ruDate(cmp.from)} — {ruDate(cmp.to)}
                    </Text>
                  )}
                </Group>
              )}
            </>
          )}

          {/* Зоны (Д-051: в одну строку — строки, столбцы, значения, фильтры) */}
          <div className="pivot-zones" hidden={setupCollapsed}>
            <ZoneBox
              zone="rows"
              title={t.pivot.zoneRows}
              empty={t.pivot.zoneRowsEmpty}
              kind="dim"
              chips={dimChips('rows')}
              onRemove={(i) => update((c) => ({ ...c, rows: c.rows.filter((_, j) => j !== i) }))}
            />
            <ZoneBox
              zone="cols"
              title={t.pivot.zoneCols}
              empty={t.pivot.zoneColsEmpty}
              kind="dim"
              chips={dimChips('cols')}
              onRemove={(i) => update((c) => ({ ...c, cols: c.cols.filter((_, j) => j !== i) }))}
            />
            <ZoneBox
              zone="values"
              title={t.pivot.zoneValues}
              empty={t.pivot.zoneValuesEmpty}
              kind="measure"
              chips={known.values.map((id) => ({
                id,
                label: measureById.get(id)!.label,
                warn: incompatible(id) ? t.pivot.incompatible : undefined,
              }))}
              onRemove={(i) => update((c) => ({ ...c, values: c.values.filter((_, j) => j !== i) }))}
            />
            <ZoneBox
              zone="filters"
              title={t.pivot.zoneFilters}
              empty={t.pivot.zoneFiltersEmpty}
              kind="dim"
              onRemove={(i) => update((c) => ({ ...c, filters: c.filters.filter((_, j) => j !== i) }))}
              chips={known.filters.map((f) => {
                const dim = dimById.get(f.field)!;
                return {
                  id: f.field,
                  label: dim.label,
                  sub: filterSummary(f, cat.measures),
                  onClick: () => showFilter(openFilter === f.field ? null : f.field),
                  wrap: (chip: ReactNode) => (
                    <FilterPopover
                      dim={dim}
                      filter={f}
                      measures={cat.measures}
                      opened={openFilter === f.field}
                      onClose={() => {
                        if (Date.now() - openedAt.current > 400) setOpenFilter(null);
                      }}
                      onChange={(nf) => setFilter(f.field, nf)}
                      onMap={() => {
                        setOpenFilter(null);
                        setMapFor(f.field);
                      }}
                    >
                      {chip}
                    </FilterPopover>
                  ),
                };
              })}
            />
          </div>

          {/* Результат */}
          {!cfg.values.length && <Alert color="blue">{t.pivot.emptyHint}</Alert>}
          {pending && pending.key === queryKey && (
            <Alert
              color="orange"
              icon={<IconAlertTriangle size={18} />}
              title={t.pivot.heavyTitle}
              data-testid="pivot-heavy"
            >
              <Stack gap={6}>
                <Text size="sm">
                  {t.pivot.heavyText(
                    fmtN(pending.estimate.sourceRows),
                    fmtN(pending.estimate.groups),
                    pending.estimate.measures,
                    pending.estimate.periods,
                  )}
                </Text>
                <Group gap={6}>
                  <IconClock size={16} />
                  <Text size="sm" fw={600}>
                    {t.pivot.heavyTime(
                      pending.estimate.seconds.toLocaleString('ru-RU', { maximumFractionDigits: 1 }),
                      pending.estimate.timeoutSeconds,
                    )}
                  </Text>
                </Group>
                {pending.estimate.seconds > pending.estimate.timeoutSeconds && (
                  <Text size="sm" c="red">
                    {t.pivot.heavyLimit}
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  {t.pivot.heavyHint}
                </Text>
                <Group>
                  <Button
                    size="xs"
                    color="orange"
                    onClick={() => setConfirmKey(queryKey)}
                    data-testid="pivot-heavy-run"
                  >
                    {t.pivot.heavyRun}
                  </Button>
                </Group>
              </Stack>
            </Alert>
          )}
          {error && (
            <Alert color="red" data-testid="pivot-error">
              {error}
            </Alert>
          )}
          {result?.warnings.map((w) => (
            <Alert key={w} color="yellow" py={6}>
              <Text size="sm">{w}</Text>
            </Alert>
          ))}
          {/* Пока сложный отчёт ждёт подтверждения, прежний результат не показывается — он уже не про эти настройки. */}
          {result && cfg.values.length > 0 && !(pending && pending.key === queryKey) && (
            <div className={`pivot-busy${busy ? ' pivot-busy-on' : ''}`}>
              {isChart ? (
                <Suspense fallback={<Loader size="sm" />}>
                  <PivotChart
                    res={result}
                    nRows={Math.min(known.rows.length, result.dims.length)}
                    view={cfg.view}
                  />
                </Suspense>
              ) : (
                grid && (
                  <PivotTable
                    grid={grid}
                    sort={cfg.sort}
                    onSort={(s) => set('sort', s)}
                    textMode={cfg.textMode ?? 'full'}
                  />
                )
              )}
            </div>
          )}
          <Group gap={8}>
            {busy && (
              <>
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  {t.pivot.building}
                </Text>
              </>
            )}
            {!busy && result && (
              <Text size="xs" c="dimmed" data-testid="pivot-stats">
                {ruDate(result.period.from)} — {ruDate(result.period.to)}
                {result.compare
                  ? ` · ${t.pivot.compare.toLowerCase()} ${ruDate(result.compare.from)} — ${ruDate(result.compare.to)}`
                  : ''}
                {' · '}
                {t.pivot.built(result.ms, result.rows.filter((r) => r.g === 0).length)}
              </Text>
            )}
          </Group>
        </Stack>
      </div>

      <StationLassoMap
        opened={!!mapFor}
        value={mapFilter?.values ?? []}
        onClose={() => setMapFor(null)}
        onApply={(ids, labels) => {
          if (mapFor) setFilter(mapFor, { field: mapFor, mode: 'in', values: ids, labels });
          setMapFor(null);
        }}
      />
      <SaveModal
        opened={saveOpen}
        current={current}
        busy={saveView.isPending}
        onClose={() => setSaveOpen(false)}
        onSave={(a) => saveView.mutate(a)}
      />
      <Modal opened={!!toDelete} onClose={() => setToDelete(null)} title={t.pivot.deleteReport} size="sm">
        <Stack>
          <Text size="sm">{toDelete ? t.pivot.deleteConfirm(toDelete.name) : ''}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setToDelete(null)}>
              {t.cancel}
            </Button>
            <Button
              color="red"
              loading={deleteView.isPending}
              onClick={() => toDelete && deleteView.mutate(toDelete)}
            >
              {t.pivot.deleteReport}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </PivotDnd>
  );
}

function SaveModal({
  opened,
  current,
  busy,
  onClose,
  onSave,
}: {
  opened: boolean;
  current: SavedView | null;
  busy: boolean;
  onClose(): void;
  onSave(a: { id?: string; name: string; isShared: boolean }): void;
}) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (opened) {
      setName(current?.mine ? current.name : '');
      setShared(current?.mine ? current.isShared : false);
      setTried(false);
    }
  }, [opened, current]);
  const go = (id?: string) => {
    setTried(true);
    if (!name.trim()) {
      notifications.show({ color: 'red', message: `${t.pivot.name}: ${t.pivot.nameRequired}` });
      return;
    }
    onSave({ id, name: name.trim(), isShared: shared });
  };
  return (
    <Modal opened={opened} onClose={onClose} title={t.pivot.saveTitle} size="md">
      <Stack>
        <TextInput
          label={t.pivot.name}
          withAsterisk
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          error={tried && !name.trim() ? t.pivot.nameRequired : undefined}
          data-autofocus
          data-testid="pivot-save-name"
        />
        <Checkbox
          label={t.pivot.shared}
          checked={shared}
          onChange={(e) => setShared(e.currentTarget.checked)}
        />
        <Group justify="flex-end">
          {current?.mine && (
            <Button variant="default" loading={busy} onClick={() => go()}>
              {t.pivot.saveAs}
            </Button>
          )}
          <Button
            loading={busy}
            onClick={() => go(current?.mine ? current.id : undefined)}
            data-testid="pivot-save-ok"
          >
            {t.pivot.save}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
