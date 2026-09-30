import {
  Alert,
  Button,
  Chip,
  Group,
  Loader,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { authBlobUrl, errorText, get } from '../lib/api';

interface CatalogItem {
  kind: string;
  title: string;
  groups: string[];
}
interface Column {
  key: string;
  label: string;
  type: 'text' | 'int' | 'num' | 'pct' | 'dur' | 'date' | 'datetime';
}
interface Report {
  kind: string;
  title: string;
  from: string;
  to: string;
  timezone: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown> | null;
  notes: string[];
}
type Opt = { id: string; name: string };
interface Options {
  channels: Opt[];
  enterprises: Opt[];
  departments: Opt[];
  topics: Opt[];
  objects: Opt[];
  queues: Opt[];
  operators: Opt[];
  assignees: Opt[];
}

const GROUP_LABELS: Record<string, string> = {
  channel: 'по каналам',
  queue: 'по очередям',
  operator: 'по операторам',
  topic: 'по темам',
  subtopic: 'по темам и подтемам',
  result: 'по результатам обработки',
  enterprise: 'по предприятиям',
  department: 'по предприятиям и подразделениям',
  object: 'по объектам',
  day: 'по дням',
  assignee: 'по ответственным и кураторам',
};

/** Сегодняшняя дата по Минску (единый часовой пояс отчётов, M-REP-03). */
const minskDate = (shiftDays = 0) =>
  new Date(Date.now() + shiftDays * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Minsk' });

const pad = (n: number) => String(n).padStart(2, '0');
/** Длительность: «ч:мм:сс» или «м:сс». */
export function formatDuration(s: number): string {
  const v = Math.round(s);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(v % 60)}` : `${m}:${pad(v % 60)}`;
}

function cell(v: unknown, type: Column['type']): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (type) {
    case 'dur':
      return formatDuration(Number(v));
    case 'pct':
      return `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`;
    case 'num':
      return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    case 'int':
      return Number(v).toLocaleString('ru-RU');
    case 'datetime':
      return new Date(String(v)).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
    case 'date':
      return new Date(`${String(v)}T00:00:00`).toLocaleDateString('ru-RU');
    default:
      return String(v);
  }
}

/**
 * Отчёты M-REP-03 (Ф10): выбор отчёта и разреза, фильтры (период, канал, очередь, предприятие, подразделение,
 * тема/подтема, объект, оператор, ответственный/куратор, «Особо важные»), таблица и выгрузка CSV.
 * Данные ограничены областью видимости сотрудника — это делает сервер.
 */
export function ReportsPage() {
  const catalog = useQuery({ queryKey: ['/reports'], queryFn: () => get<CatalogItem[]>('/reports') });
  const options = useQuery({
    queryKey: ['/reports/options'],
    queryFn: () => get<Options>('/reports/options'),
  });
  const [kind, setKind] = useState('conversations');
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [f, setF] = useState<Record<string, string>>({ from: minskDate(-6), to: minskDate() });
  const [important, setImportant] = useState(false);
  const [busy, setBusy] = useState(false);

  const item = catalog.data?.find((c) => c.kind === kind);
  const group = groupBy && item?.groups.includes(groupBy) ? groupBy : (item?.groups[0] ?? null);
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (important) p.set('important', 'true');
    if (group) p.set('groupBy', group);
    return p.toString();
  }, [f, important, group]);
  const report = useQuery({
    queryKey: ['report', kind, qs],
    queryFn: () => get<Report>(`/reports/${kind}?${qs}`),
    enabled: !!item,
  });

  const set = (k: string) => (v: string | null) => setF((x) => ({ ...x, [k]: v ?? '' }));
  const sel = (k: keyof Options, key: string, label: string) => (
    <Select
      label={label}
      clearable
      searchable
      data={(options.data?.[k] ?? []).map((o) => ({ value: o.id, label: o.name }))}
      value={f[key] || null}
      onChange={set(key)}
      data-testid={`report-filter-${key}`}
    />
  );

  const csv = async () => {
    setBusy(true);
    try {
      const url = await authBlobUrl(`/reports/${kind}?${qs}&format=csv`);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report-${kind}-${report.data?.from ?? f.from}-${report.data?.to ?? f.to}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const r = report.data;
  return (
    <Stack>
      <Title order={3}>Отчёты</Title>
      <Group align="flex-end">
        <Select
          label="Отчёт"
          w={380}
          data={(catalog.data ?? []).map((c) => ({ value: c.kind, label: c.title }))}
          value={kind}
          onChange={(v) => v && setKind(v)}
          allowDeselect={false}
          data-testid="report-kind"
        />
        {item && item.groups.length > 1 && (
          <Select
            label="Разрез"
            w={280}
            data={item.groups.map((g) => ({ value: g, label: GROUP_LABELS[g] ?? g }))}
            value={group}
            onChange={setGroupBy}
            allowDeselect={false}
            data-testid="report-group"
          />
        )}
        {kind !== 'overdue' && (
          <>
            <TextInput
              label="С"
              type="date"
              value={f.from}
              onChange={(e) => set('from')(e.currentTarget.value)}
              data-testid="report-from"
            />
            <TextInput
              label="По"
              type="date"
              value={f.to}
              onChange={(e) => set('to')(e.currentTarget.value)}
              data-testid="report-to"
            />
          </>
        )}
        <Chip checked={important} onChange={setImportant} color="red" data-testid="report-important">
          Особо важные
        </Chip>
        <Button variant="light" onClick={() => void csv()} loading={busy} data-testid="report-csv">
          Скачать CSV
        </Button>
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4, lg: 8 }} spacing="xs">
        {sel('channels', 'channel', 'Канал')}
        {sel('queues', 'queueId', 'Очередь')}
        {sel('enterprises', 'enterpriseId', 'Предприятие')}
        {sel('departments', 'departmentId', 'Подразделение')}
        {sel('topics', 'topicId', 'Тема / подтема')}
        {sel('objects', 'objectId', 'Объект')}
        {sel('operators', 'operatorId', 'Оператор')}
        {sel('assignees', 'assigneeId', 'Ответственный / куратор')}
      </SimpleGrid>
      {report.isError && <Alert color="red">{errorText(report.error)}</Alert>}
      {report.isLoading && <Loader size="sm" />}
      {r && (
        <>
          <Text size="sm" c="dimmed" data-testid="report-period">
            {r.title}
            {kind !== 'overdue' &&
              ` · ${new Date(`${r.from}T00:00:00`).toLocaleDateString('ru-RU')} — ${new Date(
                `${r.to}T00:00:00`,
              ).toLocaleDateString('ru-RU')} (${r.timezone})`}
          </Text>
          <Table.ScrollContainer minWidth={900}>
            <Table striped highlightOnHover withTableBorder data-testid="report-table">
              <Table.Thead>
                <Table.Tr>
                  {r.columns.map((c) => (
                    <Table.Th key={c.key} style={{ textAlign: c.type === 'text' ? 'left' : 'right' }}>
                      {c.label}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {r.rows.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={r.columns.length}>
                      <Text c="dimmed">Нет данных за период</Text>
                    </Table.Td>
                  </Table.Tr>
                )}
                {r.rows.map((row, i) => (
                  <Table.Tr key={String(row.key ?? i)}>
                    {r.columns.map((c) => (
                      <Table.Td key={c.key} style={{ textAlign: c.type === 'text' ? 'left' : 'right' }}>
                        {cell(row[c.key], c.type)}
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
                {r.totals && (
                  <Table.Tr data-testid="report-totals" style={{ fontWeight: 700 }}>
                    {r.columns.map((c) => (
                      <Table.Td key={c.key} style={{ textAlign: c.type === 'text' ? 'left' : 'right' }}>
                        {cell(r.totals![c.key], c.type)}
                      </Table.Td>
                    ))}
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {r.notes.map((n) => (
            <Text key={n} size="xs" c="dimmed">
              {n}
            </Text>
          ))}
        </>
      )}
    </Stack>
  );
}
