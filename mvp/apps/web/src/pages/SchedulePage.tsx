import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Chip,
  Group,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconCalendarMonth,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconMoon,
  IconPin,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { api, get, patch, post, put } from '../lib/api';
import { useAction, useRequired } from '../lib/data';
import { t } from '../lib/i18n';

const s = t.schedule;
const pad = (n: number) => String(n).padStart(2, '0');
/** Минское время (UTC+3, без перехода на летнее). */
const minsk = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000);
export const hm = (iso: string) => {
  const d = minsk(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const minToHm = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const hmToMin = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return v ? (h ?? 0) * 60 + (m ?? 0) : null;
};
export const ddmm = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const curMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
const addMonth = (m: string, k: number) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mm - 1 + k, 1)).toISOString().slice(0, 7);
};
const monthLabel = (m: string) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mm - 1, 15)).toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};
/** Дни месяца: дата, число, день недели (1 — пн … 7 — вс). */
const monthDays = (m: string) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  const n = new Date(Date.UTC(y, mm, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => {
    const wd = new Date(Date.UTC(y, mm - 1, i + 1)).getUTCDay();
    return { date: `${m}-${pad(i + 1)}`, day: i + 1, weekday: wd === 0 ? 7 : wd };
  });
};

interface Template {
  id: string;
  code: string;
  name: string;
  startMin: number;
  durationMin: number;
  isNight: boolean;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
}
interface Brk {
  id: string;
  kind: 'long' | 'short';
  startAt: string;
  endAt: string;
  manual: boolean;
}
interface Shift {
  id: string;
  userId: string;
  date: string;
  templateId: string;
  startAt: string;
  endAt: string;
  isNight: boolean;
  manual: boolean;
  code: string;
  color: string | null;
  durationMin: number;
  breaks: Brk[];
}
interface DemandRow {
  templateId: string;
  weekday?: number;
  date?: string;
  required: number;
}
interface BreakRules {
  day: { long: number; short: number[] };
  night: { long: number; short: number[] };
}
interface MonthData {
  month: string;
  status: string;
  normHours: number;
  warnings: string[];
  breakRules: BreakRules;
  staff: { userId: string; name: string }[];
  shifts: Shift[];
  demand: { weekday: DemandRow[]; dates: DemandRow[] };
}
interface StaffRule {
  id: string;
  kind: 'unavailable' | 'preferred';
  dateFrom: string | null;
  dateTo: string | null;
  weekdays: number[] | null;
  timeFrom: number | null;
  timeTo: number | null;
  month: string | null;
  comment: string | null;
}
interface Prefs {
  shiftLengths: number[];
  night: 'prefer' | 'ok' | 'no';
  weekdays: Record<string, 'prefer' | 'avoid' | 'off'>;
  maxHours: number | null;
  note: string | null;
}
interface Staff {
  userId: string;
  name: string;
  prefs: Prefs;
  prefsForMonth: boolean;
  rules: StaffRule[];
}

const useTemplates = (all = false) =>
  useQuery({
    queryKey: ['/schedule/templates', all],
    queryFn: () => get<Template[]>(`/schedule/templates${all ? '?active=all' : ''}`),
  });

