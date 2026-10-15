import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Popover,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconCategory2,
  IconChevronDown,
  IconChevronRight,
  IconGripVertical,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMapPin,
  IconPlus,
  IconSearch,
  IconSum,
  IconX,
} from '@tabler/icons-react';
import { type ReactNode, useMemo, useState } from 'react';
import { get } from '../../lib/api';
import { t } from '../../lib/i18n';
import { type DragItem, useDnd, useDropZone } from './pivotDnd';
import type { Catalog, DimInfo, Filter, MeasureInfo, Zone } from './pivotModel';

/** Высота тела окна фильтра (одинаковая на обеих вкладках). */
const FILTER_BODY_H = 300;

const canon = (s: string) =>
  s.toLowerCase().replace(new RegExp(String.fromCharCode(0x451), 'g'), String.fromCharCode(0x435));

// ------------------------------------------------------------------ каталог

/**
 * Каталог слева: две вкладки — «Поля» и «Показатели» (Д-051), в каждой разделы свёрнуты. Тянуть — мышью за строку
 * или пальцем за ручку; «+» — добавить без перетаскивания. Поиск раскрывает разделы с совпадениями. Чип, брошенный
 * на каталог, убирается. Каталог сворачивается в узкую полосу — больше места отчёту.
 */
export function FieldCatalog({
  catalog,
  used,
  onAdd,
  collapsed,
  onCollapse,
}: {
  catalog: Catalog;
  used: Set<string>;
  onAdd(item: DragItem): void;
  collapsed: boolean;
  onCollapse(v: boolean): void;
}) {
  const { start } = useDnd();
  const drop = useDropZone('catalog', (i) => !!i.from);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'dim' | 'measure'>('dim');
  const words = canon(q).split(/\s+/).filter(Boolean);
  const match = (label: string) => words.every((w) => canon(label).includes(w));
  const all = catalog.sections.map((s) => ({
    ...s,
    dims: catalog.dims.filter((d) => d.section === s.id && match(d.label)),
    measures: catalog.measures.filter((m) => m.section === s.id && match(m.label)),
  }));
  const found = {
    dim: all.reduce((n, s) => n + s.dims.length, 0),
    measure: all.reduce((n, s) => n + s.measures.length, 0),
  };
  const sections = all.filter((s) => (kind === 'dim' ? s.dims : s.measures).length > 0);
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const item = (kind: 'dim' | 'measure', x: DimInfo | MeasureInfo) => {
    const di: DragItem = { kind, id: x.id, label: x.label };
    return (
      <div
        key={x.id}
        className={`pivot-item${used.has(x.id) ? ' pivot-used' : ''}`}
        title={x.hint ?? undefined}
        onPointerDown={(e) => start(e, di)}
        data-testid={`pivot-cat-${x.id}`}
      >
        <span className="pivot-handle" data-drag-handle>
          <IconGripVertical size={14} />
        </span>
        {kind === 'dim' ? (
          <IconCategory2 size={14} className="pivot-kind-dim" />
        ) : (
          <IconSum size={14} className="pivot-kind-measure" />
        )}
        <span>{x.label}</span>
        <ActionIcon
          className="pivot-add"
          size="xs"
          variant="subtle"
          data-no-drag
          aria-label={kind === 'dim' ? t.pivot.addToRows : t.pivot.addToValues}
          title={kind === 'dim' ? t.pivot.addToRows : t.pivot.addToValues}
          onClick={() => onAdd(di)}
        >
          <IconPlus size={14} />
        </ActionIcon>
      </div>
    );
  };

  if (collapsed)
    return (
      <div
        ref={drop.ref}
        className="pivot-catalog pivot-catalog-mini"
        data-testid="pivot-catalog"
        onClick={() => onCollapse(false)}
        title={t.pivot.catalogShow}
      >
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label={t.pivot.catalogShow}
          data-testid="pivot-cat-expand"
        >
          <IconLayoutSidebarLeftExpand size={16} />
        </ActionIcon>
        <span className="pivot-catalog-mini-label">{t.pivot.catalog}</span>
      </div>
    );
  return (
    <div
      ref={drop.ref}
      className={`pivot-catalog${drop.active?.accepted ? ' pivot-catalog-drop' : ''}`}
      data-testid="pivot-catalog"
    >
      <Stack gap={4} p={8} pb={4}>
        <Group justify="space-between" wrap="nowrap" gap={4}>
          <SegmentedControl
            size="xs"
            fullWidth
            style={{ flex: 1 }}
            value={kind}
            onChange={(v) => setKind(v as 'dim' | 'measure')}
            data={[
              {
                value: 'dim',
                label: words.length ? `${t.pivot.dims} · ${found.dim}` : t.pivot.dims,
              },
              {
                value: 'measure',
                label: words.length ? `${t.pivot.measures} · ${found.measure}` : t.pivot.measures,
              },
            ]}
            data-testid="pivot-cat-kind"
          />
          <Tooltip label={t.pivot.catalogHide} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={() => onCollapse(true)}
              aria-label={t.pivot.catalogHide}
              data-testid="pivot-cat-collapse"
            >
              <IconLayoutSidebarLeftCollapse size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <TextInput
          size="xs"
          leftSection={<IconSearch size={14} />}
          placeholder={t.pivot.catalogSearch}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          data-testid="pivot-cat-search"
        />
        <Text size="xs" c="dimmed">
          {kind === 'dim' ? t.pivot.catalogHintDims : t.pivot.catalogHintMeasures}
        </Text>
      </Stack>
      <div className="pivot-catalog-list">
        {sections.length === 0 && (
          <Text size="sm" c="dimmed" p={8}>
            {t.pivot.nothingFound}
          </Text>
        )}
        {sections.map((s) => {
          const isOpen = words.length > 0 || open.has(s.id);
          return (
            <div key={s.id}>
              <button
                type="button"
                className="pivot-section-head"
                onClick={() => toggle(s.id)}
                data-testid={`pivot-sec-${s.id}`}
              >
                {isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                <span style={{ flex: 1 }}>{s.label}</span>
                <Badge size="xs" variant="light" color="gray">
                  {(kind === 'dim' ? s.dims : s.measures).length}
                </Badge>
              </button>
              {isOpen && (
                <div className="pivot-section-body">
                  {kind === 'dim'
                    ? s.dims.map((d) => item('dim', d))
                    : s.measures.map((m) => item('measure', m))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ зоны

export interface ChipView {
  id: string;
  label: string;
  sub?: string;
  warn?: string;
  /** Обёртка чипа (например, всплывающее окно фильтра). */
  wrap?(chip: ReactNode): ReactNode;
  onClick?(): void;
}

export function ZoneBox({
  zone,
  title,
  empty,
  kind,
  chips,
  wide,
  onRemove,
  extra,
}: {
  zone: Zone;
  title: string;
  empty: string;
  kind: 'dim' | 'measure';
  chips: ChipView[];
  wide?: boolean;
  onRemove(index: number): void;
  extra?: ReactNode;
}) {
  const { start } = useDnd();
  const drop = useDropZone(zone, (i) => i.kind === kind);
  const ready = drop.dragging && drop.dragging.item.kind === kind;
  const cls = [
    'pivot-zone',
    wide ? 'pivot-zone-wide' : '',
    ready ? 'pivot-zone-ready' : '',
    drop.active ? (drop.active.accepted ? 'pivot-zone-over' : 'pivot-zone-bad') : '',
  ].join(' ');
  const chipCls =
    zone === 'values'
      ? 'pivot-chip pivot-chip-measure'
      : zone === 'filters'
        ? 'pivot-chip pivot-chip-filter'
        : 'pivot-chip';
  const draggingKey = drop.dragging?.item.from
    ? `${drop.dragging.item.from.zone}:${drop.dragging.item.from.index}`
    : null;
  return (
    // Д-083: принимает вся ячейка зоны (и её название), а не только полоса с чипами.
    <div ref={drop.ref} className={cls} data-testid={`pivot-zone-${zone}`}>
      <div className="pivot-zone-title">
        {title}
        {drop.active && !drop.active.accepted && (
          <Text span size="xs" c="red" fw={600} style={{ textTransform: 'none' }}>
            {kind === 'dim' ? t.pivot.onlyDims : t.pivot.onlyMeasures}
          </Text>
        )}
        {extra}
      </div>
      <div className="pivot-zone-chips">
        {chips.length === 0 && <span className="pivot-zone-empty">{empty}</span>}
        {chips.map((c, i) => {
          const key = `${zone}:${i}`;
          const chip = (
            <div
              key={key}
              data-pivot-chip={key}
              className={`${chipCls}${c.warn ? ' pivot-chip-warn' : ''}${draggingKey === key ? ' pivot-chip-dragging' : ''}`}
              title={c.warn ?? undefined}
              onPointerDown={(e) =>
                start(e, { kind, id: c.id, label: c.label, from: { zone, index: i } }, c.onClick)
              }
              data-testid={`pivot-chip-${zone}-${c.id}`}
            >
              <span className="pivot-chip-text">{c.label}</span>
              {c.sub && <span className="pivot-chip-sub">{c.sub}</span>}
              <ActionIcon
                size={18}
                radius="xl"
                variant="subtle"
                color="gray"
                data-no-drag
                aria-label={t.pivot.remove}
                title={t.pivot.remove}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(i);
                }}
              >
                <IconX size={12} />
              </ActionIcon>
            </div>
          );
          return c.wrap ? <span key={key}>{c.wrap(chip)}</span> : chip;
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ фильтр

const OPS = ['>', '>=', '<', '<=', '=', '!='];
const OP_LABEL: Record<string, string> = { '>': '>', '>=': '≥', '<': '<', '<=': '≤', '=': '=', '!=': '≠' };

/** Краткая подпись фильтра на чипе. */
export function filterSummary(f: Filter, measures: MeasureInfo[]): string {
  if (f.measure && f.op && f.value !== undefined) {
    const m = measures.find((x) => x.id === f.measure);
    return `${m?.label ?? f.measure} ${OP_LABEL[f.op] ?? f.op} ${f.value.toLocaleString('ru-RU')}`;
  }
  if (!f.values.length) return t.pivot.summaryAll;
  if (f.values.length === 1 && f.labels?.[0])
    return f.mode === 'out' ? `${t.pivot.summaryOut(1)}: ${f.labels[0]}` : f.labels[0];
  return f.mode === 'out' ? t.pivot.summaryOut(f.values.length) : t.pivot.summaryIn(f.values.length);
}

/** Окно фильтра: галочки значений с поиском («только» / «кроме»), выбор на карте, условие по показателю. */
export function FilterPopover({
  dim,
  filter,
  measures,
  opened,
  onClose,
  onApply,
  onChange,
  onMap,
  children,
}: {
  dim: DimInfo;
  filter: Filter;
  measures: MeasureInfo[];
  opened: boolean;
  onClose(): void;
  /** «Применить» — закрыть окно сразу (без защиты от «щелчка снаружи» сразу после открытия). */
  onApply(): void;
  onChange(f: Filter): void;
  onMap(): void;
  children: ReactNode;
}) {
  const hasCond = !!filter.measure;
  const [tab, setTab] = useState<'values' | 'cond'>(hasCond || !dim.hasValues ? 'cond' : 'values');
  const [q, setQ] = useState('');
  const values = useQuery({
    queryKey: ['pivot-values', dim.id],
    queryFn: () =>
      get<{ id: string; name: string }[]>(`/reports/pivot/values?field=${encodeURIComponent(dim.id)}`),
    enabled: opened && dim.hasValues,
    staleTime: 5 * 60_000,
  });
  const words = canon(q).split(/\s+/).filter(Boolean);
  const found = useMemo(
    () => (values.data ?? []).filter((v) => words.every((w) => canon(v.name).includes(w))),
    [values.data, q],
  );
  const shown = found.slice(0, 300);
  const sel = new Set(filter.values);
  const names = new Map((values.data ?? []).map((v) => [v.id, v.name]));
  const setValues = (ids: string[]) =>
    onChange({
      field: filter.field,
      mode: filter.mode,
      values: ids,
      labels: ids.map((id) => names.get(id) ?? filter.labels?.[filter.values.indexOf(id)] ?? id),
    });
  const compatible = measures.filter((m) => dim.facts.includes(m.fact));

  return (
    <Popover
      opened={opened}
      onClose={onClose}
      width={430}
      position="bottom-start"
      shadow="md"
      trapFocus={false}
      withinPortal
      // Д-052: окно всегда в пределах экрана — переворачивается вверх и сдвигается, а не уходит за край.
      middlewares={{
        flip: true,
        shift: { padding: 8 },
        // Высота окна — не больше места до края экрана (дальше — прокрутка внутри окна).
        size: {
          padding: 8,
          apply({ availableHeight, elements }) {
            elements.floating.style.maxHeight = `${Math.max(220, Math.floor(availableHeight))}px`;
          },
        },
      }}
    >
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown data-testid="pivot-filter" style={{ overflowY: 'auto' }}>
        <Stack gap={8}>
          <Group justify="space-between" wrap="nowrap">
            <Text fw={700} size="sm">
              {dim.label}
            </Text>
            <ActionIcon size="sm" variant="subtle" onClick={onClose} aria-label={t.cancel}>
              <IconX size={14} />
            </ActionIcon>
          </Group>
          <SegmentedControl
            size="xs"
            fullWidth
            value={tab}
            onChange={(v) => setTab(v as 'values' | 'cond')}
            data={[
              { value: 'values', label: t.pivot.filterValues, disabled: !dim.hasValues },
              { value: 'cond', label: t.pivot.filterCondition },
            ]}
          />
          {/* Д-052: тело окна одной высоты на обеих вкладках — окно не скачет при переключении. */}
          <Box h={FILTER_BODY_H} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tab === 'values' && (
              <>
                <Group gap={6} wrap="nowrap">
                  <SegmentedControl
                    size="xs"
                    value={filter.mode}
                    onChange={(v) =>
                      onChange({
                        ...filter,
                        measure: undefined,
                        op: undefined,
                        value: undefined,
                        mode: v as 'in' | 'out',
                      })
                    }
                    data={[
                      { value: 'in', label: t.pivot.filterOnly },
                      { value: 'out', label: t.pivot.filterExcept },
                    ]}
                  />
                </Group>
                {dim.map && (
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconMapPin size={14} />}
                    onClick={onMap}
                    data-testid="pivot-filter-map"
                  >
                    {t.pivot.pickOnMap}
                  </Button>
                )}
                <TextInput
                  size="xs"
                  leftSection={<IconSearch size={14} />}
                  placeholder={t.search}
                  value={q}
                  onChange={(e) => setQ(e.currentTarget.value)}
                  data-autofocus
                  data-testid="pivot-filter-search"
                />
                <Group gap={6} justify="space-between">
                  <Group gap={4}>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() => setValues([...new Set([...filter.values, ...found.map((v) => v.id)])])}
                    >
                      {t.pivot.selectFound}
                    </Button>
                    <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setValues([])}>
                      {t.pivot.clearSel}
                    </Button>
                    <Button size="compact-xs" onClick={onApply} data-testid="pivot-filter-apply">
                      {t.pivot.apply}
                    </Button>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {t.pivot.shown(shown.length, found.length)}
                  </Text>
                </Group>
                <ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
                  <Stack gap={3}>
                    {shown.map((v) => (
                      <Checkbox
                        key={v.id}
                        size="xs"
                        label={v.name}
                        checked={sel.has(v.id)}
                        onChange={() =>
                          setValues(
                            sel.has(v.id)
                              ? filter.values.filter((x) => x !== v.id)
                              : [...filter.values, v.id],
                          )
                        }
                        data-testid="pivot-filter-value"
                      />
                    ))}
                    <Checkbox
                      size="xs"
                      label={t.pivot.empty}
                      checked={sel.has('__null')}
                      onChange={() =>
                        setValues(
                          sel.has('__null')
                            ? filter.values.filter((x) => x !== '__null')
                            : [...filter.values, '__null'],
                        )
                      }
                    />
                  </Stack>
                </ScrollArea>
              </>
            )}
            {tab === 'values' && !dim.hasValues && (
              <Text size="xs" c="dimmed">
                {t.pivot.noValues}
              </Text>
            )}
            {tab === 'cond' && (
              <Stack gap={6}>
                <Text size="xs" c="dimmed">
                  {t.pivot.condHint}
                </Text>
                <Select
                  size="xs"
                  label={t.pivot.condMeasure}
                  searchable
                  data={compatible.map((m) => ({ value: m.id, label: m.label }))}
                  value={filter.measure ?? null}
                  onChange={(v) =>
                    onChange({
                      field: filter.field,
                      mode: 'in',
                      values: [],
                      measure: v ?? undefined,
                      op: filter.op ?? '>',
                      value: filter.value ?? 0,
                    })
                  }
                  data-testid="pivot-cond-measure"
                />
                <Group gap={6} grow>
                  <Select
                    size="xs"
                    data={OPS.map((o) => ({ value: o, label: OP_LABEL[o]! }))}
                    value={filter.op ?? '>'}
                    onChange={(v) => onChange({ ...filter, op: v ?? '>' })}
                    allowDeselect={false}
                  />
                  <NumberInput
                    size="xs"
                    label=""
                    value={filter.value ?? 0}
                    onChange={(v) =>
                      onChange({ ...filter, value: typeof v === 'number' ? v : Number(v) || 0 })
                    }
                    decimalSeparator=","
                    data-testid="pivot-cond-value"
                  />
                </Group>
                {hasCond && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => onChange({ field: filter.field, mode: 'in', values: [] })}
                  >
                    {t.pivot.condClear}
                  </Button>
                )}
                <Group justify="flex-end">
                  <Button size="compact-xs" onClick={onApply}>
                    {t.pivot.apply}
                  </Button>
                </Group>
              </Stack>
            )}
          </Box>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function IconHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip label={label} withArrow openDelay={300}>
      <span>{children}</span>
    </Tooltip>
  );
}
