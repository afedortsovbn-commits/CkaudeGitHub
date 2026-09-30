import { Badge, Button, Card, Group, SimpleGrid, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { useAction } from '../lib/data';

interface QueueRow {
  id: string;
  name: string;
  waiting: number;
  offered: number;
  active: number;
  importantWaiting: number;
  oldestWaitS: number;
  maxWaitS: number | null;
  todayAnswered: number;
  todayAbandoned: number;
  todaySlPct: number | null;
  todayAsa: number | null;
}
interface OperatorRow {
  id: string;
  fullName: string;
  status: string;
  reasonName: string | null;
  sinceS: number;
  activeChats: number;
  callId: string | null;
  callNumber: string | null;
}
interface Thresholds {
  waitWarnS: number;
  waitCritS: number;
  queueWarn: number;
  queueCrit: number;
  breakWarnS: number;
  slTargetPct: number;
}
interface Overview {
  queues: QueueRow[];
  operators: OperatorRow[];
  active: { status: string; channelKind: string; count: number }[];
  thresholds: Thresholds;
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
const CONV_STATUS: Record<string, string> = {
  bot: 'У бота / в IVR',
  queued: 'В очереди',
  offered: 'Предложено',
  active: 'В работе',
  waiting_2nd_line: 'На 2-й линии',
  waiting_customer: 'Ждут клиента',
  new: 'Новые',
};

const mins = (s: number) => `${Math.floor(s / 60)} мин ${s % 60} с`;
/** Уровень подсветки по порогам: 0 — норма, 1 — внимание, 2 — критично. */
const level = (v: number, warn: number, crit: number) => (v >= crit ? 2 : v >= warn ? 1 : 0);
const COLOR = ['gray', 'orange', 'red'] as const;
const ROW_BG = [undefined, 'var(--mantine-color-orange-light)', 'var(--mantine-color-red-light)'];

function Tile({
  label,
  value,
  lvl = 0,
  testId,
}: {
  label: string;
  value: string;
  lvl?: number;
  testId?: string;
}) {
  return (
    <Card withBorder padding="sm" bg={ROW_BG[lvl]} data-testid={testId} data-level={lvl}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="xl">
        {value}
      </Text>
    </Card>
  );
}

/**
 * Панель супервизора в реальном времени [УПР] (M-REP-02): сводка, очереди (ожидают, дольше всех ждёт, SL за
 * сегодня), операторы по статусам, активные обращения. Подсветка — по порогам из «Настроек» (без перезапуска).
 */
export function SupervisorPage() {
  // Прослушивание (M-TEL-10): звонок приходит в софтфон супервизора и отвечается автоматически.
  const listen = useAction((id: string) => post(`/calls/${id}/listen`), 'Подключаем прослушивание…');
  const overview = useQuery({
    queryKey: ['/supervisor/overview'],
    queryFn: () => get<Overview>('/supervisor/overview'),
    refetchInterval: 4000,
  });
  const d = overview.data;
  const th = d?.thresholds;
  const queues = d?.queues ?? [];
  const operators = d?.operators ?? [];
  const waiting = queues.reduce((a, q) => a + q.waiting, 0);
  const oldest = queues.reduce((a, q) => (q.waiting > 0 ? Math.max(a, q.oldestWaitS) : a), 0);
  const byStatus = (s: string) => operators.filter((o) => o.status === s).length;
  const answered = queues.reduce((a, q) => a + q.todayAnswered, 0);
  const abandoned = queues.reduce((a, q) => a + q.todayAbandoned, 0);
  const activeTotals = new Map<string, number>();
  for (const a of d?.active ?? []) activeTotals.set(a.status, (activeTotals.get(a.status) ?? 0) + a.count);
  const qLevel = (q: QueueRow) =>
    th
      ? Math.max(
          level(q.waiting, th.queueWarn, th.queueCrit),
          q.waiting ? level(q.oldestWaitS, th.waitWarnS, th.waitCritS) : 0,
        )
      : 0;
  return (
    <>
      <Title order={3} mb="md">
        Супервизор: очереди и операторы
      </Title>
      <SimpleGrid cols={{ base: 2, sm: 3, md: 6 }} mb="lg" data-testid="supervisor-summary">
        <Tile
          label="Ожидают в очередях"
          value={String(waiting)}
          lvl={th ? level(waiting, th.queueWarn, th.queueCrit) : 0}
          testId="supervisor-waiting"
        />
        <Tile
          label="Дольше всех ждёт"
          value={waiting ? mins(oldest) : '—'}
          lvl={th && waiting ? level(oldest, th.waitWarnS, th.waitCritS) : 0}
        />
        <Tile label="Операторы: готовы / перерыв" value={`${byStatus('ready')} / ${byStatus('break')}`} />
        <Tile label="Постобработка / офлайн" value={`${byStatus('wrap_up')} / ${byStatus('offline')}`} />
        <Tile label="Отвечено / пропущено сегодня" value={`${answered} / ${abandoned}`} />
        <Tile
          label="Активные обращения"
          value={String([...activeTotals.values()].reduce((a, b) => a + b, 0))}
          testId="supervisor-active"
        />
      </SimpleGrid>
      <Group gap="xs" mb="lg">
        {[...activeTotals.entries()].map(([s, n]) => (
          <Badge key={s} variant="light" color="gray">
            {CONV_STATUS[s] ?? s}: {n}
          </Badge>
        ))}
      </Group>
      <Title order={5} mb="xs">
        Очереди
      </Title>
      <Table striped mb="xl" data-testid="supervisor-queues">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Очередь</Table.Th>
            <Table.Th>Ожидают</Table.Th>
            <Table.Th>Дольше всех ждёт</Table.Th>
            <Table.Th>Предложено / в работе</Table.Th>
            <Table.Th>SL сегодня</Table.Th>
            <Table.Th>Отвечено / пропущено</Table.Th>
            <Table.Th>Порог эскалации</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {queues.map((q) => {
            const lvl = qLevel(q);
            const slLow = th && q.todaySlPct !== null && q.todaySlPct < th.slTargetPct;
            return (
              <Table.Tr key={q.id} bg={ROW_BG[lvl]} data-level={lvl} data-testid={`queue-row-${q.name}`}>
                <Table.Td>{q.name}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    <Badge color={th ? COLOR[level(q.waiting, th.queueWarn, th.queueCrit)] : 'gray'}>
                      {q.waiting}
                    </Badge>
                    {q.importantWaiting > 0 && (
                      <Badge color="red" variant="outline" title="Особо важные в очереди">
                        !{q.importantWaiting}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {q.waiting > 0 ? (
                    <Text
                      c={th ? COLOR[level(q.oldestWaitS, th.waitWarnS, th.waitCritS)] : undefined}
                      size="sm"
                    >
                      {mins(q.oldestWaitS)}
                    </Text>
                  ) : (
                    '—'
                  )}
                </Table.Td>
                <Table.Td>
                  {q.offered} / {q.active}
                </Table.Td>
                <Table.Td>
                  {q.todaySlPct === null ? (
                    '—'
                  ) : (
                    <Badge color={slLow ? 'red' : 'green'} variant="light">
                      {q.todaySlPct.toLocaleString('ru-RU')} %
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  {q.todayAnswered} / {q.todayAbandoned}
                </Table.Td>
                <Table.Td>{q.maxWaitS ? `${q.maxWaitS} с` : '—'}</Table.Td>
              </Table.Tr>
            );
          })}
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
            <Table.Th>Звонок</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {operators.map((o) => {
            const longBreak = !!th && o.status === 'break' && o.sinceS >= th.breakWarnS;
            return (
              <Table.Tr
                key={o.id}
                bg={longBreak ? ROW_BG[2] : undefined}
                data-long-break={longBreak || undefined}
              >
                <Table.Td>{o.fullName}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    <Badge color={STATUS_COLOR[o.status] ?? 'gray'}>
                      {STATUS_LABEL[o.status] ?? o.status}
                    </Badge>
                    {o.reasonName && <Text size="xs">{o.reasonName}</Text>}
                  </Group>
                </Table.Td>
                <Table.Td>{mins(o.sinceS)}</Table.Td>
                <Table.Td>{o.activeChats}</Table.Td>
                <Table.Td>
                  {o.callId && (
                    <Group gap={4}>
                      <Text size="xs">{o.callNumber}</Text>
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => listen.mutate(String(o.callId))}
                        data-testid="supervisor-listen"
                      >
                        Прослушать
                      </Button>
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {th && (
        <Text size="xs" c="dimmed" mt="md">
          Подсветка: ожидание от {th.waitWarnS} с / {th.waitCritS} с, в очереди от {th.queueWarn} /{' '}
          {th.queueCrit}, перерыв дольше {Math.round(th.breakWarnS / 60)} мин, SL ниже {th.slTargetPct} %.
          Пороги — в «Настройках».
        </Text>
      )}
    </>
  );
}
