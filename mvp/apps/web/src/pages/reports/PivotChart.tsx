import { Alert, Stack, Text } from '@mantine/core';
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useMemo, useRef } from 'react';
import { t } from '../../lib/i18n';
import { chartData, chartValue, type Format, type Result, type ViewKind } from './pivotModel';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

const MAX_POINTS = 300;
const PALETTE = [
  '#228be6',
  '#12b886',
  '#fab005',
  '#fa5252',
  '#7950f2',
  '#15aabf',
  '#fd7e14',
  '#82c91e',
  '#e64980',
  '#495057',
];

/** Подпись значения на оси/в подсказке в единицах графика (длительность — минуты, время — часы). */
const unitFmt = (v: number, f: Format) =>
  f === 'dur'
    ? `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${t.pivot.unitMin}`
    : f === 'hours'
      ? `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${t.pivot.unitH}`
      : f === 'pct'
        ? `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`
        : v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

/**
 * Д-041. Графики по результату конструктора: категории — поля строк, серии — поля столбцов × показатели;
 * при сравнении — вторая серия пунктиром. Показатели разных единиц — на второй оси справа.
 */
export default function PivotChart({ res, nRows, view }: { res: Result; nRows: number; view: ViewKind }) {
  const box = useRef<HTMLDivElement | null>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  const built = useMemo(() => {
    const notes: string[] = [];
    const ms = res.measures;
    if (view === 'pie') {
      const d = chartData(res, res.dims.length);
      if (ms.length > 1) notes.push(t.pivot.pieFirstMeasure);
      const f = ms[0]!.format;
      // Крупные доли — отдельно, мелкие (больше 12-й) — одной долей «Прочее».
      const all = d.categories
        .map((c) => ({ name: c.label, value: chartValue(d.value(c.key, '', 0), f) ?? 0 }))
        .sort((a, b) => b.value - a.value);
      const pieData =
        all.length > 13
          ? [
              ...all.slice(0, 12),
              { name: t.pivot.other, value: all.slice(12).reduce((s2, x) => s2 + x.value, 0) },
            ]
          : all;
      return {
        notes,
        option: {
          color: PALETTE,
          tooltip: {
            trigger: 'item',
            valueFormatter: (v: number) => unitFmt(v, f),
          },
          legend: { type: 'scroll', bottom: 0 },
          series: [
            {
              type: 'pie',
              radius: ['35%', '68%'],
              itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
              label: { formatter: '{b}: {d}%' },
              data: pieData,
            },
          ],
        },
      };
    }
    if (view === 'heatmap') {
      if (nRows !== 1 || res.dims.length !== 2) return { notes: [t.pivot.heatmapNeeds], option: null };
      const rowsD = chartData(res, 1);
      const f = ms[0]!.format;
      const vals: [number, number, number | null][] = [];
      let max = 0;
      rowsD.categories.forEach((c, yi) =>
        rowsD.series.forEach((s, xi) => {
          const v = chartValue(rowsD.value(c.key, s.key, 0), f);
          if (v !== null) max = Math.max(max, v);
          vals.push([xi, yi, v]);
        }),
      );
      return {
        notes,
        option: {
          tooltip: {
            formatter: (p: { value: [number, number, number | null] }) =>
              `${rowsD.categories[p.value[1]]!.label} · ${rowsD.series[p.value[0]]!.label}<br/><b>${
                p.value[2] === null ? '—' : unitFmt(p.value[2], f)
              }</b>`,
          },
          grid: { left: 140, right: 20, top: 10, bottom: 110 },
          xAxis: { type: 'category', data: rowsD.series.map((s) => s.label), splitArea: { show: true } },
          yAxis: { type: 'category', data: rowsD.categories.map((c) => c.label), splitArea: { show: true } },
          visualMap: {
            min: 0,
            max: max || 1,
            calculable: true,
            orient: 'horizontal',
            left: 'center',
            bottom: 0,
            inRange: { color: ['#e7f5ff', '#74c0fc', '#1971c2', '#c92a2a'] },
          },
          series: [{ type: 'heatmap', data: vals, label: { show: vals.length <= 400 } }],
        },
      };
    }

    const d = chartData(res, nRows);
    const cats = d.categories.slice(0, MAX_POINTS);
    if (d.categories.length > MAX_POINTS) notes.push(t.pivot.tooManyPoints(MAX_POINTS));
    const formats = [...new Set(ms.map((m) => m.format))];
    const axisOf = (f: Format) => (formats.indexOf(f) === 0 ? 0 : 1);
    const horizontal = view === 'hbar';
    const series: Record<string, unknown>[] = [];
    const sers = d.series.length ? d.series : [{ key: '', label: '' }];
    ms.forEach((m, mi) => {
      const isLine = view === 'line' || view === 'area' || (view === 'combo' && mi > 0);
      const axis = view === 'combo' ? (mi === 0 ? 0 : 1) : axisOf(m.format);
      for (const s of sers) {
        const name = s.label ? (ms.length > 1 ? `${s.label} · ${m.label}` : s.label) : m.label;
        const base = {
          name,
          type: isLine ? 'line' : 'bar',
          smooth: isLine,
          symbolSize: 5,
          areaStyle: view === 'area' ? { opacity: 0.25 } : undefined,
          stack: view === 'stacked' || view === 'area' ? `s${axis}` : undefined,
          [horizontal ? 'xAxisIndex' : 'yAxisIndex']: axis,
          emphasis: { focus: 'series' },
          tooltip: { valueFormatter: (v: number | null) => (v === null ? '—' : unitFmt(v, m.format)) },
          barMaxWidth: 48,
        };
        series.push({ ...base, data: cats.map((c) => chartValue(d.value(c.key, s.key, mi), m.format)) });
        if (res.compare)
          series.push({
            ...base,
            name: `${name} (${t.pivot.cmpShort})`,
            stack: undefined,
            areaStyle: undefined,
            lineStyle: { type: 'dashed' },
            itemStyle: { opacity: 0.45 },
            data: cats.map((c) => chartValue(d.value(c.key, s.key, mi, 'c'), m.format)),
          });
      }
    });
    const usedAxes = view === 'combo' && ms.length > 1 ? 2 : Math.min(2, formats.length);
    const valueAxes = [...Array(usedAxes).keys()].map((i) => {
      const f = view === 'combo' ? ms[i === 0 ? 0 : 1]!.format : formats[i]!;
      return {
        type: 'value',
        axisLabel: { formatter: (v: number) => unitFmt(v, f) },
        splitLine: { show: i === 0 },
      };
    });
    const catAxis = {
      type: 'category',
      data: cats.map((c) => c.label),
      axisLabel: {
        interval: cats.length <= 24 ? 0 : 'auto',
        rotate: !horizontal && cats.length > 6 ? 30 : 0,
        hideOverlap: cats.length > 24,
      },
    };
    const zoom = cats.length > 40 ? [{ type: 'slider', [horizontal ? 'yAxisIndex' : 'xAxisIndex']: 0 }] : [];
    return {
      notes,
      option: {
        color: PALETTE,
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: { type: 'scroll', top: 0 },
        grid: {
          left: horizontal ? 180 : 60,
          right: usedAxes > 1 ? 70 : 24,
          top: 36,
          bottom: zoom.length ? 80 : 50,
          containLabel: !horizontal,
        },
        xAxis: horizontal ? valueAxes : catAxis,
        yAxis: horizontal
          ? { ...catAxis, inverse: true, axisLabel: { width: 170, overflow: 'truncate' } }
          : valueAxes,
        dataZoom: zoom,
        series,
      },
    };
  }, [res, nRows, view]);

  useEffect(() => {
    if (!box.current) return;
    const c = echarts.init(box.current);
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    if (built.option) chart.current?.setOption(built.option as echarts.EChartsCoreOption, true);
    else chart.current?.clear();
  }, [built]);

  const height = view === 'hbar' ? Math.max(380, Math.min(2400, res.rows.length * 26 + 80)) : 460;
  return (
    <Stack gap={6}>
      {built.notes.map((n) => (
        <Alert key={n} color="yellow" py={6}>
          <Text size="sm">{n}</Text>
        </Alert>
      ))}
      <div ref={box} style={{ width: '100%', height }} data-testid="pivot-chart" />
      {res.measures.some((m) => m.format === 'dur') && (
        <Text size="xs" c="dimmed">
          {t.pivot.durInMinutes}
        </Text>
      )}
    </Stack>
  );
}
