import { IconDeviceTv } from '@tabler/icons-react';
import { Badge, Button, Card, Group, Menu, SimpleGrid, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

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
  /** Д-017: занятость за сегодня, %; карточки, не закрытые после звонка; продления постобработки «+2 мин». */
  occupancyPct: number | null;
  unclosedCards: number;
  wrapUpExtends: number;
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
  /** Д-017: просроченные неспешные обращения в очереди. */
  overdue: number;
}

const STATUS_LABEL: Record<string, string> = {
  ready: t.supervisor.gotov,
  break: t.supervisor.pereryv,
  wrap_up: t.supervisor.postobrabotka,
  offline: t.supervisor.oflayn,
};
const STATUS_COLOR: Record<string, string> = {
  ready: 'green',
  break: 'yellow',
  wrap_up: 'blue',
  offline: 'gray',
};
const CONV_STATUS: Record<string, string> = {
  bot: t.supervisor.uBotaVIvr,
  queued: t.supervisor.vOcheredi,
  offered: t.supervisor.predlozheno,
  active: t.supervisor.vRabote,
  waiting_2nd_line: t.supervisor.na2YLinii,
  waiting_customer: t.supervisor.zhdutKlienta,
  new: t.supervisor.novye,
};

const mins = (s: number) => t.supervisor.minS(Math.floor(s / 60), s % 60);
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
  // Ф14: сразу в режиме суфлирования или вмешательства; перехват — звонок переходит к супервизору.
  const { can } = useAuth();
  const listen = useAction(
    (a: { id: string; mode?: 'listen' | 'whisper' | 'barge' }) =>
      post(`/calls/${a.id}/listen`, { mode: a.mode ?? 'listen' }),
    t.supervisor.podklyuchaemProslushivanie,
  );
  const takeover = useAction((id: string) => post(`/calls/${id}/takeover`), t.supervisor.perekhvatZvonka);
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
      <Group justify="flex-end" mb="xs">
        <Button
          size="xs"
          variant="light"
          leftSection={<IconDeviceTv size={16} />}
          onClick={() => window.open('/wallboard', 'cc-wallboard')}
          data-testid="open-wallboard"
        >
          {t.wallboard.openOnMonitor}
        </Button>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 3, md: 6 }} mb="lg" data-testid="supervisor-summary">
        <Tile
          label={t.supervisor.ozhidayutVOcheredyakh}
          value={String(waiting)}
          lvl={th ? level(waiting, th.queueWarn, th.queueCrit) : 0}
          testId="supervisor-waiting"
        />
        <Tile
          label={t.supervisor.dolsheVsekhZhdet}
          value={waiting ? mins(oldest) : '—'}
          lvl={th && waiting ? level(oldest, th.waitWarnS, th.waitCritS) : 0}
        />
        <Tile
          label={t.supervisor.operatoryGotovyPereryv}
          value={`${byStatus('ready')} / ${byStatus('break')}`}
        />
        <Tile
          label={t.supervisor.postobrabotkaOflayn}
          value={`${byStatus('wrap_up')} / ${byStatus('offline')}`}
        />
        <Tile label={t.supervisor.otvechenoPropushchenoSegodnya} value={`${answered} / ${abandoned}`} />
        <Tile
          label={t.supervisor.aktivnyeObrashcheniya}
          value={String([...activeTotals.values()].reduce((a, b) => a + b, 0))}
          testId="supervisor-active"
        />
        <Tile
          label={t.supervisor.prosrochenoVOcheredi}
          value={String(d?.overdue ?? 0)}
          lvl={d?.overdue ? 1 : 0}
          testId="supervisor-overdue"
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
        {t.supervisor.ocheredi}
      </Title>
      <Table striped mb="xl" data-testid="supervisor-queues">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.supervisor.ochered}</Table.Th>
            <Table.Th>{t.supervisor.ozhidayut}</Table.Th>
            <Table.Th>{t.supervisor.dolsheVsekhZhdet}</Table.Th>
            <Table.Th>{t.supervisor.predlozhenoVRabote}</Table.Th>
            <Table.Th>{t.supervisor.slSegodnya}</Table.Th>
            <Table.Th>{t.supervisor.otvechenoPropushcheno}</Table.Th>
            <Table.Th>{t.supervisor.porogEskalatsii}</Table.Th>
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
                      <Badge color="red" variant="outline" title={t.supervisor.osoboVazhnyeVOcheredi}>
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
                <Table.Td>{q.maxWaitS ? t.supervisor.s(q.maxWaitS) : '—'}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      <Title order={5} mb="xs">
        {t.supervisor.operatory}
      </Title>
      <Table striped data-testid="supervisor-operators">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.supervisor.operator}</Table.Th>
            <Table.Th>{t.supervisor.status}</Table.Th>
            <Table.Th>{t.supervisor.vStatuse}</Table.Th>
            <Table.Th>{t.supervisor.aktivnykhChatov}</Table.Th>
            <Table.Th title={t.supervisor.zanyatostHint}>{t.supervisor.zanyatost}</Table.Th>
            <Table.Th>{t.supervisor.nezakrytyeKartochki}</Table.Th>
            <Table.Th>{t.supervisor.zvonok}</Table.Th>
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
                <Table.Td data-testid="supervisor-occupancy">
                  {o.occupancyPct === null || o.occupancyPct === undefined ? '—' : `${o.occupancyPct} %`}
                </Table.Td>
                <Table.Td data-testid="supervisor-unclosed">
                  <Group gap={4}>
                    <Text
                      size="sm"
                      c={o.unclosedCards ? 'orange' : undefined}
                      fw={o.unclosedCards ? 700 : undefined}
                    >
                      {o.unclosedCards || '—'}
                    </Text>
                    {o.wrapUpExtends > 0 && (
                      <Badge size="xs" color="yellow" variant="light">
                        {t.supervisor.prodleniy(o.wrapUpExtends)}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {o.callId && (
                    <Group gap={4}>
                      <Text size="xs">{o.callNumber}</Text>
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => listen.mutate({ id: String(o.callId) })}
                        data-testid="supervisor-listen"
                      >
                        {t.supervisor.proslushat}
                      </Button>
                      {(can('calls.whisper') || can('calls.barge') || can('conversations.takeover')) && (
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target>
                            <Button size="xs" variant="subtle" px={6} data-testid="supervisor-more">
                              ⋯
                            </Button>
                          </Menu.Target>
                          <Menu.Dropdown>
                            {can('calls.whisper') && (
                              <Menu.Item
                                onClick={() => listen.mutate({ id: String(o.callId), mode: 'whisper' })}
                                data-testid="supervisor-whisper"
                              >
                                {t.supervisor.suflirovat}
                              </Menu.Item>
                            )}
                            {can('calls.barge') && (
                              <Menu.Item
                                onClick={() => listen.mutate({ id: String(o.callId), mode: 'barge' })}
                                data-testid="supervisor-barge"
                              >
                                {t.supervisor.vmeshatsya}
                              </Menu.Item>
                            )}
                            {can('conversations.takeover') && (
                              <Menu.Item
                                color="orange"
                                onClick={() => takeover.mutate(String(o.callId))}
                                data-testid="supervisor-takeover-call"
                              >
                                {t.supervisor.perekhvatit}
                              </Menu.Item>
                            )}
                          </Menu.Dropdown>
                        </Menu>
                      )}
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
          {t.supervisor.podsvetkaOzhidanieOt}
          {th.waitWarnS}
          {t.supervisor.s2}
          {th.waitCritS}
          {t.supervisor.sVOcherediOt}
          {th.queueWarn} / {th.queueCrit}
          {t.supervisor.pereryvDolshe}
          {Math.round(th.breakWarnS / 60)}
          {t.supervisor.minSlNizhe}
          {th.slTargetPct}
          {t.supervisor.porogiVNastroykakh}
        </Text>
      )}
    </>
  );
}
