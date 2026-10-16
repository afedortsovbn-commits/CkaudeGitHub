import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Menu,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconCheck, IconMessageReply, IconNews, IconWorld, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '../lib/api';
import { type Row, useAction } from '../lib/data';
import { t } from '../lib/i18n';

interface Reply {
  id: string;
  body: string;
  authorName: string;
  isOfficial: boolean;
  status: string;
  postedAt: string;
}
const fmt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('ru-RU') : '');

function CommentCard({ c, reasons }: { c: Row; reasons: { value: string; label: string }[] }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const approve = useAction(() => post(`/moderation/comments/${c.id}/approve`), t.moderation.approved);
  const reject = useAction(
    (reason: string) => post(`/moderation/comments/${c.id}/reject`, { reason }),
    t.moderation.rejected,
  );
  const reply = useAction(
    () => post(`/moderation/comments/${c.id}/reply`, { text: text.trim(), approve: true }),
    t.moderation.replied,
  );
  const pending = c.status === 'pending';
  const parent = c.parent as {
    authorName?: string;
    author_name?: string;
    body: string;
    is_official?: boolean;
  } | null;
  const replies = (c.replies as Reply[]) ?? [];
  return (
    <Paper withBorder p="sm" radius="md" data-testid="mod-comment" data-status={String(c.status)}>
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap={6}>
            <Text size="sm" fw={600}>
              {String(c.authorName || t.moderation.anonymous)}
            </Text>
            <Text size="xs" c="dimmed">
              {fmt(c.postedAt)}
            </Text>
          </Group>
          {c.status === 'approved' && (
            <Badge color="green" variant="light" leftSection={<IconWorld size={11} />}>
              {t.moderation.published}
            </Badge>
          )}
          {c.status === 'rejected' && (
            <Badge color="red" variant="light">
              {t.moderation.rejectedBadge}
            </Badge>
          )}
        </Group>
        {parent && (
          <Text size="xs" c="dimmed" pl="xs" style={{ borderLeft: '3px solid var(--mantine-color-gray-3)' }}>
            {t.moderation.inReplyTo(String(parent.author_name ?? parent.authorName ?? ''))}: {parent.body}
          </Text>
        )}
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {String(c.body)}
        </Text>
        {c.status === 'rejected' && c.rejectReason ? (
          <Text size="xs" c="red">
            {t.moderation.reason}:{' '}
            {reasons.find((r) => String(c.rejectReason).startsWith(r.value))?.label ?? String(c.rejectReason)}
          </Text>
        ) : null}
        {c.moderatedByName ? (
          <Text size="xs" c="dimmed">
            {t.moderation.by(String(c.moderatedByName), fmt(c.moderatedAt))}
          </Text>
        ) : null}
        {replies.map((r) => (
          <Paper
            key={r.id}
            p="xs"
            ml="lg"
            radius="md"
            bg={r.isOfficial ? 'blue.0' : 'gray.0'}
            data-testid={r.isOfficial ? 'mod-official-reply' : undefined}
          >
            <Group gap={6}>
              <Text size="xs" fw={600} c={r.isOfficial ? 'blue.8' : undefined}>
                {r.isOfficial ? t.moderation.officialAuthor : r.authorName}
              </Text>
              <Text size="xs" c="dimmed">
                {fmt(r.postedAt)}
              </Text>
            </Group>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {r.body}
            </Text>
          </Paper>
        ))}
        {replying && (
          <Stack gap={4}>
            <Textarea
              autosize
              minRows={2}
              placeholder={t.moderation.replyPlaceholder}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              error={tried && !text.trim() ? t.moderation.replyEmpty : undefined}
              withAsterisk
              data-testid="mod-reply-text"
            />
            <Text size="xs" c="orange.8">
              {t.moderation.replyWarn}
            </Text>
            <Group gap="xs">
              <Button
                size="xs"
                loading={reply.isPending}
                onClick={() => {
                  setTried(true);
                  if (text.trim())
                    reply.mutate(undefined, {
                      onSuccess: () => {
                        setReplying(false);
                        setText('');
                      },
                    });
                }}
                data-testid="mod-reply-send"
              >
                {pending ? t.moderation.publishWithReply : t.moderation.publishReply}
              </Button>
              <Button size="xs" variant="subtle" color="gray" onClick={() => setReplying(false)}>
                {t.cancel}
              </Button>
            </Group>
          </Stack>
        )}
        {!replying && c.status !== 'rejected' && (
          <Group gap="xs">
            {pending && (
              <Button
                size="xs"
                color="green"
                leftSection={<IconCheck size={14} />}
                loading={approve.isPending}
                onClick={() => approve.mutate(undefined)}
                data-testid="mod-approve"
              >
                {t.moderation.approve}
              </Button>
            )}
            {pending && (
              <Menu shadow="md" width={280}>
                <Menu.Target>
                  <Button
                    size="xs"
                    color="red"
                    variant="light"
                    leftSection={<IconX size={14} />}
                    loading={reject.isPending}
                    data-testid="mod-reject"
                  >
                    {t.moderation.reject}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>{t.moderation.rejectWhy}</Menu.Label>
                  {reasons.map((r) => (
                    <Menu.Item
                      key={r.value}
                      onClick={() => reject.mutate(r.value)}
                      data-testid={`mod-reason-${r.value}`}
                    >
                      {r.label}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            )}
            <Button
              size="xs"
              variant="light"
              leftSection={<IconMessageReply size={14} />}
              onClick={() => setReplying(true)}
              data-testid="mod-reply"
            >
              {t.moderation.reply}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

/**
 * Модерация комментариев к новостям (Д-100): публичный канал — опубликованное видят все читатели новости.
 * Комментарии сгруппированы по новостям; решение модератора уходит на сайт событием comment.moderated.
 */
export function ModerationPage() {
  const [status, setStatus] = useState('pending');
  const [q, setQ] = useState('');
  const counts = useQuery({
    queryKey: ['/moderation/counts'],
    queryFn: () => get<{ pending: number; today: number }>('/moderation/counts'),
    refetchInterval: 15_000,
  });
  const list = useQuery({
    queryKey: ['/moderation/comments', status, q],
    queryFn: () =>
      get<Row[]>(
        `/moderation/comments?status=${status}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`,
      ),
    refetchInterval: 15_000,
  });
  const reasons = useQuery({
    queryKey: ['/moderation/reasons'],
    queryFn: () => get<{ value: string; label: string }[]>('/moderation/reasons'),
    meta: { static: true },
  });
  // Новости по порядку появления комментариев.
  const byNews = new Map<string, { title: string; url: string | null; items: Row[] }>();
  for (const c of list.data ?? []) {
    const k = String(c.newsId);
    const g = byNews.get(k) ?? {
      title: String(c.newsTitle || c.newsId),
      url: (c.newsUrl as string) ?? null,
      items: [],
    };
    g.items.push(c);
    byNews.set(k, g);
  }
  return (
    <Stack>
      <Group gap="sm">
        <Title order={3}>{t.moderation.pageTitle}</Title>
        <Badge color="orange" variant="filled" leftSection={<IconWorld size={12} />} data-testid="mod-public">
          {t.moderation.publicChannel}
        </Badge>
      </Group>
      <Alert color="orange" variant="light" p="xs">
        <Text size="sm">{t.moderation.publicHint}</Text>
      </Alert>
      <Group justify="space-between" wrap="wrap">
        <SegmentedControl
          value={status}
          onChange={setStatus}
          data={[
            { value: 'pending', label: t.moderation.tabPending(counts.data?.pending ?? 0) },
            { value: 'approved', label: t.moderation.tabApproved },
            { value: 'rejected', label: t.moderation.tabRejected },
          ]}
          data-testid="mod-tabs"
        />
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {t.moderation.today(counts.data?.today ?? 0)}
          </Text>
          <TextInput
            size="xs"
            w={240}
            placeholder={t.moderation.search}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
          />
        </Group>
      </Group>
      {!list.isLoading && !(list.data ?? []).length && (
        <Text c="dimmed" ta="center" py="xl">
          {status === 'pending' ? t.moderation.emptyPending : t.moderation.empty}
        </Text>
      )}
      {[...byNews.entries()].map(([id, g]) => (
        <Stack key={id} gap="xs">
          <Group gap={6}>
            <IconNews size={16} />
            {g.url ? (
              <Anchor href={g.url} target="_blank" rel="noopener" fw={600} size="sm">
                {g.title}
              </Anchor>
            ) : (
              <Text fw={600} size="sm">
                {g.title}
              </Text>
            )}
            <Badge size="xs" variant="light">
              {g.items.length}
            </Badge>
          </Group>
          {g.items.map((c) => (
            <CommentCard key={String(c.id)} c={c} reasons={reasons.data ?? []} />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
