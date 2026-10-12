import { Button, Group, NumberInput, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, put } from '../lib/api';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

interface DueChannel {
  id: string;
  kind: string;
  name: string;
  businessDays: number | null;
  hours: number | null;
}
interface DueData {
  channels: DueChannel[];
  defaults: { emailBusinessDays: number; reviewPositiveHours: number; reviewNegativeHours: number };
}
type Draft = Record<string, { businessDays: number | ''; hours: number | '' }>;

/**
 * Сроки ответа по каналам поступления (Д-020): таблица каналов — рабочих дней или часов. Пусто — срока нет (почта
 * и отзывы — по общим настройкам распределения). Используется в «Настройках» и на панели супервизора.
 */
export function ChannelDueEditor() {
  const q = useQuery({ queryKey: ['/routing/due'], queryFn: () => get<DueData>('/routing/due') });
  const [v, setV] = useState<Draft>({});
  useEffect(() => {
    if (q.data)
      setV(
        Object.fromEntries(
          q.data.channels.map((c) => [c.id, { businessDays: c.businessDays ?? '', hours: c.hours ?? '' }]),
        ),
      );
  }, [q.data]);
  const save = useAction(() =>
    put('/routing/due', {
      byChannel: Object.fromEntries(
        Object.entries(v).map(([id, x]) => [
          id,
          {
            businessDays: x.businessDays === '' ? null : Number(x.businessDays),
            hours: x.hours === '' ? null : Number(x.hours),
          },
        ]),
      ),
    }),
  );
  const num = (x: string | number): number | '' => (x === '' || x === null ? '' : Number(x));
  const d = q.data?.defaults;
  return (
    <Stack gap="xs" data-testid="channel-due">
      <Text size="xs" c="dimmed">
        {t.settingsPage.dueHint}
        {d
          ? t.settingsPage.dueDefaults(d.emailBusinessDays, d.reviewNegativeHours, d.reviewPositiveHours)
          : ''}
      </Text>
      <Table withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.settingsPage.dueChannel}</Table.Th>
            <Table.Th>{t.settingsPage.dueBusinessDays}</Table.Th>
            <Table.Th>{t.settingsPage.dueHours}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(q.data?.channels ?? []).map((c) => (
            <Table.Tr key={c.id} data-testid="due-row" data-kind={c.kind}>
              <Table.Td>
                <Text size="sm">{c.name}</Text>
                <Text size="xs" c="dimmed">
                  {t.channels.kindNames[c.kind] ?? c.kind}
                </Text>
              </Table.Td>
              <Table.Td>
                <NumberInput
                  size="xs"
                  min={0}
                  max={30}
                  value={v[c.id]?.businessDays ?? ''}
                  onChange={(x) =>
                    setV({ ...v, [c.id]: { ...(v[c.id] ?? { hours: '' }), businessDays: num(x) } })
                  }
                  data-testid={`due-days-${c.kind}`}
                />
              </Table.Td>
              <Table.Td>
                <NumberInput
                  size="xs"
                  min={1}
                  max={720}
                  value={v[c.id]?.hours ?? ''}
                  onChange={(x) =>
                    setV({ ...v, [c.id]: { ...(v[c.id] ?? { businessDays: '' }), hours: num(x) } })
                  }
                  data-testid={`due-hours-${c.kind}`}
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group>
        <Button
          size="xs"
          onClick={() => save.mutate(undefined)}
          loading={save.isPending}
          data-testid="due-save"
        >
          {t.settingsPage.dueSave}
        </Button>
      </Group>
    </Stack>
  );
}
