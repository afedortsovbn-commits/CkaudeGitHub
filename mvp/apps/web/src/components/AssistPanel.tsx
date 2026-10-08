import { Badge, Button, Card, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { errorText, get, post } from '../lib/api';
import type { Row } from '../lib/data';
import { t } from '../lib/i18n';

interface Suggestion {
  type: 'template' | 'article' | 'draft';
  title?: string;
  text: string;
  score: number;
  source?: string;
  refId?: string;
}
interface Outcome {
  providerId: string;
  name: string;
  kind: string;
  ok: boolean;
  error?: string;
}

const TYPE: Record<Suggestion['type'], { label: string; color: string }> = {
  template: { label: t.assistPanelUi.shablon, color: 'blue' },
  article: { label: t.assistPanelUi.statyaBz, color: 'teal' },
  draft: { label: t.assistPanelUi.ii, color: 'grape' },
};

/** Переменные шаблона ответа — те же, что подставляет сервер в подсказках. */
export function renderTemplate(body: string, conv: Row, operatorName: string): string {
  const vars: Record<string, string> = {
    'client.name':
      conv.contactName && conv.contactName !== t.assistPanelUi.klient ? String(conv.contactName) : '',
    'operator.name': operatorName,
    'operator.firstName': operatorName.split(' ')[1] ?? operatorName,
    'conversation.topic': String(conv.topicName ?? ''),
  };
  return body.replace(/\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu, (_, k: string) => vars[k] ?? '');
}

/**
 * Панель подсказок (M-OP-10): шаблоны, статьи БЗ и ответы ИИ-провайдеров по последним сообщениям клиента;
 * «Вставить» — текст в поле ответа одним кликом. Обновляется при новом сообщении клиента. Недоступный
 * провайдер показывается строкой-предупреждением, остальные подсказки работают как обычно.
 */
export function AssistPanel({
  conv,
  lastInSeq,
  onInsert,
}: {
  conv: Row;
  lastInSeq: number;
  onInsert(text: string, s?: Suggestion): void;
}) {
  const [open, setOpen] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const q = useQuery({
    // Ключ не начинается с «/conversations» — общая перечитка по событиям realtime его не трогает:
    // провайдеры (в т.ч. LLM) опрашиваются только при новом сообщении клиента.
    queryKey: ['assist', conv.id, lastInSeq],
    queryFn: () =>
      get<{ suggestions: Suggestion[]; providers: Outcome[] }>(`/conversations/${conv.id}/suggestions`),
    staleTime: Infinity,
    enabled: conv.status !== 'closed',
  });
  const draft = async () => {
    setDrafting(true);
    try {
      const r = await post<{ draft: Suggestion }>(`/conversations/${conv.id}/draft`);
      onInsert(r.draft.text, r.draft);
    } catch (e) {
      notifications.show({ color: 'orange', message: errorText(e), autoClose: 8000 });
    } finally {
      setDrafting(false);
    }
  };
  if (conv.status === 'closed') return null;
  const list = q.data?.suggestions ?? [];
  const failed = (q.data?.providers ?? []).filter((p) => !p.ok);
  return (
    <Paper withBorder p={6} data-testid="assist">
      <Group justify="space-between" gap={4}>
        <Text size="xs" fw={600} style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
          {t.assistPanelUi.podskazki}
          {list.length ? ` (${list.length})` : ''}
        </Text>
        <Group gap={4}>
          {failed.map((p) => (
            <Tooltip key={p.providerId} label={p.error ?? ''}>
              <Badge size="xs" color="orange" variant="light" data-testid="assist-provider-failed">
                {p.name}
                {t.assistPanelUi.nedostupen}
              </Badge>
            </Tooltip>
          ))}
          <Button
            size="compact-xs"
            variant="subtle"
            color="grape"
            loading={drafting}
            onClick={() => void draft()}
            data-testid="assist-draft"
          >
            {t.assistPanelUi.chernovikIi}
          </Button>
        </Group>
      </Group>
      {open && (
        <Stack gap={4} mt={4} mah={170} style={{ overflowY: 'auto' }}>
          {q.isLoading && (
            <Text size="xs" c="dimmed">
              {t.assistPanelUi.podbiraem}
            </Text>
          )}
          {!q.isLoading && !list.length && (
            <Text size="xs" c="dimmed">
              {t.assistPanelUi.netPodkhodyashchikhShablonovI}
            </Text>
          )}
          {list.map((s, i) => (
            <Card
              key={`${s.type}:${s.refId ?? i}`}
              withBorder
              padding={4}
              data-testid={`suggestion-${s.type}`}
            >
              <Group justify="space-between" wrap="nowrap" gap={4}>
                <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                  <Badge size="xs" color={TYPE[s.type].color} variant="light">
                    {TYPE[s.type].label}
                  </Badge>
                  <Text size="xs" fw={500} truncate>
                    {s.title ?? ''}
                  </Text>
                </Group>
                <Button size="compact-xs" onClick={() => onInsert(s.text, s)} data-testid="suggestion-insert">
                  {t.assistPanelUi.vstavit}
                </Button>
              </Group>
              <Text size="xs" c="dimmed" lineClamp={2} style={{ whiteSpace: 'pre-wrap' }}>
                {s.text}
              </Text>
            </Card>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

/** Быстрый вызов шаблона: «/код» в начале поля ответа (M-AUTO-01). */
export function useSlashTemplates(text: string, channel: string) {
  const m = /^\/([^\s]*)$/.exec(text);
  const term = m?.[1] ?? null;
  const q = useQuery({
    queryKey: ['slash-templates', channel, term],
    queryFn: () => get<Row[]>(`/templates?channel=${channel}${term ? `&q=${encodeURIComponent(term)}` : ''}`),
    enabled: term !== null,
    staleTime: 5000,
  });
  return { open: term !== null, items: (q.data ?? []).slice(0, 8) };
}

export function SlashList({ items, onPick }: { items: Row[]; onPick(r: Row): void }) {
  return (
    <Paper withBorder p={4} className="cc-dropdown" data-testid="slash-list">
      {!items.length && (
        <Text size="xs" c="dimmed" p={4}>
          {t.assistPanelUi.shablonyNeNaydeny}
        </Text>
      )}
      {items.map((r, i) => (
        <Group
          key={r.id}
          gap={6}
          p={4}
          wrap="nowrap"
          style={{
            cursor: 'pointer',
            borderRadius: 4,
            background: i === 0 ? 'var(--mantine-color-blue-0)' : undefined,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(r);
          }}
          data-testid="slash-item"
        >
          <Text size="xs" c="blue" w={90} truncate>
            {r.shortcut ? `/${String(r.shortcut)}` : ''}
          </Text>
          <Text size="xs" fw={500} truncate>
            {String(r.title)}
          </Text>
          <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
            {String(r.body)}
          </Text>
        </Group>
      ))}
    </Paper>
  );
}
