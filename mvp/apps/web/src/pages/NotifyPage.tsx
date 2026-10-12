import {
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  PasswordInput,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FormModal } from '../components/FormModal';
import { del, get, patch, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

interface EventDef {
  code: string;
  title: string;
  description: string;
  optIn: boolean;
  group: string;
}

/** Правила: событие → каналы → роли и сотрудники. */
function RulesTab() {
  const { can } = useAuth();
  const events = useList<EventDef>('/notify/events');
  const rules = useList('/notify/rules');
  const roles = useList('/users/roles');
  const users = useList('/users');
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const save = useAction((v: Record<string, unknown>) =>
    editing === 'new' || !editing
      ? post('/notify/rules', v)
      : patch(`/notify/rules/${String((editing as Row).id)}`, v),
  );
  const remove = useAction((id: string) => del(`/notify/rules/${id}`), t.notify.deleted);
  const toggle = useAction((r: Row) => patch(`/notify/rules/${String(r.id)}`, { isActive: !r.isActive }));
  const ev = (events.data ?? []).filter((e) => !e.optIn);
  const roleName = (c: string) => String((roles.data ?? []).find((r) => r.code === c)?.name ?? c);
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {t.notify.rulesHint}
      </Text>
      <Group>
        <Button size="xs" onClick={() => setEditing('new')} data-testid="rule-add">
          {t.notify.addRule}
        </Button>
      </Group>
      <Table striped data-testid="rules-table">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.notify.colEvent}</Table.Th>
            <Table.Th>{t.notify.colChannels}</Table.Th>
            <Table.Th>{t.notify.colRecipients}</Table.Th>
            <Table.Th>{t.notify.colActive}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(rules.data ?? []).map((r) => (
            <Table.Tr
              key={r.id}
              opacity={r.isActive ? 1 : 0.5}
              data-testid="rule-row"
              data-event={String(r.event)}
            >
              <Table.Td>
                <Text size="sm" fw={600}>
                  {String(r.title)}
                </Text>
                {r.name ? (
                  <Text size="xs" c="dimmed">
                    {String(r.name)}
                  </Text>
                ) : null}
              </Table.Td>
              <Table.Td>
                <Group gap={4}>
                  {((r.channels as string[]) ?? []).map((c) => (
                    <Badge key={c} size="xs" variant="light">
                      {t.notify.channel[c] ?? c}
                    </Badge>
                  ))}
                </Group>
              </Table.Td>
              <Table.Td>
                <Text size="xs">
                  {[
                    ...((r.roleCodes as string[]) ?? []).map(roleName),
                    ...((r.userNames as string[] | null) ?? []),
                  ].join(', ')}
                </Text>
              </Table.Td>
              <Table.Td>{r.isActive ? t.yes : t.no}</Table.Td>
              <Table.Td>
                <Group gap="xs" justify="flex-end" wrap="nowrap">
                  <Button size="xs" variant="light" onClick={() => setEditing(r)} data-testid="rule-edit">
                    {t.edit}
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => toggle.mutate(r)}>
                    {r.isActive ? t.deactivate : t.activate}
                  </Button>
                  {can('settings.manage') && (
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => remove.mutate(String(r.id))}
                    >
                      {t.notify.deleteRule}
                    </Button>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <FormModal
        opened={editing !== null}
        title={t.notify.ruleTitle}
        isCreate={editing === 'new'}
        initial={
          editing && editing !== 'new'
            ? {
                event: editing.event,
                name: editing.name,
                channels: editing.channels,
                roleCodes: editing.roleCodes,
                userIds: editing.userIds,
                isActive: editing.isActive,
              }
            : { channels: ['ui'], roleCodes: ['supervisor'], isActive: true }
        }
        fields={[
          {
            key: 'event',
            label: t.notify.event,
            type: 'select',
            required: true,
            options: ev.map((e) => ({
              value: e.code,
              label: `${t.notify.group[e.group] ?? e.group}: ${e.title}`,
            })),
          },
          { key: 'name', label: t.notify.name },
          {
            key: 'channels',
            label: t.notify.channels,
            type: 'multiselect',
            required: true,
            options: ['ui', 'email', 'telegram'].map((c) => ({ value: c, label: t.notify.channel[c]! })),
          },
          {
            key: 'roleCodes',
            label: t.notify.roles,
            type: 'multiselect',
            options: (roles.data ?? []).map((r) => ({ value: String(r.code), label: String(r.name) })),
          },
          {
            key: 'userIds',
            label: t.notify.users,
            type: 'multiselect',
            options: (users.data ?? []).map((u) => ({ value: String(u.id), label: String(u.fullName) })),
          },
          { key: 'isActive', label: t.notify.active, type: 'switch' },
        ]}
        loading={save.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(v) =>
          save.mutate(
            { ...v, name: v.name ?? '', roleCodes: v.roleCodes ?? [], userIds: v.userIds ?? [] },
            { onSuccess: () => setEditing(null) },
          )
        }
      />
    </Stack>
  );
}

/** Минимум операторов на линии: сетка день недели × час. */
function StaffingTab() {
  const q = useQuery({
    queryKey: ['/staffing/minimum'],
    queryFn: () => get<{ cells: { weekday: number; hour: number; required: number }[] }>('/staffing/minimum'),
  });
  const [grid, setGrid] = useState<number[][]>(() => Array.from({ length: 7 }, () => Array(24).fill(0)));
  useEffect(() => {
    if (!q.data) return;
    const g = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const c of q.data.cells) g[c.weekday - 1]![c.hour] = c.required;
    setGrid(g);
  }, [q.data]);
  const save = useAction(
    () =>
      put('/staffing/minimum', {
        cells: grid.flatMap((row, d) => row.map((required, hour) => ({ weekday: d + 1, hour, required }))),
      }),
    t.notify.staffingSaved,
  );
  const [fill, setFill] = useState<number | ''>(2);
  const set = (d: number, h: number, v: number) =>
    setGrid((g) => g.map((row, i) => (i === d ? row.map((x, j) => (j === h ? v : x)) : row)));
  const fillRow = (d: number) =>
    setGrid((g) => g.map((row, i) => (i === d ? row.map(() => Number(fill) || 0) : row)));
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {t.notify.staffingHint}
      </Text>
      <Group gap="xs">
        <NumberInput
          size="xs"
          w={90}
          min={0}
          max={1000}
          value={fill}
          onChange={(x) => setFill(x === '' ? '' : Number(x))}
          data-testid="staffing-fill-value"
        />
        <Text size="xs" c="dimmed">
          {t.notify.staffingFillHint}
        </Text>
      </Group>
      <Table withTableBorder withColumnBorders style={{ fontSize: 12 }} data-testid="staffing-grid">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.notify.staffingDay}</Table.Th>
            {Array.from({ length: 24 }, (_, h) => (
              <Table.Th key={h} ta="center" px={2}>
                {h}
              </Table.Th>
            ))}
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {grid.map((row, d) => (
            <Table.Tr key={d}>
              <Table.Td fw={600}>{t.notify.weekdays[d]}</Table.Td>
              {row.map((v, h) => (
                <Table.Td key={h} p={0}>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={v || ''}
                    onChange={(e) => set(d, h, Number(e.currentTarget.value) || 0)}
                    style={{
                      width: 34,
                      border: 'none',
                      textAlign: 'center',
                      background: v ? '#fff4e6' : 'transparent',
                    }}
                    data-testid={`staffing-${d + 1}-${h}`}
                  />
                </Table.Td>
              ))}
              <Table.Td>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => fillRow(d)}
                  data-testid={`staffing-fill-${d + 1}`}
                >
                  {t.notify.staffingFill}
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group>
        <Button
          size="xs"
          onClick={() => save.mutate(undefined)}
          loading={save.isPending}
          data-testid="staffing-save"
        >
          {t.notify.staffingSave}
        </Button>
      </Group>
    </Stack>
  );
}

