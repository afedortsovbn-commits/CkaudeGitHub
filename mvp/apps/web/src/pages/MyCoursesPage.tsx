import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Image,
  List,
  Paper,
  Progress,
  Radio,
  RingProgress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBook2,
  IconBulb,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconQuote,
  IconSchool,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { TakeTestModal } from '../components/TestAttempt';
import { authBlobUrl, get, post } from '../lib/api';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

/** Блоки урока (см. courses.controller.ts). */
export type Block =
  | { type: 'text'; title?: string; text: string }
  | { type: 'image'; assetId?: string; url?: string; caption?: string }
  | { type: 'tip'; text: string; tone?: 'info' | 'warning' | 'success' }
  | { type: 'steps'; title?: string; items: string[] }
  | { type: 'quote'; text: string; author?: string }
  | {
      type: 'situation';
      id: string;
      question: string;
      options: { id: string; text: string; correct: boolean; feedback?: string }[];
      explanation?: string;
    };

interface MyCourse {
  id: string;
  title: string;
  description: string;
  coverAssetId: string | null;
  color: string;
  icon: string;
  minutes: number;
  lessons: number;
  assignmentId: string | null;
  dueDate: string | null;
  completedAt: string | null;
  isRepeat: boolean;
  comment: string;
  progressPct: number;
  status: 'available' | 'assigned' | 'overdue' | 'completed';
}
interface LessonProgress {
  readAt: string | null;
  answers: Record<string, string>;
  situationsTotal: number;
  situationsCorrect: number;
  testPassedAt: string | null;
  completedAt: string | null;
}
interface Lesson {
  id: string;
  title: string;
  summary: string;
  blocks: Block[];
  testId: string | null;
  testTitle: string | null;
  passScore: number | null;
  progress: LessonProgress | null;
}
interface MyCourseFull extends Omit<MyCourse, 'lessons'> {
  assignment: { id: string; dueDate: string; completedAt: string | null } | null;
  scope: string;
  lessons: Lesson[];
}

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Minsk',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
const dmy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const STATUS_COLOR: Record<MyCourse['status'], string> = {
  available: 'gray',
  assigned: 'blue',
  overdue: 'red',
  completed: 'green',
};
const STATUS_LABEL: Record<MyCourse['status'], string> = {
  available: t.courses.statusAvailable,
  assigned: t.courses.statusAssigned,
  overdue: t.courses.statusOverdue,
  completed: t.courses.statusCompleted,
};

/** Картинка курса (с авторизацией). */
export function AssetImage({ id, url, alt, h }: { id?: string; url?: string; alt?: string; h?: number }) {
  const [src, setSrc] = useState<string | null>(url ?? null);
  useEffect(() => {
    let alive = true;
    if (url) setSrc(url);
    else if (id)
      void authBlobUrl(`/courses/assets/${id}`)
        .then((u) => alive && setSrc(u))
        .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, url]);
  if (!src) return null;
  return <Image src={src} alt={alt ?? ''} h={h} fit="cover" radius="md" />;
}

