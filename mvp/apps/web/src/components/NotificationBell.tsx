import { ActionIcon, Badge, Button, Group, Indicator, Popover, ScrollArea, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post } from '../lib/api';
import type { Row } from '../lib/data';
import { notify, onRealtime } from '../lib/realtime';
import { t } from '../lib/i18n';

const EVENT_TEXT: Record<string, string> = {
  'ticket.assigned': t.notificationBellUi.naznachenVam,
  'ticket.redirected': t.notificationBellUi.pereadresovan,
  'ticket.client_message': t.notificationBellUi.novoeSoobshchenieKlienta,
  'ticket.needs_reassign': t.notificationBellUi.trebuetPerenaznacheniya,
  'ticket.commented': t.notificationBellUi.novyyKommentariy,
};
const STATUS_TEXT: Record<string, string> = {
  approval: t.notificationBellUi.ozhidaetSoglasovaniya,
  rework: t.notificationBellUi.vozvrashchenNaDorabotku,
  closed: t.notificationBellUi.prinyatIZakryt,
  in_work: t.notificationBellUi.vzyatVRabotu,
};

const when = (s: unknown) =>
  new Date(String(s)).toLocaleString('ru-RU', {
    timeZone: 'Europe/Minsk',
    dateStyle: 'short',
    timeStyle: 'short',
  });

/** Колокольчик уведомлений по тикетам (M-TKT-12): счётчик непрочитанных, список, всплывающее уведомление. */
export function NotificationBell() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [opened, setOpened] = useState(false);
  const q = useQuery({
    queryKey: ['/notifications'],
    queryFn: () => get<{ items: Row[]; unread: number }>('/notifications?limit=30'),
    refetchInterval: 30_000,
  });
  useEffect(
    () =>
      onRealtime((e) => {
        if (e.type !== 'ticket') return;
        void qc.invalidateQueries({
          predicate: (x) => /^\/(notifications|tickets)/.test(String(x.queryKey[0])),
        });
        const d = (e.data ?? {}) as { number?: number; status?: string };
        const text =
          e.event === 'ticket.status_changed'
            ? (STATUS_TEXT[String(d.status)] ?? t.notificationBellUi.izmenen)
            : (EVENT_TEXT[String(e.event)] ?? t.notificationBellUi.obnovlen);
        notifications.show({
          color: 'blue',
          title: t.notificationBellUi.tiket(String(d.number ?? '')),
          message: text,
        });
        notify(t.notificationBellUi.tiket(String(d.number ?? '')), text);
      }),
    [qc],
  );
  const unread = q.data?.unread ?? 0;
  const readAll = () =>
    void post('/notifications/read').then(() => qc.invalidateQueries({ queryKey: ['/notifications'] }));
  return (
    <Popover opened={opened} onChange={setOpened} width={360} position="bottom-end" withArrow>
      <Popover.Target>
        <Indicator label={unread} size={16} disabled={!unread} color="red" data-testid="bell-count">
          <ActionIcon
            variant="subtle"
            size="lg"
            onClick={() => setOpened((o) => !o)}
            aria-label={t.notificationBellUi.uvedomleniya}
            data-testid="bell"
          >
            🔔
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown>
        <Group justify="space-between" mb="xs">
          <Text fw={600} size="sm">
            {t.notificationBellUi.uvedomleniya}
          </Text>
          <Button size="compact-xs" variant="subtle" disabled={!unread} onClick={readAll}>
            {t.notificationBellUi.prochitatVse}
          </Button>
        </Group>
        <ScrollArea.Autosize mah={380}>
          <Stack gap={6} data-testid="bell-list">
            {(q.data?.items ?? []).length === 0 && (
              <Text size="sm" c="dimmed">
                {t.notificationBellUi.pokaNichegoNovogo}
              </Text>
            )}
            {(q.data?.items ?? []).map((n) => (
              <Stack
                key={n.id}
                gap={0}
                p={6}
                style={{
                  cursor: n.ticketId || (n.data as { path?: string } | null)?.path ? 'pointer' : undefined,
                  background: n.readAt ? undefined : 'var(--mantine-color-blue-0)',
                  borderRadius: 4,
                }}
                onClick={() => {
                  void post('/notifications/read', { ids: [n.id] }).then(() =>
                    qc.invalidateQueries({ queryKey: ['/notifications'] }),
                  );
                  // Обращение 2-й линии — в карточку; прочие (ресурсы сервера) — на свою страницу.
                  const path = (n.data as { path?: string } | null)?.path;
                  if (n.ticketId) {
                    setOpened(false);
                    nav(`/tickets/${String(n.ticketId)}`);
                  } else if (path) {
                    setOpened(false);
                    nav(path);
                  }
                }}
                data-testid="bell-item"
              >
                <Group gap={6}>
                  {!n.readAt && <Badge size="xs" circle color="blue" />}
                  <Text size="sm">{String(n.subject)}</Text>
                </Group>
                <Text size="xs" c="dimmed">
                  {when(n.createdAt)}
                </Text>
              </Stack>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
