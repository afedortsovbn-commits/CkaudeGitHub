import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronRight, IconPlayerPlay, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTopicTree } from '../components/DictPickers';
import { AttemptModal, fmtDate, fmtDateTime, scoreColor, TakeTestModal } from '../components/TestAttempt';
import { type TreeNode, TreePicker } from '../components/TreePicker';
import { get, post, put } from '../lib/api';
import { type Row, useAction, useList, useRequired } from '../lib/data';
import { t } from '../lib/i18n';
import { AssignmentStatus, AttemptsTable, TopicTable } from './MyTestsPage';

// ---------------------------------------------------------------- группы списка тестов (Д-063)

const GROUP_COMBINED = '~combined';
const GROUP_NONE = '~none';
const COURSE = 'course:';

/** Где тест показывается в списке: [группа, подгруппа | null]; тест с несколькими темами — в каждой. */
function testPlaces(r: Row): [string, string | null][] {
  if (((r.sourceTestIds as string[]) ?? []).length) return [[GROUP_COMBINED, null]];
  const topics = (r.topicGroups as { topic: string; sub: string | null }[]) ?? [];
  if (topics.length) return topics.map((x) => [x.topic, x.sub]);
  if (r.courseTitle) return [[`${COURSE}${String(r.courseTitle)}`, null]];
  return [[GROUP_NONE, null]];
}
const groupLabel = (g: string) =>
  g === GROUP_COMBINED
    ? t.tests.groupCombined
    : g === GROUP_NONE
      ? t.tests.groupNone
      : g.startsWith(COURSE)
        ? t.tests.groupCourse(g.slice(COURSE.length))
        : g;
/** Порядок групп: сборные, темы, курсы обучения, без темы. */
const groupRank = (g: string) =>
  g === GROUP_COMBINED ? 0 : g === GROUP_NONE ? 3 : g.startsWith(COURSE) ? 2 : 1;

interface TestGroup {
  key: string;
  tests: Row[];
  subs: { key: string; name: string; tests: Row[] }[];
  n: number;
}
function groupTests(list: Row[]): TestGroup[] {
  const map = new Map<string, TestGroup>();
  for (const r of list)
    for (const [g, sub] of testPlaces(r)) {
      const grp = map.get(g) ?? { key: g, tests: [], subs: [], n: 0 };
      map.set(g, grp);
      grp.n++;
      if (!sub) grp.tests.push(r);
      else {
        const k = `${g}\u0000${sub}`;
        const s = grp.subs.find((x) => x.key === k) ?? { key: k, name: sub, tests: [] };
        if (!grp.subs.includes(s)) grp.subs.push(s);
        s.tests.push(r);
      }
    }
  const groups = [...map.values()];
  for (const g of groups) g.subs.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return groups.sort(
    (a, b) => groupRank(a.key) - groupRank(b.key) || groupLabel(a.key).localeCompare(groupLabel(b.key), 'ru'),
  );
}
/** Данные для выбора теста из списка — сгруппированы так же, как список тестов. */
function groupedOptions(list: Row[], withCount = false) {
  return groupTests(list).map((g) => ({
    group: groupLabel(g.key),
    items: [
      ...new Map(
        [...g.tests, ...g.subs.flatMap((sub) => sub.tests)].map((x) => [
          x.id,
          {
            value: x.id,
            label: withCount
              ? t.tests.optionWithCount(String(x.title), Number(x.questions))
              : String(x.title),
          },
        ]),
      ).values(),
    ],
  }));
}

// ---------------------------------------------------------------- редактор теста

interface EditOption {
  id?: string;
  key: string;
  text: string;
  correct: boolean;
}
interface EditQuestion {
  id?: string;
  key: string;
  text: string;
  options: EditOption[];
}
interface EditTest {
  title: string;
  description: string;
  topicIds: string[];
  passScore: number;
  isActive: boolean;
  questions: EditQuestion[];
  /** Сборный тест (Д-062): тесты-источники и число случайных вопросов в попытке (null — все). */
  combined: boolean;
  sourceTestIds: string[];
  questionCount: number | null;
}
let seq = 0;
const key = () => `k${++seq}`;
const blankQuestion = (): EditQuestion => ({
  key: key(),
  text: '',
  options: [
    { key: key(), text: '', correct: true },
    { key: key(), text: '', correct: false },
  ],
});
const BLANK: EditTest = {
  title: '',
  description: '',
  topicIds: [],
  passScore: 100,
  isActive: true,
  questions: [],
  combined: false,
  sourceTestIds: [],
  questionCount: null,
};

/**
 * Создание и правка теста: название, темы, проходной балл, вопросы с вариантами (правильные — флажком).
 * Сборный тест (Д-062) — вопросы берутся из выбранных тестов, в попытке — заданное число случайных.
 */
