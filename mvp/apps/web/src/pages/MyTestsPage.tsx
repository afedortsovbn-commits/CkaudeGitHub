import {
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconStarFilled, IconTrophy } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AttemptModal, fmtDate, fmtDateTime, scoreColor, TakeTestModal } from '../components/TestAttempt';
import { get } from '../lib/api';
import type { Row } from '../lib/data';
import { t } from '../lib/i18n';

interface MyRating {
  month: { avg: number | null; count: number };
  all: { avg: number | null; count: number };
  distribution: { score: number; count: number }[];
  place: number | null;
  of: number;
  handledMonth: number;
}

/** Состояние назначения: пройдено, осталось N дней, просрочено. */
export function AssignmentStatus({ a }: { a: Row }) {
  const s = String(a.status);
  const d = Number(a.daysLeft);
  if (s === 'passed')
    return (
      <Badge color="green" variant="light" data-testid="assignment-status" data-status={s}>
        {t.tests.statusPassed}
      </Badge>
    );
  if (s === 'cancelled')
    return (
      <Badge color="gray" variant="light" data-testid="assignment-status" data-status={s}>
        {t.tests.statusCancelled}
      </Badge>
    );
  if (s === 'overdue')
    return (
      <Badge
        color="red"
        variant="filled"
        className="cc-urgent-blink"
        data-testid="assignment-status"
        data-status={s}
      >
        {t.tests.statusOverdue(-d)}
      </Badge>
    );
  return (
    <Badge color={d <= 3 ? 'orange' : 'blue'} variant="light" data-testid="assignment-status" data-status={s}>
      {t.tests.statusOpen(d)}
    </Badge>
  );
}

