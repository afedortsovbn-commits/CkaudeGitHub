import { Badge, Button, Menu, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCalendarTime, IconChevronDown, IconCoffee, IconHeadset, IconLogout } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';
import { softphone } from '../lib/softphone';
import { MyScheduleModal } from './MySchedule';

/** Статус перерыва/постобработки опрашивается чаще (постобработка заканчивается сама). */
const STATUS_POLL_MS = 5000;

const hhmm = (s: unknown) =>
  s
    ? new Date(String(s)).toLocaleTimeString('ru-RU', {
        timeZone: 'Europe/Minsk',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

/**
 * Статус оператора в шапке: «В работе» или «Перерыв» (с причиной и временем начала); постобработка — сама.
 * Время начала и конца каждого статуса пишется в журнал статусов. «Завершить смену» — уйти из распределения.
 */
export function AgentStatusMenu() {
  const reasons = useList('/dict/break-reasons');
  const [myOpen, setMyOpen] = useState(false);
  const status = useQuery({
    queryKey: ['/agent-status/me'],
    queryFn: () => get<Row>('/agent-status/me'),
    refetchInterval: STATUS_POLL_MS,
  });
  const setStatus = useAction(
    (b: Record<string, unknown>) => post('/agent-status', b),
    t.workspace.statusIzmenen,
  );
  const cur = String(status.data?.status ?? 'offline');
  const reason = (reasons.data ?? []).find((r) => r.id === status.data?.reasonId);
  const since = hhmm(status.data?.since);
  const toReady = () => {
    // Интеграция со статусом (Ф5b): «В работе» без подключённого телефона — звонки не придут, чаты — да.
    if (softphone.getSnapshot().reg !== 'registered')
      notifications.show({
        color: 'yellow',
        title: t.workspace.telefonNePodklyuchen,
        message: t.workspace.zvonkiPostupatNeBudut,
        autoClose: 8000,
      });
    setStatus.mutate({ status: 'ready' });
  };
  let label: string;
  let color: string;
  if (cur === 'wrap_up') {
    const until = status.data?.wrapUpUntil ? new Date(String(status.data.wrapUpUntil)).getTime() : 0;
    label = `${t.workspace.postobrabotka}${Math.max(0, Math.round((until - Date.now()) / 1000))}${t.workspace.s}`;
    color = 'yellow';
  } else if (cur === 'break') {
    label = `${t.workspace.pereryv}${reason ? ` · ${String(reason.name)}` : ''}${since ? ` ${t.workspace.statusSince(since)}` : ''}`;
    color = 'orange';
  } else if (cur === 'ready') {
    label = t.workspace.statusWork;
    color = 'green';
  } else {
    label = t.workspace.statusOff;
    color = 'gray';
  }
  return (
    <>
      <MyScheduleModal opened={myOpen} onClose={() => setMyOpen(false)} />
      <Menu position="bottom-start" shadow="md" withinPortal>
        <Menu.Target>
          <Button
            size="compact-sm"
            variant="light"
            color={color}
            leftSection={<Badge size="xs" circle color={color} variant="filled" />}
            rightSection={<IconChevronDown size={14} />}
            data-testid="agent-status"
            data-status={cur}
          >
            {label}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconHeadset size={16} />}
            color="green"
            onClick={toReady}
            disabled={cur === 'ready'}
            data-testid="agent-status-ready"
          >
            {t.workspace.statusWork}
          </Menu.Item>
          <Menu.Label>{t.workspace.pereryv}</Menu.Label>
          {(reasons.data ?? []).map((r, i) => (
            <Menu.Item
              key={r.id}
              leftSection={<IconCoffee size={16} />}
              color="orange"
              onClick={() => setStatus.mutate({ status: 'break', reasonId: r.id })}
              data-testid={`agent-status-break-${i}`}
            >
              {String(r.name)}
            </Menu.Item>
          ))}
          {!(reasons.data ?? []).length && (
            <Menu.Item
              leftSection={<IconCoffee size={16} />}
              color="orange"
              onClick={() => setStatus.mutate({ status: 'break' })}
              data-testid="agent-status-break-0"
            >
              {t.workspace.pereryv}
            </Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconCalendarTime size={16} />}
            onClick={() => setMyOpen(true)}
            data-testid="my-schedule-open"
          >
            {t.schedule.my}
          </Menu.Item>
          <Menu.Item
            leftSection={<IconLogout size={16} />}
            onClick={() => setStatus.mutate({ status: 'offline' })}
            disabled={cur === 'offline'}
            data-testid="agent-status-offline"
          >
            <Text size="sm">{t.workspace.statusEndShift}</Text>
            <Text size="xs" c="dimmed">
              {t.workspace.statusEndShiftHint}
            </Text>
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}
