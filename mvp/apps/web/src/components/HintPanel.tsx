import {
  Alert,
  Badge,
  Box,
  Button,
  CloseButton,
  Group,
  List,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { errorText, get, post } from '../lib/api';
import { type Row, useList } from '../lib/data';
import { type Hint, parseHint } from '../lib/hints';
import { t } from '../lib/i18n';

export interface Suggestion {
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
  article: { label: t.hintPanel.typeArticle, color: 'teal' },
  template: { label: t.hintPanel.typeTemplate, color: 'blue' },
  draft: { label: t.hintPanel.typeDraft, color: 'grape' },
};
const VISIBLE = 4;

const key = (s: Suggestion, i: number) => `${s.type}:${s.refId ?? i}`;
const canon = (s: string) =>
  s
    .toLowerCase()
    .replace(new RegExp(String.fromCharCode(0x451), 'g'), String.fromCharCode(0x435))
    .replace(/[«»“”„"]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Подсказки оператору во время разговора (M-OP-10): подбираются по теме обращения и последним сообщениям клиента,
 * плюс поиск по базе знаний — он работает и во время звонка, когда сообщений нет. Структурированная статья
 * показывается по разделам: что сказать клиенту, что уточнить, что сделать, когда передавать на 2-ю линию.
 */
export function HintPanel({
  conv,
  lastInSeq,
  canInsert,
  onInsert,
  onPickTopic,
  voice = false,
  height,
}: {
  conv: Row;
  lastInSeq: number;
  canInsert: boolean;
  onInsert(text: string, s?: Suggestion): void;
  onPickTopic(topicId: string): void;
  voice?: boolean;
  height: number | string;
}) {
  const [open, setOpen] = useState(true);
  const [q, setQ] = useState('');
  const [dq] = useDebouncedValue(q.trim(), 300);
  const [picked, setPicked] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const topics = useList('/topics');
  const sugg = useQuery({
    // Ключ не начинается с «/conversations» — общая перечитка по событиям realtime его не трогает:
    // провайдеры (в т.ч. LLM) опрашиваются при новом сообщении клиента и при смене темы.
    queryKey: ['assist', conv.id, lastInSeq, conv.topicId ?? null],
    queryFn: () =>
      get<{ suggestions: Suggestion[]; providers: Outcome[] }>(`/conversations/${conv.id}/suggestions`),
    staleTime: Infinity,
    enabled: conv.status !== 'closed',
  });
  const search = useQuery({
    queryKey: ['hint-search', dq],
    queryFn: () => get<Row[]>(`/kb/articles?q=${encodeURIComponent(dq)}`),
    enabled: dq.length >= 2,
    staleTime: 60_000,
  });
  const searching = dq.length >= 2;
  const items: Suggestion[] = useMemo(
    () =>
      searching
        ? (search.data ?? []).slice(0, 15).map((a) => ({
            type: 'article' as const,
            title: String(a.title),
            text: String(a.body),
            score: 1,
            refId: String(a.id),
          }))
        : (sugg.data?.suggestions ?? []),
    [searching, search.data, sugg.data],
  );
  const failed = (sugg.data?.providers ?? []).filter((p) => !p.ok);
  const current =
    items.find((s, i) => key(s, i) === picked) ?? items.find((s) => s.type === 'article') ?? items[0];
  // Черновик ИИ виден всегда: это готовый ответ по всему диалогу, а не одна из похожих справок.
  const visible = showAll
    ? items
    : [...items.slice(0, VISIBLE), ...items.slice(VISIBLE).filter((s) => s.type === 'draft')];

  const pickTopic = (h: Hint) => {
    if (!h.escalate) return;
    const all = topics.data ?? [];
    const theme = all.find((x) => !x.parentId && canon(String(x.name)) === canon(h.escalate!.topic));
    const sub =
      theme && h.escalate.sub
        ? all.find((x) => x.parentId === theme.id && canon(String(x.name)) === canon(h.escalate!.sub))
        : undefined;
    const id = (sub ?? theme)?.id;
    if (!id) {
      notifications.show({ color: 'orange', message: t.hintPanel.topicNotFound });
      return;
    }
    onPickTopic(String(id));
    notifications.show({ color: 'green', message: t.hintPanel.topicPicked, autoClose: 2500 });
  };

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
  const loading = searching ? search.isFetching && !search.data : sugg.isLoading;
  return (
    <Paper withBorder p={8} data-testid="assist" bg="var(--mantine-color-gray-0)">
      <Group gap={6} wrap="nowrap">
        <UnstyledButton onClick={() => setOpen(!open)} data-testid="assist-toggle">
          <Text size="sm" fw={700}>
            {open ? '▾ ' : '▸ '}
            {t.hintPanel.title}
          </Text>
        </UnstyledButton>
        <TextInput
          size="xs"
          style={{ flex: 1 }}
          placeholder={t.hintPanel.searchPlaceholder}
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value);
            setPicked(null);
            setOpen(true);
          }}
          rightSection={q ? <CloseButton size="xs" onClick={() => setQ('')} /> : null}
          data-testid="hint-search"
        />
        {failed.map((p) => (
          <Tooltip key={p.providerId} label={p.error ?? ''}>
            <Badge size="xs" color="orange" variant="light" data-testid="assist-provider-failed">
              {p.name}
              {t.hintPanel.unavailable}
            </Badge>
          </Tooltip>
        ))}
        {!voice && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="grape"
            loading={drafting}
            onClick={() => void draft()}
            data-testid="assist-draft"
          >
            {t.hintPanel.draft}
          </Button>
        )}
      </Group>
      {open && (
        <ScrollArea.Autosize mah={height} mt={6} type="auto" offsetScrollbars>
          {loading && (
            <Text size="xs" c="dimmed">
              {searching ? t.hintPanel.searching : t.hintPanel.loading}
            </Text>
          )}
          {!loading && !items.length && (
            <Text size="sm" c="dimmed" data-testid="hint-empty">
              {searching ? t.hintPanel.nothingFound : voice ? t.hintPanel.emptyCall : t.hintPanel.emptyChat}
            </Text>
          )}
          {items.length > 0 && (
            <Stack gap={4}>
              {visible.map((s) => {
                const k = key(s, items.indexOf(s));
                const active = current && key(current, items.indexOf(current)) === k;
                return (
                  <Group
                    key={k}
                    gap={6}
                    wrap="nowrap"
                    px={6}
                    py={3}
                    style={{
                      cursor: 'pointer',
                      borderRadius: 6,
                      background: active ? 'var(--mantine-color-blue-1)' : 'var(--mantine-color-white)',
                      border: '1px solid var(--mantine-color-gray-3)',
                    }}
                    onClick={() => setPicked(k)}
                    data-testid={`suggestion-${s.type}`}
                  >
                    <Badge size="xs" variant="light" color={TYPE[s.type].color} style={{ flexShrink: 0 }}>
                      {TYPE[s.type].label}
                    </Badge>
                    <Text size="xs" fw={active ? 700 : 500} truncate style={{ flex: 1 }}>
                      {s.title ?? s.text.slice(0, 80)}
                    </Text>
                    {s.type !== 'article' && canInsert && (
                      <Button
                        size="compact-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onInsert(s.text, s);
                        }}
                        data-testid="suggestion-insert"
                      >
                        {t.hintPanel.insert}
                      </Button>
                    )}
                  </Group>
                );
              })}
              {items.length > VISIBLE && (
                <Button size="compact-xs" variant="subtle" onClick={() => setShowAll(!showAll)}>
                  {showAll ? t.hintPanel.showLess : t.hintPanel.more(items.length - VISIBLE)}
                </Button>
              )}
              {current && (
                <HintView s={current} canInsert={canInsert} onInsert={onInsert} onPickTopic={pickTopic} />
              )}
            </Stack>
          )}
        </ScrollArea.Autosize>
      )}
    </Paper>
  );
}