/** Таблица компетентности сотрудника по темам. */
export function TopicTable({ rows }: { rows: Row[] }) {
  if (!rows.length)
    return (
      <Text size="sm" c="dimmed">
        {t.tests.noTopics}
      </Text>
    );
  return (
    <Table striped withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t.tests.colTopic}</Table.Th>
          <Table.Th>{t.tests.colAttempts}</Table.Th>
          <Table.Th>{t.tests.colLastShort}</Table.Th>
          <Table.Th>{t.tests.colBestShort}</Table.Th>
          <Table.Th>{t.tests.colAvgShort}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr key={String(r.topicId)}>
            <Table.Td>{String(r.topicName)}</Table.Td>
            <Table.Td>{String(r.attempts)}</Table.Td>
            <Table.Td>
              <Badge color={scoreColor(Number(r.lastScore))} variant="light">
                {String(r.lastScore)} %
              </Badge>
            </Table.Td>
            <Table.Td>{String(r.bestScore)} %</Table.Td>
            <Table.Td>{String(r.avgScore)} %</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** Попытки сотрудника: дата, тест, какая по счёту, балл, итог; щелчок — разбор ответов. */
export function AttemptsTable({ rows, onOpen }: { rows: Row[]; onOpen(id: string): void }) {
  if (!rows.length)
    return (
      <Text size="sm" c="dimmed">
        {t.tests.noHistory}
      </Text>
    );
  return (
    <Table striped highlightOnHover withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t.tests.colDate}</Table.Th>
          <Table.Th>{t.tests.colTest}</Table.Th>
          <Table.Th>{t.tests.colTry}</Table.Th>
          <Table.Th>{t.tests.colScore}</Table.Th>
          <Table.Th>{t.tests.colResult}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr
            key={r.id}
            style={{ cursor: 'pointer' }}
            onClick={() => onOpen(r.id)}
            data-testid="attempt-row"
          >
            <Table.Td>{fmtDateTime(r.finishedAt)}</Table.Td>
            <Table.Td>
              <Text size="sm">{String(r.testTitle)}</Text>
              <Text size="xs" c="dimmed">
                {((r.topicNames as string[]) ?? []).join('; ')}
              </Text>
            </Table.Td>
            <Table.Td>{t.tests.tryNo(Number(r.tryNo))}</Table.Td>
            <Table.Td>
              <Badge color={scoreColor(Number(r.score))} variant="light">
                {String(r.score)} % · {String(r.correct)}/{String(r.total)}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c={r.passed ? 'green.8' : 'red.7'}>
                {r.passed ? t.tests.passed : t.tests.failed}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/**
 * «Мои тесты и рейтинг»: рейтинг по оценкам клиентов (за 30 дней и всё время, место среди операторов),
 * назначенные тесты со сроками (пройти / пройти ещё раз), мои попытки и компетентность по темам.
 */
export function MyTestsPage() {
  const rating = useQuery({ queryKey: ['/my-rating'], queryFn: () => get<MyRating>('/my-rating') });
  const my = useQuery({
    queryKey: ['/my-tests'],
    queryFn: () => get<{ assignments: Row[]; attempts: Row[]; topics: Row[] }>('/my-tests'),
  });
  const [take, setTake] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null);
  const r = rating.data;
  const maxDist = Math.max(1, ...(r?.distribution ?? []).map((d) => d.count));
  return (
    <Stack>
      <TakeTestModal testId={take} onClose={() => setTake(null)} />
      <AttemptModal attemptId={view} onClose={() => setView(null)} />
      <Paper withBorder p="md" radius="md" data-testid="my-rating">
        <Group gap={8} mb="sm">
          <IconStarFilled size={20} color="var(--mantine-color-yellow-6)" />
          <Title order={4}>{t.tests.myRating}</Title>
        </Group>
        <Grid>
          <Grid.Col span={{ base: 12, md: 7 }}>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              {[
                { label: t.tests.month, v: r?.month },
                { label: t.tests.allTime, v: r?.all },
              ].map((x) => (
                <Card key={x.label} withBorder padding="sm">
                  <Text size="xs" c="dimmed">
                    {x.label}
                  </Text>
                  <Text fz={28} fw={800} c={x.v?.avg ? 'yellow.8' : 'dimmed'}>
                    {x.v?.avg ? x.v.avg.toFixed(2) : '—'}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {x.v?.count ? t.tests.nRatings(x.v.count) : t.tests.noRatings}
                  </Text>
                </Card>
              ))}
              <Card withBorder padding="sm">
                <Group gap={6}>
                  <IconTrophy size={18} color="var(--mantine-color-orange-6)" />
                  <Text size="xs" c="dimmed">
                    {t.tests.colPlace}
                  </Text>
                </Group>
                <Text fz={28} fw={800} data-testid="my-place">
                  {r?.place ?? '—'}
                </Text>
                <Text size="xs" c="dimmed">
                  {r?.place ? t.tests.place(r.place, r.of) : t.tests.noPlace}
                </Text>
              </Card>
            </SimpleGrid>
            <Text size="sm" mt="xs" c="dimmed">
              {t.tests.handledMonth(r?.handledMonth ?? 0)}
            </Text>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 5 }}>
            <Stack gap={4}>
              {[...(r?.distribution ?? [])].reverse().map((d) => (
                <Group key={d.score} gap={8} wrap="nowrap">
                  <Text size="sm" w={40}>
                    {'★'.repeat(1)} {d.score}
                  </Text>
                  <Progress
                    value={(d.count * 100) / maxDist}
                    color={d.score >= 4 ? 'green' : d.score === 3 ? 'yellow' : 'red'}
                    style={{ flex: 1 }}
                  />
                  <Text size="xs" c="dimmed" w={30} ta="right">
                    {d.count}
                  </Text>
                </Group>
              ))}
            </Stack>
          </Grid.Col>
        </Grid>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          {t.tests.myTests}
        </Title>
        {(my.data?.assignments ?? []).length === 0 ? (
          <Text size="sm" c="dimmed">
            {t.tests.noMyTests}
          </Text>
        ) : (
          <Stack gap="xs">
            {(my.data?.assignments ?? []).map((a) => (
              <Card
                key={a.id}
                withBorder
                padding="sm"
                data-testid="my-assignment"
                style={
                  a.status === 'overdue'
                    ? { borderColor: 'var(--mantine-color-red-5)', borderWidth: 2 }
                    : undefined
                }
              >
                <Group justify="space-between" wrap="nowrap">
                  <Stack gap={2} style={{ minWidth: 0 }}>
                    <Group gap={8}>
                      <Text fw={700}>{String(a.testTitle)}</Text>
                      <AssignmentStatus a={a} />
                    </Group>
                    <Text size="xs" c="dimmed">
                      {t.tests.colDue}: {fmtDate(a.dueDate)} · {t.tests.questionsCount(Number(a.questions))} ·{' '}
                      {t.tests.passScoreShort(Number(a.passScore))}
                      {((a.topicNames as string[]) ?? []).length
                        ? ` · ${((a.topicNames as string[]) ?? []).join('; ')}`
                        : ''}
                    </Text>
                    {a.comment ? <Text size="xs">{String(a.comment)}</Text> : null}
                    {Number(a.attempts) > 0 && (
                      <Text size="xs" c="dimmed">
                        {t.tests.colAttempts}: {String(a.attempts)} · {t.tests.colBest}:{' '}
                        <Text span size="xs" fw={700} c={scoreColor(Number(a.bestScore))}>
                          {String(a.bestScore)} %
                        </Text>
                      </Text>
                    )}
                  </Stack>
                  <Button
                    variant={a.status === 'passed' ? 'light' : 'filled'}
                    color={a.status === 'overdue' ? 'red' : 'blue'}
                    onClick={() => setTake(String(a.testId))}
                    data-testid="my-test-start"
                  >
                    {a.status === 'passed' || Number(a.attempts) > 0 ? t.tests.retake : t.tests.start}
                  </Button>
                </Group>
              </Card>
            ))}
          </Stack>
        )}
      </Paper>

      <Grid>
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Paper withBorder p="md" radius="md">
            <Title order={5} mb="sm">
              {t.tests.myHistory}
            </Title>
            <AttemptsTable rows={my.data?.attempts ?? []} onOpen={setView} />
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Paper withBorder p="md" radius="md">
            <Title order={5} mb="sm">
              {t.tests.myTopics}
            </Title>
            <TopicTable rows={my.data?.topics ?? []} />
          </Paper>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
