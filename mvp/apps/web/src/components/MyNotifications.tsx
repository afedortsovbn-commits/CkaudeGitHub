import { Badge, Button, Checkbox, Code, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, get, post, put } from '../lib/api';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

interface MyNotify {
  events: { code: string; title: string; description: string; fixedChannels?: string[] }[];
  channels: string[];
  prefs: Record<string, string[]>;
  telegram: {
    available: boolean;
    botUsername: string | null;
    linked: boolean;
    linkedAt: string | null;
    code: string | null;
  };
  emailUnsubscribedAt: string | null;
}

const ddmm = (s: string) =>
  new Date(s).toLocaleString('ru-RU', {
    timeZone: 'Europe/Minsk',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Профиль: уведомления «по желанию сотрудника» (Д-012), привязка Telegram (Д-010), подписка на письма (Д-013). */
export function MyNotifications() {
  const q = useQuery({ queryKey: ['/me/notify'], queryFn: () => get<MyNotify>('/me/notify') });
  const [prefs, setPrefs] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (q.data) setPrefs(q.data.prefs);
  }, [q.data]);
  const [code, setCode] = useState<{ code: string; botUsername: string | null } | null>(null);
  const save = useAction(() => put('/me/notify', { prefs }), t.notify.mySaved);
  const link = useAction(() =>
    post<{ code: string; botUsername: string | null }>('/me/telegram/link').then(setCode),
  );
  const unlink = useAction(() => del('/me/telegram').then(() => setCode(null)), t.notify.tgUnlinked);
  const resub = useAction(() => post('/me/resubscribe'), t.notify.emailResubscribed);
  const d = q.data;
  const toggle = (event: string, ch: string, on: boolean) =>
    setPrefs((p) => {
      const cur = new Set(p[event] ?? []);
      if (on) cur.add(ch);
      else cur.delete(ch);
      return { ...p, [event]: [...cur] };
    });
  return (
    <Paper withBorder p="md" data-testid="my-notify">
      <Stack>
        <Title order={5}>{t.notify.myTitle}</Title>
        <Text size="xs" c="dimmed">
          {t.notify.myHint}
        </Text>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th />
              {(d?.channels ?? []).map((c) => (
                <Table.Th key={c} ta="center">
                  {t.notify.channel[c] ?? c}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(d?.events ?? []).map((e) => (
              <Table.Tr key={e.code} data-testid={`pref-${e.code}`}>
                <Table.Td>
                  <Text size="sm">{e.title}</Text>
                  <Text size="xs" c="dimmed">
                    {e.description}
                  </Text>
                </Table.Td>
                {(d?.channels ?? []).map((c) => {
                  const fixed = (e.fixedChannels ?? []).includes(c);
                  return (
                    <Table.Td key={c} ta="center">
                      <Checkbox
                        checked={fixed || (prefs[e.code] ?? []).includes(c)}
                        disabled={fixed || (c === 'telegram' && !d?.telegram.linked)}
                        onChange={(ev) => toggle(e.code, c, ev.currentTarget.checked)}
                        data-testid={`pref-${e.code}-${c}`}
                        style={{ display: 'inline-block' }}
                      />
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group>
          <Button
            size="xs"
            onClick={() => save.mutate(undefined)}
            loading={save.isPending}
            data-testid="pref-save"
          >
            {t.notify.mySave}
          </Button>
        </Group>
        <Group gap="xs">
          <Title order={6}>{t.notify.tgTitle}</Title>
          {d && (
            <Badge color={d.telegram.linked ? 'green' : 'gray'} data-testid="tg-status">
              {d.telegram.linked
                ? t.notify.tgLinked(d.telegram.linkedAt ? ddmm(d.telegram.linkedAt) : '')
                : t.notify.tgNotLinked}
            </Badge>
          )}
        </Group>
        {d && !d.telegram.available && (
          <Text size="xs" c="dimmed">
            {t.notify.tgUnavailable}
          </Text>
        )}
        {d?.telegram.available && (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              onClick={() => link.mutate(undefined)}
              loading={link.isPending}
              data-testid="tg-link"
            >
              {t.notify.tgGetCode}
            </Button>
            {d.telegram.linked && (
              <Button
                size="xs"
                variant="subtle"
                color="red"
                onClick={() => unlink.mutate(undefined)}
                data-testid="tg-unlink"
              >
                {t.notify.tgUnlink}
              </Button>
            )}
          </Group>
        )}
        {(code ??
          (d?.telegram.code && !d.telegram.linked
            ? { code: d.telegram.code, botUsername: d.telegram.botUsername }
            : null)) &&
          (() => {
            const c = code ?? { code: d!.telegram.code!, botUsername: d!.telegram.botUsername };
            return (
              <Paper withBorder p="xs" bg="gray.0">
                <Text size="sm">{t.notify.tgCodeHint(c.botUsername)}</Text>
                <Code block data-testid="tg-code">{`/start ${c.code}`}</Code>
                <Text size="xs" c="dimmed">
                  {t.notify.tgCodeNote}
                </Text>
              </Paper>
            );
          })()}
        {d?.emailUnsubscribedAt && (
          <Group gap="xs">
            <Text size="sm" c="red">
              {t.notify.emailUnsubscribed}
            </Text>
            <Button
              size="xs"
              variant="light"
              onClick={() => resub.mutate(undefined)}
              data-testid="email-resubscribe"
            >
              {t.notify.emailResubscribe}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
