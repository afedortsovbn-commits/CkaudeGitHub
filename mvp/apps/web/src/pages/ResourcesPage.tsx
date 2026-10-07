import { Alert, Badge, Group, Paper, Progress, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { t } from '../lib/i18n';

interface Sample {
  key: string;
  level: 'ok' | 'warn' | 'crit';
  usedPct: number | null;
  detail: string;
}
interface Snapshot {
  at: string;
  thresholds: { warnPct: number; critPct: number };
  samples: Sample[];
}

const COLOR = { ok: 'green', warn: 'orange', crit: 'red' } as const;

/** Ресурсы сервера: последний замер worker (диск, память, подключения к БД, очереди) и пороги уведомлений. */
export function ResourcesPage() {
  const q = useQuery({
    queryKey: ['/resources'],
    queryFn: () => get<Snapshot | null>('/resources'),
    refetchInterval: 60_000,
  });
  const s = q.data;
  const stale = s ? Date.now() - Date.parse(s.at) > 15 * 60_000 : false;
  return (
    <Stack maw={760}>
      <Text size="sm" c="dimmed">
        {t.resources.intro}
      </Text>
      {!s && !q.isLoading && <Alert color="gray">{t.resources.none}</Alert>}
      {s && (
        <>
          <Group justify="space-between">
            <Text size="sm">
              {t.resources.checkedAt(new Date(s.at).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' }))}
            </Text>
            <Text size="xs" c="dimmed">
              {t.resources.thresholds(s.thresholds.warnPct, s.thresholds.critPct)}
            </Text>
          </Group>
          {stale && <Alert color="orange">{t.resources.stale}</Alert>}
          {s.samples.map((x) => (
            <Paper key={x.key} withBorder p="sm" data-testid={`resource-${x.key}`}>
              <Group justify="space-between" mb={4}>
                <Text fw={600}>{t.resources.label[x.key] ?? x.key}</Text>
                <Badge color={COLOR[x.level]} variant={x.level === 'ok' ? 'light' : 'filled'}>
                  {t.resources[x.level]}
                </Badge>
              </Group>
              {x.usedPct !== null && <Progress value={x.usedPct} color={COLOR[x.level]} size="lg" mb={4} />}
              <Text size="sm" c="dimmed">
                {x.detail}
              </Text>
            </Paper>
          ))}
        </>
      )}
    </Stack>
  );
}