function HintView({
  s,
  canInsert,
  onInsert,
  onPickTopic,
}: {
  s: Suggestion;
  canInsert: boolean;
  onInsert(text: string, s?: Suggestion): void;
  onPickTopic(h: Hint): void;
}) {
  const [full, setFull] = useState(false);
  const h = parseHint(s.text);
  return (
    <Paper withBorder p={8} mt={4} data-testid="hint-view">
      <Text size="sm" fw={700} mb={6}>
        {s.title}
      </Text>
      {h.structured ? (
        <Stack gap={8}>
          {h.answer && (
            <Box
              p={8}
              style={{ background: 'var(--mantine-color-blue-0)', borderRadius: 6 }}
              data-testid="hint-answer"
            >
              <Group justify="space-between" mb={4} wrap="nowrap">
                <Text size="xs" fw={700} c="blue.8" tt="uppercase">
                  {t.hintPanel.sayToClient}
                </Text>
                {canInsert && (
                  <Button
                    size="compact-xs"
                    onClick={() => onInsert(h.answer, s)}
                    data-testid="hint-insert-answer"
                  >
                    {t.hintPanel.insertAnswer}
                  </Button>
                )}
              </Group>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {h.answer}
              </Text>
            </Box>
          )}
          {h.intro && (
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
              {h.intro}
            </Text>
          )}
          {h.ask.length > 0 && (
            <Section title={t.hintPanel.ask}>
              <List size="sm" spacing={2}>
                {h.ask.map((x, i) => (
                  <List.Item key={i}>{x}</List.Item>
                ))}
              </List>
            </Section>
          )}
          {h.warn.length > 0 && (
            <Alert color="orange" p={6} title={t.hintPanel.warn}>
              <List size="sm" spacing={2}>
                {h.warn.map((x, i) => (
                  <List.Item key={i}>{x}</List.Item>
                ))}
              </List>
            </Alert>
          )}
          {h.steps.length > 0 && (
            <Section title={t.hintPanel.steps}>
              <List type="ordered" size="sm" spacing={2}>
                {h.steps.map((x, i) => (
                  <List.Item key={i}>{x}</List.Item>
                ))}
              </List>
            </Section>
          )}
          {h.contacts.length > 0 && (
            <Section title={t.hintPanel.contacts}>
              {h.contacts.map((x, i) => (
                <Text key={i} size="sm" style={{ userSelect: 'text' }}>
                  {x}
                </Text>
              ))}
            </Section>
          )}
          {h.source && (
            <Box>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => setFull(!full)}
                data-testid="hint-source"
              >
                {full ? t.hintPanel.hideSource : t.hintPanel.showSource}
              </Button>
              {full && (
                <Text size="xs" c="dimmed" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
                  {h.source}
                </Text>
              )}
            </Box>
          )}
          {h.escalate && (
            <Box
              p={8}
              style={{ background: 'var(--mantine-color-violet-0)', borderRadius: 6 }}
              data-testid="hint-escalate"
            >
              <Text size="xs" fw={700} c="violet.8" tt="uppercase" mb={2}>
                {t.hintPanel.escalateTitle}
              </Text>
              {h.escalate.when && (
                <Text size="sm">
                  {t.hintPanel.escalateWhen}
                  {h.escalate.when}
                </Text>
              )}
              <Group justify="space-between" mt={4} wrap="nowrap" gap={6}>
                <Text size="sm" fw={600}>
                  {h.escalate.topic}
                  {h.escalate.sub ? ` › ${h.escalate.sub}` : ''}
                </Text>
                <Button
                  size="compact-xs"
                  color="violet"
                  variant="light"
                  onClick={() => onPickTopic(h)}
                  data-testid="hint-pick-topic"
                  style={{ flexShrink: 0 }}
                >
                  {t.hintPanel.pickTopic}
                </Button>
              </Group>
            </Box>
          )}
        </Stack>
      ) : (
        <>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} lineClamp={full ? undefined : 8}>
            {s.text}
          </Text>
          <Group gap={6} mt={4}>
            {s.text.split('\n').length > 8 || s.text.length > 600 ? (
              <Button size="compact-xs" variant="subtle" onClick={() => setFull(!full)}>
                {full ? t.hintPanel.showLess : t.hintPanel.showMore}
              </Button>
            ) : null}
            {s.type !== 'article' && canInsert && (
              <Button size="compact-xs" onClick={() => onInsert(s.text, s)}>
                {t.hintPanel.insert}
              </Button>
            )}
          </Group>
        </>
      )}
    </Paper>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box>
      <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>
        {title}
      </Text>
      {children}
    </Box>
  );
}