/** График работы персонала: график на месяц, пожелания сотрудников, потребность, смены и правила. */
export function SchedulePage() {
  const [month, setMonth] = useState(curMonth);
  const [tab, setTab] = useState<string | null>('grid');
  return (
    <Stack gap="sm">
      <Group gap="xs">
        <ActionIcon
          variant="subtle"
          onClick={() => setMonth((m) => addMonth(m, -1))}
          aria-label={s.prevMonth}
        >
          <IconChevronLeft size={18} />
        </ActionIcon>
        <Group gap={6} w={190} justify="center">
          <IconCalendarMonth size={18} color="var(--mantine-color-blue-6)" />
          <Text fw={600} data-testid="schedule-month">
            {monthLabel(month)}
          </Text>
        </Group>
        <ActionIcon variant="subtle" onClick={() => setMonth((m) => addMonth(m, 1))} aria-label={s.nextMonth}>
          <IconChevronRight size={18} />
        </ActionIcon>
      </Group>
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="grid" data-testid="schedule-tab-grid">
            {s.tabGrid}
          </Tabs.Tab>
          <Tabs.Tab value="prefs" data-testid="schedule-tab-prefs">
            {s.tabPrefs}
          </Tabs.Tab>
          <Tabs.Tab value="demand" data-testid="schedule-tab-demand">
            {s.tabDemand}
          </Tabs.Tab>
          <Tabs.Tab value="settings" data-testid="schedule-tab-settings">
            {s.tabSettings}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="grid" pt="sm">
          <GridTab month={month} />
        </Tabs.Panel>
        <Tabs.Panel value="prefs" pt="sm">
          <PrefsTab month={month} />
        </Tabs.Panel>
        <Tabs.Panel value="demand" pt="sm">
          <DemandTab />
        </Tabs.Panel>
        <Tabs.Panel value="settings" pt="sm">
          <SettingsTab />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

// ---------------- График ----------------

const tplColor = (c: string | null | undefined, night: boolean) => c || (night ? 'indigo' : 'blue');

function GridTab({ month }: { month: string }) {
  const q = useQuery({
    queryKey: ['/schedule/month', month],
    queryFn: () => get<MonthData>(`/schedule/month?month=${month}`),
  });
  const tpls = useTemplates();
  const gen = useAction(() => post('/schedule/month/generate', { month }), s.generated);
  const pub = useAction(() => post('/schedule/month/publish', { month }), s.publishedOk);
  const setCell = useAction((b: { userId: string; date: string; templateId: string | null }) =>
    put('/schedule/month/shift', { month, ...b }),
  );
  const [cell, setCellEdit] = useState<{ userId: string; name: string; date: string } | null>(null);
  const [breaksDay, setBreaksDay] = useState<string | null>(null);
  const [showWarn, setShowWarn] = useState(false);
  const d = q.data;
  const days = useMemo(() => monthDays(month), [month]);
  const byCell = useMemo(() => new Map((d?.shifts ?? []).map((x) => [`${x.userId}|${x.date}`, x])), [d]);
  if (!d) return null;
  const longOf = (x: Shift) => (x.isNight ? d.breakRules.night.long : d.breakRules.day.long);
  const hours = (uid: string) =>
    d.shifts.filter((x) => x.userId === uid).reduce((a, x) => a + (x.durationMin - longOf(x)) / 60, 0);
  const required = (tplId: string, date: string, weekday: number) =>
    d.demand.dates.find((x) => x.templateId === tplId && x.date === date)?.required ??
    d.demand.weekday.find((x) => x.templateId === tplId && x.weekday === weekday)?.required ??
    0;
  const regenerate = () => {
    if (d.status !== 'none' && !window.confirm(s.regenerateConfirm)) return;
    gen.mutate(undefined);
  };
  const cellW = 30;
  const sticky = { position: 'sticky' as const, left: 0, background: 'var(--mantine-color-body)', zIndex: 1 };
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group gap="xs">
          <Button
            leftSection={<IconCalendarMonth size={16} />}
            onClick={regenerate}
            loading={gen.isPending}
            data-testid="schedule-generate"
          >
            {d.status === 'none' ? s.generate : s.regenerate}
          </Button>
          <Button
            variant="light"
            color="green"
            onClick={() => pub.mutate(undefined)}
            loading={pub.isPending}
            disabled={d.status === 'none'}
            data-testid="schedule-publish"
          >
            {s.publish}
          </Button>
          <Badge
            variant="light"
            color={d.status === 'published' ? 'green' : d.status === 'draft' ? 'orange' : 'gray'}
            data-testid="schedule-status"
          >
            {s.status[d.status]}
          </Badge>
        </Group>
        <Group gap="md">
          <Group gap={4}>
            <IconMoon size={14} color="var(--mantine-color-indigo-6)" />
            <Text size="xs" c="dimmed">
              {s.legendNight}
            </Text>
          </Group>
          <Group gap={4}>
            <IconPin size={14} color="var(--mantine-color-gray-6)" />
            <Text size="xs" c="dimmed">
              {s.legendManual}
            </Text>
          </Group>
        </Group>
      </Group>
      {d.status === 'none' && (
        <Alert color="blue" variant="light">
          {s.prefsFirst}
        </Alert>
      )}
      {d.warnings.length > 0 && (
        <Alert color="orange" variant="light" p="xs">
          <UnstyledButton onClick={() => setShowWarn((v) => !v)} data-testid="schedule-warnings">
            <Text size="sm" fw={600} c="orange.8">
              {s.warnings(d.warnings.length)}
            </Text>
          </UnstyledButton>
          {showWarn && (
            <ScrollArea.Autosize mah={180} mt={4} type="auto">
              <Stack gap={2}>
                {d.warnings.map((w, i) => (
                  <Text key={i} size="xs">
                    {w}
                  </Text>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Alert>
      )}
      {!d.staff.length && <Alert color="gray">{s.emptyStaff}</Alert>}
      <ScrollArea type="auto" offsetScrollbars>
        <Table
          withTableBorder
          withColumnBorders
          horizontalSpacing={0}
          verticalSpacing={0}
          style={{ tableLayout: 'fixed', width: 'max-content' }}
          data-testid="schedule-grid"
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ ...sticky, width: 175, padding: '4px 8px' }}>{s.employee}</Table.Th>
              {days.map((x) => (
                <Table.Th
                  key={x.date}
                  style={{
                    width: cellW,
                    textAlign: 'center',
                    cursor: 'pointer',
                    background: x.weekday >= 6 ? 'var(--mantine-color-red-0)' : undefined,
                  }}
                  onClick={() => setBreaksDay(x.date)}
                  title={s.dayBreaks}
                >
                  <Text size="xs" fw={600} lh={1.2}>
                    {x.day}
                  </Text>
                  <Text size="10px" c={x.weekday >= 6 ? 'red.7' : 'dimmed'} lh={1.2}>
                    {s.weekdays[x.weekday - 1]}
                  </Text>
                </Table.Th>
              ))}
              <Table.Th style={{ width: 64, textAlign: 'center' }} title={s.normHint(d.normHours)}>
                <Text size="xs" fw={600}>
                  {s.hours}
                </Text>
              </Table.Th>
              <Table.Th style={{ width: 48, textAlign: 'center' }}>
                <Text size="xs" fw={600}>
                  {s.nights}
                </Text>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {d.staff.map((u) => {
              const h = Math.round(hours(u.userId));
              const off = h < d.normHours * 0.85 || h > d.normHours * 1.1;
              return (
                <Table.Tr key={u.userId} data-testid={`schedule-row-${u.userId}`}>
                  <Table.Td style={{ ...sticky, padding: '2px 8px' }}>
                    <Text size="sm" truncate>
                      {u.name}
                    </Text>
                  </Table.Td>
                  {days.map((x) => {
                    const sh = byCell.get(`${u.userId}|${x.date}`);
                    const c = sh ? tplColor(sh.color, sh.isNight) : null;
                    return (
                      <Table.Td
                        key={x.date}
                        p={0}
                        style={{
                          background: x.weekday >= 6 && !sh ? 'var(--mantine-color-red-0)' : undefined,
                        }}
                      >
                        <UnstyledButton
                          w="100%"
                          h={30}
                          onClick={() => setCellEdit({ userId: u.userId, name: u.name, date: x.date })}
                          data-testid={`cell-${u.userId}-${x.day}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            position: 'relative',
                            background: c ? `var(--mantine-color-${c}-1)` : undefined,
                            color: c ? `var(--mantine-color-${c}-9)` : undefined,
                          }}
                        >
                          {sh && (
                            <Text size="10px" fw={700}>
                              {sh.code}
                            </Text>
                          )}
                          {sh?.manual && (
                            <IconPin
                              size={9}
                              style={{ position: 'absolute', top: 1, right: 1, opacity: 0.6 }}
                            />
                          )}
                        </UnstyledButton>
                      </Table.Td>
                    );
                  })}
                  <Table.Td style={{ textAlign: 'center' }}>
                    <Text size="sm" fw={600} c={off ? 'orange.8' : undefined}>
                      {h}
                    </Text>
                  </Table.Td>
                  <Table.Td style={{ textAlign: 'center' }}>
                    <Text size="sm" c={'indigo.7'}>
                      {d.shifts.filter((x) => x.userId === u.userId && x.isNight).length || ''}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              );
            })}
            {(tpls.data ?? []).map((tp) => (
              <Table.Tr key={tp.id} style={{ background: 'var(--mantine-color-gray-0)' }}>
                <Table.Td
                  style={{ ...sticky, background: 'var(--mantine-color-gray-0)', padding: '2px 8px' }}
                >
                  <Text size="xs" c="dimmed" title={s.coverageHint}>
                    {s.coverage}: {tp.code}
                  </Text>
                </Table.Td>
                {days.map((x) => {
                  const n = d.shifts.filter((y) => y.templateId === tp.id && y.date === x.date).length;
                  const r = required(tp.id, x.date, x.weekday);
                  return (
                    <Table.Td key={x.date} style={{ textAlign: 'center' }}>
                      {(n > 0 || r > 0) && (
                        <Text size="10px" fw={600} c={n < r ? 'red.7' : n > r ? 'blue.7' : 'green.8'}>
                          {n}/{r}
                        </Text>
                      )}
                    </Table.Td>
                  );
                })}
                <Table.Td />
                <Table.Td />
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      <Text size="xs" c="dimmed">
        {s.normHint(d.normHours)}. {d.status === 'published' ? s.republishHint : ''}
      </Text>
      <Modal
        opened={!!cell}
        onClose={() => setCellEdit(null)}
        title={cell ? s.cellTitle(cell.name, ddmm(cell.date)) : ''}
        size="sm"
      >
        {cell && (
          <Stack gap="xs">
            <SimpleGrid cols={2} spacing="xs">
              {(tpls.data ?? []).map((tp) => {
                const curTpl = byCell.get(`${cell.userId}|${cell.date}`)?.templateId;
                return (
                  <Button
                    key={tp.id}
                    variant={curTpl === tp.id ? 'filled' : 'light'}
                    color={tplColor(tp.color, tp.isNight)}
                    leftSection={tp.isNight ? <IconMoon size={14} /> : <IconClock size={14} />}
                    onClick={() => {
                      setCell.mutate({ userId: cell.userId, date: cell.date, templateId: tp.id });
                      setCellEdit(null);
                    }}
                    data-testid={`cell-set-${tp.code}`}
                    styles={{ inner: { justifyContent: 'flex-start' } }}
                  >
                    <Stack gap={0} align="flex-start">
                      <Text size="sm" fw={600}>
                        {tp.code}
                      </Text>
                      <Text size="10px">
                        {minToHm(tp.startMin)}–{minToHm(tp.startMin + tp.durationMin)}
                      </Text>
                    </Stack>
                  </Button>
                );
              })}
            </SimpleGrid>
            <Button
              variant="default"
              onClick={() => {
                setCell.mutate({ userId: cell.userId, date: cell.date, templateId: null });
                setCellEdit(null);
              }}
              data-testid="cell-set-off"
            >
              {s.dayOff}
            </Button>
            {byCell.get(`${cell.userId}|${cell.date}`) && (
              <Button
                variant="subtle"
                onClick={() => {
                  setBreaksDay(cell.date);
                  setCellEdit(null);
                }}
              >
                {s.dayBreaks}
              </Button>
            )}
            <Text size="xs" c="dimmed">
              {s.manual}
            </Text>
          </Stack>
        )}
      </Modal>
      <BreaksModal day={breaksDay} data={d} onClose={() => setBreaksDay(null)} />
    </Stack>
  );
}

/** Перерывы дня по всем сотрудникам: время начала можно поправить; пересечения подсвечиваются. */
function BreaksModal({ day, data, onClose }: { day: string | null; data: MonthData; onClose: () => void }) {
  const move = useAction(
    (b: { id: string; startMin: number }) =>
      patch<{ overlaps: number }>(`/schedule/breaks/${b.id}`, { startMin: b.startMin }),
    s.breakMoved,
  );
  const name = (uid: string) => data.staff.find((x) => x.userId === uid)?.name ?? '';
  const all = data.shifts.flatMap((sh) => sh.breaks.map((b) => ({ ...b, userId: sh.userId, date: sh.date })));
  const list = all.filter((b) => b.date === day).sort((a, b) => a.startAt.localeCompare(b.startAt));
  const clash = (b: (typeof all)[number]) =>
    all.some((o) => o.id !== b.id && o.startAt < b.endAt && b.startAt < o.endAt);
  return (
    <Modal opened={!!day} onClose={onClose} title={day ? s.breaksTitle(ddmm(day)) : ''} size="lg">
      <Stack gap={6}>
        <Text size="xs" c="dimmed">
          {s.breaksHint}
        </Text>
        {!list.length && <Text c="dimmed">{s.noBreaks}</Text>}
        {list.map((b) => {
          const bad = clash(b);
          return (
            <Group
              key={b.id}
              gap="sm"
              wrap="nowrap"
              p={4}
              style={{
                borderRadius: 6,
                background: bad ? 'var(--mantine-color-red-0)' : undefined,
              }}
              data-testid="break-row"
            >
              <TextInput
                type="time"
                size="xs"
                w={100}
                defaultValue={hm(b.startAt)}
                key={b.startAt}
                onBlur={(e) => {
                  const v = hmToMin(e.currentTarget.value);
                  if (v != null && e.currentTarget.value !== hm(b.startAt))
                    move.mutate({ id: b.id, startMin: v });
                }}
              />
              <Text size="sm" w={50} c="dimmed">
                {`–${hm(b.endAt)}`}
              </Text>
              <Badge variant="light" color={b.kind === 'long' ? 'orange' : 'gray'} w={80}>
                {b.kind === 'long' ? s.breakLong : s.breakShort}
              </Badge>
              <Text size="sm" style={{ flex: 1 }} truncate>
                {name(b.userId)}
              </Text>
              {b.manual && <IconPin size={14} color="var(--mantine-color-gray-6)" />}
              {bad && (
                <Text size="xs" c="red.7">
                  {s.overlap}
                </Text>
              )}
            </Group>
          );
        })}
      </Stack>
    </Modal>
  );
}

// ---------------- Пожелания ----------------

const WD_NEXT: Record<string, 'prefer' | 'avoid' | 'off' | undefined> = {
  none: 'prefer',
  prefer: 'avoid',
  avoid: 'off',
  off: undefined,
};
const WD_COLOR: Record<string, string> = { prefer: 'green', avoid: 'orange', off: 'red' };

function PrefsTab({ month }: { month: string }) {
  const q = useQuery({
    queryKey: ['/schedule/staff', month],
    queryFn: () => get<Staff[]>(`/schedule/staff?month=${month}`),
  });
  const [scope, setScope] = useState<'month' | 'permanent'>('month');
  const [ruleFor, setRuleFor] = useState<Staff | null>(null);
  return (
    <Stack gap="sm">
      <Group gap="sm">
        <Text size="sm">{s.scope}:</Text>
        <SegmentedControl
          size="xs"
          value={scope}
          onChange={(v) => setScope(v as 'month' | 'permanent')}
          data={[
            { value: 'month', label: s.scopeMonth(monthLabel(month)) },
            { value: 'permanent', label: s.scopePermanent },
          ]}
          data-testid="prefs-scope"
        />
      </Group>
      <Text size="xs" c="dimmed">
        {s.prefsHint} {s.weekdaysHint}.
      </Text>
      {!(q.data ?? []).length && !q.isLoading && <Alert color="gray">{s.emptyStaff}</Alert>}
      {(q.data ?? []).map((st) => (
        <StaffCard key={st.userId} st={st} month={month} scope={scope} onAddRule={() => setRuleFor(st)} />
      ))}
      <RuleModal st={ruleFor} month={month} scope={scope} onClose={() => setRuleFor(null)} />
    </Stack>
  );
}

function StaffCard({
  st,
  month,
  scope,
  onAddRule,
}: {
  st: Staff;
  month: string;
  scope: 'month' | 'permanent';
  onAddRule: () => void;
}) {
  const save = useAction((p: Prefs & { month?: string; permanentFrom?: string }) =>
    put(`/schedule/staff/${st.userId}/prefs`, p),
  );
  const savePerm = useAction(
    () => put(`/schedule/staff/${st.userId}/prefs`, { ...st.prefs, permanentFrom: month }),
    s.savedPermanent,
  );
  const reset = useAction(() => api('DELETE', `/schedule/staff/${st.userId}/prefs?month=${month}`));
  const delRule = useAction((id: string) => api('DELETE', `/schedule/rules/${id}`));
  const permRule = useAction((id: string) => post(`/schedule/rules/${id}/permanent`), s.savedPermanent);
  const [maxH, setMaxH] = useState<number | string>(st.prefs.maxHours ?? '');
  useEffect(() => setMaxH(st.prefs.maxHours ?? ''), [st.prefs.maxHours]);
  const change = (patchP: Partial<Prefs>) => {
    const { note, ...rest } = { ...st.prefs, ...patchP };
    save.mutate({ ...rest, note, ...(scope === 'month' ? { month } : {}) });
  };
  return (
    <Paper withBorder p="sm" data-testid={`prefs-${st.userId}`}>
      <Group justify="space-between" mb={6}>
        <Group gap="xs">
          <Text fw={600}>{st.name}</Text>
          {st.prefsForMonth && (
            <Badge size="sm" variant="light" color="grape">
              {s.forMonth(monthLabel(month))}
            </Badge>
          )}
        </Group>
        {st.prefsForMonth && (
          <Group gap={4}>
            <Button size="compact-xs" variant="light" onClick={() => savePerm.mutate(undefined)}>
              {s.savePermanent}
            </Button>
            <Button size="compact-xs" variant="subtle" color="gray" onClick={() => reset.mutate(undefined)}>
              {s.resetPermanent}
            </Button>
          </Group>
        )}
      </Group>
      <Group gap="lg" align="flex-end" wrap="wrap">
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            {s.lengths}
          </Text>
          <Chip.Group
            multiple
            value={st.prefs.shiftLengths.map(String)}
            onChange={(v) => v.length && change({ shiftLengths: v.map(Number) })}
          >
            <Group gap={4}>
              <Chip size="xs" value="8">
                {s.len8}
              </Chip>
              <Chip size="xs" value="12">
                {s.len12}
              </Chip>
            </Group>
          </Chip.Group>
        </Stack>
        <SegmentedControl
          size="xs"
          value={st.prefs.night}
          onChange={(v) => change({ night: v as Prefs['night'] })}
          data={(['prefer', 'ok', 'no'] as const).map((v) => ({ value: v, label: s.night[v] ?? v }))}
          data-testid={`prefs-night-${st.userId}`}
        />
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            {s.weekdaysLabel}
          </Text>
          <Group gap={3}>
            {s.weekdays.map((w, i) => {
              const k = String(i + 1);
              const cur = st.prefs.weekdays[k];
              return (
                <Tooltip key={k} label={cur ? s.wd[cur] : s.weekdaysHint} openDelay={400}>
                  <Button
                    size="compact-xs"
                    w={34}
                    variant={cur ? 'filled' : 'default'}
                    color={cur ? WD_COLOR[cur] : undefined}
                    onClick={() => {
                      const next = WD_NEXT[cur ?? 'none'];
                      const wd = { ...st.prefs.weekdays };
                      if (next) wd[k] = next;
                      else delete wd[k];
                      change({ weekdays: wd });
                    }}
                    data-testid={`prefs-wd-${st.userId}-${k}`}
                  >
                    {w}
                  </Button>
                </Tooltip>
              );
            })}
          </Group>
        </Stack>
        <NumberInput
          size="xs"
          w={130}
          label={s.maxHours}
          min={1}
          max={400}
          value={maxH}
          onChange={setMaxH}
          onBlur={() => {
            const v = maxH === '' ? null : Number(maxH);
            if (v !== st.prefs.maxHours) change({ maxHours: v });
          }}
        />
      </Group>
      <Group gap={6} mt={8} align="center">
        <Text size="xs" c="dimmed">
          {s.rules}:
        </Text>
        {!st.rules.length && (
          <Text size="xs" c="dimmed">
            {s.noRules}
          </Text>
        )}
        {st.rules.map((r) => (
          <Badge
            key={r.id}
            variant="light"
            color={r.kind === 'unavailable' ? 'red' : 'green'}
            size="lg"
            radius="sm"
            tt="none"
            fw={500}
            rightSection={
              <Group gap={0}>
                {r.month && (
                  <Tooltip label={s.makePermanent}>
                    <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => permRule.mutate(r.id)}>
                      <IconPin size={12} />
                    </ActionIcon>
                  </Tooltip>
                )}
                <Tooltip label={s.deleteRule}>
                  <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => delRule.mutate(r.id)}>
                    <IconTrash size={12} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            }
          >
            {ruleText(r)}
          </Badge>
        ))}
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          onClick={onAddRule}
          data-testid={`prefs-add-rule-${st.userId}`}
        >
          {s.addRule}
        </Button>
      </Group>
    </Paper>
  );
}

function ruleText(r: StaffRule): string {
  const parts = [s.ruleKind[r.kind] ?? r.kind];
  if (r.dateFrom || r.dateTo)
    parts.push(
      [r.dateFrom && s.from(ddmm(r.dateFrom)), r.dateTo && s.to(ddmm(r.dateTo))].filter(Boolean).join(' '),
    );
  else if (!r.weekdays?.length) parts.push(s.anyDate);
  if (r.weekdays?.length) parts.push(r.weekdays.map((w) => s.weekdays[w - 1]).join(', '));
  parts.push(
    r.timeFrom != null && r.timeTo != null ? `${minToHm(r.timeFrom)}–${minToHm(r.timeTo)}` : s.allDay,
  );
  if (r.comment) parts.push(r.comment);
  parts.push(r.month ? s.ruleMonth : s.rulePermanent);
  return parts.join(' · ');
}

function RuleModal({
  st,
  month,
  scope,
  onClose,
}: {
  st: Staff | null;
  month: string;
  scope: 'month' | 'permanent';
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'unavailable' | 'preferred'>('unavailable');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [wd, setWd] = useState<string[]>([]);
  const [tFrom, setTFrom] = useState('');
  const [tTo, setTTo] = useState('');
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (!st) return;
    setKind('unavailable');
    setFrom('');
    setTo('');
    setWd([]);
    setTFrom('');
    setTTo('');
    setComment('');
  }, [st]);
  const add = useAction((b: Record<string, unknown>) => post(`/schedule/staff/${st?.userId}/rules`, b));
  const submit = () =>
    add.mutate(
      {
        kind,
        dateFrom: from || null,
        dateTo: to || null,
        weekdays: wd.length ? wd.map(Number) : null,
        timeFrom: tFrom && tTo ? hmToMin(tFrom) : null,
        timeTo: tFrom && tTo ? hmToMin(tTo) : null,
        month: scope === 'month' ? month : null,
        comment: comment || null,
      },
      { onSuccess: onClose },
    );
  return (
    <Modal opened={!!st} onClose={onClose} title={st ? `${s.newRule}: ${st.name}` : ''}>
      <Stack gap="sm">
        <SegmentedControl
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          data={[
            { value: 'unavailable', label: s.ruleKind.unavailable ?? '' },
            { value: 'preferred', label: s.ruleKind.preferred ?? '' },
          ]}
          color={kind === 'unavailable' ? 'red' : 'green'}
        />
        <Group grow>
          <TextInput
            type="date"
            label={s.dateFrom}
            value={from}
            onChange={(e) => setFrom(e.currentTarget.value)}
          />
          <TextInput type="date" label={s.dateTo} value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        </Group>
        <Stack gap={2}>
          <Text size="sm">{s.ruleWeekdays}</Text>
          <Chip.Group multiple value={wd} onChange={setWd}>
            <Group gap={4}>
              {s.weekdays.map((w, i) => (
                <Chip key={w} size="xs" value={String(i + 1)}>
                  {w}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </Stack>
        <Group grow>
          <TextInput
            type="time"
            label={s.timeFrom}
            value={tFrom}
            onChange={(e) => setTFrom(e.currentTarget.value)}
          />
          <TextInput
            type="time"
            label={s.timeTo}
            value={tTo}
            onChange={(e) => setTTo(e.currentTarget.value)}
          />
        </Group>
        <Text size="xs" c="dimmed">
          {s.timeHint}
        </Text>
        <TextInput label={s.comment} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
        <Text size="xs" c="grape.7">
          {s.ruleWillBe(scope === 'month' ? s.scopeMonth(monthLabel(month)) : s.scopePermanent)}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button onClick={submit} loading={add.isPending} data-testid="rule-save">
            {t.save}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------- Потребность ----------------

function DemandTab() {
  const tpls = useTemplates();
  const q = useQuery({
    queryKey: ['/schedule/demand'],
    queryFn: () => get<{ weekday: DemandRow[]; dates: DemandRow[] }>('/schedule/demand'),
  });
  const [wk, setWk] = useState<Record<string, number>>({});
  const [dates, setDates] = useState<DemandRow[]>([]);
  useEffect(() => {
    if (!q.data) return;
    setWk(Object.fromEntries(q.data.weekday.map((x) => [`${x.templateId}|${x.weekday}`, x.required])));
    setDates(q.data.dates);
  }, [q.data]);
  const save = useAction(() =>
    put('/schedule/demand', {
      weekday: Object.entries(wk).map(([k, required]) => {
        const [templateId, w] = k.split('|');
        return { templateId, weekday: Number(w), required };
      }),
      dates: dates.filter((x) => x.date && x.templateId).map((x) => ({ ...x, weekday: undefined })),
    }),
  );
  const tplOptions = (tpls.data ?? []).map((x) => ({ value: x.id, label: `${x.code} — ${x.name}` }));
  return (
    <Stack gap="sm" maw={900}>
      <Text size="sm" c="dimmed">
        {s.demandHint}
      </Text>
      <Table withTableBorder withColumnBorders data-testid="demand-table">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{s.shift}</Table.Th>
            {s.weekdays.map((w, i) => (
              <Table.Th
                key={w}
                style={{ textAlign: 'center', color: i >= 5 ? 'var(--mantine-color-red-7)' : undefined }}
              >
                {w}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(tpls.data ?? []).map((tp) => (
            <Table.Tr key={tp.id}>
              <Table.Td>
                <Group gap={6} wrap="nowrap">
                  {tp.isNight ? <IconMoon size={14} /> : <IconClock size={14} />}
                  <Text size="sm">{tp.name}</Text>
                </Group>
              </Table.Td>
              {s.weekdays.map((w, i) => (
                <Table.Td key={w} p={4}>
                  <NumberInput
                    size="xs"
                    min={0}
                    max={100}
                    w={60}
                    mx="auto"
                    value={wk[`${tp.id}|${i + 1}`] ?? 0}
                    onChange={(v) => setWk((o) => ({ ...o, [`${tp.id}|${i + 1}`]: Number(v) || 0 }))}
                    data-testid={`demand-${tp.code}-${i + 1}`}
                  />
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text fw={600} size="sm">
        {s.specialDates}
      </Text>
      {dates.map((x, i) => (
        <Group key={i} gap="xs">
          <TextInput
            type="date"
            size="xs"
            value={x.date ?? ''}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setDates((o) => o.map((y, k) => (k === i ? { ...y, date: v } : y)));
            }}
          />
          <Select
            size="xs"
            w={260}
            data={tplOptions}
            value={x.templateId}
            onChange={(v) => setDates((o) => o.map((y, k) => (k === i ? { ...y, templateId: v ?? '' } : y)))}
          />
          <NumberInput
            size="xs"
            w={80}
            min={0}
            max={100}
            value={x.required}
            onChange={(v) =>
              setDates((o) => o.map((y, k) => (k === i ? { ...y, required: Number(v) || 0 } : y)))
            }
          />
          <ActionIcon
            variant="subtle"
            color="gray"
            onClick={() => setDates((o) => o.filter((_, k) => k !== i))}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            setDates((o) => [...o, { templateId: tpls.data?.[0]?.id ?? '', date: '', required: 0 }])
          }
        >
          {s.addDate}
        </Button>
      </Group>
      <Group>
        <Button onClick={() => save.mutate(undefined)} loading={save.isPending} data-testid="demand-save">
          {t.save}
        </Button>
      </Group>
    </Stack>
  );
}

// ---------------- Смены и правила ----------------

interface Rules {
  restFactor: number;
  maxConsecutiveDays: number;
  maxShiftHours: number;
  monthNormHours: number;
  normTolerancePct: number;
  breakLateMin: number;
}
const COLORS = ['yellow', 'indigo', 'teal', 'blue', 'grape', 'orange', 'cyan', 'pink', 'lime'];

function SettingsTab() {
  const tpls = useTemplates(true);
  const st = useQuery({
    queryKey: ['/schedule/settings'],
    queryFn: () => get<{ rules: Rules; breaks: BreakRules }>('/schedule/settings'),
  });
  const [edit, setEditRaw] = useState<Partial<Template> | null>(null);
  const req = useRequired();
  const setEdit = (x: Partial<Template> | null) => {
    if (!edit && x) req.reset();
    setEditRaw(x);
  };
  const [rules, setRules] = useState<Rules | null>(null);
  const [br, setBr] = useState<{ dl: number; ds: string; nl: number; ns: string } | null>(null);
  useEffect(() => {
    if (!st.data) return;
    setRules(st.data.rules);
    const b = st.data.breaks;
    setBr({ dl: b.day.long, ds: b.day.short.join(', '), nl: b.night.long, ns: b.night.short.join(', ') });
  }, [st.data]);
  const list = (v: string) =>
    v
      .split(/[,; ]+/)
      .map(Number)
      .filter((x) => x > 0);
  const saveRules = useAction(() =>
    put('/schedule/settings', {
      rules,
      breaks: br && {
        day: { long: br.dl, short: list(br.ds) },
        night: { long: br.nl, short: list(br.ns) },
      },
    }),
  );
  const saveTpl = useAction((x: Partial<Template>) => {
    const body = {
      code: x.code,
      name: x.name,
      startMin: x.startMin,
      durationMin: x.durationMin,
      isNight: !!x.isNight,
      color: x.color ?? null,
      isActive: x.isActive ?? true,
    };
    return x.id ? patch(`/schedule/templates/${x.id}`, body) : post('/schedule/templates', body);
  });
  const num = (k: keyof Rules, label: string, step = 1) => (
    <NumberInput
      label={label}
      step={step}
      decimalScale={step < 1 ? 1 : 0}
      value={rules?.[k] ?? ''}
      onChange={(v) => setRules((o) => (o ? { ...o, [k]: Number(v) || 0 } : o))}
    />
  );
  return (
    <Stack gap="md" maw={900}>
      <Paper withBorder p="sm">
        <Group justify="space-between" mb="xs">
          <Text fw={600}>{s.templates}</Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() =>
              setEdit({ startMin: 480, durationMin: 720, isNight: false, isActive: true, color: 'blue' })
            }
          >
            {s.newTemplate}
          </Button>
        </Group>
        <Table highlightOnHover>
          <Table.Tbody>
            {(tpls.data ?? []).map((x) => (
              <Table.Tr
                key={x.id}
                style={{ cursor: 'pointer', opacity: x.isActive ? 1 : 0.5 }}
                onClick={() => setEdit(x)}
              >
                <Table.Td w={70}>
                  <Badge color={tplColor(x.color, x.isNight)} variant="light">
                    {x.code}
                  </Badge>
                </Table.Td>
                <Table.Td>{x.name}</Table.Td>
                <Table.Td>
                  {minToHm(x.startMin)}–{minToHm(x.startMin + x.durationMin)}
                </Table.Td>
                <Table.Td>
                  {x.isNight && <IconMoon size={16} color="var(--mantine-color-indigo-6)" />}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
      {br && rules && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">
            {s.breaks}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Stack gap="xs">
              <Text size="sm" c="dimmed">
                {s.dayShift}
              </Text>
              <NumberInput
                label={s.longBreak}
                value={br.dl}
                onChange={(v) => setBr({ ...br, dl: Number(v) || 0 })}
              />
              <TextInput
                label={s.shortBreaks}
                value={br.ds}
                onChange={(e) => setBr({ ...br, ds: e.currentTarget.value })}
              />
            </Stack>
            <Stack gap="xs">
              <Text size="sm" c="dimmed">
                {s.nightShift}
              </Text>
              <NumberInput
                label={s.longBreak}
                value={br.nl}
                onChange={(v) => setBr({ ...br, nl: Number(v) || 0 })}
              />
              <TextInput
                label={s.shortBreaks}
                value={br.ns}
                onChange={(e) => setBr({ ...br, ns: e.currentTarget.value })}
              />
            </Stack>
          </SimpleGrid>
          <Text fw={600} mt="md" mb={4}>
            {s.law}
          </Text>
          <Text size="xs" c="dimmed" mb="xs">
            {s.lawHint}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {num('restFactor', s.restFactor, 0.5)}
            {num('maxConsecutiveDays', s.maxConsecutiveDays)}
            {num('maxShiftHours', s.maxShiftHours)}
            {num('monthNormHours', s.monthNormHours)}
            {num('normTolerancePct', s.normTolerancePct)}
            {num('breakLateMin', s.breakLateMin)}
          </SimpleGrid>
          <Button mt="md" onClick={() => saveRules.mutate(undefined)} loading={saveRules.isPending}>
            {t.save}
          </Button>
        </Paper>
      )}
      <Modal opened={!!edit} onClose={() => setEdit(null)} title={edit?.id ? edit.name : s.newTemplate}>
        {edit && (
          <Stack gap="sm">
            <Group grow>
              <TextInput
                label={s.code}
                withAsterisk
                error={req.error(!edit.code?.trim())}
                value={edit.code ?? ''}
                onChange={(e) => setEdit({ ...edit, code: e.currentTarget.value })}
              />
              <Select
                label={s.color}
                data={COLORS}
                value={edit.color ?? null}
                onChange={(v) => setEdit({ ...edit, color: v })}
              />
            </Group>
            <TextInput
              label={s.name}
              withAsterisk
              error={req.error(!edit.name?.trim())}
              value={edit.name ?? ''}
              onChange={(e) => setEdit({ ...edit, name: e.currentTarget.value })}
            />
            <Group grow>
              <TextInput
                type="time"
                label={s.start}
                value={minToHm(edit.startMin ?? 0)}
                onChange={(e) => setEdit({ ...edit, startMin: hmToMin(e.currentTarget.value) ?? 0 })}
              />
              <NumberInput
                label={s.duration}
                min={1}
                max={24}
                step={0.25}
                decimalScale={2}
                value={(edit.durationMin ?? 0) / 60}
                onChange={(v) => setEdit({ ...edit, durationMin: Math.round((Number(v) || 0) * 60) })}
              />
            </Group>
            <Checkbox
              label={s.isNight}
              checked={!!edit.isNight}
              onChange={(e) => setEdit({ ...edit, isNight: e.currentTarget.checked })}
            />
            <Checkbox
              label={s.active}
              checked={edit.isActive ?? true}
              onChange={(e) => setEdit({ ...edit, isActive: e.currentTarget.checked })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setEdit(null)}>
                {t.cancel}
              </Button>
              <Button
                onClick={() => {
                  const missing = [!edit.code?.trim() && s.code, !edit.name?.trim() && s.name].filter(
                    (x): x is string => !!x,
                  );
                  if (req.check(missing)) saveTpl.mutate(edit, { onSuccess: () => setEdit(null) });
                }}
                loading={saveTpl.isPending}
              >
                {t.save}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
