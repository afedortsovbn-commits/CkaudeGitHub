import { Badge, Group, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';

interface QueueRow {
  id: string;
  name: string;
  waiting: number;
  oldestWaitS: number;
  maxWaitS: number | null;
}
interface OperatorRow {
  id: string;
  fullName: string;
  status: string;
  reasonName: string | null;
  sinceS: number;
  activeChats: number;
}

const STATUS_LABEL: Record<string, string> = {
  ready: 'Готов',
  break: 'Перерыв',
  wrap_up: 'Постобработка',
  offline: 'Офлайн',
};
const STATUS_COLOR: Record<string, string> = {
  ready: 'green',
  break: 'yellow',
  wrap_up: 'blue',
  offline: 'gray',
};

const mins = (s: number) => `${Math.floor(s / 60)} мин ${s % 60} с`;

/** Панель супервизора в реальном времени [УПР] (M-REP-02, M-RT-*): очереди и операторы. */
export function SupervisorPage() {
  const overview = useQuery({
    queryKey: ['/supervisor/overview'],
    queryFn: () => get<{ queues: QueueRow[]; operators: OperatorRow[] }>('/supervisor/overview'),
    refetchInterval: 4000,
  });
  return (
    <>
      <Title order={3} mb="md">
        Супервизор: очереди и операторы
      </Title>
      <Title order={5} mb="xs">
        Очереди
      </Title>
      <Table striped mb="xl" data-testid="supervisor-queues">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Очередь</Table.Th>
            <Table.Th>Ожидают</Table.Th>
            <Table.Th>Дольше всех ждёт</Table.Th>
            <Table.Th>Порог эскалации</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(overview.data?.queues ?? []).map((q) => (
            <Table.Tr key={q.id}>
              <Table.Td>{q.name}</Table.Td>
              <Table.Td>
                <Badge color={q.waiting > 0 ? 'orange' : 'gray'}>{q.waiting}</Badge>
              </Table.Td>
              <Table.Td>{q.waiting > 0 ? mins(q.oldestWaitS) : '—'}</Table.Td>
              <Table.Td>{q.maxWaitS ? `${q.maxWaitS} с` : '—'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Title order={5} mb="xs">
        Операторы
      </Title>
      <Table striped data-testid="supervisor-operators">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Оператор</Table.Th>
            <Table.Th>Статус</Table.Th>
            <Table.Th>В статусе</Table.Th>
            <Table.Th>Активных чатов</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(overview.data?.operators ?? []).map((o) => (
            <Table.Tr key={o.id}>
              <Table.Td>{o.fullName}</Table.Td>
              <Table.Td>
                <Group gap={4}>
                  <Badge color={STATUS_COLOR[o.status] ?? 'gray'}>{STATUS_LABEL[o.status] ?? o.status}</Badge>
                  {o.reasonName && <Text size="xs">{o.reasonName}</Text>}
                </Group>
              </Table.Td>
              <Table.Td>{mins(o.sinceS)}</Table.Td>
              <Table.Td>{o.activeChats}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
