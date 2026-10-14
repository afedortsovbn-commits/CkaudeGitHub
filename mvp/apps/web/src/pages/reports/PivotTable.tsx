import { Button, Group, Text } from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconSortAscending,
  IconSortDescending,
} from '@tabler/icons-react';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import { type Config, formatValue, type Grid } from './pivotModel';

/**
 * Д-041. Таблица конструктора: шапка в несколько уровней (поля столбцов, показатель, при сравнении — текущее,
 * прошлое и изменение), заголовки строк по уровням; группы сворачиваются щелчком, итог закреплён внизу,
 * щелчок по заголовку показателя — сортировка (по убыванию, по возрастанию, без сортировки).
 * Д-053: колонки подписей строк закреплены при прокрутке вбок вместе с заголовком (если они не шире половины
 * таблицы — иначе прокручиваются все вместе); длинный текст — полностью, сокращённым до 25 символов или с переносом.
 */
const CUT = 25;
const cut = (x: ReactNode, mode: TextMode): ReactNode =>
  mode === 'cut' && typeof x === 'string' && x.length > CUT ? `${x.slice(0, CUT - 1)}…` : x;
type TextMode = NonNullable<Config['textMode']>;

export function PivotTable({
  grid,
  sort,
  onSort,
  textMode = 'full',
}: {
  grid: Grid;
  sort: Config['sort'];
  onSort(s: Config['sort']): void;
  textMode?: TextMode;
}) {
  // Смещения закреплённых колонок подписей: ширина предыдущих колонок, измеренная после отрисовки.
  const wrap = useRef<HTMLDivElement>(null);
  const [lefts, setLefts] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    const box = wrap.current;
    if (!box) return;
    const measure = () => {
      const ths = [...box.querySelectorAll<HTMLElement>('th.pivot-rowhead')];
      const widths = ths.map((th) => th.getBoundingClientRect().width);
      const total = widths.reduce((a, b) => a + b, 0);
      if (!ths.length || total > box.clientWidth / 2) return setLefts(null);
      const next = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0));
      setLefts((prev) => (prev && prev.join() === next.join() ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [grid, textMode]);
  const stick = (i: number) => (lefts ? { position: 'sticky' as const, left: lefts[i] } : undefined);
  const titleOf = (x: ReactNode) =>
    textMode === 'cut' && typeof x === 'string' && x.length > CUT ? x : undefined;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => grid.rows.filter((r) => r.kind === 'group').map((r) => r.id), [grid]);
  const visible = grid.rows.filter((r) => !r.parents.some((p) => collapsed.has(p)));
  const nHead = grid.head.length;
  const nLabels = grid.rowHeaders.length;
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const clickSort = (colId: string) => {
    if (!sort || sort.col !== colId) onSort({ col: colId, dir: 'desc' });
    else if (sort.dir === 'desc') onSort({ col: colId, dir: 'asc' });
    else onSort(null);
  };
  const subtotalCol = grid.cols.map((c) => c.colLevel < Math.max(...grid.cols.map((x) => x.colLevel)));
  // Высота строки шапки — для закрепления нескольких уровней (sticky top).
  const ROW_H = 31;

  return (
    <div>
      {groups.length > 0 && (
        <Group gap={6} mb={6}>
          <Button size="compact-xs" variant="subtle" onClick={() => setCollapsed(new Set(groups))}>
            {t.pivot.collapseAll}
          </Button>
          <Button size="compact-xs" variant="subtle" onClick={() => setCollapsed(new Set())}>
            {t.pivot.expandAll}
          </Button>
        </Group>
      )}
      <div className="pivot-table-wrap" ref={wrap}>
        <table
          className={`pivot-table${textMode === 'wrap' ? ' pivot-text-wrap' : ''}${lefts ? ' pivot-sticky-labels' : ''}`}
          data-testid="pivot-table"
          data-text={textMode}
        >
          <thead>
            {grid.head.map((row, d) => (
              <tr key={d}>
                {d === 0 &&
                  grid.rowHeaders.map((h, i) => (
                    <th
                      key={`rh${i}`}
                      rowSpan={nHead}
                      className="pivot-rowhead"
                      style={{ top: 0, left: lefts ? lefts[i] : 'auto', verticalAlign: 'bottom' }}
                      title={titleOf(h)}
                    >
                      {cut(h, textMode)}
                    </th>
                  ))}
                {row.map((c, i) => {
                  const sorted = c.colId && sort?.col === c.colId ? sort.dir : null;
                  return (
                    <th
                      key={i}
                      colSpan={c.span}
                      rowSpan={c.rowSpan}
                      style={{ top: d * ROW_H }}
                      className={c.colId ? 'pivot-sortable' : undefined}
                      title={c.colId ? t.pivot.sortHint : undefined}
                      onClick={c.colId ? () => clickSort(c.colId!) : undefined}
                    >
                      <span
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        title={titleOf(c.text)}
                      >
                        {cut(c.text, textMode)}
                        {sorted === 'desc' && <IconSortDescending size={14} />}
                        {sorted === 'asc' && <IconSortAscending size={14} />}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={nLabels + grid.cols.length}>
                  <Text c="dimmed" size="sm">
                    {t.pivot.noData}
                  </Text>
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={r.id} className={`pivot-${r.kind}`}>
                {r.labels.map((l, i) => (
                  <td
                    key={i}
                    className="pivot-label"
                    style={{ paddingLeft: 10, ...stick(i) }}
                    title={titleOf(l)}
                  >
                    {r.kind === 'group' && i === r.level - 1 ? (
                      <button type="button" className="pivot-toggle" onClick={() => toggle(r.id)}>
                        {collapsed.has(r.id) ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
                        {cut(l, textMode)}
                      </button>
                    ) : (
                      cut(l, textMode)
                    )}
                  </td>
                ))}
                {r.cells.map((v, i) => {
                  const col = grid.cols[i]!;
                  const delta = col.part === 'd' && v !== null;
                  return (
                    <td
                      key={i}
                      className={`pivot-num${subtotalCol[i] ? ' pivot-subtotal-col' : ''}${
                        delta ? (v! > 0 ? ' pivot-delta-up' : v! < 0 ? ' pivot-delta-down' : '') : ''
                      }`}
                    >
                      {delta && v! > 0 ? '+' : ''}
                      {formatValue(v, col.format)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
