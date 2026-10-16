import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Divider,
  Group,
  Paper,
  Popover,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconAlarm,
  IconArrowForwardUp,
  IconBell,
  IconBrandTelegram,
  IconCalendar,
  IconChevronDown,
  IconChevronRight,
  IconClockExclamation,
  IconCoffee,
  IconCopy,
  IconHourglass,
  IconListCheck,
  IconMail,
  IconMessage,
  IconMoodSad,
  IconSchool,
  IconServer,
  IconSpeakerphone,
  IconTicket,
  IconUserOff,
  IconUsersMinus,
  type Icon,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { get, post, put } from '../lib/api';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

interface MatrixEvent {
  code: string;
  title: string;
  description: string;
  group: string;
  optIn: boolean;
  relations?: string[];
}
interface MatrixUser {
  id: string;
  fullName: string;
  email: string;
  emailUnsubscribed: boolean;
  telegramContact: string | null;
  telegramLinked: boolean;
  telegramOk: boolean;
  enterpriseId: string | null;
  enterpriseName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  roleNames: string[];
}
interface Cell {
  channels: string[];
  conditions: string[];
}
interface MatrixData {
  events: MatrixEvent[];
  users: MatrixUser[];
  cells: (Cell & { userId: string; event: string })[];
}

const EVENT_ICON: Record<string, Icon> = {
  'operators.below_min': IconUsersMinus,
  'queue.long_wait': IconHourglass,
  'queue.no_free': IconUserOff,
  'conversation.overdue': IconClockExclamation,
  'review.negative': IconMoodSad,
  'ticket.created': IconArrowForwardUp,
  'ticket.overdue': IconAlarm,
  'ticket.open_reminder': IconListCheck,
  'break.violation': IconCoffee,
  'resource.alert': IconServer,
  'my.conversation': IconMessage,
  'my.ticket': IconTicket,
  'my.test': IconSchool,
  'my.message': IconSpeakerphone,
  'my.shift': IconCalendar,
};
const CHANNEL_ICON: Record<string, Icon> = { ui: IconBell, email: IconMail, telegram: IconBrandTelegram };
const CHANNEL_COLOR: Record<string, string> = { ui: '#1c7ed6', email: '#e8590c', telegram: '#1098ad' };
const GROUP_ORDER = ['line', 'second', 'system', 'me'];

const key = (userId: string, event: string) => `${userId}|${event}`;

/** Канал выбран, а контакта у сотрудника нет (почта отписана, Telegram не указан и не привязан). */
function missing(u: MatrixUser, channels: string[]): string[] {
  const out: string[] = [];
  if (channels.includes('email') && (!u.email || u.emailUnsubscribed)) out.push(t.notify.mxNoEmail);
  if (channels.includes('telegram') && !u.telegramOk)
    out.push(u.telegramContact ? t.notify.mxTgNotLinked : t.notify.mxNoTelegram);
  return out;
}

