import { Badge, Button, Divider, Group, Modal, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBell, IconCoffee, IconHeadset, IconMoon } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { get, post } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';
import { notify } from '../lib/realtime';

const s = t.schedule;
const pad = (n: number) => String(n).padStart(2, '0');
const minsk = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000);
const hm = (iso: string) => {
  const d = minsk(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

interface MyBreak {
  id: string;
  kind: 'long' | 'short';
  startAt: string;
  endAt: string;
}
interface MyShift {
  id: string;
  date: string;
  startAt: string;
  endAt: string;
  isNight: boolean;
  code: string;
  name: string;
  breaks: MyBreak[];
}

/** Опубликованный график сотрудника (смены и перерывы на ближайший месяц). */
export const useMySchedule = (enabled = true) =>
  useQuery({
    queryKey: ['/schedule/me'],
    queryFn: () => get<MyShift[]>('/schedule/me'),
    refetchInterval: 5 * 60_000,
    enabled,
  });

/** «Мой график»: текущая смена (до скольки), перерывы сегодня, ближайшие смены. */
export function MyScheduleModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const q = useMySchedule(opened);
  const now = Date.now();
  const list = (q.data ?? []).filter((x) => Date.parse(x.endAt) > now);
  const cur = list.find((x) => Date.parse(x.startAt) <= now);
  const next = list.filter((x) => x !== cur);
  return (
    <Modal opened={opened} onClose={onClose} title={s.my} size="md">
      <Stack gap="sm" data-testid="my-schedule">
        {!list.length && <Text c="dimmed">{s.myNoShift}</Text>}
        {cur && (
          <Paper withBorder p="sm" radius="md" bg="blue.0">
            <Group justify="space-between">
              <Text fw={600}>{s.myToday}</Text>
              <Badge size="lg" variant="filled" data-testid="my-shift-end">
                {s.myEndsAt(hm(cur.endAt))}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed" mb={6}>
              {s.myShiftUntil(hm(cur.startAt), hm(cur.endAt))}
            </Text>
            <Text size="sm" fw={600} mb={4}>
              {s.myBreaks}
            </Text>
            <Stack gap={4}>
              {cur.breaks.map((b) => {
                const past = Date.parse(b.endAt) <= now;
                const on = Date.parse(b.startAt) <= now && !past;
                return (
                  <Group key={b.id} gap="xs" opacity={past ? 0.45 : 1}>
                    <IconCoffee size={14} color={on ? 'var(--mantine-color-orange-6)' : undefined} />
                    <Text size="sm" fw={on ? 700 : 400} td={past ? 'line-through' : undefined}>
                      {hm(b.startAt)}–{hm(b.endAt)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {b.kind === 'long' ? s.breakLong : s.breakShort}
                    </Text>
                  </Group>
                );
              })}
            </Stack>
          </Paper>
        )}
        {next.length > 0 && (
          <>
            <Divider label={s.myUpcoming} labelPosition="left" />
            <Stack gap={4}>
              {next.slice(0, 14).map((x) => (
                <Group key={x.id} gap="xs" wrap="nowrap">
                  <Text size="sm" w={150}>
                    {dayLabel(x.date)}
                  </Text>
                  <Badge variant="light" color={x.isNight ? 'indigo' : 'blue'} w={60}>
                    {x.code}
                  </Badge>
                  <Text size="sm">
                    {hm(x.startAt)}–{hm(x.endAt)}
                  </Text>
                  {x.isNight && <IconMoon size={14} color="var(--mantine-color-indigo-6)" />}
                </Group>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Modal>
  );
}

const SNOOZE_MS = 5 * 60_000;

/**
 * Напоминания о перерывах по опубликованному графику (на всех страницах, пока оператор в работе):
 * за 5 минут — всплывающее сообщение; в начале перерыва — окно, которое нельзя просто закрыть (звук и
 * уведомление браузера; повтор — через 5 минут по кнопке); перерыв закончился, а статус «Перерыв» — окно
 * «Вернуться в работу». Супервизоры получают уведомление от сервера отдельно.
 */
export function BreakReminder() {
  const sched = useMySchedule();
  const status = useQuery({
    queryKey: ['/agent-status/me'],
    queryFn: () => get<Row>('/agent-status/me'),
    refetchInterval: 15_000,
  });
  const reasons = useList('/dict/break-reasons');
  const [now, setNow] = useState(Date.now());
  const [snooze, setSnooze] = useState<Record<string, number>>({});
  const warned = useRef(new Set<string>());
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(h);
  }, []);
  const setStatus = useAction(
    (b: Record<string, unknown>) => post('/agent-status', b),
    t.workspace.statusIzmenen,
  );
  const st = String(status.data?.status ?? 'offline');
  const since = status.data?.since ? Date.parse(String(status.data.since)) : 0;
  const breaks = (sched.data ?? []).flatMap((x) => x.breaks);
  const working = st === 'ready' || st === 'wrap_up';
  const due = working
    ? breaks.find(
        (b) => Date.parse(b.startAt) <= now && now < Date.parse(b.endAt) && (snooze[b.id] ?? 0) <= now,
      )
    : undefined;
  const over =
    st === 'break'
      ? breaks.find(
          (b) =>
            Date.parse(b.endAt) <= now &&
            now < Date.parse(b.endAt) + 3 * 3600_000 &&
            since < Date.parse(b.endAt) &&
            (snooze[`${b.id}:end`] ?? 0) <= now,
        )
      : undefined;
  const soon = working
    ? breaks.find((b) => Date.parse(b.startAt) - SNOOZE_MS <= now && now < Date.parse(b.startAt))
    : undefined;
  useEffect(() => {
    if (soon && !warned.current.has(`soon:${soon.id}`)) {
      warned.current.add(`soon:${soon.id}`);
      notifications.show({
        color: 'orange',
        icon: <IconBell size={16} />,
        message: s.breakSoon(hm(soon.startAt)),
      });
    }
  }, [soon]);
  // Звук и уведомление браузера — при каждом показе окна (и после «напомнить через 5 минут»).
  const key = due
    ? `${due.id}:${snooze[due.id] ?? 0}`
    : over
      ? `${over.id}:end:${snooze[`${over.id}:end`] ?? 0}`
      : '';
  useEffect(() => {
    if (!key || warned.current.has(key)) return;
    warned.current.add(key);
    if (due) notify(s.breakNow, s.breakNowText(hm(due.startAt), hm(due.endAt)));
    else if (over) notify(s.breakOver, s.breakOverText(hm(over.endAt)));
  }, [key, due, over]);
  const reasonFor = (b: MyBreak) => {
    const list = reasons.data ?? [];
    const word = b.kind === 'long' ? s.reasonLong : s.reasonShort;
    return (list.find((r) => String(r.name).toLowerCase().includes(word)) ?? list[0])?.id;
  };
  return (
    <>
      <Modal
        opened={!!due}
        onClose={() => undefined}
        withCloseButton={false}
        closeOnClickOutside={false}
        closeOnEscape={false}
        centered
        size="sm"
        data-testid="break-due"
      >
        {due && (
          <Stack align="center" gap="sm">
            <ThemeIcon size={56} radius="xl" color="orange" variant="light">
              <IconCoffee size={32} />
            </ThemeIcon>
            <Text fw={700} size="lg">
              {s.breakNow}
            </Text>
            <Text ta="center">{s.breakNowText(hm(due.startAt), hm(due.endAt))}</Text>
            <Button
              fullWidth
              color="orange"
              leftSection={<IconCoffee size={16} />}
              onClick={() => {
                const reasonId = reasonFor(due);
                setStatus.mutate({ status: 'break', ...(reasonId ? { reasonId } : {}) });
              }}
              loading={setStatus.isPending}
              data-testid="break-start"
            >
              {s.startBreak}
            </Button>
            <Button
              fullWidth
              variant="subtle"
              color="gray"
              onClick={() => setSnooze((o) => ({ ...o, [due.id]: Date.now() + SNOOZE_MS }))}
              data-testid="break-snooze"
            >
              {s.snooze}
            </Button>
          </Stack>
        )}
      </Modal>
      <Modal
        opened={!due && !!over}
        onClose={() => undefined}
        withCloseButton={false}
        closeOnClickOutside={false}
        closeOnEscape={false}
        centered
        size="sm"
      >
        {over && (
          <Stack align="center" gap="sm">
            <ThemeIcon size={56} radius="xl" color="green" variant="light">
              <IconHeadset size={32} />
            </ThemeIcon>
            <Text fw={700} size="lg">
              {s.breakOver}
            </Text>
            <Text ta="center">{s.breakOverText(hm(over.endAt))}</Text>
            <Button
              fullWidth
              color="green"
              leftSection={<IconHeadset size={16} />}
              onClick={() => setStatus.mutate({ status: 'ready' })}
              loading={setStatus.isPending}
              data-testid="break-back"
            >
              {s.backToWork}
            </Button>
            <Button
              fullWidth
              variant="subtle"
              color="gray"
              onClick={() => setSnooze((o) => ({ ...o, [`${over.id}:end`]: Date.now() + SNOOZE_MS }))}
            >
              {s.snooze}
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  );
}