/** Текст урока: абзацы, списки («- »), **жирный**. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/\n{2,}/);
  const inline = (s: string) =>
    s
      .split(/(\*\*[^*]+\*\*)/g)
      .map((x, i) =>
        x.startsWith('**') && x.endsWith('**') ? (
          <b key={i}>{x.slice(2, -2)}</b>
        ) : (
          <Fragment key={i}>{x}</Fragment>
        ),
      );
  return (
    <>
      {parts.map((p, i) => {
        const lines = p.split('\n');
        if (lines.every((l) => l.trim().startsWith('- ')))
          return (
            <List key={i} spacing={4} size="sm" mb="sm">
              {lines.map((l, j) => (
                <List.Item key={j}>{inline(l.trim().slice(2))}</List.Item>
              ))}
            </List>
          );
        return (
          <Text key={i} size="sm" mb="sm" style={{ lineHeight: 1.55 }}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {inline(l)}
                {j < lines.length - 1 && <br />}
              </Fragment>
            ))}
          </Text>
        );
      })}
    </>
  );
}

function CourseCard({ c }: { c: MyCourse }) {
  return (
    <Card withBorder radius="md" padding="md" data-testid="course-card" data-status={c.status}>
      {c.coverAssetId ? (
        <Card.Section>
          <AssetImage id={c.coverAssetId} h={120} />
        </Card.Section>
      ) : (
        <Card.Section
          bg={`${c.color}.1`}
          h={80}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <ThemeIcon size={48} radius="xl" color={c.color} variant="light">
            <IconSchool size={28} />
          </ThemeIcon>
        </Card.Section>
      )}
      <Stack gap={6} mt="sm">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={700} size="sm" lineClamp={2}>
            {c.title}
          </Text>
          <RingProgress
            size={44}
            thickness={5}
            roundCaps
            sections={[{ value: c.progressPct, color: c.status === 'overdue' ? 'red' : 'green' }]}
            label={
              <Text size="xs" ta="center" fw={600}>
                {c.progressPct}
              </Text>
            }
          />
        </Group>
        <Text size="xs" c="dimmed" lineClamp={2}>
          {c.description}
        </Text>
        <Group gap={6}>
          <Badge size="xs" color={STATUS_COLOR[c.status]} variant="light" data-testid="course-status">
            {STATUS_LABEL[c.status]}
            {c.dueDate && c.status !== 'completed' ? ` · ${t.courses.dueBy(dmy(c.dueDate))}` : ''}
          </Badge>
          <Badge size="xs" variant="outline" color="gray">
            {t.courses.lessons(c.lessons)}
          </Badge>
          <Badge size="xs" variant="outline" color="gray">
            {t.courses.minutes(c.minutes)}
          </Badge>
          {c.isRepeat && (
            <Badge size="xs" variant="outline" color="orange">
              {t.courses.repeat}
            </Badge>
          )}
        </Group>
        <Button
          component={Link}
          to={`/my-courses/${c.id}`}
          size="xs"
          mt={4}
          variant={c.status === 'completed' ? 'light' : 'filled'}
          color={c.color}
          data-testid="course-open"
        >
          {c.status === 'completed'
            ? t.courses.review
            : c.progressPct
              ? t.courses.continueCourse
              : t.courses.startCourse}
        </Button>
      </Stack>
    </Card>
  );
}

/** Моё обучение: назначенные и доступные курсы. */
export function MyCoursesPage() {
  const q = useQuery({ queryKey: ['/my-courses'], queryFn: () => get<MyCourse[]>('/my-courses') });
  const list = q.data ?? [];
  return (
    <Stack>
      <Title order={3}>{t.courses.myTitle}</Title>
      {q.data && !list.length && <Text c="dimmed">{t.courses.noCourses}</Text>}
      {q.data && list.length > 0 && !list.some((c) => c.assignmentId) && (
        <Text size="sm" c="dimmed">
          {t.courses.myEmpty}
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} data-testid="my-courses">
        {list.map((c) => (
          <CourseCard key={c.id} c={c} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

const TONE_COLOR = { info: 'blue', warning: 'orange', success: 'green' } as const;

function Situation({
  s,
  chosen,
  onPick,
}: {
  s: Extract<Block, { type: 'situation' }>;
  chosen: string | undefined;
  onPick(optionId: string): void;
}) {
  const picked = s.options.find((o) => o.id === chosen);
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      bg="violet.0"
      data-testid="situation"
      data-answered={chosen ? 'yes' : undefined}
    >
      <Group gap={8} mb="xs">
        <ThemeIcon color="violet" variant="light" radius="xl">
          <IconBulb size={18} />
        </ThemeIcon>
        <Text fw={700} size="sm">
          {t.courses.situationsTitle}
        </Text>
      </Group>
      <Text size="sm" mb="sm" style={{ lineHeight: 1.5 }}>
        {s.question}
      </Text>
      <Radio.Group value={chosen ?? null} onChange={(v) => !chosen && onPick(v)}>
        <Stack gap={6}>
          {s.options.map((o) => {
            const state = chosen ? (o.correct ? 'ok' : o.id === chosen ? 'bad' : 'muted') : 'idle';
            return (
              <Paper
                key={o.id}
                withBorder
                p="xs"
                radius="sm"
                bg={state === 'ok' ? 'green.0' : state === 'bad' ? 'red.0' : undefined}
                style={{ cursor: chosen ? 'default' : 'pointer', opacity: state === 'muted' ? 0.6 : 1 }}
                onClick={() => !chosen && onPick(o.id)}
                data-testid="situation-option"
              >
                <Radio
                  value={o.id}
                  label={o.text}
                  disabled={!!chosen}
                  styles={{ label: { cursor: 'inherit' } }}
                />
                {chosen && o.id === chosen && o.feedback && (
                  <Text size="xs" c={o.correct ? 'green.8' : 'red.8'} mt={4} ml={28}>
                    {o.feedback}
                  </Text>
                )}
              </Paper>
            );
          })}
        </Stack>
      </Radio.Group>
      {picked && (
        <Alert
          mt="sm"
          color={picked.correct ? 'green' : 'orange'}
          icon={picked.correct ? <IconCircleCheck size={18} /> : <IconAlertTriangle size={18} />}
          title={picked.correct ? t.courses.correct : t.courses.wrong}
          data-testid="situation-result"
        >
          {s.explanation ?? (picked.correct ? '' : s.options.find((o) => o.correct)?.text)}
        </Alert>
      )}
    </Paper>
  );
}

function BlockView({
  b,
  chosen,
  onPick,
}: {
  b: Block;
  chosen: Record<string, string>;
  onPick(sid: string, oid: string): void;
}) {
  switch (b.type) {
    case 'text':
      return (
        <Box>
          {b.title && (
            <Title order={5} mb={6}>
              {b.title}
            </Title>
          )}
          <RichText text={b.text} />
        </Box>
      );
    case 'image':
      return (
        <Box ta="center">
          <AssetImage id={b.assetId} url={b.url} alt={b.caption} />
          {b.caption && (
            <Text size="xs" c="dimmed" mt={4}>
              {b.caption}
            </Text>
          )}
        </Box>
      );
    case 'tip':
      return (
        <Alert color={TONE_COLOR[b.tone ?? 'info']} icon={<IconBulb size={18} />} radius="md">
          <RichText text={b.text} />
        </Alert>
      );
    case 'steps':
      return (
        <Paper withBorder p="md" radius="md">
          <Text fw={700} size="sm" mb="xs">
            {b.title ?? t.courses.stepsTitle}
          </Text>
          <List type="ordered" spacing={6} size="sm">
            {b.items.map((it, i) => (
              <List.Item key={i}>{it}</List.Item>
            ))}
          </List>
        </Paper>
      );
    case 'quote':
      return (
        <Paper
          p="md"
          radius="md"
          bg="gray.0"
          style={{ borderLeft: '4px solid var(--mantine-color-green-5)' }}
        >
          <Group gap={8} align="flex-start" wrap="nowrap">
            <IconQuote size={18} style={{ flexShrink: 0, opacity: 0.6 }} />
            <Box>
              <Text size="sm" fs="italic">
                {b.text}
              </Text>
              {b.author && (
                <Text size="xs" c="dimmed" mt={4}>
                  — {b.author}
                </Text>
              )}
            </Box>
          </Group>
        </Paper>
      );
    case 'situation':
      return <Situation s={b} chosen={chosen[b.id]} onPick={(oid) => onPick(b.id, oid)} />;
    default:
      return null;
  }
}

/** Прохождение курса: список уроков слева, урок справа; ситуации, тест, отметки. */
export function CourseLessonPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [`/my-courses/${id}`],
    queryFn: () => get<MyCourseFull>(`/my-courses/${id}`),
    enabled: !!id,
  });
  const course = q.data;
  const lessons = useMemo(() => course?.lessons ?? [], [course]);
  const [idx, setIdx] = useState(0);
  // Открывать первый непройденный урок.
  useEffect(() => {
    if (!lessons.length) return;
    const first = lessons.findIndex((l) => !l.progress?.completedAt);
    setIdx(first === -1 ? 0 : first);
  }, [course?.id, lessons.length]);
  const lesson = lessons[idx];
  const [testFor, setTestFor] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  useEffect(() => setChosen(lesson?.progress?.answers ?? {}), [lesson?.id, lesson?.progress?.answers]);
  const assignmentId = course?.assignment && !course.assignment.completedAt ? course.assignment.id : null;
  const save = useAction(async (body: { read?: boolean; answers?: Record<string, string> }) => {
    const r = await post<{ completed: boolean; courseCompleted: boolean }>(
      `/my-courses/lessons/${lesson!.id}/progress`,
      {
        assignmentId,
        ...body,
      },
    );
    return r;
  }, t.courses.lessonRead);
  const refresh = () =>
    qc.invalidateQueries({ predicate: (x) => /^\/my-courses/.test(String(x.queryKey[0])) });
  const pick = (sid: string, oid: string) => {
    setChosen((c) => ({ ...c, [sid]: oid }));
    void post(`/my-courses/lessons/${lesson!.id}/progress`, { assignmentId, answers: { [sid]: oid } }).then(
      refresh,
    );
  };
  if (!course || !lesson)
    return (
      <Stack>
        <Button
          component={Link}
          to="/my-courses"
          variant="subtle"
          size="xs"
          leftSection={<IconChevronLeft size={14} />}
          w="fit-content"
        >
          {t.courses.backToList}
        </Button>
      </Stack>
    );
  const pr = lesson.progress;
  const situations = lesson.blocks.filter(
    (b): b is Extract<Block, { type: 'situation' }> => b.type === 'situation',
  );
  const answered = situations.filter((s) => chosen[s.id]).length;
  const correct = situations.filter((s) => s.options.find((o) => o.id === chosen[s.id])?.correct).length;
  const doneCount = lessons.filter((l) => l.progress?.completedAt).length;
  const allDone = lessons.length > 0 && doneCount === lessons.length;
  return (
    <Stack gap="sm">
      <TakeTestModal
        testId={testFor}
        onClose={() => {
          setTestFor(null);
          // Результат теста — в отметку урока.
          void post(`/my-courses/lessons/${lesson.id}/progress`, { assignmentId }).then(refresh);
        }}
      />
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <Button
            component={Link}
            to="/my-courses"
            variant="subtle"
            size="xs"
            leftSection={<IconChevronLeft size={14} />}
          >
            {t.courses.backToList}
          </Button>
          <Title order={4} lineClamp={1}>
            {course.title}
          </Title>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {course.assignment && !course.assignment.completedAt && (
            <Badge color="blue" variant="light">
              {t.courses.dueBy(dmy(course.assignment.dueDate))}
            </Badge>
          )}
          <Text size="xs" c="dimmed">
            {doneCount}/{lessons.length}
          </Text>
          <Progress value={lessons.length ? (100 * doneCount) / lessons.length : 0} w={120} color="green" />
        </Group>
      </Group>
      {allDone && (
        <Alert
          color="green"
          icon={<IconCircleCheck size={18} />}
          title={t.courses.courseCompletedTitle}
          data-testid="course-completed"
        >
          {t.courses.courseCompleted}
        </Alert>
      )}
      <Group align="flex-start" wrap="nowrap" gap="md">
        <Paper withBorder p="xs" radius="md" w={260} style={{ flexShrink: 0 }} data-testid="lesson-list">
          <Stack gap={4}>
            {lessons.map((l, i) => (
              <Paper
                key={l.id}
                p="xs"
                radius="sm"
                bg={i === idx ? 'green.0' : undefined}
                style={{ cursor: 'pointer' }}
                onClick={() => setIdx(i)}
                data-testid="lesson-item"
                data-done={l.progress?.completedAt ? 'yes' : undefined}
              >
                <Group gap={8} wrap="nowrap">
                  <ThemeIcon
                    size="sm"
                    radius="xl"
                    color={l.progress?.completedAt ? 'green' : 'gray'}
                    variant={l.progress?.completedAt ? 'filled' : 'light'}
                  >
                    {l.progress?.completedAt ? <IconCheck size={12} /> : <Text size="xs">{i + 1}</Text>}
                  </ThemeIcon>
                  <Text size="sm" fw={i === idx ? 700 : 500} lineClamp={2}>
                    {l.title}
                  </Text>
                </Group>
              </Paper>
            ))}
          </Stack>
        </Paper>
        <Paper withBorder p="lg" radius="md" style={{ flex: 1, minWidth: 0 }} data-testid="lesson-view">
          <Stack gap="md">
            <Box>
              <Text size="xs" c="dimmed">
                {t.courses.lessonOf(idx + 1, lessons.length)}
              </Text>
              <Title order={3}>{lesson.title}</Title>
              {lesson.summary && (
                <Text size="sm" c="dimmed">
                  {lesson.summary}
                </Text>
              )}
            </Box>
            {lesson.blocks.map((b, i) => (
              <BlockView key={i} b={b} chosen={chosen} onPick={pick} />
            ))}
            <Paper withBorder p="md" radius="md" bg="gray.0" data-testid="lesson-footer">
              <Stack gap="xs">
                {situations.length > 0 && (
                  <Text size="sm" data-testid="situations-score">
                    {t.courses.situationsDone(correct, situations.length)}
                    {answered < situations.length ? ` · ${t.courses.situationsHint}` : ''}
                  </Text>
                )}
                <Group gap="xs">
                  {pr?.readAt ? (
                    <Badge color="green" variant="light" leftSection={<IconCheck size={12} />}>
                      {t.courses.lessonRead}
                    </Badge>
                  ) : (
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => save.mutate({ read: true }, { onSuccess: refresh })}
                      loading={save.isPending}
                      data-testid="lesson-read"
                    >
                      {t.courses.markRead}
                    </Button>
                  )}
                  {lesson.testId && (
                    <>
                      {pr?.testPassedAt ? (
                        <Badge
                          color="green"
                          variant="light"
                          leftSection={<IconCheck size={12} />}
                          data-testid="lesson-test-passed"
                        >
                          {t.courses.testPassed(fmtDate(pr.testPassedAt))}
                        </Badge>
                      ) : null}
                      <Button
                        size="xs"
                        color="violet"
                        variant={pr?.testPassedAt ? 'subtle' : 'filled'}
                        onClick={() => setTestFor(lesson.testId)}
                        data-testid="lesson-test"
                      >
                        {pr?.testPassedAt ? t.courses.retakeTest : t.courses.takeTest}
                      </Button>
                      {!pr?.testPassedAt && (
                        <Text size="xs" c="dimmed">
                          {t.courses.testHint}
                        </Text>
                      )}
                    </>
                  )}
                  {pr?.completedAt && (
                    <Badge
                      color="green"
                      leftSection={<IconCircleCheck size={12} />}
                      data-testid="lesson-done"
                    >
                      {t.courses.lessonDone}
                    </Badge>
                  )}
                </Group>
                <Group justify="space-between">
                  <Button
                    size="xs"
                    variant="default"
                    disabled={idx === 0}
                    onClick={() => setIdx(idx - 1)}
                    leftSection={<IconChevronLeft size={14} />}
                  >
                    {t.courses.prevLesson}
                  </Button>
                  {idx < lessons.length - 1 ? (
                    <Button
                      size="xs"
                      onClick={() => setIdx(idx + 1)}
                      rightSection={<IconChevronRight size={14} />}
                      data-testid="lesson-next"
                    >
                      {t.courses.nextLesson}
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => nav('/my-courses')}
                      rightSection={<IconBook2 size={14} />}
                    >
                      {t.courses.backToList}
                    </Button>
                  )}
                </Group>
              </Stack>
            </Paper>
          </Stack>
        </Paper>
      </Group>
    </Stack>
  );
}
