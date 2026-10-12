import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  FileButton,
  Group,
  Modal,
  Paper,
  Progress,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FormModal } from '../components/FormModal';
import { TreePicker } from '../components/TreePicker';
import { get, patch, post, upload } from '../lib/api';
import { type Row, useAction, useList, useRequired } from '../lib/data';
import { t } from '../lib/i18n';
import { AssetImage, type Block } from './MyCoursesPage';
import { usePeopleTree } from './TestsPage';

const COLORS = ['green', 'blue', 'violet', 'orange', 'teal', 'grape', 'cyan', 'red'];
let seq = 0;
const key = () => `b${Date.now().toString(36)}${++seq}`;

// ---------------------------------------------------------------- редактор урока

function LessonEditor({
  courseId,
  lesson,
  onClose,
}: {
  courseId: string;
  lesson: Row | 'new' | null;
  onClose(): void;
}) {
  const tests = useList('/tests');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [testId, setTestId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const req = useRequired();
  useEffect(() => {
    if (!lesson) return;
    if (lesson === 'new') {
      setTitle('');
      setSummary('');
      setTestId(null);
      setBlocks([{ type: 'text', text: '' }]);
    } else {
      setTitle(String(lesson.title ?? ''));
      setSummary(String(lesson.summary ?? ''));
      setTestId((lesson.testId as string | null) ?? null);
      setBlocks((lesson.blocks as Block[]) ?? []);
    }
    req.reset();
  }, [lesson]);
  const save = useAction(
    () =>
      lesson === 'new'
        ? post(`/courses/${courseId}/lessons`, { title, summary, blocks, testId })
        : patch(`/courses/lessons/${String((lesson as Row).id)}`, { title, summary, blocks, testId }),
    t.courses.lessonSaved,
  );
  const uploadImage = useAction(async (f: { file: File; i: number }) => {
    const r = await upload<{ id: string }>('/courses/assets', f.file);
    setBlocks((bs) =>
      bs.map((b, j) => (j === f.i && b.type === 'image' ? { ...b, assetId: r.id, url: undefined } : b)),
    );
  });
  const set = (i: number, b: Block) => setBlocks((bs) => bs.map((x, j) => (j === i ? b : x)));
  const move = (i: number, d: number) =>
    setBlocks((bs) => {
      const n = [...bs];
      const j = i + d;
      if (j < 0 || j >= n.length) return bs;
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  const add = (type: Block['type']) =>
    setBlocks((bs) => [
      ...bs,
      type === 'text'
        ? { type, text: '' }
        : type === 'image'
          ? { type, caption: '' }
          : type === 'tip'
            ? { type, text: '', tone: 'info' }
            : type === 'steps'
              ? { type, items: [] }
              : type === 'quote'
                ? { type, text: '' }
                : {
                    type,
                    id: key(),
                    question: '',
                    options: [
                      { id: key(), text: '', correct: true },
                      { id: key(), text: '', correct: false },
                    ],
                  },
    ]);
  const valid =
    title.trim() &&
    blocks.every((b) =>
      b.type === 'situation' ? b.question.trim() && b.options.every((o) => o.text.trim()) : true,
    );
  return (
    <Modal opened={!!lesson} onClose={onClose} title={t.courses.editLesson} size="xl">
      <Stack gap="sm">
        <TextInput
          label={t.courses.lessonTitle}
          withAsterisk
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          error={req.error(!title.trim())}
          data-testid="lesson-title"
        />
        <TextInput
          label={t.courses.lessonSummary}
          value={summary}
          onChange={(e) => setSummary(e.currentTarget.value)}
          data-testid="lesson-summary"
        />
        <Select
          label={t.courses.lessonTest}
          data={[
            { value: '', label: t.courses.lessonTestNone },
            ...(tests.data ?? [])
              .filter((x) => x.isActive)
              .map((x) => ({ value: String(x.id), label: String(x.title) })),
          ]}
          value={testId ?? ''}
          onChange={(v) => setTestId(v || null)}
          searchable
          data-testid="lesson-test-select"
        />
        <Text fw={600} size="sm">
          {t.courses.blocks}
        </Text>
        {blocks.map((b, i) => (
          <Paper key={i} withBorder p="sm" radius="md" data-testid={`block-${b.type}`}>
            <Group justify="space-between" mb={6}>
              <Badge variant="light">
                {
                  {
                    text: t.courses.blockText,
                    image: t.courses.blockImage,
                    tip: t.courses.blockTip,
                    steps: t.courses.blockSteps,
                    quote: t.courses.blockQuote,
                    situation: t.courses.blockSituation,
                  }[b.type]
                }
              </Badge>
              <Group gap={4}>
                <ActionIcon size="sm" variant="subtle" onClick={() => move(i, -1)} aria-label={t.courses.up}>
                  <IconArrowUp size={14} />
                </ActionIcon>
                <ActionIcon size="sm" variant="subtle" onClick={() => move(i, 1)} aria-label={t.courses.down}>
                  <IconArrowDown size={14} />
                </ActionIcon>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  onClick={() => setBlocks((bs) => bs.filter((_, j) => j !== i))}
                  aria-label={t.courses.removeBlock}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            </Group>
            {b.type === 'text' && (
              <>
                <TextInput
                  size="xs"
                  label={t.courses.blockTitle}
                  value={b.title ?? ''}
                  onChange={(e) => set(i, { ...b, title: e.currentTarget.value })}
                />
                <Textarea
                  size="xs"
                  label={t.courses.blockBody}
                  autosize
                  minRows={3}
                  value={b.text}
                  onChange={(e) => set(i, { ...b, text: e.currentTarget.value })}
                  data-testid="block-text-body"
                />
              </>
            )}
            {b.type === 'image' && (
              <Group align="flex-end">
                <AssetImage id={b.assetId} url={b.url} h={80} />
                <FileButton onChange={(file) => file && uploadImage.mutate({ file, i })} accept="image/*">
                  {(props) => (
                    <Button {...props} size="xs" variant="light" loading={uploadImage.isPending}>
                      {t.courses.blockImageUpload}
                    </Button>
                  )}
                </FileButton>
                <TextInput
                  size="xs"
                  label={t.courses.blockImageUrl}
                  value={b.url ?? ''}
                  onChange={(e) => set(i, { ...b, url: e.currentTarget.value || undefined })}
                  style={{ flex: 1 }}
                />
                <TextInput
                  size="xs"
                  label={t.courses.blockCaption}
                  value={b.caption ?? ''}
                  onChange={(e) => set(i, { ...b, caption: e.currentTarget.value })}
                  style={{ flex: 1 }}
                />
              </Group>
            )}
            {b.type === 'tip' && (
              <Group align="flex-end">
                <Select
                  size="xs"
                  label={t.courses.blockTone}
                  data={[
                    { value: 'info', label: t.courses.toneInfo },
                    { value: 'warning', label: t.courses.toneWarning },
                    { value: 'success', label: t.courses.toneSuccess },
                  ]}
                  value={b.tone ?? 'info'}
                  onChange={(v) => set(i, { ...b, tone: (v as 'info' | 'warning' | 'success') ?? 'info' })}
                  w={160}
                />
                <Textarea
                  size="xs"
                  autosize
                  minRows={2}
                  value={b.text}
                  onChange={(e) => set(i, { ...b, text: e.currentTarget.value })}
                  style={{ flex: 1 }}
                />
              </Group>
            )}
            {b.type === 'steps' && (
              <>
                <TextInput
                  size="xs"
                  label={t.courses.blockTitle}
                  value={b.title ?? ''}
                  onChange={(e) => set(i, { ...b, title: e.currentTarget.value })}
                />
                <Textarea
                  size="xs"
                  label={t.courses.blockItems}
                  autosize
                  minRows={3}
                  value={b.items.join('\n')}
                  onChange={(e) => set(i, { ...b, items: e.currentTarget.value.split('\n') })}
                />
              </>
            )}
            {b.type === 'quote' && (
              <Group align="flex-end">
                <Textarea
                  size="xs"
                  autosize
                  minRows={2}
                  value={b.text}
                  onChange={(e) => set(i, { ...b, text: e.currentTarget.value })}
                  style={{ flex: 1 }}
                />
                <TextInput
                  size="xs"
                  label={t.courses.blockAuthor}
                  value={b.author ?? ''}
                  onChange={(e) => set(i, { ...b, author: e.currentTarget.value })}
                  w={220}
                />
              </Group>
            )}
            {b.type === 'situation' && (
              <Stack gap={6}>
                <Textarea
                  size="xs"
                  label={t.courses.situationQuestion}
                  autosize
                  minRows={2}
                  value={b.question}
                  onChange={(e) => set(i, { ...b, question: e.currentTarget.value })}
                  data-testid="situation-question"
                />
                <Text size="xs" c="dimmed">
                  {t.courses.situationOptions}
                </Text>
                {b.options.map((o, k) => (
                  <Group key={o.id} gap="xs" align="flex-start" wrap="nowrap">
                    <Checkbox
                      mt={6}
                      label={t.courses.situationCorrect}
                      checked={o.correct}
                      onChange={(e) =>
                        set(i, {
                          ...b,
                          options: b.options.map((x, m) =>
                            m === k ? { ...x, correct: e.currentTarget.checked } : x,
                          ),
                        })
                      }
                    />
                    <TextInput
                      size="xs"
                      value={o.text}
                      onChange={(e) =>
                        set(i, {
                          ...b,
                          options: b.options.map((x, m) =>
                            m === k ? { ...x, text: e.currentTarget.value } : x,
                          ),
                        })
                      }
                      style={{ flex: 1 }}
                      data-testid="situation-option-text"
                    />
                    <TextInput
                      size="xs"
                      placeholder={t.courses.situationFeedback}
                      value={o.feedback ?? ''}
                      onChange={(e) =>
                        set(i, {
                          ...b,
                          options: b.options.map((x, m) =>
                            m === k ? { ...x, feedback: e.currentTarget.value } : x,
                          ),
                        })
                      }
                      style={{ flex: 1 }}
                    />
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      mt={4}
                      onClick={() => set(i, { ...b, options: b.options.filter((_, m) => m !== k) })}
                      disabled={b.options.length <= 2}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                ))}
                <Group>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<IconPlus size={12} />}
                    onClick={() =>
                      set(i, { ...b, options: [...b.options, { id: key(), text: '', correct: false }] })
                    }
                    disabled={b.options.length >= 6}
                  >
                    {t.courses.addOption}
                  </Button>
                </Group>
                <Textarea
                  size="xs"
                  label={t.courses.situationExplanation}
                  autosize
                  minRows={1}
                  value={b.explanation ?? ''}
                  onChange={(e) => set(i, { ...b, explanation: e.currentTarget.value })}
                />
              </Stack>
            )}
          </Paper>
        ))}
        <Group gap="xs">
          {(['text', 'image', 'tip', 'steps', 'quote', 'situation'] as Block['type'][]).map((tp) => (
            <Button
              key={tp}
              size="compact-xs"
              variant="default"
              leftSection={<IconPlus size={12} />}
              onClick={() => add(tp)}
              data-testid={`add-block-${tp}`}
            >
              {
                {
                  text: t.courses.blockText,
                  image: t.courses.blockImage,
                  tip: t.courses.blockTip,
                  steps: t.courses.blockSteps,
                  quote: t.courses.blockQuote,
                  situation: t.courses.blockSituation,
                }[tp]
              }
            </Button>
          ))}
        </Group>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            onClick={() => {
              if (!valid) return req.check([t.courses.lessonTitle, t.courses.situationOptions]);
              save.mutate(undefined, { onSuccess: onClose });
            }}
            loading={save.isPending}
            data-testid="lesson-save"
          >
            {t.courses.saveLesson}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- курсы

function CourseLessons({ course, onClose }: { course: Row | null; onClose(): void }) {
  const q = useQuery({
    queryKey: [`/courses/${String(course?.id)}`],
    queryFn: () => get<Row & { lessons: Row[] }>(`/courses/${String(course!.id)}`),
    enabled: !!course,
  });
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const remove = useAction((id: string) => patch(`/courses/lessons/${id}`, { isActive: false }));
  const reorder = useAction((a: { id: string; sortOrder: number }) =>
    patch(`/courses/lessons/${a.id}`, { sortOrder: a.sortOrder }),
  );
  const lessons = ((q.data?.lessons as Row[] | undefined) ?? []).filter((l) => l.isActive);
  return (
    <Modal
      opened={!!course}
      onClose={onClose}
      title={`${t.courses.lessonsOf}: ${String(course?.title ?? '')}`}
      size="lg"
    >
      {course && (
        <LessonEditor courseId={String(course.id)} lesson={editing} onClose={() => setEditing(null)} />
      )}
      <Stack gap="xs">
        <Group>
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => setEditing('new')}
            data-testid="lesson-add"
          >
            {t.courses.addLesson}
          </Button>
        </Group>
        <Table striped data-testid="lessons-table">
          <Table.Tbody>
            {lessons.map((l, i) => (
              <Table.Tr key={l.id} data-testid="lesson-row">
                <Table.Td w={30}>{i + 1}</Table.Td>
                <Table.Td>
                  <Text size="sm" fw={600}>
                    {String(l.title)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t.courses.blocksCount(((l.blocks as Block[]) ?? []).length)}
                    {l.testTitle ? ` · ${t.courses.testLabel}: ${String(l.testTitle)}` : ''}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      disabled={i === 0}
                      onClick={() =>
                        reorder.mutate({ id: String(l.id), sortOrder: Number(lessons[i - 1]!.sortOrder) - 1 })
                      }
                    >
                      <IconArrowUp size={14} />
                    </ActionIcon>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      disabled={i === lessons.length - 1}
                      onClick={() =>
                        reorder.mutate({ id: String(l.id), sortOrder: Number(lessons[i + 1]!.sortOrder) + 1 })
                      }
                    >
                      <IconArrowDown size={14} />
                    </ActionIcon>
                    <Button size="xs" variant="light" onClick={() => setEditing(l)}>
                      {t.edit}
                    </Button>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      onClick={() => remove.mutate(String(l.id))}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </Modal>
  );
}

function CoursesTab() {
  const list = useList('/courses');
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [lessonsFor, setLessonsFor] = useState<Row | null>(null);
  const save = useAction(
    (v: Record<string, unknown>) =>
      editing === 'new' || !editing
        ? post('/courses', v)
        : patch(`/courses/${String((editing as Row).id)}`, v),
    t.courses.courseSaved,
  );
  const cover = useAction(async (a: { course: Row; file: File }) => {
    const r = await upload<{ id: string }>('/courses/assets', a.file);
    await patch(`/courses/${String(a.course.id)}`, { coverAssetId: r.id });
  });
  const toggle = useAction((r: Row) => patch(`/courses/${String(r.id)}`, { isActive: !r.isActive }));
  return (
    <Stack gap="sm">
      <CourseLessons course={lessonsFor} onClose={() => setLessonsFor(null)} />
      <Group>
        <Button
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => setEditing('new')}
          data-testid="course-add"
        >
          {t.courses.addCourse}
        </Button>
      </Group>
      <Table striped data-testid="courses-table">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.courses.title}</Table.Th>
            <Table.Th>{t.courses.colLessons}</Table.Th>
            <Table.Th>{t.courses.colAssigned}</Table.Th>
            <Table.Th>{t.courses.colCompleted}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((c) => (
            <Table.Tr key={c.id} opacity={c.isActive ? 1 : 0.5} data-testid="course-row">
              <Table.Td>
                <Group gap="xs" wrap="nowrap">
                  {c.coverAssetId ? (
                    <AssetImage id={String(c.coverAssetId)} h={36} />
                  ) : (
                    <Badge color={String(c.color)} variant="light">
                      {String(c.code ?? '')}
                    </Badge>
                  )}
                  <div>
                    <Text size="sm" fw={600}>
                      {String(c.title)}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {String(c.description ?? '')}
                    </Text>
                  </div>
                </Group>
              </Table.Td>
              <Table.Td>{String(c.lessons)}</Table.Td>
              <Table.Td>{String(c.assigned)}</Table.Td>
              <Table.Td>{String(c.completed)}</Table.Td>
              <Table.Td>
                <Group gap="xs" justify="flex-end" wrap="nowrap">
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => setLessonsFor(c)}
                    data-testid="course-lessons"
                  >
                    {t.courses.lessonsOf}
                  </Button>
                  <FileButton onChange={(file) => file && cover.mutate({ course: c, file })} accept="image/*">
                    {(props) => (
                      <Button {...props} size="xs" variant="subtle">
                        {t.courses.coverUpload}
                      </Button>
                    )}
                  </FileButton>
                  <Button size="xs" variant="subtle" onClick={() => setEditing(c)}>
                    {t.edit}
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => toggle.mutate(c)}>
                    {c.isActive ? t.deactivate : t.activate}
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <FormModal
        opened={editing !== null}
        title={t.courses.editCourse}
        isCreate={editing === 'new'}
        initial={
          editing && editing !== 'new'
            ? editing
            : { color: 'green', minutes: 20, isActive: true, sortOrder: 0 }
        }
        fields={[
          { key: 'title', label: t.courses.title, required: true },
          { key: 'description', label: t.courses.description, type: 'textarea' },
          { key: 'code', label: t.courses.code },
          { key: 'minutes', label: t.courses.minutesLabel, type: 'number' },
          {
            key: 'color',
            label: t.courses.color,
            type: 'select',
            options: COLORS.map((c) => ({ value: c, label: c })),
          },
          { key: 'sortOrder', label: t.courses.sortOrder, type: 'number' },
          { key: 'isActive', label: t.courses.active, type: 'switch' },
        ]}
        loading={save.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(v) =>
          save.mutate(
            {
              title: v.title,
              description: v.description ?? '',
              code: v.code ?? null,
              minutes: Number(v.minutes) || 20,
              color: v.color ?? 'green',
              sortOrder: Number(v.sortOrder) || 0,
              isActive: v.isActive !== false,
            },
            { onSuccess: () => setEditing(null) },
          )
        }
      />
    </Stack>
  );
}

// ---------------------------------------------------------------- назначения и результаты

const STATUS_LABEL: Record<string, string> = {
  open: t.courses.statusAssigned,
  overdue: t.courses.statusOverdue,
  completed: t.courses.statusCompleted,
  cancelled: t.courses.cancel,
};
const STATUS_COLOR: Record<string, string> = {
  open: 'blue',
  overdue: 'red',
  completed: 'green',
  cancelled: 'gray',
};

function AssignTab() {
  const courses = useList('/courses');
  const people = usePeopleTree();
  const [courseId, setCourseId] = useState<string | null>(null);
  const [who, setWho] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const [comment, setComment] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [fCourse, setFCourse] = useState<string | null>(null);
  const [fStatus, setFStatus] = useState('all');
  const req = useRequired();
  const list = useList(`/courses-assignments${fCourse ? `?courseId=${fCourse}` : ''}`);
  const assign = useAction(
    () =>
      post('/courses-assignments', { courseId, userIds: people.expand(who), dueDate: due, comment, repeat }),
    t.courses.assignedOk,
  );
  const cancel = useAction((id: string) => post(`/courses-assignments/${id}/cancel`), t.courses.cancelled);
  const opts = (courses.data ?? [])
    .filter((x) => x.isActive)
    .map((x) => ({ value: String(x.id), label: String(x.title) }));
  const rows = (list.data ?? []).filter((r) => fStatus === 'all' || r.status === fStatus);
  return (
    <Stack>
      <Paper withBorder p="md" data-testid="course-assign-form">
        <Text fw={700} mb="xs">
          {t.courses.assignTitle}
        </Text>
        <Group grow align="flex-start">
          <Select
            label={t.courses.assignCourse}
            withAsterisk
            data={opts}
            value={courseId}
            onChange={setCourseId}
            searchable
            error={req.error(!courseId)}
            data-testid="course-assign-course"
          />
          <TreePicker
            multiple
            size="sm"
            data={people.tree}
            value={who}
            onChange={setWho}
            label={t.courses.assignPeople}
            description={t.courses.assignPeopleHint}
            withAsterisk
            error={req.error(!who.length)}
            testId="course-assign-people"
          />
          <TextInput
            type="date"
            label={t.courses.assignDue}
            withAsterisk
            value={due}
            onChange={(e) => setDue(e.currentTarget.value)}
            error={req.error(!due)}
            data-testid="course-assign-due"
            maw={200}
          />
        </Group>
        <Group align="flex-end" mt="xs">
          <TextInput
            style={{ flex: 1 }}
            label={t.courses.assignComment}
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
          />
          <Switch
            label={t.courses.assignRepeat}
            checked={repeat}
            onChange={(e) => setRepeat(e.currentTarget.checked)}
            data-testid="course-assign-repeat"
          />
          <Button
            onClick={() => {
              if (!courseId || !who.length || !due)
                return req.check(
                  [
                    !courseId && t.courses.assignCourse,
                    !who.length && t.courses.assignPeople,
                    !due && t.courses.assignDue,
                  ].filter((x): x is string => !!x),
                );
              assign.mutate(undefined, { onSuccess: () => setWho([]) });
            }}
            loading={assign.isPending}
            data-testid="course-assign-submit"
          >
            {t.courses.assignBtn}
          </Button>
        </Group>
      </Paper>
      <Group>
        <Select
          label={t.courses.filterCourse}
          data={[{ value: '', label: t.courses.all }, ...opts]}
          value={fCourse ?? ''}
          onChange={(v) => setFCourse(v || null)}
          w={320}
        />
        <Select
          label={t.courses.filterStatus}
          data={[
            { value: 'all', label: t.courses.all },
            ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
          ]}
          value={fStatus}
          onChange={(v) => setFStatus(v ?? 'all')}
          w={200}
        />
      </Group>
      <Table striped data-testid="course-assignments">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.courses.colUser}</Table.Th>
            <Table.Th>{t.courses.colCourse}</Table.Th>
            <Table.Th>{t.courses.colDue}</Table.Th>
            <Table.Th>{t.courses.colProgress}</Table.Th>
            <Table.Th>{t.courses.colStatus}</Table.Th>
            <Table.Th>{t.courses.colAssignedBy}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.id} data-testid="course-assignment-row" data-status={String(r.status)}>
              <Table.Td>{String(r.userName)}</Table.Td>
              <Table.Td>
                {String(r.courseTitle)}
                {r.isRepeat ? (
                  <Badge size="xs" color="orange" variant="outline" ml={6}>
                    {t.courses.repeat}
                  </Badge>
                ) : null}
              </Table.Td>
              <Table.Td>{String(r.dueDate).split('-').reverse().join('.')}</Table.Td>
              <Table.Td w={140}>
                <Progress value={Number(r.progressPct)} color={r.status === 'completed' ? 'green' : 'blue'} />
                <Text size="xs" c="dimmed">
                  {t.courses.progress(Number(r.progressPct))}
                </Text>
              </Table.Td>
              <Table.Td>
                <Badge color={STATUS_COLOR[String(r.status)]} variant="light">
                  {STATUS_LABEL[String(r.status)]}
                </Badge>
              </Table.Td>
              <Table.Td>{String(r.assignedByName ?? '')}</Table.Td>
              <Table.Td>
                {r.status === 'open' || r.status === 'overdue' ? (
                  <Button size="xs" variant="subtle" color="red" onClick={() => cancel.mutate(String(r.id))}>
                    {t.courses.cancel}
                  </Button>
                ) : null}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function ResultsTab() {
  const list = useList('/courses-results');
  return (
    <Table striped data-testid="course-results">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t.courses.colUser}</Table.Th>
          <Table.Th>{t.courses.resAssigned}</Table.Th>
          <Table.Th>{t.courses.resCompleted}</Table.Th>
          <Table.Th>{t.courses.resOverdue}</Table.Th>
          <Table.Th>{t.courses.resSituations}</Table.Th>
          <Table.Th>{t.courses.resLast}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {(list.data ?? []).map((r) => (
          <Table.Tr key={String(r.userId)}>
            <Table.Td>{String(r.fullName)}</Table.Td>
            <Table.Td>{String(r.assigned)}</Table.Td>
            <Table.Td>{String(r.completed)}</Table.Td>
            <Table.Td c={Number(r.overdue) ? 'red' : undefined}>{String(r.overdue)}</Table.Td>
            <Table.Td>
              {r.situationsPct === null || r.situationsPct === undefined
                ? t.courses.dash
                : `${String(r.situationsPct)} %`}
            </Table.Td>
            <Table.Td>
              {r.lastActivity
                ? new Date(String(r.lastActivity)).toLocaleDateString('ru-RU', { timeZone: 'Europe/Minsk' })
                : t.courses.dash}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** Обучение сотрудников (Д-014): курсы и уроки, назначения, результаты. */
export function CoursesPage() {
  const [tab, setTab] = useState<string | null>('courses');
  return (
    <Stack>
      <Title order={3}>{t.courses.pageTitle}</Title>
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="courses" data-testid="courses-tab-courses">
            {t.courses.tabCourses}
          </Tabs.Tab>
          <Tabs.Tab value="assign" data-testid="courses-tab-assign">
            {t.courses.tabAssign}
          </Tabs.Tab>
          <Tabs.Tab value="results" data-testid="courses-tab-results">
            {t.courses.tabResults}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="courses" pt="sm">
          <CoursesTab />
        </Tabs.Panel>
        <Tabs.Panel value="assign" pt="sm">
          <AssignTab />
        </Tabs.Panel>
        <Tabs.Panel value="results" pt="sm">
          <ResultsTab />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
