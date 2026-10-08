import { Badge, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';
import { notify, onRealtime } from '../lib/realtime';

const s = t.staffMessages;
interface Msg {
  id: string;
  importance: 'normal' | 'important' | 'urgent';
  subject: string;
  body: string;
  createdAt: string;
  authorName: string;
}
export const LEVEL_COLOR: Record<string, string> = { normal: 'blue', important: 'orange', urgent: 'red' };
const at = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk', dateStyle: 'short', timeStyle: 'short' });

/**
 * Сообщения от руководства (рассылка сотрудникам): непрочитанные всплывают окном по одному. Важное и срочное
 * закрываются только кнопкой «Прочитал(а)»; обычное можно свернуть — оно появится снова при следующем входе.
 */
export function StaffMessageInbox() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['/staff-messages/inbox'],
    queryFn: () => get<Msg[]>('/staff-messages/inbox'),
    refetchInterval: 60_000,
    meta: { static: true },
  });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(
    () =>
      onRealtime((e) => {
        if (e.type !== 'staff_message') return;
        void qc.invalidateQueries({ queryKey: ['/staff-messages/inbox'] });
        notify(s.browserTitle, '');
      }),
    [qc],
  );
  const read = useAction(
    (id: string) =>
      post(`/staff-messages/${id}/read`).then(() =>
        qc.invalidateQueries({ queryKey: ['/staff-messages/inbox'] }),
      ),
    s.confirmed,
  );
  const unread = (q.data ?? []).filter((m) => !hidden.has(m.id));
  const m = unread[0];
  if (!m) return null;
  const strict = m.importance !== 'normal';
  return (
    <Modal
      opened
      onClose={() => !strict && setHidden(new Set([...hidden, m.id]))}
      withCloseButton={!strict}
      closeOnClickOutside={!strict}
      closeOnEscape={!strict}
      centered
      size="lg"
      title={
        <Group gap="xs">
          <Badge color={LEVEL_COLOR[m.importance]} variant="filled">
            {s.levels[m.importance]}
          </Badge>
          <Text fw={700}>{s.inboxTitle}</Text>
        </Group>
      }
      styles={
        strict
          ? { header: { borderBottom: `3px solid var(--mantine-color-${LEVEL_COLOR[m.importance]}-6)` } }
          : undefined
      }
      data-testid="staff-message-modal"
    >
      <Stack gap="sm">
        <Text size="xl" fw={700}>
          {m.subject}
        </Text>
        {m.body && (
          <Text style={{ whiteSpace: 'pre-wrap' }} size="md">
            {m.body}
          </Text>
        )}
        <Text size="sm" c="dimmed">
          {s.from(m.authorName, at(m.createdAt))}
        </Text>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {unread.length > 1 ? s.more(unread.length - 1) : ''}
          </Text>
          <Button
            size="md"
            color={LEVEL_COLOR[m.importance]}
            loading={read.isPending}
            onClick={() => read.mutate(m.id)}
            data-testid="staff-message-read"
          >
            {s.confirm}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