function CellEditor({
  user,
  ev,
  cell,
  onChange,
  onCopyColumn,
}: {
  user: MatrixUser;
  ev: MatrixEvent;
  cell: Cell | undefined;
  onChange(c: Cell): void;
  onCopyColumn(): void;
}) {
  const [opened, setOpened] = useState(false);
  const channels = cell?.channels ?? [];
  const conditions = cell?.conditions?.length ? cell.conditions : ['all'];
  const problems = missing(user, channels);
  const rel = ev.relations ?? [];
  const setChannels = (c: string, on: boolean) =>
    onChange({
      channels: on ? [...new Set([...channels, c])] : channels.filter((x) => x !== c),
      conditions,
    });
  const setCondition = (c: string, on: boolean) => {
    let next = on ? [...conditions.filter((x) => x !== 'all'), c] : conditions.filter((x) => x !== c);
    if (c === 'all' && on) next = ['all'];
    if (!next.length) next = ['all'];
    onChange({ channels, conditions: next });
  };
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom" withArrow shadow="md" width={260}>
      <Popover.Target>
        <button
          type="button"
          className="cc-mx-cell"
          onClick={() => setOpened((o) => !o)}
          data-testid="mx-cell"
          data-user={user.id}
          data-event={ev.code}
          data-problem={problems.length ? 'yes' : undefined}
          style={{
            background: problems.length ? '#fff0f0' : channels.length ? '#f3f9ff' : 'transparent',
            outline: problems.length ? '2px solid #fa5252' : undefined,
          }}
          title={problems.join('; ') || undefined}
        >
          {channels.length ? (
            <Group gap={1} wrap="nowrap" justify="center">
              {channels.map((c) => {
                const I = CHANNEL_ICON[c]!;
                const bad =
                  (c === 'email' && (!user.email || user.emailUnsubscribed)) ||
                  (c === 'telegram' && !user.telegramOk);
                return <I key={c} size={14} color={bad ? '#fa5252' : CHANNEL_COLOR[c]} />;
              })}
              {!conditions.includes('all') && (
                <Text span size="9px" fw={700} c="grape.7" ml={1}>
                  {conditions.map((c) => t.notify.mxRelShort[c] ?? c).join('')}
                </Text>
              )}
            </Group>
          ) : (
            <Text span size="xs" c="gray.4">
              ·
            </Text>
          )}
        </button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={6}>
          <Text size="xs" fw={700}>
            {ev.title}
          </Text>
          <Text size="xs" c="dimmed">
            {user.fullName}
          </Text>
          <Divider label={t.notify.mxChannels} labelPosition="left" />
          {['ui', 'email', 'telegram'].map((c) => {
            const I = CHANNEL_ICON[c]!;
            return (
              <Checkbox
                key={c}
                size="xs"
                checked={channels.includes(c)}
                onChange={(e) => setChannels(c, e.currentTarget.checked)}
                label={
                  <Group gap={4}>
                    <I size={14} color={CHANNEL_COLOR[c]} />
                    {t.notify.channel[c]}
                  </Group>
                }
                data-testid={`mx-ch-${c}`}
              />
            );
          })}
          {problems.length > 0 && (
            <Text size="xs" c="red" data-testid="mx-problem">
              {problems.join('; ')}
            </Text>
          )}
          {!ev.optIn && (
            <>
              <Divider label={t.notify.mxWhen} labelPosition="left" />
              {['all', ...rel].map((c) => (
                <Checkbox
                  key={c}
                  size="xs"
                  checked={conditions.includes(c)}
                  onChange={(e) => setCondition(c, e.currentTarget.checked)}
                  label={t.notify.mxRel[c] ?? c}
                  data-testid={`mx-cond-${c}`}
                />
              ))}
            </>
          )}
          <Button
            size="compact-xs"
            variant="light"
            leftSection={<IconCopy size={12} />}
            onClick={() => {
              setOpened(false);
              onCopyColumn();
            }}
            data-testid="mx-copy-column"
          >
            {t.notify.mxCopyColumn}
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * Матрица уведомлений (Д-094): строки — сотрудники по предприятиям и подразделениям (с ролями), столбцы — события
 * (значки с подсказкой), на пересечении — каналы и условие получения. Ячейка сохраняется сразу; «Скопировать на
 * всех» — строку сотрудника или один столбец. Выбран канал, а контакта нет — ячейка подсвечена красным.
 */
export function NotifyMatrixTab() {
  const q = useQuery({ queryKey: ['/notify/matrix'], queryFn: () => get<MatrixData>('/notify/matrix') });
  const [cells, setCells] = useState<Map<string, Cell>>(new Map());
  const [search, setSearch] = useState('');
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (q.data) setCells(new Map(q.data.cells.map((c) => [key(c.userId, c.event), c])));
  }, [q.data]);
  const saveCell = useAction(
    (v: { userId: string; event: string } & Cell) => put('/notify/matrix/cell', v),
    t.notify.mxSaved,
  );
  const copy = useAction(
    (v: { fromUserId: string; event?: string }) =>
      post<{ users: number; cells: number }>('/notify/matrix/copy', v),
    t.notify.mxCopied,
  );
  const events = useMemo(
    () =>
      [...(q.data?.events ?? [])].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)),
    [q.data],
  );
  const groups = GROUP_ORDER.map((g) => ({ g, n: events.filter((e) => e.group === g).length })).filter(
    (x) => x.n,
  );
  const users = (q.data?.users ?? []).filter(
    (u) =>
      (!search || u.fullName.toLowerCase().includes(search.toLowerCase())) &&
      (!onlyFilled || events.some((e) => cells.get(key(u.id, e.code))?.channels.length)),
  );
  // Иерархия: предприятие → подразделение → сотрудники.
  const tree = new Map<string, Map<string, MatrixUser[]>>();
  for (const u of users) {
    const ent = u.enterpriseName ?? t.notify.mxNoEnterprise;
    const dep = u.departmentName ?? t.notify.mxNoDepartment;
    if (!tree.has(ent)) tree.set(ent, new Map());
    const d = tree.get(ent)!;
    d.set(dep, [...(d.get(dep) ?? []), u]);
  }
  const toggle = (k: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const change = (u: MatrixUser, ev: MatrixEvent, c: Cell) => {
    setCells((m) => new Map(m).set(key(u.id, ev.code), c));
    saveCell.mutate({ userId: u.id, event: ev.code, ...c });
  };
  const problems = users.reduce(
    (n, u) =>
      n + events.filter((e) => missing(u, cells.get(key(u.id, e.code))?.channels ?? []).length).length,
    0,
  );
  const cols = events.length + 2;
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {t.notify.mxHint}
      </Text>
      <Group gap="md" wrap="wrap">
        <TextInput
          size="xs"
          w={240}
          placeholder={t.notify.mxSearch}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          data-testid="mx-search"
        />
        <Switch
          size="xs"
          label={t.notify.mxOnlyFilled}
          checked={onlyFilled}
          onChange={(e) => setOnlyFilled(e.currentTarget.checked)}
        />
        <Group gap={10}>
          {['ui', 'email', 'telegram'].map((c) => {
            const I = CHANNEL_ICON[c]!;
            return (
              <Group key={c} gap={3}>
                <I size={14} color={CHANNEL_COLOR[c]} />
                <Text size="xs">{t.notify.channel[c]}</Text>
              </Group>
            );
          })}
          <Text size="xs" c="grape.7" fw={600}>
            {t.notify.mxRelLegend}
          </Text>
        </Group>
        {problems > 0 && (
          <Badge color="red" variant="light" data-testid="mx-problems">
            {t.notify.mxProblems(problems)}
          </Badge>
        )}
      </Group>
      <Paper withBorder style={{ overflow: 'auto', maxHeight: 'calc(100vh - 260px)' }}>
        <Table className="cc-mx" withColumnBorders stickyHeader data-testid="mx-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th className="cc-mx-first" rowSpan={2}>
                {t.notify.mxEmployee}
              </Table.Th>
              {groups.map(({ g, n }) => (
                <Table.Th key={g} colSpan={n} ta="center" style={{ fontSize: 11 }}>
                  {t.notify.group[g]}
                </Table.Th>
              ))}
              <Table.Th rowSpan={2} />
            </Table.Tr>
            <Table.Tr>
              {events.map((e) => {
                const I = EVENT_ICON[e.code] ?? IconBell;
                return (
                  <Table.Th key={e.code} ta="center" p={4}>
                    <Tooltip
                      multiline
                      w={260}
                      withArrow
                      label={
                        <>
                          <b>{e.title}</b>
                          <br />
                          {e.description}
                        </>
                      }
                    >
                      <span data-testid="mx-event" data-event={e.code} style={{ display: 'inline-flex' }}>
                        <I size={18} />
                      </span>
                    </Tooltip>
                  </Table.Th>
                );
              })}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[...tree.entries()].map(([ent, deps]) => (
              <EnterpriseRows
                key={ent}
                ent={ent}
                deps={deps}
                cols={cols}
                collapsed={collapsed}
                toggle={toggle}
                render={(u) => (
                  <Table.Tr key={u.id} data-testid="mx-row" data-user={u.id}>
                    <Table.Td className="cc-mx-first">
                      <Text size="xs" fw={600} lh={1.2}>
                        {u.fullName}
                      </Text>
                      <Group gap={4} wrap="nowrap">
                        <Text size="10px" c="dimmed" lh={1.2} truncate maw={150}>
                          {u.roleNames.join(', ')}
                        </Text>
                        <Tooltip label={u.emailUnsubscribed ? t.notify.mxEmailUnsub : u.email}>
                          <IconMail size={11} color={u.emailUnsubscribed ? '#fa5252' : '#adb5bd'} />
                        </Tooltip>
                        <Tooltip
                          label={
                            u.telegramOk
                              ? u.telegramLinked
                                ? t.notify.mxTgLinked
                                : u.telegramContact
                              : u.telegramContact
                                ? t.notify.mxTgNotLinked
                                : t.notify.mxNoTelegram
                          }
                        >
                          <IconBrandTelegram size={11} color={u.telegramOk ? '#1098ad' : '#ced4da'} />
                        </Tooltip>
                      </Group>
                    </Table.Td>
                    {events.map((e) => (
                      <Table.Td key={e.code} p={2} ta="center">
                        <CellEditor
                          user={u}
                          ev={e}
                          cell={cells.get(key(u.id, e.code))}
                          onChange={(c) => change(u, e, c)}
                          onCopyColumn={() => {
                            if (window.confirm(t.notify.mxCopyColumnConfirm(u.fullName, e.title)))
                              copy.mutate({ fromUserId: u.id, event: e.code });
                          }}
                        />
                      </Table.Td>
                    ))}
                    <Table.Td p={2}>
                      <Tooltip label={t.notify.mxCopyRow}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          onClick={() => {
                            if (window.confirm(t.notify.mxCopyRowConfirm(u.fullName)))
                              copy.mutate({ fromUserId: u.id });
                          }}
                          aria-label={t.notify.mxCopyRow}
                          data-testid="mx-copy-row"
                        >
                          <IconCopy size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                )}
              />
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  );
}

function EnterpriseRows({
  ent,
  deps,
  cols,
  collapsed,
  toggle,
  render,
}: {
  ent: string;
  deps: Map<string, MatrixUser[]>;
  cols: number;
  collapsed: Set<string>;
  toggle(k: string): void;
  render(u: MatrixUser): ReactNode;
}) {
  const total = [...deps.values()].reduce((n, l) => n + l.length, 0);
  const closed = collapsed.has(ent);
  return (
    <>
      <Table.Tr className="cc-mx-group" onClick={() => toggle(ent)} data-testid="mx-enterprise">
        <Table.Td colSpan={cols}>
          <Group gap={4}>
            {closed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
            <Text size="xs" fw={700}>
              {ent}
            </Text>
            <Text size="xs" c="dimmed">
              ({total})
            </Text>
          </Group>
        </Table.Td>
      </Table.Tr>
      {!closed &&
        [...deps.entries()].map(([dep, list]) => {
          const k = `${ent}|${dep}`;
          const dClosed = collapsed.has(k);
          return [
            <Table.Tr key={k} className="cc-mx-sub" onClick={() => toggle(k)}>
              <Table.Td colSpan={cols} pl={22}>
                <Group gap={4}>
                  {dClosed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                  <Text size="xs" fw={600} c="dimmed">
                    {dep} ({list.length})
                  </Text>
                </Group>
              </Table.Td>
            </Table.Tr>,
            ...(dClosed ? [] : list.map(render)),
          ];
        })}
    </>
  );
}