function TestEditor({
  testId,
  opened,
  onClose,
  onSaved,
}: {
  testId: string | null;
  opened: boolean;
  onClose(): void;
  onSaved(id: string): void;
}) {
  const topicTree = useTopicTree();
  const all = useList('/tests');
  const [v, setV] = useState<EditTest>(BLANK);
  const req = useRequired();
  const existing = useQuery({
    queryKey: [`/tests/${testId}`],
    queryFn: () => get<Row>(`/tests/${testId}`),
    enabled: opened && !!testId,
  });
  useEffect(() => {
    if (!opened) return;
    req.reset();
    if (!testId) setV({ ...BLANK, questions: [blankQuestion()] });
  }, [opened, testId]);
  useEffect(() => {
    const d = existing.data;
    if (!d || !opened) return;
    const sources = (d.sourceTestIds as string[]) ?? [];
    setV({
      title: String(d.title),
      description: String(d.description ?? ''),
      topicIds: (d.topicIds as string[]) ?? [],
      passScore: Number(d.passScore),
      isActive: !!d.isActive,
      combined: sources.length > 0,
      sourceTestIds: sources,
      questionCount:
        d.questionCount === null || d.questionCount === undefined ? null : Number(d.questionCount),
      questions: ((d.questions as Row[]) ?? []).map((q) => ({
        id: q.id,
        key: key(),
        text: String(q.text),
        options: ((q.options as { id: string; text: string; correct: boolean }[]) ?? []).map((o) => ({
          ...o,
          key: key(),
        })),
      })),
    });
  }, [existing.data, opened]);
  // Источники сборного теста — обычные тесты с вопросами; сколько вопросов в выбранных.
  const sources = useMemo(
    () => (all.data ?? []).filter((x) => !((x.sourceTestIds as string[]) ?? []).length && x.id !== testId),
    [all.data, testId],
  );
  const pool = sources
    .filter((x) => v.sourceTestIds.includes(x.id))
    .reduce((a, x) => a + Number(x.questions || 0), 0);
  const save = useAction(() => {
    const body = {
      title: v.title,
      description: v.description,
      topicIds: v.topicIds,
      passScore: v.passScore,
      isActive: v.isActive,
      sourceTestIds: v.combined ? v.sourceTestIds : [],
      questionCount: v.combined ? v.questionCount : null,
      questions: v.combined
        ? []
        : v.questions.map((q) => ({
            ...(q.id ? { id: q.id } : {}),
            text: q.text,
            options: q.options.map((o) => ({
              ...(o.id ? { id: o.id } : {}),
              text: o.text,
              correct: o.correct,
            })),
          })),
    };
    return testId ? put<Row>(`/tests/${testId}`, body) : post<Row>('/tests', body);
  }, t.tests.saved);
  const setQ = (i: number, q: EditQuestion) =>
    setV({ ...v, questions: v.questions.map((x, j) => (j === i ? q : x)) });
  const missing = () => [
    ...(!v.title.trim() ? [t.tests.needTitle] : []),
    ...(v.combined
      ? !v.sourceTestIds.length
        ? [t.tests.needSources]
        : []
      : v.questions.flatMap((q, i) => [
          ...(!q.text.trim() ? [t.tests.needQuestionText(i + 1)] : []),
          ...(q.options.filter((o) => o.text.trim()).length < 2 ? [t.tests.needOptions(i + 1)] : []),
          ...(!q.options.some((o) => o.correct && o.text.trim()) ? [t.tests.needCorrect(i + 1)] : []),
        ])),
  ];
  return (
    <Modal opened={opened} onClose={onClose} size="xl" title={testId ? t.tests.edit : t.tests.create}>
      <Stack gap="sm" data-testid="test-editor">
        {!testId && (
          <SegmentedControl
            data={[
              { value: 'own', label: t.tests.kindOwn },
              { value: 'combined', label: t.tests.kindCombined },
            ]}
            value={v.combined ? 'combined' : 'own'}
            onChange={(x) => setV({ ...v, combined: x === 'combined' })}
            data-testid="test-kind"
          />
        )}
        <TextInput
          label={t.tests.title}
          withAsterisk
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.currentTarget.value })}
          error={req.error(!v.title.trim())}
          data-testid="test-title"
        />
        <Textarea
          label={t.tests.description}
          autosize
          minRows={1}
          value={v.description}
          onChange={(e) => setV({ ...v, description: e.currentTarget.value })}
        />
        {/* Д-086: поля выровнены по нижнему краю — пояснение к темам не сдвигает поле тем ниже соседних. */}
        <Group grow align="flex-end">
          <TreePicker
            multiple
            size="sm"
            data={topicTree}
            value={v.topicIds}
            onChange={(ids) => setV({ ...v, topicIds: ids })}
            label={t.tests.topics}
            description={v.combined ? t.tests.topicsHintCombined : t.tests.topicsHint}
            testId="test-topics"
          />
          <NumberInput
            label={t.tests.passScore}
            min={1}
            max={100}
            value={v.passScore}
            onChange={(x) => setV({ ...v, passScore: Number(x) || 100 })}
            maw={180}
            data-testid="test-pass"
          />
          <Switch
            mb={8}
            label={t.tests.active}
            checked={v.isActive}
            onChange={(e) => setV({ ...v, isActive: e.currentTarget.checked })}
          />
        </Group>
        {v.combined ? (
          <>
            <MultiSelect
              label={t.tests.sources}
              description={t.tests.sourcesHint}
              withAsterisk
              searchable
              clearable
              data={groupedOptions(
                sources.filter((x) => Number(x.questions) > 0),
                true,
              )}
              value={v.sourceTestIds}
              onChange={(ids) => setV({ ...v, sourceTestIds: ids })}
              error={req.error(!v.sourceTestIds.length)}
              maxDropdownHeight={360}
              data-testid="test-sources"
            />
            <Group align="flex-end">
              <NumberInput
                label={t.tests.questionCount}
                description={t.tests.questionCountHint(pool)}
                min={1}
                max={300}
                value={v.questionCount ?? ''}
                onChange={(x) => setV({ ...v, questionCount: x === '' ? null : Number(x) || null })}
                maw={320}
                data-testid="test-qcount"
              />
              {v.questionCount !== null && v.questionCount > pool && pool > 0 && (
                <Text size="xs" c="orange">
                  {t.tests.questionCountTooMany(pool)}
                </Text>
              )}
            </Group>
          </>
        ) : (
          <>
            <Text fw={700}>{t.tests.questions}</Text>
            {v.questions.length === 0 && (
              <Text size="sm" c="dimmed">
                {t.tests.noQuestions}
              </Text>
            )}
            {v.questions.map((q, i) => (
              <Paper key={q.key} withBorder p="sm" data-testid="editor-question">
                <Group justify="space-between" mb={6}>
                  <Text size="sm" fw={700}>
                    {t.tests.question(i + 1)}
                  </Text>
                  <Tooltip label={t.tests.removeQuestion}>
                    <ActionIcon
                      color="red"
                      variant="subtle"
                      onClick={() => setV({ ...v, questions: v.questions.filter((_, j) => j !== i) })}
                      aria-label={t.tests.removeQuestion}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                <Textarea
                  autosize
                  minRows={1}
                  placeholder={t.tests.questionText}
                  value={q.text}
                  onChange={(e) => setQ(i, { ...q, text: e.currentTarget.value })}
                  error={req.error(!q.text.trim())}
                  data-testid="editor-question-text"
                />
                <Text size="xs" c="dimmed" mt={6} mb={4}>
                  {t.tests.correctHint}
                </Text>
                <Stack gap={4}>
                  {q.options.map((o, k) => (
                    <Group key={o.key} gap={6} wrap="nowrap">
                      <Checkbox
                        color="green"
                        checked={o.correct}
                        onChange={(e) =>
                          setQ(i, {
                            ...q,
                            options: q.options.map((x, j) =>
                              j === k ? { ...x, correct: e.currentTarget.checked } : x,
                            ),
                          })
                        }
                        data-testid="editor-option-correct"
                      />
                      <TextInput
                        style={{ flex: 1 }}
                        size="xs"
                        placeholder={t.tests.option}
                        value={o.text}
                        onChange={(e) =>
                          setQ(i, {
                            ...q,
                            options: q.options.map((x, j) =>
                              j === k ? { ...x, text: e.currentTarget.value } : x,
                            ),
                          })
                        }
                        styles={
                          o.correct ? { input: { borderColor: 'var(--mantine-color-green-5)' } } : undefined
                        }
                        data-testid="editor-option-text"
                      />
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        disabled={q.options.length <= 2}
                        onClick={() => setQ(i, { ...q, options: q.options.filter((_, j) => j !== k) })}
                        aria-label={t.tests.removeQuestion}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Group>
                  ))}
                </Stack>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  mt={6}
                  leftSection={<IconPlus size={14} />}
                  onClick={() =>
                    setQ(i, { ...q, options: [...q.options, { key: key(), text: '', correct: false }] })
                  }
                  data-testid="editor-add-option"
                >
                  {t.tests.addOption}
                </Button>
              </Paper>
            ))}
            <Button
              variant="light"
              leftSection={<IconPlus size={16} />}
              onClick={() => setV({ ...v, questions: [...v.questions, blankQuestion()] })}
              data-testid="editor-add-question"
            >
              {t.tests.addQuestion}
            </Button>
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            loading={save.isPending}
            onClick={() =>
              req.check(missing()) &&
              save.mutate(undefined, {
                onSuccess: (r) => {
                  onSaved(String((r as Row).id));
                  onClose();
                },
              })
            }
            data-testid="test-save"
          >
            {t.save}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Заголовок сворачиваемой группы списка тестов. */
function GroupHead({
  label,
  n,
  open,
  onToggle,
  level,
}: {
  label: string;
  n: number;
  open: boolean;
  onToggle(): void;
  level: 0 | 1;
}) {
  return (
    <UnstyledButton
      onClick={onToggle}
      className="cc-test-group"
      data-level={level}
      data-open={open || undefined}
      data-testid="test-group"
      py={6}
      px="xs"
      pl={level ? 32 : 'xs'}
      w="100%"
    >
      <Group gap={6} wrap="nowrap">
        <IconChevronRight
          size={16}
          style={{ transition: 'transform 150ms ease', transform: open ? 'rotate(90deg)' : undefined }}
        />
        <Text fw={level ? 500 : 700} size="sm" style={{ flex: 1 }}>
          {label}
        </Text>
        <Badge size="sm" variant="light" color="gray">
          {n}
        </Badge>
      </Group>
    </UnstyledButton>
  );
}

function TestsTab() {
  const list = useList('/tests');
  const [edit, setEdit] = useState<{ id: string | null } | null>(null);
  const [take, setTake] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Группы изначально свёрнуты (Д-063); после сохранения раскрываются группы сохранённого теста.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (list.data ?? []).filter(
        (r) =>
          !needle ||
          String(r.title).toLowerCase().includes(needle) ||
          ((r.topicNames as string[]) ?? []).some((x) => x.toLowerCase().includes(needle)),
      ),
    [list.data, needle],
  );
  const groups = useMemo(() => groupTests(shown), [shown]);
  useEffect(() => {
    const r = justSaved && (list.data ?? []).find((x) => x.id === justSaved);
    if (!r) return;
    setOpen(
      (s) => new Set([...s, ...testPlaces(r).flatMap(([g, sub]) => (sub ? [g, `${g}\u0000${sub}`] : [g]))]),
    );
    setJustSaved(null);
  }, [list.data, justSaved]);
  const isOpen = (k: string) => !!needle || open.has(k);
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const table = (items: Row[]) => (
    <Table highlightOnHover withTableBorder data-testid="tests-table" mb="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t.tests.colTest}</Table.Th>
          <Table.Th w={90}>{t.tests.colQuestions}</Table.Th>
          <Table.Th w={100}>{t.tests.colPass}</Table.Th>
          <Table.Th w={100}>{t.tests.colAssigned}</Table.Th>
          <Table.Th w={90}>{t.tests.colPassed}</Table.Th>
          <Table.Th w={110}>{t.tests.colOverdue}</Table.Th>
          <Table.Th w={140}>{t.tests.colAvg}</Table.Th>
          <Table.Th w={50} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((r) => (
          <Table.Tr
            key={r.id}
            style={{ cursor: 'pointer', opacity: r.isActive ? 1 : 0.55 }}
            onClick={() => setEdit({ id: r.id })}
            data-testid="test-row"
          >
            <Table.Td>
              <Text fw={600} size="sm">
                {String(r.title)}
                {!r.isActive && (
                  <Badge ml={6} size="xs" color="gray">
                    {t.tests.off}
                  </Badge>
                )}
                {((r.sourceTestIds as string[]) ?? []).length > 0 && (
                  <Badge ml={6} size="xs" variant="light" color="grape">
                    {t.tests.combinedBadge(((r.sourceTestIds as string[]) ?? []).length)}
                  </Badge>
                )}
              </Text>
              <Text size="xs" c="dimmed">
                {((r.topicNames as string[]) ?? []).join('; ')}
              </Text>
            </Table.Td>
            <Table.Td>{String(r.questions)}</Table.Td>
            <Table.Td>{String(r.passScore)} %</Table.Td>
            <Table.Td>{String(r.assigned)}</Table.Td>
            <Table.Td>{String(r.passed)}</Table.Td>
            <Table.Td>
              {Number(r.overdue) ? (
                <Badge color="red">{String(r.overdue)}</Badge>
              ) : (
                <Text size="sm" c="dimmed">
                  0
                </Text>
              )}
            </Table.Td>
            <Table.Td>
              {r.avgScore !== null ? (
                <Group gap={4} wrap="nowrap">
                  <Badge color={scoreColor(Number(r.avgScore))} variant="light" style={{ flex: 'none' }}>
                    {String(r.avgScore)} %
                  </Badge>
                  <Text size="xs" c="dimmed">
                    ×{String(r.attempts)}
                  </Text>
                </Group>
              ) : (
                '—'
              )}
            </Table.Td>
            <Table.Td>
              <Tooltip label={t.tests.tryIt}>
                <ActionIcon
                  variant="subtle"
                  disabled={!r.isActive || !Number(r.questions)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTake(r.id);
                  }}
                  aria-label={t.tests.tryIt}
                >
                  <IconPlayerPlay size={16} />
                </ActionIcon>
              </Tooltip>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
  return (
    <Stack gap="xs">
      <TestEditor
        testId={edit?.id ?? null}
        opened={!!edit}
        onClose={() => setEdit(null)}
        onSaved={setJustSaved}
      />
      <TakeTestModal testId={take} onClose={() => setTake(null)} />
      <Group justify="space-between">
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder={t.tests.search}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          w={320}
          data-testid="tests-search"
        />
        <Group gap="xs">
          {open.size > 0 && !needle && (
            <Button variant="subtle" size="xs" onClick={() => setOpen(new Set())}>
              {t.tests.collapseAll}
            </Button>
          )}
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => setEdit({ id: null })}
            data-testid="test-create"
          >
            {t.tests.create}
          </Button>
        </Group>
      </Group>
      {(list.data ?? []).length === 0 ? (
        <Text c="dimmed">{t.tests.noTests}</Text>
      ) : groups.length === 0 ? (
        <Text c="dimmed">{t.tests.nothingFound}</Text>
      ) : (
        <Paper withBorder p={4} data-testid="tests-groups">
          {groups.map((g) => (
            <div key={g.key}>
              <GroupHead
                label={groupLabel(g.key)}
                n={g.n}
                open={isOpen(g.key)}
                onToggle={() => toggle(g.key)}
                level={0}
              />
              <Collapse in={isOpen(g.key)}>
                <Stack gap={0} pl="md" pr={4}>
                  {g.tests.length > 0 && table(g.tests)}
                  {g.subs.map((s) => (
                    <div key={s.key}>
                      <GroupHead
                        label={s.name}
                        n={s.tests.length}
                        open={isOpen(s.key)}
                        onToggle={() => toggle(s.key)}
                        level={1}
                      />
                      <Collapse in={isOpen(s.key)}>
                        <div style={{ paddingLeft: 24 }}>{table(s.tests)}</div>
                      </Collapse>
                    </div>
                  ))}
                </Stack>
              </Collapse>
            </div>
          ))}
        </Paper>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------- назначения

interface People {
  users: { id: string; fullName: string; roles: string[] }[];
  roles: { code: string; name: string }[];
}
const ROLE = 'role:';

/** Дерево «роль → сотрудники» для выбора из справочника сотрудников. */
export function usePeopleTree(): { tree: TreeNode[]; expand(v: string[]): string[] } {
  const q = useQuery({ queryKey: ['/tests-people'], queryFn: () => get<People>('/tests-people') });
  return useMemo(() => {
    const d = q.data;
    if (!d) return { tree: [], expand: () => [] };
    const tree: TreeNode[] = d.roles
      .map((r) => ({
        value: `${ROLE}${r.code}`,
        label: r.name,
        children: d.users
          .filter((u) => u.roles.includes(r.code))
          .map((u) => ({ value: u.id, label: u.fullName })),
      }))
      .filter((r) => r.children.length);
    const expand = (vals: string[]) => [
      ...new Set(
        vals.flatMap((v) =>
          v.startsWith(ROLE)
            ? d.users.filter((u) => u.roles.includes(v.slice(ROLE.length))).map((u) => u.id)
            : [v],
        ),
      ),
    ];
    return { tree, expand };
  }, [q.data]);
}

function AssignTab() {
  const tests = useList('/tests');
  const people = usePeopleTree();
  const [testId, setTestId] = useState<string | null>(null);
  const [who, setWho] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const [comment, setComment] = useState('');
  const [fTest, setFTest] = useState<string | null>(null);
  const [fStatus, setFStatus] = useState('all');
  const req = useRequired();
  const list = useList(`/tests-assignments${fTest ? `?testId=${fTest}` : ''}`);
  const assign = useAction(
    () =>
      post<{ created: number; updated: number }>('/tests-assignments', {
        testId,
        userIds: people.expand(who),
        dueDate: due,
        comment,
      }),
    t.tests.assignedOk,
  );
  const cancel = useAction((id: string) => post(`/tests-assignments/${id}/cancel`), t.tests.cancelled);
  // Тесты для назначения — сгруппированы, как в списке тестов (Д-063).
  const testOptions = groupedOptions((tests.data ?? []).filter((x) => x.isActive));
  const rows = (list.data ?? []).filter((r) => fStatus === 'all' || r.status === fStatus);
  return (
    <Stack>
      <Paper withBorder p="md" data-testid="assign-form">
        <Text fw={700} mb="xs">
          {t.tests.assignTitle}
        </Text>
        <Group grow align="flex-start">
          <Select
            label={t.tests.assignTest}
            withAsterisk
            data={testOptions}
            value={testId}
            onChange={setTestId}
            searchable
            error={req.error(!testId)}
            data-testid="assign-test"
          />
          <TreePicker
            multiple
            size="sm"
            data={people.tree}
            value={who}
            onChange={setWho}
            label={t.tests.assignPeople}
            withAsterisk
            error={req.error(!who.length)}
            testId="assign-people"
          />
          <TextInput
            type="date"
            label={t.tests.assignDue}
            withAsterisk
            value={due}
            onChange={(e) => setDue(e.currentTarget.value)}
            error={req.error(!due)}
            data-testid="assign-due"
            maw={200}
          />
        </Group>
        <Group align="flex-end" mt="xs">
          <TextInput
            style={{ flex: 1 }}
            label={t.tests.assignComment}
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
          />
          <Button
            loading={assign.isPending}
            onClick={() =>
              req.check([
                ...(!testId ? [t.tests.assignTest] : []),
                ...(!who.length ? [t.tests.assignPeople] : []),
                ...(!due ? [t.tests.assignDue] : []),
              ]) &&
              assign.mutate(undefined, {
                onSuccess: () => {
                  setWho([]);
                  setComment('');
                  req.reset();
                },
              })
            }
            data-testid="assign-submit"
          >
            {t.tests.assignSubmit}
          </Button>
        </Group>
      </Paper>
      <Group>
        <Select
          size="xs"
          label={t.tests.filterTest}
          placeholder={t.tests.allTests}
          data={(tests.data ?? []).map((x) => ({ value: x.id, label: String(x.title) }))}
          value={fTest}
          onChange={setFTest}
          clearable
        />
        <Stack gap={2}>
          <Text size="xs" fw={500}>
            {t.tests.filterStatus}
          </Text>
          <SegmentedControl
            size="xs"
            value={fStatus}
            onChange={setFStatus}
            data={[
              { value: 'all', label: t.tests.allStatuses },
              ...['open', 'overdue', 'passed', 'cancelled'].map((s) => ({
                value: s,
                label: t.tests.statusNames[s] ?? s,
              })),
            ]}
          />
        </Stack>
      </Group>
      {rows.length === 0 ? (
        <Text c="dimmed">{t.tests.noAssignments}</Text>
      ) : (
        <Table withTableBorder striped data-testid="assignments-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t.tests.colEmployee}</Table.Th>
              <Table.Th>{t.tests.colTest}</Table.Th>
              <Table.Th>{t.tests.colDue}</Table.Th>
              <Table.Th>{t.tests.colStatus}</Table.Th>
              <Table.Th>{t.tests.colAttempts}</Table.Th>
              <Table.Th>{t.tests.colBest}</Table.Th>
              <Table.Th>{t.tests.colAssignedBy}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.id} data-testid="assignment-row">
                <Table.Td>{String(r.fullName)}</Table.Td>
                <Table.Td>{String(r.testTitle)}</Table.Td>
                <Table.Td>{fmtDate(r.dueDate)}</Table.Td>
                <Table.Td>
                  <AssignmentStatus a={r} />
                </Table.Td>
                <Table.Td>{String(r.attempts)}</Table.Td>
                <Table.Td>
                  {r.bestScore !== null ? (
                    <Badge color={scoreColor(Number(r.bestScore))} variant="light">
                      {String(r.bestScore)} %
                    </Badge>
                  ) : (
                    '—'
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{String(r.assignedByName ?? '—')}</Text>
                </Table.Td>
                <Table.Td>
                  {(r.status === 'open' || r.status === 'overdue') && (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={() => window.confirm(t.tests.cancelConfirm) && cancel.mutate(r.id)}
                    >
                      {t.tests.cancel}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------- результаты

function UserResults({ userId, onClose }: { userId: string | null; onClose(): void }) {
  const q = useQuery({
    queryKey: [`/tests-results/${userId}`],
    queryFn: () =>
      get<{ user: Row; attempts: Row[]; topics: Row[]; assignments: Row[] }>(`/tests-results/${userId}`),
    enabled: !!userId,
  });
  const [view, setView] = useState<string | null>(null);
  const d = q.data;
  return (
    <Modal opened={!!userId} onClose={onClose} size="xl" title={d ? String(d.user.fullName) : ''}>
      <AttemptModal attemptId={view} onClose={() => setView(null)} />
      {d && (
        <Stack data-testid="user-results">
          <Text fw={700}>{t.tests.assignmentsTitle}</Text>
          {d.assignments.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t.tests.noAssignments}
            </Text>
          ) : (
            <Table withTableBorder>
              <Table.Tbody>
                {d.assignments.map((a) => (
                  <Table.Tr key={a.id}>
                    <Table.Td>{String(a.testTitle)}</Table.Td>
                    <Table.Td>{fmtDate(a.dueDate)}</Table.Td>
                    <Table.Td>
                      <AssignmentStatus a={a} />
                    </Table.Td>
                    <Table.Td>
                      {t.tests.colAttempts}: {String(a.attempts)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          <Text fw={700}>{t.tests.topicsTitle}</Text>
          <TopicTable rows={d.topics} />
          <Text fw={700}>{t.tests.attemptsTitle}</Text>
          <AttemptsTable rows={d.attempts} onOpen={setView} />
        </Stack>
      )}
    </Modal>
  );
}

function ResultsTab() {
  const list = useList('/tests-results');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const rows = (list.data ?? []).filter((r) =>
    String(r.fullName).toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <Stack>
      <UserResults userId={open} onClose={() => setOpen(null)} />
      <TextInput
        placeholder={t.tests.filterEmployee}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        maw={320}
      />
      {rows.length === 0 ? (
        <Text c="dimmed">{t.tests.noResults}</Text>
      ) : (
        <Table highlightOnHover withTableBorder data-testid="results-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t.tests.colEmployee}</Table.Th>
              <Table.Th>{t.tests.colRoles}</Table.Th>
              <Table.Th>{t.tests.colAttempts}</Table.Th>
              <Table.Th>{t.tests.colTestsPassed}</Table.Th>
              <Table.Th>{t.tests.colAvg}</Table.Th>
              <Table.Th>{t.tests.colLast}</Table.Th>
              <Table.Th>{t.tests.colOpen}</Table.Th>
              <Table.Th>{t.tests.colOverdue}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr
                key={r.id}
                style={{ cursor: 'pointer' }}
                onClick={() => setOpen(r.id)}
                data-testid="result-row"
              >
                <Table.Td fw={600}>{String(r.fullName)}</Table.Td>
                <Table.Td>
                  <Text size="xs">{((r.roles as string[]) ?? []).join(', ')}</Text>
                </Table.Td>
                <Table.Td>{String(r.attempts)}</Table.Td>
                <Table.Td>
                  {String(r.testsPassed)} / {String(r.testsTried)}
                </Table.Td>
                <Table.Td>
                  {r.avgScore !== null ? (
                    <Badge color={scoreColor(Number(r.avgScore))} variant="light">
                      {String(r.avgScore)} %
                    </Badge>
                  ) : (
                    '—'
                  )}
                </Table.Td>
                <Table.Td>{fmtDateTime(r.lastAt)}</Table.Td>
                <Table.Td>{String(r.open)}</Table.Td>
                <Table.Td>
                  {Number(r.overdue) ? <Badge color="red">{String(r.overdue)}</Badge> : '0'}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

/** Матрица «сотрудник × тема»: последний балл цветом, в подсказке — лучший, средний и число попыток. */
function CompetenceTab() {
  const list = useList('/tests-competence');
  const data = list.data ?? [];
  const topics = [...new Map(data.map((r) => [String(r.topicId), String(r.topicName)])).entries()].sort(
    (a, b) => a[1].localeCompare(b[1], 'ru'),
  );
  const users = [...new Map(data.map((r) => [String(r.userId), String(r.fullName)])).entries()];
  const cell = new Map(data.map((r) => [`${String(r.userId)}:${String(r.topicId)}`, r]));
  if (!data.length) return <Text c="dimmed">{t.tests.noCompetence}</Text>;
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t.tests.competenceHint}
      </Text>
      <ScrollArea type="auto">
        <Table withTableBorder withColumnBorders data-testid="competence-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t.tests.colEmployee}</Table.Th>
              {topics.map(([id, name]) => (
                <Table.Th key={id} style={{ minWidth: 120 }}>
                  <Text size="xs" fw={600}>
                    {name}
                  </Text>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.map(([uid, name]) => (
              <Table.Tr key={uid}>
                <Table.Td fw={600}>{name}</Table.Td>
                {topics.map(([tid]) => {
                  const c = cell.get(`${uid}:${tid}`);
                  return (
                    <Table.Td key={tid} ta="center">
                      {c ? (
                        <Tooltip
                          label={`${t.tests.colBestShort}: ${String(c.bestScore)} % · ${t.tests.colAvgShort}: ${String(c.avgScore)} % · ${t.tests.colAttempts}: ${String(c.attempts)}`}
                        >
                          <Badge color={scoreColor(Number(c.lastScore))} variant="filled">
                            {String(c.lastScore)} %
                          </Badge>
                        </Tooltip>
                      ) : (
                        <Text c="dimmed">—</Text>
                      )}
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Stack>
  );
}

// ---------------------------------------------------------------- рейтинг вопросов

function QuestionDetail({ id, onClose }: { id: string | null; onClose(): void }) {
  const q = useQuery({
    queryKey: [`/tests-questions/${id}`],
    queryFn: () => get<Row>(`/tests-questions/${id}`),
    enabled: !!id,
  });
  const d = q.data;
  const opts = (d?.options as { id: string; text: string; correct: boolean; chosen: number }[]) ?? [];
  const max = Math.max(1, ...opts.map((o) => o.chosen));
  return (
    <Modal opened={!!id} onClose={onClose} size="lg" title={d ? String(d.testTitle) : ''}>
      {d && (
        <Stack data-testid="question-detail">
          <Text fw={600}>{String(d.text)}</Text>
          <Text size="sm" fw={700}>
            {t.tests.optionsTitle}
          </Text>
          {opts.map((o) => (
            <Stack key={o.id} gap={2}>
              <Group justify="space-between">
                <Text size="sm" c={o.correct ? 'green.8' : undefined} fw={o.correct ? 700 : undefined}>
                  {o.text}
                  {o.correct ? ` · ${t.tests.rightAnswer}` : ''}
                </Text>
                <Text size="xs" c="dimmed">
                  {t.tests.chosenTimes(o.chosen)}
                </Text>
              </Group>
              <Progress value={(o.chosen * 100) / max} color={o.correct ? 'green' : 'red'} size="sm" />
            </Stack>
          ))}
          <Text size="sm" fw={700}>
            {t.tests.usersTitle}
          </Text>
          {((d.users as Row[]) ?? []).length === 0 ? (
            <Text size="sm" c="dimmed">
              {t.tests.noAnswers}
            </Text>
          ) : (
            <Table withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t.tests.colEmployee}</Table.Th>
                  <Table.Th>{t.tests.colAnswers}</Table.Th>
                  <Table.Th>{t.tests.colWrong}</Table.Th>
                  <Table.Th>{t.tests.colLast}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {((d.users as Row[]) ?? []).map((u) => (
                  <Table.Tr key={String(u.userId)}>
                    <Table.Td>{String(u.fullName)}</Table.Td>
                    <Table.Td>{String(u.answers)}</Table.Td>
                    <Table.Td>
                      <Text c={Number(u.wrong) ? 'red.7' : undefined} fw={Number(u.wrong) ? 700 : undefined}>
                        {String(u.wrong)}
                      </Text>
                    </Table.Td>
                    <Table.Td>{fmtDateTime(u.lastAt)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      )}
    </Modal>
  );
}

function QuestionsTab() {
  const tests = useList('/tests');
  const people = useQuery({ queryKey: ['/tests-people'], queryFn: () => get<People>('/tests-people') });
  const [testId, setTestId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const qs = new URLSearchParams({ ...(testId ? { testId } : {}), ...(userId ? { userId } : {}) }).toString();
  const list = useList(`/tests-questions${qs ? `?${qs}` : ''}`);
  return (
    <Stack>
      <QuestionDetail id={open} onClose={() => setOpen(null)} />
      <Text size="sm" c="dimmed">
        {t.tests.questionsHint}
      </Text>
      <Group>
        <Select
          size="xs"
          label={t.tests.filterTest}
          placeholder={t.tests.allTests}
          data={(tests.data ?? []).map((x) => ({ value: x.id, label: String(x.title) }))}
          value={testId}
          onChange={setTestId}
          clearable
        />
        <Select
          size="xs"
          label={t.tests.filterEmployee}
          placeholder={t.tests.allEmployees}
          data={(people.data?.users ?? []).map((u) => ({ value: u.id, label: u.fullName }))}
          value={userId}
          onChange={setUserId}
          searchable
          clearable
          data-testid="questions-user"
        />
      </Group>
      <Table highlightOnHover withTableBorder data-testid="questions-table">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.tests.colQuestion}</Table.Th>
            <Table.Th>{t.tests.colTest}</Table.Th>
            <Table.Th>{t.tests.colAnswers}</Table.Th>
            <Table.Th>{t.tests.colWrong}</Table.Th>
            <Table.Th w={200}>{t.tests.colWrongPct}</Table.Th>
            <Table.Th>{t.tests.colPeople}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((r) => {
            const n = Number(r.answers);
            const pct = n ? Math.round((Number(r.wrong) * 100) / n) : null;
            return (
              <Table.Tr
                key={r.id}
                style={{ cursor: 'pointer' }}
                onClick={() => setOpen(r.id)}
                data-testid="question-row"
              >
                <Table.Td>
                  <Text size="sm" lineClamp={2}>
                    {String(r.text)}
                  </Text>
                  {!r.isActive && (
                    <Text size="xs" c="dimmed">
                      {t.tests.inactiveQuestion}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{String(r.testTitle)}</Text>
                </Table.Td>
                <Table.Td>{n}</Table.Td>
                <Table.Td>{String(r.wrong)}</Table.Td>
                <Table.Td>
                  {pct === null ? (
                    '—'
                  ) : (
                    <Group gap={6} wrap="nowrap">
                      <Progress
                        value={pct}
                        color={pct >= 50 ? 'red' : pct >= 20 ? 'yellow' : 'green'}
                        style={{ flex: 1 }}
                      />
                      <Text size="xs" w={36} ta="right">
                        {pct} %
                      </Text>
                    </Group>
                  )}
                </Table.Td>
                <Table.Td>{String(r.people)}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

const TABS = ['tests', 'assignments', 'results', 'competence', 'questions'] as const;

/**
 * Тестирование сотрудников: тесты и вопросы по темам, назначение со сроком (из справочника сотрудников),
 * результаты по сотрудникам (все попытки и оценки), компетентность по темам, рейтинг вопросов.
 */
export function TestsPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab = TABS.includes(asked as (typeof TABS)[number]) ? asked! : 'tests';
  const labels: Record<string, string> = {
    tests: t.tests.tabTests,
    assignments: t.tests.tabAssign,
    results: t.tests.tabResults,
    competence: t.tests.tabCompetence,
    questions: t.tests.tabQuestions,
  };
  return (
    <Tabs value={tab} onChange={(v) => setParams(v && v !== 'tests' ? { tab: v } : {}, { replace: true })}>
      <Tabs.List mb="md">
        {TABS.map((x) => (
          <Tabs.Tab key={x} value={x} data-testid={`tests-tab-${x}`}>
            {labels[x]}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <Tabs.Panel value="tests">{tab === 'tests' && <TestsTab />}</Tabs.Panel>
      <Tabs.Panel value="assignments">{tab === 'assignments' && <AssignTab />}</Tabs.Panel>
      <Tabs.Panel value="results">{tab === 'results' && <ResultsTab />}</Tabs.Panel>
      <Tabs.Panel value="competence">{tab === 'competence' && <CompetenceTab />}</Tabs.Panel>
      <Tabs.Panel value="questions">{tab === 'questions' && <QuestionsTab />}</Tabs.Panel>
    </Tabs>
  );
}
