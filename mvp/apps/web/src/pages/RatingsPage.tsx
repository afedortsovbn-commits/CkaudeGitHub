import { Badge, Box, Group, Paper, SegmentedControl, Table, Text, Tooltip } from '@mantine/core';
import { IconPhoneCall, IconStarFilled } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { scoreColor } from '../components/TestAttempt';
import { get } from '../lib/api';
import type { Row } from '../lib/data';
import { t } from '../lib/i18n';

const STATUS: Record<string, { label: string; color: string }> = {
  ready: { label: t.tests.statusReady, color: 'green' },
  wrap_up: { label: t.tests.statusWrap, color: 'yellow' },
  break: { label: t.tests.statusBreak, color: 'orange' },
  offline: { label: t.tests.statusOff, color: 'gray' },
};
const MEDAL = ['#f5b301', '#a7b1bd', '#c97b3c'];
const mins = (s: unknown) => {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return t.tests.dur(h, m);
};

/**
 * Рейтинг операторов: места по средней оценке клиентов за период, статус цветом (в работе, перерыв, не на
 * смене), работа с обращением сейчас, обработано за период и с начала смены, баллы тестов. Обновляется сам.
 */
export function RatingsPage() {
  const [days, setDays] = useState('30');
  const q = useQuery({
    queryKey: [`/ratings/operators?days=${days}`],
    queryFn: () => get<{ items: Row[]; rated: number }>(`/ratings/operators?days=${days}`),
    refetchInterval: 15_000,
  });
  const items = q.data?.items ?? [];
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="xs" wrap="wrap">
        <Text size="sm" c="dimmed" maw={760}>
          {t.tests.ratingHint}
        </Text>
        <SegmentedControl
          size="xs"
          data={t.tests.periods}
          value={days}
          onChange={setDays}
          data-testid="rating-period"
        />
      </Group>
      <Table highlightOnHover verticalSpacing="xs" data-testid="rating-table">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={70}>{t.tests.colPlace}</Table.Th>
            <Table.Th>{t.tests.colOperator}</Table.Th>
            <Table.Th>{t.tests.colRating}</Table.Th>
            <Table.Th>{t.tests.colNow}</Table.Th>
            <Table.Th>{t.tests.colHandled}</Table.Th>
            <Table.Th>{t.tests.colShift}</Table.Th>
            <Table.Th>{t.tests.colCompetence}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={7}>
                <Text size="sm" c="dimmed">
                  {t.tests.noOperators}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
          {items.map((r) => {
            const st = STATUS[String(r.status)] ?? STATUS.offline!;
            const place = r.place as number | null;
            const active = Number(r.activeNow);
            return (
              <Table.Tr
                key={r.id}
                bg={r.me ? 'var(--mantine-color-blue-0)' : undefined}
                data-testid="rating-row"
                data-me={r.me || undefined}
              >
                <Table.Td>
                  {place ? (
                    <Box
                      w={30}
                      h={30}
                      style={{
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 800,
                        color: place <= 3 ? '#fff' : undefined,
                        background: place <= 3 ? MEDAL[place - 1] : 'var(--mantine-color-gray-1)',
                      }}
                      data-testid="rating-place"
                    >
                      {place}
                    </Box>
                  ) : (
                    <Text c="dimmed">—</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={8} wrap="nowrap">
                    <Tooltip
                      label={`${st.label}${r.reasonName ? ` · ${String(r.reasonName)}` : ''}${r.sinceS !== null && r.status !== 'offline' ? ` · ${mins(r.sinceS)}` : ''}`}
                    >
                      <Box
                        w={12}
                        h={12}
                        style={{
                          borderRadius: '50%',
                          flex: 'none',
                          background: `var(--mantine-color-${st.color}-6)`,
                        }}
                      />
                    </Tooltip>
                    <Box>
                      <Text size="sm" fw={600}>
                        {String(r.fullName)}
                        {r.me ? (
                          <Badge ml={6} size="xs" variant="light">
                            {t.tests.me}
                          </Badge>
                        ) : null}
                      </Text>
                      <Text size="xs" c={`${st.color}.7`}>
                        {st.label}
                        {r.reasonName ? ` · ${String(r.reasonName)}` : ''}
                      </Text>
                    </Box>
                  </Group>
                </Table.Td>
                <Table.Td>
                  {r.csatAvg ? (
                    <Group gap={4} wrap="nowrap">
                      <IconStarFilled size={14} color="var(--mantine-color-yellow-6)" />
                      <Text fw={700}>{Number(r.csatAvg).toFixed(2)}</Text>
                      <Text size="xs" c="dimmed">
                        ({String(r.csatN)})
                      </Text>
                    </Group>
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  {r.onCall ? (
                    <Badge color="red" variant="light" leftSection={<IconPhoneCall size={12} />}>
                      {t.tests.nowCall}
                    </Badge>
                  ) : active ? (
                    <Badge color={r.status === 'offline' ? 'gray' : 'blue'} variant="light">
                      {t.tests.nowConv(active)}
                    </Badge>
                  ) : (
                    <Text size="xs" c="dimmed">
                      {r.status === 'offline' ? '—' : t.tests.nowFree}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text fw={600}>{String(r.handled ?? 0)}</Text>
                </Table.Td>
                <Table.Td>
                  <Text>
                    {r.handledShift === null || r.handledShift === undefined ? '—' : String(r.handledShift)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {r.competence !== null && r.competence !== undefined ? (
                    <Badge color={scoreColor(Number(r.competence))} variant="light">
                      {String(r.competence)} %
                    </Badge>
                  ) : (
                    <Text size="xs" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}
