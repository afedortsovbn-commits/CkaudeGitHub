import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Paper,
  Progress,
  Radio,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconClipboardCheck, IconX } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorText, get, post } from '../lib/api';
import { t } from '../lib/i18n';

interface StartedQuestion {
  id: string;
  text: string;
  multi: boolean;
  options: { id: string; text: string }[];
}
interface Started {
  attemptId: string;
  title: string;
  description: string;
  passScore: number;
  questions: StartedQuestion[];
}
export interface AttemptDetail {
  id: string;
  fullName?: string;
  testTitle: string;
  passScore: number;
  finishedAt: string | null;
  correct: number;
  total: number;
  score: number;
  passed: boolean;
  questions: {
    id: string;
    text: string;
    options: { id: string; text: string; correct: boolean }[];
    chosen: string[] | null;
    correct: boolean | null;
  }[];
}

/** Цвет балла: от 80 % — зелёный, 50–79 % — жёлтый, ниже — красный. */
export const scoreColor = (s: number | null | undefined) =>
  s === null || s === undefined ? 'gray' : s >= 80 ? 'green' : s >= 50 ? 'yellow' : 'red';

export const fmtDateTime = (s: unknown) =>
  s
    ? new Date(String(s)).toLocaleString('ru-RU', {
        timeZone: 'Europe/Minsk',
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : '—';
export const fmtDate = (d: unknown) => {
  const s = String(d ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '—';
};

/** Разбор попытки: итог и каждый вопрос — правильные варианты зелёным, выбранные неверно — красным. */
export function AttemptResult({ a }: { a: AttemptDetail }) {
  return (
    <Stack gap="sm" data-testid="attempt-result">
      <Alert
        color={a.passed ? 'green' : 'red'}
        icon={a.passed ? <IconCheck size={18} /> : <IconX size={18} />}
        title={a.passed ? t.tests.resultPassed : t.tests.resultFailed}
      >
        <Text size="sm" data-testid="attempt-score">
          {t.tests.resultLine(a.correct, a.total, a.score)} · {t.tests.passScoreShort(a.passScore)}
        </Text>
      </Alert>
      {a.questions.map((q, i) => {
        const chosen = new Set(q.chosen ?? []);
        return (
          <Paper
            key={q.id}
            withBorder
            p="sm"
            style={{ borderLeft: `4px solid var(--mantine-color-${q.correct ? 'green' : 'red'}-6)` }}
            data-testid="attempt-question"
            data-correct={q.correct || undefined}
          >
            <Group gap={6} mb={6} wrap="nowrap" align="flex-start">
              {q.correct ? (
                <IconCheck size={18} color="var(--mantine-color-green-7)" style={{ flex: 'none' }} />
              ) : (
                <IconX size={18} color="var(--mantine-color-red-7)" style={{ flex: 'none' }} />
              )}
              <Text size="sm" fw={600}>
                {i + 1}. {q.text}
              </Text>
            </Group>
            <Stack gap={2} pl={24}>
              {q.options.map((o) => {
                const picked = chosen.has(o.id);
                const color = o.correct ? 'green.8' : picked ? 'red.7' : undefined;
                return (
                  <Group key={o.id} gap={6} wrap="nowrap" align="flex-start">
                    <Text size="sm" c={color} fw={o.correct || picked ? 600 : undefined} style={{ flex: 1 }}>
                      {picked ? '●' : '○'} {o.text}
                    </Text>
                    {o.correct && (
                      <Badge size="xs" color="green" variant="light" style={{ flex: 'none' }}>
                        {t.tests.rightAnswer}
                      </Badge>
                    )}
                    {picked && (
                      <Badge
                        size="xs"
                        color={o.correct ? 'green' : 'red'}
                        variant="outline"
                        style={{ flex: 'none' }}
                      >
                        {t.tests.yourAnswer}
                      </Badge>
                    )}
                  </Group>
                );
              })}
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

/** Окно с разбором уже пройденной попытки (свой результат или сотрудника — для супервизора). */
export function AttemptModal({ attemptId, onClose }: { attemptId: string | null; onClose(): void }) {
  const q = useQuery({
    queryKey: [`/tests-attempts/${attemptId}`],
    queryFn: () => get<AttemptDetail>(`/tests-attempts/${attemptId}`),
    enabled: !!attemptId,
  });
  return (
    <Modal
      opened={!!attemptId}
      onClose={onClose}
      size="lg"
      title={
        q.data ? `${q.data.testTitle}${q.data.fullName ? ` · ${q.data.fullName}` : ''}` : t.tests.resultTitle
      }
    >
      {q.data ? <AttemptResult a={q.data} /> : <Loader size="sm" />}
    </Modal>
  );
}

/**
 * Прохождение теста: попытка начинается при открытии (вопросы без правильных ответов), ответы — переключатели
 * (один правильный) или флажки (несколько), «Завершить» — проверка на сервере и сразу разбор.
 */
export function TakeTestModal({ testId, onClose }: { testId: string | null; onClose(): void }) {
  const qc = useQueryClient();
  const [started, setStarted] = useState<Started | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<AttemptDetail | null>(null);
  const start = useMutation({
    mutationFn: (id: string) => post<Started>(`/my-tests/${id}/start`),
    onSuccess: (s) => setStarted(s),
    onError: (e) => {
      notifications.show({ color: 'red', title: t.error, message: errorText(e), autoClose: 8000 });
      onClose();
    },
  });
  const finish = useMutation({
    mutationFn: () =>
      post<AttemptDetail>(`/my-tests/attempts/${started!.attemptId}/finish`, {
        answers: Object.entries(answers).map(([questionId, optionIds]) => ({ questionId, optionIds })),
      }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ predicate: (x) => /^\/(my-tests|tests)/.test(String(x.queryKey[0])) });
    },
    onError: (e) =>
      notifications.show({ color: 'red', title: t.error, message: errorText(e), autoClose: 8000 }),
  });
  useEffect(() => {
    setStarted(null);
    setAnswers({});
    setResult(null);
    if (testId) start.mutate(testId);
  }, [testId]);
  const n = started?.questions.length ?? 0;
  const done = started ? started.questions.filter((q) => (answers[q.id] ?? []).length > 0).length : 0;
  const submit = () => {
    if (done < n && !window.confirm(t.tests.finishConfirm(n - done))) return;
    finish.mutate();
  };
  return (
    <Modal
      opened={!!testId}
      onClose={onClose}
      size="lg"
      closeOnClickOutside={false}
      title={
        <Group gap={6}>
          <IconClipboardCheck size={20} color="var(--mantine-color-blue-6)" />
          <Text fw={700}>{t.tests.takeTitle(started?.title ?? '')}</Text>
        </Group>
      }
      data-testid="take-test"
    >
      {!started ? (
        <Loader size="sm" />
      ) : result ? (
        <Stack>
          <AttemptResult a={result} />
          <Button onClick={onClose} data-testid="take-close">
            {t.tests.close}
          </Button>
        </Stack>
      ) : (
        <Stack gap="sm">
          {started.description ? (
            <Text size="sm" c="dimmed">
              {started.description}
            </Text>
          ) : null}
          <Box pos="sticky" top={0} bg="var(--mantine-color-body)" py={4} style={{ zIndex: 2 }}>
            <Group justify="space-between" mb={4}>
              <Text size="xs" c="dimmed">
                {t.tests.answered(done, n)}
              </Text>
              <Text size="xs" c="dimmed">
                {t.tests.passScoreShort(started.passScore)}
              </Text>
            </Group>
            <Progress value={n ? (done * 100) / n : 0} size="sm" />
          </Box>
          {started.questions.map((q, i) => (
            <Paper key={q.id} withBorder p="sm" data-testid="take-question">
              <Text size="sm" fw={600} mb={2}>
                {i + 1}. {q.text}
              </Text>
              <Text size="xs" c="dimmed" mb={6}>
                {q.multi ? t.tests.multiHint : t.tests.singleHint}
              </Text>
              {q.multi ? (
                <Checkbox.Group
                  value={answers[q.id] ?? []}
                  onChange={(v) => setAnswers({ ...answers, [q.id]: v })}
                >
                  <Stack gap={6}>
                    {q.options.map((o) => (
                      <Checkbox key={o.id} value={o.id} label={o.text} data-testid="take-option" />
                    ))}
                  </Stack>
                </Checkbox.Group>
              ) : (
                <Radio.Group
                  value={answers[q.id]?.[0] ?? null}
                  onChange={(v) => setAnswers({ ...answers, [q.id]: [v] })}
                >
                  <Stack gap={6}>
                    {q.options.map((o) => (
                      <Radio key={o.id} value={o.id} label={o.text} data-testid="take-option" />
                    ))}
                  </Stack>
                </Radio.Group>
              )}
            </Paper>
          ))}
          <Button onClick={submit} loading={finish.isPending} size="md" data-testid="take-finish">
            {t.tests.finish}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}

/**
 * Значок в шапке: тест просрочен (красный, мигает) или срок через 3 дня или меньше (оранжевый) — сотрудник видит
 * это постоянно, щелчок — «Мои тесты и рейтинг».
 */
export function TestDueBadge() {
  const nav = useNavigate();
  const q = useQuery({
    queryKey: ['/my-tests/due'],
    queryFn: () => get<{ overdue: number; soon: number; nearest: string | null }>('/my-tests/due'),
    refetchInterval: 300_000,
  });
  const d = q.data;
  if (!d || (!d.overdue && !d.soon)) return null;
  const late = d.overdue > 0;
  return (
    <Tooltip label={t.tests.dueHint} withArrow>
      <Badge
        color={late ? 'red' : 'orange'}
        variant="filled"
        size="lg"
        leftSection={<IconClipboardCheck size={14} />}
        className={late ? 'cc-urgent-blink' : undefined}
        style={{ cursor: 'pointer', textTransform: 'none' }}
        onClick={() => nav('/my-tests')}
        data-testid="test-due"
      >
        {late ? t.tests.dueOverdue(d.overdue) : t.tests.dueSoon(fmtDate(d.nearest).slice(0, 5))}
      </Badge>
    </Tooltip>
  );
}