/** Бот Telegram для сотрудников: токен, адрес Bot API, адрес мини-приложения. */
function TelegramTab() {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['/notify/telegram'],
    queryFn: () =>
      get<{
        configured: boolean;
        botTokenMasked: string | null;
        apiRoot: string;
        miniAppUrl: string | null;
        botUsername: string | null;
      }>('/notify/telegram'),
  });
  const [v, setV] = useState({ botToken: '', apiRoot: '', miniAppUrl: '' });
  useEffect(() => {
    if (q.data) setV({ botToken: '', apiRoot: q.data.apiRoot ?? '', miniAppUrl: q.data.miniAppUrl ?? '' });
  }, [q.data]);
  const save = useAction(() =>
    patch('/notify/telegram', {
      ...(v.botToken.trim() ? { botToken: v.botToken.trim() === '-' ? null : v.botToken.trim() } : {}),
      apiRoot: v.apiRoot.trim() || null,
      miniAppUrl: v.miniAppUrl.trim() || null,
    }),
  );
  return (
    <Stack gap="sm" maw={620}>
      <Text size="xs" c="dimmed">
        {t.notify.telegramHint}
      </Text>
      <Group gap="xs">
        <Text size="sm">{t.notify.botStatus}:</Text>
        <Badge color={q.data?.configured ? 'green' : 'gray'} data-testid="bot-status">
          {q.data?.configured ? t.notify.botConfigured(q.data.botUsername) : t.notify.botNotConfigured}
        </Badge>
      </Group>
      <PasswordInput
        label={t.notify.botToken}
        description={t.notify.botTokenHint}
        placeholder={q.data?.botTokenMasked ?? ''}
        value={v.botToken}
        onChange={(e) => setV({ ...v, botToken: e.currentTarget.value })}
        disabled={!can('settings.manage')}
        data-testid="bot-token"
      />
      <TextInput
        label={t.notify.apiRoot}
        value={v.apiRoot}
        onChange={(e) => setV({ ...v, apiRoot: e.currentTarget.value })}
        disabled={!can('settings.manage')}
        data-testid="bot-api-root"
      />
      <TextInput
        label={t.notify.miniAppUrl}
        description={t.notify.miniAppHint}
        value={v.miniAppUrl}
        onChange={(e) => setV({ ...v, miniAppUrl: e.currentTarget.value })}
        disabled={!can('settings.manage')}
        data-testid="bot-miniapp"
      />
      {can('settings.manage') && (
        <Group>
          <Button
            size="xs"
            onClick={() => save.mutate(undefined)}
            loading={save.isPending}
            data-testid="bot-save"
          >
            {t.notify.telegramSave}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

/** Почта: копии писем и фраза про отписку. */
function MailTab() {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['/notify/mail'],
    queryFn: () => get<{ copyTo: string[]; unsubscribePhrase: string }>('/notify/mail'),
  });
  const [copyTo, setCopyTo] = useState('');
  useEffect(() => {
    if (q.data) setCopyTo(q.data.copyTo.join('\n'));
  }, [q.data]);
  const save = useAction(() =>
    patch('/notify/mail', {
      copyTo: copyTo
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    }),
  );
  return (
    <Stack gap="sm" maw={620}>
      <Text size="xs" c="dimmed">
        {t.notify.mailHint}
      </Text>
      <Textarea
        label={t.notify.mailCopyTo}
        autosize
        minRows={2}
        value={copyTo}
        onChange={(e) => setCopyTo(e.currentTarget.value)}
        disabled={!can('settings.manage')}
        data-testid="mail-copy-to"
      />
      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          {t.notify.mailPhrase}
        </Text>
        <Text size="sm">{q.data?.unsubscribePhrase}</Text>
      </Paper>
      {can('settings.manage') && (
        <Group>
          <Button
            size="xs"
            onClick={() => save.mutate(undefined)}
            loading={save.isPending}
            data-testid="mail-save"
          >
            {t.notify.mailSave}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

/** Уведомления о событиях (Д-012), минимум операторов (Д-011), бот Telegram (Д-010), почта (Д-013). */
export function NotifyPage() {
  const [tab, setTab] = useState<string | null>('rules');
  return (
    <Stack>
      <Title order={3}>{t.notify.pageTitle}</Title>
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="rules" data-testid="notify-tab-rules">
            {t.notify.tabRules}
          </Tabs.Tab>
          <Tabs.Tab value="staffing" data-testid="notify-tab-staffing">
            {t.notify.tabStaffing}
          </Tabs.Tab>
          <Tabs.Tab value="telegram" data-testid="notify-tab-telegram">
            {t.notify.tabTelegram}
          </Tabs.Tab>
          <Tabs.Tab value="mail" data-testid="notify-tab-mail">
            {t.notify.tabMail}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="rules" pt="sm">
          <RulesTab />
        </Tabs.Panel>
        <Tabs.Panel value="staffing" pt="sm">
          <StaffingTab />
        </Tabs.Panel>
        <Tabs.Panel value="telegram" pt="sm">
          <TelegramTab />
        </Tabs.Panel>
        <Tabs.Panel value="mail" pt="sm">
          <MailTab />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
