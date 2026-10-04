import { Badge, Box, Button, Divider, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { get } from '../lib/api';
import { type Row, useList } from '../lib/data';
import { t } from '../lib/i18n';

const SHOWN = 3;
const day = (v: unknown) => new Date(String(v)).toLocaleDateString('ru-RU');
const clock = (v: unknown) =>
  new Date(String(v)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Статус обращения для оператора — тремя словами: открыто, в работе, закрыто. */
function statusLabel(s: unknown): string {
  if (s === 'closed') return t.callContext.closed;
  if (s === 'active' || s === 'hold' || s === 'wrap_up') return t.callContext.inWork;
  return t.callContext.open;
}

/**
 * Кто звонит и о чём: имя клиента, тема и подтема (если уже определены — клиентом в голосовом меню или
 * оператором), последние обращения с краткой темой и быстрый просмотр всей истории. Показывается в виджете
 * звонка, пока идёт вызов.
 */
export function CallContext({ conversationId, fallbackName }: { conversationId: string; fallbackName: string }) {
  const [all, setAll] = useState(false);
  const conv = useQuery({
    queryKey: [`/conversations/${conversationId}`],
    queryFn: () => get<Row>(`/conversations/${conversationId}`),
  });
  const contactId = conv.data?.contactId ? String(conv.data.contactId) : null;
  const contact = useQuery({
    queryKey: [`/contacts/${contactId}`],
    queryFn: () => get<Row>(`/contacts/${contactId}`),
    enabled: !!contactId,
  });
  const history = useList(`/contacts/${contactId}/conversations`, !!contactId);
  const topics = useList('/topics');
  const topicLabel = useMemo(() => {
    const id = conv.data?.topicId ? String(conv.data.topicId) : null;
    if (!id) return null;
    const byId = new Map((topics.data ?? []).map((x) => [String(x.id), x]));
    const x = byId.get(id);
    if (!x) return conv.data?.topicName ? String(conv.data.topicName) : null;
    const parent = x.parentId ? byId.get(String(x.parentId)) : undefined;
    return parent ? `${String(parent.name)} › ${String(x.name)}` : String(x.name);
  }, [conv.data, topics.data]);

  if (conv.isLoading) {
    return (
      <Text size="xs" c="dimmed">
        {t.callContext.loading}
      </Text>
    );
  }
  const name = String(contact.data?.displayName ?? '').trim() || fallbackName || t.callContext.unknownClient;
  const prev = (history.data ?? []).filter((h) => h.id !== conversationId);
  return (
    <Stack gap={6} data-testid="call-context">
      <Box>
        <Text size="xs" c="dimmed">
          {t.callContext.client}
        </Text>
        <Text fw={700} size="md" data-testid="call-client-name">
          {name}
        </Text>
      </Box>
      <Box>
        <Text size="xs" c="dimmed">
          {t.callContext.topic}
        </Text>
        <Text size="sm" fw={topicLabel ? 600 : 400} c={topicLabel ? undefined : 'orange.8'} data-testid="call-topic">
          {topicLabel ?? t.callContext.topicNone}
        </Text>
      </Box>
      <Divider />
      <Group justify="space-between" gap={4}>
        <Text size="xs" c="dimmed">
          {t.callContext.history}
          {prev.length ? ` (${prev.length})` : ''}
        </Text>
        {prev.length > SHOWN && (
          <Button size="compact-xs" variant="subtle" onClick={() => setAll(true)} data-testid="call-history-all">
            {t.callContext.historyAll}
          </Button>
        )}
      </Group>
      {prev.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t.callContext.historyNone}
        </Text>
      ) : (
        <Stack gap={3} data-testid="call-history">
          {prev.slice(0, SHOWN).map((h) => (
            <HistoryRow key={String(h.id)} h={h} compact />
          ))}
        </Stack>
      )}
      <Modal
        opened={all}
        onClose={() => setAll(false)}
        title={`${t.callContext.historyTitle}: ${name}`}
        size="lg"
        zIndex={400}
      >
        <ScrollArea.Autosize mah="70vh">
          <Stack gap={8}>
            {prev.length === 0 && <Text c="dimmed">{t.callContext.historyEmpty}</Text>}
            {prev.map((h) => (
              <HistoryRow key={String(h.id)} h={h} />
            ))}
          </Stack>
        </ScrollArea.Autosize>
      </Modal>
    </Stack>
  );
}

function HistoryRow({ h, compact = false }: { h: Row; compact?: boolean }) {
  const when = h.createdAt ? `${day(h.createdAt)} ${clock(h.createdAt)}` : '';
  const topic = h.topicName ? String(h.topicName) : '';
  return (
    <Box
      p={compact ? 4 : 8}
      style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 6 }}
      data-testid="history-row"
    >
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {when}
        </Text>
        <Group gap={4} wrap="nowrap">
          <Badge size="xs" variant="light">
            {t.callContext.channel[String(h.channelKind)] ?? String(h.channelKind)}
          </Badge>
          <Badge size="xs" variant="outline" color={h.status === 'closed' ? 'gray' : 'blue'}>
            {statusLabel(h.status)}
          </Badge>
        </Group>
      </Group>
      <Text size="sm" fw={600} lineClamp={compact ? 1 : 2}>
        {topic || t.callContext.topicNone}
      </Text>
      {!compact && h.lastMessage ? (
        <Text size="xs" c="dimmed" lineClamp={3}>
          {t.callContext.lastMessage}
          {String(h.lastMessage)}
        </Text>
      ) : null}
      {!compact && h.assigneeName ? (
        <Text size="xs" c="dimmed">
          {t.callContext.by}
          {String(h.assigneeName)}
        </Text>
      ) : null}
    </Box>
  );
}
