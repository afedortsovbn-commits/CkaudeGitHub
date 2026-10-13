import { Badge, Button, Group, Paper, SegmentedControl, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '../lib/api';
import { type Row, useAction } from '../lib/data';
import { t } from '../lib/i18n';

const dt = (s: unknown) =>
  new Date(String(s)).toLocaleString('ru-RU', {
    timeZone: 'Europe/Minsk',
    dateStyle: 'short',
    timeStyle: 'short',
  });

/** Журнал исправлений после нейросети (Д-030): для супервизора и дообучения модели. */
export function AiJournalPage() {
  const [days, setDays] = useState('30');
  const q = useQuery({
    queryKey: [`/ai/corrections?days=${days}`],
    queryFn: () =>
      get<{ items: Row[]; stats: { fills: number; checked: number; corrected: number } | null }>(
        `/ai/corrections?days=${days}`,
      ),
  });
  const review = useAction((id: string) => post(`/ai/corrections/${id}/review`, {}), t.ai.review);
  const s = q.data?.stats;
  const items = q.data?.items ?? [];
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="xs" wrap="wrap">
        <Title order={4}>{t.ai.journalTitle}</Title>
        <SegmentedControl size="xs" data={t.ai.periods} value={days} onChange={setDays} />
      </Group>
      <Text size="sm" c="dimmed" mb="xs">
        {t.ai.journalHint}
      </Text>
      {s && (
        <Text size="sm" mb="sm" data-testid="ai-stats">
          {t.ai.stats(s.fills, s.checked, s.corrected)}
        </Text>
      )}
      <Table highlightOnHover verticalSpacing="xs" data-testid="ai-journal">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.ai.colDate}</Table.Th>
            <Table.Th>{t.ai.colOperator}</Table.Th>
            <Table.Th>{t.ai.colClient}</Table.Th>
            <Table.Th>{t.ai.colField}</Table.Th>
            <Table.Th>{t.ai.colSuggested}</Table.Th>
            <Table.Th>{t.ai.colFinal}</Table.Th>
            <Table.Th>{t.ai.colReviewed}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={7}>
                <Text size="sm" c="dimmed">
                  {t.ai.empty}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
          {items.map((r) => (
            <Table.Tr key={r.id} style={{ opacity: r.reviewedAt ? 0.6 : 1 }} data-testid="ai-row">
              <Table.Td>
                <Text size="xs">{dt(r.createdAt)}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{String(r.userName ?? '')}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{String(r.contactName ?? '')}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" fw={600}>
                  {String(r.label || r.field)}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="red.8" td="line-through">
                  {String(r.suggested ?? '')}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="green.8">
                  {String(r.final ?? '')}
                </Text>
              </Table.Td>
              <Table.Td>
                {r.reviewedAt ? (
                  <Badge variant="light" color="gray">
                    {t.ai.reviewed(String(r.reviewedByName ?? ''))}
                  </Badge>
                ) : (
                  <Button
                    size="compact-xs"
                    variant="light"
                    loading={review.isPending}
                    onClick={() => review.mutate(String(r.id))}
                    data-testid="ai-review"
                  >
                    {t.ai.review}
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}
