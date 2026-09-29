import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  FileButton,
  Grid,
  Group,
  Modal,
  MultiSelect,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, authBlobUrl, errorText, get, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, options, useAction, useList } from '../lib/data';

// ---------------------------------------------------------------- общее

export const TICKET_STATUS: Record<string, { label: string; color: string }> = {
  new: { label: 'Новый', color: 'blue' },
  in_work: { label: 'В работе', color: 'cyan' },
  approval: { label: 'На согласовании', color: 'violet' },
  rework: { label: 'На доработке', color: 'orange' },
  closed: { label: 'Закрыт', color: 'gray' },
};

const dayWord = (n: number) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b > 1 && b < 5) return 'дня';
  return b === 1 ? 'день' : 'дней';
};

const fmtDate = (d: unknown) => (d ? String(d).split('-').reverse().join('.') : '');
const fmtTime = (s: unknown) =>
  s
    ? new Date(String(s)).toLocaleString('ru-RU', {
        timeZone: 'Europe/Minsk',
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : '';

/** Срок: «осталось N дн.» / «просрочено на N дн.» цветом; на согласовании — сколько ждёт согласования. */
export function Deadline({ t }: { t: Row }) {
  const status = String(t.status);
  if (status === 'closed')
    return (
      <Text size="xs" c="dimmed">
        закрыт{t.closedInTime === false ? ' с нарушением срока' : t.closedInTime ? ' в срок' : ''}
      </Text>
    );
  if (status === 'approval')
    return (
      <Text size="xs" c="violet" data-testid="deadline">
        ожидает согласования {Number(t.approvalWaitDays ?? 0)} {dayWord(Number(t.approvalWaitDays ?? 0))}
      </Text>
    );
  const left = Number(t.daysLeft);
  const overdue = left < 0;
  return (
    <Text
      size="xs"
      c={overdue ? 'red' : left <= 2 ? 'orange' : 'green'}
      fw={overdue ? 700 : 500}
      data-testid="deadline"
    >
      {overdue
        ? `просрочено на ${-left} ${dayWord(-left)}`
        : left === 0
          ? 'срок истекает сегодня'
          : `осталось ${left} ${dayWord(left)}`}{' '}
      · до {fmtDate(t.dueDate)}
    </Text>
  );
}

export function StatusBadge({ status, testId = 'ticket-status' }: { status: string; testId?: string }) {
  const s = TICKET_STATUS[status] ?? { label: status, color: 'gray' };
  return (
    <Badge color={s.color} variant="light" data-testid={testId}>
      {s.label}
    </Badge>
  );
}

async function openTicketFile(ticketId: string, fileId: string): Promise<void> {
  const url = await authBlobUrl(`/tickets/${ticketId}/files/${fileId}`);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Действие над тикетом: успех и ошибка обновляют данные (при «тикет уже изменён» форма покажет свежее). */
function useTicketAction<A>(fn: (a: A) => Promise<unknown>, okText: string, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries();
      notifications.show({ color: 'green', message: okText });
      onDone?.();
    },
    onError: (e) => {
      void qc.invalidateQueries();
      notifications.show({ color: 'red', title: 'Ошибка', message: errorText(e), autoClose: 8000 });
    },
  });
}

interface Uploaded {
  id: string;
  filename: string;
}

function Files({ value, onChange }: { value: Uploaded[]; onChange(v: Uploaded[]): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Group gap="xs">
      <FileButton
        multiple
        onChange={async (files) => {
          setBusy(true);
          try {
            const done: Uploaded[] = [];
            for (const f of files) done.push(await upload<Uploaded>('/tickets/attachments', f));
            onChange([...value, ...done]);
          } catch (e) {
            notifications.show({ color: 'red', message: errorText(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        {(p) => (
          <Button {...p} size="xs" variant="light" loading={busy} data-testid="ticket-attach">
            Приложить документ
          </Button>
        )}
      </FileButton>
      {value.map((f) => (
        <Badge key={f.id} variant="outline" data-testid="ticket-file">
          {f.filename}
        </Badge>
      ))}
    </Group>
  );
}

// ---------------------------------------------------------------- передача из карточки

/** Форма «Передать на 2-ю линию» (M-TKT-01): предприятие и подразделение, ответственные и срок с подстановкой. */
export function EscalateModal({ conv, opened, onClose }: { conv: Row; opened: boolean; onClose(): void }) {
  const enterprises = useList('/dict/enterprises');
  const topics = useList('/topics');
  const people = useList('/tickets/assignable');
  const [enterpriseId, setEnterpriseId] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [responsible, setResponsible] = useState<string[]>([]);
  const [curators, setCurators] = useState<string[]>([]);
  const [due, setDue] = useState('');
  useEffect(() => {
    if (!opened) return;
    setEnterpriseId((conv.enterpriseId as string) ?? null);
    setDepartmentId((conv.departmentId as string) ?? null);
    setTopicId((conv.topicId as string) ?? null);
    setSummary('');
  }, [opened, conv.id, conv.enterpriseId, conv.departmentId, conv.topicId]);
  const eds = useList(
    enterpriseId
      ? `/enterprise-departments?enterpriseId=${enterpriseId}`
      : '/enterprise-departments?enterpriseId=none',
    !!enterpriseId,
  );
  const ready = !!enterpriseId && !!departmentId && !!topicId;
  const defaults = useQuery({
    queryKey: ['/tickets/defaults', enterpriseId, departmentId, topicId],
    queryFn: () =>
      get<{ responsibleIds: string[]; curatorIds: string[]; dueDate: string }>(
        `/tickets/defaults?enterpriseId=${enterpriseId}&departmentId=${departmentId}&topicId=${topicId}`,
      ),
    enabled: opened && ready,
  });
  // Подстановка по матрице: оператор может заменить или добавить людей и изменить срок.
  useEffect(() => {
    if (!defaults.data) return;
    setResponsible(defaults.data.responsibleIds);
    setCurators(defaults.data.curatorIds);
    setDue(defaults.data.dueDate);
  }, [defaults.data]);
  useEffect(() => {
    if (!ready) {
      setResponsible([]);
      setCurators([]);
    }
  }, [ready]);
  const send = useTicketAction(
    () =>
      post<Row>(`/conversations/${conv.id}/escalate`, {
        enterpriseId,
        departmentId,
        topicId,
        summary,
        responsibleIds: responsible,
        curatorIds: curators.filter((c) => !responsible.includes(c)),
        ...(due ? { dueDate: due } : {}),
      }),
    'Обращение передано на 2-ю линию',
    onClose,
  );
  const topicOptions = (topics.data ?? []).map((t) => ({
    value: t.id,
    label: `${'— '.repeat(Number(t.level) - 1)}${String(t.name)}`,
  }));
  const peopleOptions = (people.data ?? []).map((p) => ({ value: p.id, label: String(p.fullName) }));
  return (
    <Modal opened={opened} onClose={onClose} title="Передать на 2-ю линию" size="lg">
      <Stack gap="xs" data-testid="escalate-form">
        <Group grow>
          <Select
            label="Предприятие"
            data={options(enterprises.data)}
            value={enterpriseId}
            onChange={(v) => {
              setEnterpriseId(v);
              setDepartmentId(null);
            }}
            data-testid="esc-enterprise"
          />
          <Select
            label="Подразделение"
            data={(eds.data ?? []).map((e) => ({
              value: String(e.departmentId),
              label: String(e.departmentName),
            }))}
            value={departmentId}
            onChange={setDepartmentId}
            disabled={!enterpriseId}
            data-testid="esc-department"
          />
        </Group>
        <Select
          label="Тема"
          data={topicOptions}
          value={topicId}
          onChange={setTopicId}
          searchable
          data-testid="esc-topic"
        />
        <Textarea
          label="Суть обращения для ответственных"
          description="Ответственные видят эту суть в письме и в кабинете"
          value={summary}
          onChange={(e) => setSummary(e.currentTarget.value)}
          minRows={3}
          autosize
          data-testid="esc-summary"
        />
        <MultiSelect
          label="Ответственные"
          description={
            ready && defaults.data && !defaults.data.responsibleIds.length
              ? 'По матрице ответственных не найдено — выберите вручную'
              : 'Подставлены по матрице; можно заменить или добавить'
          }
          data={peopleOptions}
          value={responsible}
          onChange={setResponsible}
          searchable
          data-testid="esc-responsible"
        />
        <MultiSelect
          label="Кураторы"
          data={peopleOptions}
          value={curators}
          onChange={setCurators}
          searchable
          data-testid="esc-curators"
        />
        <TextInput
          type="date"
          label="Срок ответа"
          description="По умолчанию — срок темы или общий (15 дней); можно изменить"
          value={due}
          onChange={(e) => setDue(e.currentTarget.value)}
          data-testid="esc-due"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={() => send.mutate(undefined)}
            loading={send.isPending}
            disabled={!ready || !summary.trim() || !responsible.length}
            data-testid="esc-submit"
          >
            Передать
          </Button>
        </Group>
        <Text size="xs" c="dimmed" hidden={!!responsible.length}>
          Без ответственного тикет не сохраняется.
        </Text>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- списки

function TicketCard({ t, selected, onOpen }: { t: Row; selected?: boolean; onOpen(id: string): void }) {
  const mine = t.myRole as string | null;
  return (
    <Card
      withBorder
      padding="xs"
      onClick={() => onOpen(t.id)}
      style={{
        cursor: 'pointer',
        borderLeft: `4px solid ${mine === 'responsible' ? 'var(--mantine-color-blue-6)' : mine === 'curator' ? 'var(--mantine-color-gray-5)' : 'transparent'}`,
        outline: selected ? '2px solid var(--mantine-color-blue-5)' : undefined,
      }}
      data-testid="ticket-item"
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap={6} wrap="nowrap">
          <Text fw={700} size="sm">
            №{String(t.number)}
          </Text>
          {t.isImportant ? (
            <Badge color="red" size="xs" variant="filled">
              особо важное
            </Badge>
          ) : null}
          {mine ? (
            <Badge size="xs" variant={mine === 'responsible' ? 'filled' : 'light'} color="blue">
              {mine === 'responsible' ? 'я ответственный' : 'я куратор'}
            </Badge>
          ) : null}
        </Group>
        <StatusBadge status={String(t.status)} testId="ticket-item-status" />
      </Group>
      <Text size="xs" lineClamp={1}>
        {String(t.topicName)} · {String(t.enterpriseName)} / {String(t.departmentName)}
      </Text>
      <Text size="xs" c="dimmed" lineClamp={1}>
        {String(t.contactName)}: {String(t.summary)}
      </Text>
      <Group justify="space-between">
        <Deadline t={t} />
        {Number(t.returnsCount) > 0 && (
          <Text size="xs" c="orange">
            возвратов: {String(t.returnsCount)}
          </Text>
        )}
      </Group>
    </Card>
  );
}

/** Список тикетов для вкладок оператора и супервизора; клик — переход в тикет. */
export function TicketList({ view, extra = '' }: { view: string; extra?: string }) {
  const nav = useNavigate();
  const [important, setImportant] = useState(false);
  const list = useList(`/tickets?view=${view}${extra}${important ? '&important=true' : ''}`);
  return (
    <Stack gap={6}>
      <Checkbox
        size="xs"
        label="Только особо важные"
        checked={important}
        onChange={(e) => setImportant(e.currentTarget.checked)}
      />
      {(list.data ?? []).length === 0 && (
        <Text c="dimmed" size="sm">
          Нет тикетов
        </Text>
      )}
      {(list.data ?? []).map((t) => (
        <TicketCard key={t.id} t={t} onOpen={(id) => nav(`/tickets/${id}`)} />
      ))}
    </Stack>
  );
}

/** Количество тикетов во вкладке (для подписи). */
export function useTicketCount(view: string, extra = ''): number {
  const list = useList(`/tickets?view=${view}${extra}`);
  return (list.data ?? []).length;
}

// ---------------------------------------------------------------- кабинет ответственного

const QUICK: { value: string; label: string; q: string }[] = [
  { value: 'all', label: 'Все', q: '' },
  { value: 'resp', label: 'Я ответственный', q: '&role=responsible' },
  { value: 'cur', label: 'Я куратор', q: '&role=curator' },
  { value: 'overdue', label: 'Просроченные', q: '&overdue=true' },
  { value: 'rework', label: 'На доработке', q: '&status=rework' },
  { value: 'important', label: 'Особо важные', q: '&important=true' },
];

/** Кабинет ответственного/куратора (M-TKT-05): список, быстрые фильтры, предпросмотр, переход в обращение. */
export function CabinetPage() {
  const nav = useNavigate();
  const [quick, setQuick] = useState('all');
  const [enterpriseId, setEnterpriseId] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [dueTo, setDueTo] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const enterprises = useList('/dict/enterprises');
  const departments = useList('/dict/departments');
  const topics = useList('/topics');
  const q =
    (QUICK.find((x) => x.value === quick)?.q ?? '') +
    (enterpriseId ? `&enterpriseId=${enterpriseId}` : '') +
    (departmentId ? `&departmentId=${departmentId}` : '') +
    (topicId ? `&topicId=${topicId}` : '') +
    (status && quick !== 'rework' ? `&status=${status}` : '') +
    (dueTo ? `&dueTo=${dueTo}` : '');
  const list = useList(`/tickets?view=cabinet${q}`);
  const preview = useQuery({
    queryKey: [`/tickets/${selected}`],
    queryFn: () => get<Row>(`/tickets/${selected}`),
    enabled: !!selected,
  });
  return (
    <Grid gutter="sm">
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Title order={3} mb="xs">
          Кабинет 2-й линии
        </Title>
        <SegmentedControl
          size="xs"
          data={QUICK.map(({ value, label }) => ({ value, label }))}
          value={quick}
          onChange={setQuick}
          mb="xs"
          data-testid="quick-filters"
          style={{ flexWrap: 'wrap' }}
        />
        <Group grow gap="xs" mb="xs">
          <Select
            size="xs"
            placeholder="Предприятие"
            data={options(enterprises.data)}
            value={enterpriseId}
            onChange={setEnterpriseId}
            clearable
          />
          <Select
            size="xs"
            placeholder="Подразделение"
            data={options(departments.data)}
            value={departmentId}
            onChange={setDepartmentId}
            clearable
          />
        </Group>
        <Group grow gap="xs" mb="xs">
          <Select
            size="xs"
            placeholder="Тема"
            data={(topics.data ?? []).map((t) => ({
              value: t.id,
              label: `${'— '.repeat(Number(t.level) - 1)}${String(t.name)}`,
            }))}
            value={topicId}
            onChange={setTopicId}
            searchable
            clearable
          />
          <Select
            size="xs"
            placeholder="Статус"
            data={Object.entries(TICKET_STATUS).map(([value, s]) => ({ value, label: s.label }))}
            value={status}
            onChange={setStatus}
            clearable
          />
          <TextInput
            size="xs"
            type="date"
            placeholder="Срок до"
            value={dueTo}
            onChange={(e) => setDueTo(e.currentTarget.value)}
          />
        </Group>
        <ScrollArea h="calc(100vh - 270px)">
          <Stack gap={6} data-testid="ticket-list">
            {(list.data ?? []).length === 0 && (
              <Text c="dimmed" size="sm">
                Нет тикетов
              </Text>
            )}
            {(list.data ?? []).map((t) => (
              <TicketCard key={t.id} t={t} selected={selected === t.id} onOpen={setSelected} />
            ))}
          </Stack>
        </ScrollArea>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 7 }}>
        {preview.data ? (
          <Paper withBorder p="md" data-testid="ticket-preview">
            <Group justify="space-between" mb="xs">
              <Title order={4}>Тикет №{String(preview.data.number)}</Title>
              <StatusBadge status={String(preview.data.status)} testId="ticket-preview-status" />
            </Group>
            <TicketFacts t={preview.data} />
            <Divider my="xs" />
            <Text fw={600} size="sm">
              История
            </Text>
            <History items={(preview.data.history as Row[]).slice(-6)} />
            <Button mt="md" onClick={() => nav(`/tickets/${selected}`)} data-testid="ticket-open-full">
              Открыть обращение целиком
            </Button>
          </Paper>
        ) : (
          <Text c="dimmed">Выберите тикет слева — здесь появится предпросмотр.</Text>
        )}
      </Grid.Col>
    </Grid>
  );
}

// ---------------------------------------------------------------- карточка тикета

const ACTION: Record<string, string> = {
  created: 'передан на 2-ю линию',
  opened: 'взят в работу',
  answered: 'закрыт ответственным → на согласование',
  approved: 'принят, тикет закрыт',
  returned: 'возвращён на доработку',
  redirected: 'переадресован',
  reassigned: 'изменены ответственные/срок',
  commented: 'комментарий',
  auto_reassigned: 'ответственные пересчитаны автоматически',
  assignee_removed: 'исключён из назначенных',
  needs_reassign: 'требует переназначения',
  matrix_applied: 'применена матрица',
};

function History({ items }: { items: Row[] }) {
  return (
    <Stack gap={2} data-testid="ticket-history">
      {items.map((h) => (
        <Text size="xs" key={h.id}>
          <Text span c="dimmed">
            {fmtTime(h.at)}
          </Text>{' '}
          {ACTION[String(h.action)] ?? String(h.action)}
          {h.actorName ? ` — ${String(h.actorName)}` : ''}
          {(h.details as { comment?: string } | null)?.comment
            ? `: «${(h.details as { comment: string }).comment}»`
            : ''}
        </Text>
      ))}
    </Stack>
  );
}

function TicketFacts({ t }: { t: Row }) {
  const c = t.conversation as Row | null;
  const assignees = ((t.assignees as Row[]) ?? []).filter((a) => a.isActive);
  return (
    <Stack gap={4}>
      <Deadline t={t} />
      <Text size="sm">
        <b>Тема:</b> {String(t.topicName)}
      </Text>
      <Text size="sm">
        <b>Направлено:</b> {String(t.enterpriseName)} / {String(t.departmentName)}
      </Text>
      <Text size="sm">
        <b>Суть:</b> {String(t.summary)}
      </Text>
      <Text size="sm">
        <b>Клиент:</b>{' '}
        {[c?.displayName, c?.phone, c?.email].filter(Boolean).join(', ') || String(t.contactName)}
      </Text>
      <Text size="sm">
        <b>Ответственные:</b>{' '}
        {assignees
          .filter((a) => a.kind === 'responsible')
          .map((a) => String(a.fullName))
          .join(', ') || '—'}
      </Text>
      <Text size="sm">
        <b>Кураторы:</b>{' '}
        {assignees
          .filter((a) => a.kind === 'curator')
          .map((a) => String(a.fullName))
          .join(', ') || '—'}
      </Text>
      <Text size="sm">
        <b>Передал:</b> {String(t.creatorName)}
      </Text>
      {t.answerSummary ? (
        <Alert color="violet" variant="light" title={`Ответ клиенту (${String(t.answerMethodName ?? '')})`}>
          {String(t.answerSummary)}
        </Alert>
      ) : null}
    </Stack>
  );
}

type Att = { id: string; filename: string };

function Comments({ t }: { t: Row }) {
  const KIND: Record<string, string> = {
    answer: 'Ответ клиенту',
    return: 'Возврат на доработку',
    redirect: 'Переадресация',
    comment: 'Комментарий',
    system: 'Система',
  };
  return (
    <Stack gap="xs" data-testid="ticket-comments">
      {((t.comments as Row[]) ?? []).map((c) => (
        <Paper key={c.id} withBorder p="xs">
          <Group justify="space-between">
            <Text size="xs" fw={600}>
              {KIND[String(c.kind)] ?? String(c.kind)} · {String(c.authorName ?? '')}
            </Text>
            <Text size="xs" c="dimmed">
              {fmtTime(c.createdAt)}
            </Text>
          </Group>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {String(c.body)}
          </Text>
          {((c.attachments as Att[]) ?? []).map((a) => (
            <Anchor key={a.id} size="xs" mr="xs" onClick={() => void openTicketFile(t.id, a.id)}>
              📎 {a.filename}
            </Anchor>
          ))}
        </Paper>
      ))}
    </Stack>
  );
}

function Conversation({ ticketId }: { ticketId: string }) {
  const msgs = useList(`/tickets/${ticketId}/messages`);
  return (
    <Stack gap={4} data-testid="ticket-messages">
      {(msgs.data ?? []).map((m) => (
        <Box
          key={m.id}
          p="xs"
          style={{
            borderRadius: 6,
            background:
              m.direction === 'in'
                ? 'var(--mantine-color-gray-1)'
                : m.direction === 'out'
                  ? 'var(--mantine-color-blue-0)'
                  : 'var(--mantine-color-yellow-0)',
          }}
        >
          <Text size="xs" c="dimmed">
            {m.direction === 'in'
              ? 'Клиент'
              : m.direction === 'out'
                ? String(m.authorName ?? 'Оператор')
                : m.direction === 'note'
                  ? 'Заметка оператора'
                  : 'Система'}{' '}
            · {fmtTime(m.sentAt)}
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {String(m.body)}
          </Text>
          {((m.attachments as Att[]) ?? []).map((a) => (
            <Anchor key={a.id} size="xs" mr="xs" onClick={() => void openTicketFile(ticketId, a.id)}>
              📎 {a.filename}
            </Anchor>
          ))}
        </Box>
      ))}
    </Stack>
  );
}

type Dialog = 'close' | 'redirect' | 'return' | 'approve' | 'reassign' | null;

/** Полный переход в обращение: суть, переписка, документы, история и действия по правам (M-TKT-05..10). */
export function TicketPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<Att[]>([]);
  const q = useQuery({
    queryKey: [`/tickets/${id}`],
    queryFn: () => get<Row>(`/tickets/${id}`),
    enabled: !!id,
  });
  const t = q.data;
  const can = (t?.can as Record<string, boolean> | undefined) ?? {};
  const open = useTicketAction(() => post(`/tickets/${id}/open`), 'Тикет взят в работу');
  // Ответственный или куратор открыл «Новый» (или возвращённый) тикет — он переходит «В работе» (M-TKT-03).
  // Только при открытии страницы: фоновое обновление по событию (например, возврат на доработку, пока страница
  // открыта) не должно само брать тикет в работу.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!t || autoOpened.current === id) return;
    autoOpened.current = id ?? null;
    if (can.open) open.mutate(undefined);
  }, [t, id, can.open, open]);
  const send = useTicketAction(
    () => post(`/tickets/${id}/comments`, { body: comment, attachmentIds: files.map((f) => f.id) }),
    'Комментарий добавлен',
    () => {
      setComment('');
      setFiles([]);
    },
  );
  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  if (!t) return null;
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group>
          <Button variant="subtle" size="xs" onClick={() => nav(-1)}>
            ← Назад
          </Button>
          <Title order={3} data-testid="ticket-title">
            Тикет №{String(t.number)}
          </Title>
          <StatusBadge status={String(t.status)} />
          {t.isImportant ? (
            <Badge color="red" variant="filled">
              особо важное
            </Badge>
          ) : null}
        </Group>
        <Group gap="xs">
          {can.close && (
            <Button size="xs" color="green" onClick={() => setDialog('close')} data-testid="ticket-close">
              Закрыть (ответ клиенту дан)
            </Button>
          )}
          {can.redirect && (
            <Button
              size="xs"
              variant="light"
              onClick={() => setDialog('redirect')}
              data-testid="ticket-redirect"
            >
              Переадресовать
            </Button>
          )}
          {can.approve && (
            <>
              <Button
                size="xs"
                color="green"
                onClick={() => setDialog('approve')}
                data-testid="ticket-approve"
              >
                Принять
              </Button>
              <Button
                size="xs"
                color="orange"
                variant="light"
                onClick={() => setDialog('return')}
                data-testid="ticket-return"
              >
                Вернуть на доработку
              </Button>
            </>
          )}
          {can.reassign && (
            <Button
              size="xs"
              variant="default"
              onClick={() => setDialog('reassign')}
              data-testid="ticket-reassign"
            >
              Ответственные и срок
            </Button>
          )}
        </Group>
      </Group>
      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Paper withBorder p="md">
            <TicketFacts t={t} />
          </Paper>
          <Paper withBorder p="md" mt="sm">
            <Text fw={600} size="sm" mb={4}>
              История
            </Text>
            <History items={(t.history as Row[]) ?? []} />
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Tabs defaultValue="messages">
            <Tabs.List mb="xs">
              <Tabs.Tab value="messages">Переписка с клиентом</Tabs.Tab>
              <Tabs.Tab value="comments" data-testid="tab-ticket-comments">
                Комментарии и документы
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="messages">
              <ScrollArea h="55vh">
                <Conversation ticketId={String(t.id)} />
              </ScrollArea>
            </Tabs.Panel>
            <Tabs.Panel value="comments">
              <Comments t={t} />
              {can.comment && (
                <Stack gap="xs" mt="sm">
                  <Textarea
                    placeholder="Комментарий к тикету"
                    value={comment}
                    onChange={(e) => setComment(e.currentTarget.value)}
                    autosize
                    minRows={2}
                    data-testid="ticket-comment"
                  />
                  <Files value={files} onChange={setFiles} />
                  <Button
                    size="xs"
                    disabled={!comment.trim() && !files.length}
                    onClick={() => send.mutate(undefined)}
                    data-testid="ticket-comment-send"
                  >
                    Добавить
                  </Button>
                </Stack>
              )}
            </Tabs.Panel>
          </Tabs>
        </Grid.Col>
      </Grid>
      <CloseDialog t={t} opened={dialog === 'close'} onClose={() => setDialog(null)} />
      <RedirectDialog t={t} opened={dialog === 'redirect'} onClose={() => setDialog(null)} />
      <ApproveDialog t={t} mode="approve" opened={dialog === 'approve'} onClose={() => setDialog(null)} />
      <ApproveDialog t={t} mode="return" opened={dialog === 'return'} onClose={() => setDialog(null)} />
      <ReassignDialog t={t} opened={dialog === 'reassign'} onClose={() => setDialog(null)} />
    </Stack>
  );
}

function CloseDialog({ t, opened, onClose }: { t: Row; opened: boolean; onClose(): void }) {
  const methods = useList('/dict/answer-methods');
  const [method, setMethod] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [files, setFiles] = useState<Att[]>([]);
  const close = useTicketAction(
    () =>
      post(`/tickets/${t.id}/close`, {
        version: t.version,
        answerMethodId: method,
        answerSummary: summary,
        attachmentIds: files.map((f) => f.id),
      }),
    'Тикет отправлен на согласование',
    () => {
      onClose();
      setSummary('');
      setFiles([]);
    },
  );
  return (
    <Modal opened={opened} onClose={onClose} title="Закрытие тикета: как и что ответили клиенту" size="lg">
      <Stack gap="xs" data-testid="close-form">
        <Alert color="blue" variant="light">
          Система ответ клиенту не отправляет: свяжитесь с клиентом сами (телефон, почта, письмо) и
          зафиксируйте результат.
        </Alert>
        <Select
          label="Способ ответа"
          data={options(methods.data)}
          value={method}
          onChange={setMethod}
          data-testid="answer-method"
        />
        <Textarea
          label="Суть ответа"
          value={summary}
          onChange={(e) => setSummary(e.currentTarget.value)}
          minRows={4}
          autosize
          data-testid="answer-summary"
        />
        <Files value={files} onChange={setFiles} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button
            color="green"
            disabled={!method || !summary.trim()}
            loading={close.isPending}
            onClick={() => close.mutate(undefined)}
            data-testid="close-submit"
          >
            Отправить на согласование
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ApproveDialog({
  t,
  mode,
  opened,
  onClose,
}: {
  t: Row;
  mode: 'approve' | 'return';
  opened: boolean;
  onClose(): void;
}) {
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<Att[]>([]);
  const done = () => {
    onClose();
    setComment('');
    setFiles([]);
  };
  const approve = useTicketAction(
    () => post(`/tickets/${t.id}/approve`, { version: t.version, ...(comment.trim() ? { comment } : {}) }),
    'Тикет принят и закрыт, обращение закрыто',
    done,
  );
  const back = useTicketAction(
    () =>
      post(`/tickets/${t.id}/return`, { version: t.version, comment, attachmentIds: files.map((f) => f.id) }),
    'Тикет возвращён на доработку',
    done,
  );
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={mode === 'approve' ? 'Принять ответ' : 'Вернуть на доработку'}
      size="lg"
    >
      <Stack gap="xs" data-testid={`${mode}-form`}>
        {t.answerSummary ? (
          <Alert
            color="violet"
            variant="light"
            title={`Ответ ответственного (${String(t.answerMethodName ?? '')})`}
          >
            {String(t.answerSummary)}
          </Alert>
        ) : null}
        <Text size="xs" c="dimmed">
          Проверьте, приложены ли нужные документы и понятно ли изложена суть ответа.
        </Text>
        <Textarea
          label={mode === 'approve' ? 'Комментарий (необязательно)' : 'Что нужно доработать'}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          minRows={3}
          autosize
          data-testid={`${mode}-comment`}
        />
        {mode === 'return' && <Files value={files} onChange={setFiles} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          {mode === 'approve' ? (
            <Button
              color="green"
              loading={approve.isPending}
              onClick={() => approve.mutate(undefined)}
              data-testid="approve-submit"
            >
              Принять
            </Button>
          ) : (
            <Button
              color="orange"
              disabled={!comment.trim()}
              loading={back.isPending}
              onClick={() => back.mutate(undefined)}
              data-testid="return-submit"
            >
              Вернуть на доработку
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

function RedirectDialog({ t, opened, onClose }: { t: Row; opened: boolean; onClose(): void }) {
  const enterprises = useList('/dict/enterprises');
  const topics = useList('/topics');
  const people = useList('/tickets/assignable');
  const [enterpriseId, setEnterpriseId] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [responsible, setResponsible] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (!opened) return;
    setEnterpriseId(String(t.enterpriseId));
    setDepartmentId(String(t.departmentId));
    setTopicId(String(t.topicId));
    setResponsible([]);
    setComment('');
  }, [opened, t.enterpriseId, t.departmentId, t.topicId]);
  const eds = useList(
    enterpriseId
      ? `/enterprise-departments?enterpriseId=${enterpriseId}`
      : '/enterprise-departments?enterpriseId=none',
    !!enterpriseId,
  );
  const dims: Record<string, string> = {};
  if (enterpriseId && enterpriseId !== t.enterpriseId) dims.enterpriseId = enterpriseId;
  if (departmentId && departmentId !== t.departmentId) dims.departmentId = departmentId;
  if (topicId && topicId !== t.topicId) dims.topicId = topicId;
  const changed = Object.keys(dims).length > 0;
  const go = useTicketAction(
    () =>
      post(`/tickets/${t.id}/redirect`, {
        version: t.version,
        comment,
        ...dims,
        ...(responsible.length ? { responsibleIds: responsible } : {}),
      }),
    'Тикет переадресован',
    onClose,
  );
  return (
    <Modal opened={opened} onClose={onClose} title="Переадресация тикета" size="lg">
      <Stack gap="xs" data-testid="redirect-form">
        <Text size="xs" c="dimmed">
          Смена темы, подразделения или предприятия пересчитывает ответственных по матрице; можно и просто
          выбрать другого ответственного. Срок ответа не меняется.
        </Text>
        <Group grow>
          <Select
            label="Предприятие"
            data={options(enterprises.data)}
            value={enterpriseId}
            onChange={(v) => {
              setEnterpriseId(v);
              setDepartmentId(null);
            }}
          />
          <Select
            label="Подразделение"
            data={(eds.data ?? []).map((e) => ({
              value: String(e.departmentId),
              label: String(e.departmentName),
            }))}
            value={departmentId}
            onChange={setDepartmentId}
            data-testid="redirect-department"
          />
        </Group>
        <Select
          label="Тема"
          data={(topics.data ?? []).map((x) => ({
            value: x.id,
            label: `${'— '.repeat(Number(x.level) - 1)}${String(x.name)}`,
          }))}
          value={topicId}
          onChange={setTopicId}
          searchable
        />
        <MultiSelect
          label="Ответственный (вручную)"
          description={
            changed ? 'Пусто — ответственные подставятся по матрице' : 'Выберите другого ответственного'
          }
          data={(people.data ?? []).map((p) => ({ value: p.id, label: String(p.fullName) }))}
          value={responsible}
          onChange={setResponsible}
          searchable
          data-testid="redirect-responsible"
        />
        <Textarea
          label="Комментарий (обязателен)"
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          minRows={2}
          autosize
          data-testid="redirect-comment"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={!comment.trim() || (!changed && !responsible.length)}
            loading={go.isPending}
            onClick={() => go.mutate(undefined)}
            data-testid="redirect-submit"
          >
            Переадресовать
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ReassignDialog({ t, opened, onClose }: { t: Row; opened: boolean; onClose(): void }) {
  const people = useList('/tickets/assignable');
  const [responsible, setResponsible] = useState<string[]>([]);
  const [curators, setCurators] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const [important, setImportant] = useState(false);
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (!opened) return;
    const act = ((t.assignees as Row[]) ?? []).filter((a) => a.isActive);
    setResponsible(act.filter((a) => a.kind === 'responsible').map((a) => String(a.userId)));
    setCurators(act.filter((a) => a.kind === 'curator').map((a) => String(a.userId)));
    setDue(String(t.dueDate));
    setImportant(!!t.isImportant);
    setComment('');
  }, [opened, t.assignees, t.dueDate, t.isImportant]);
  const go = useTicketAction(
    () =>
      post(`/tickets/${t.id}/reassign`, {
        version: t.version,
        responsibleIds: responsible,
        curatorIds: curators.filter((c) => !responsible.includes(c)),
        ...(due && due !== t.dueDate ? { dueDate: due } : {}),
        ...(important !== !!t.isImportant ? { isImportant: important } : {}),
        ...(comment.trim() ? { comment } : {}),
      }),
    'Изменения сохранены',
    onClose,
  );
  const opts = (people.data ?? []).map((p) => ({ value: p.id, label: String(p.fullName) }));
  return (
    <Modal opened={opened} onClose={onClose} title="Ответственные, срок и важность" size="lg">
      <Stack gap="xs" data-testid="reassign-form">
        <MultiSelect
          label="Ответственные"
          data={opts}
          value={responsible}
          onChange={setResponsible}
          searchable
          data-testid="reassign-responsible"
        />
        <MultiSelect label="Кураторы" data={opts} value={curators} onChange={setCurators} searchable />
        <TextInput
          type="date"
          label="Срок ответа"
          value={due}
          onChange={(e) => setDue(e.currentTarget.value)}
          data-testid="reassign-due"
        />
        <Checkbox
          label="Особо важное"
          checked={important}
          onChange={(e) => setImportant(e.currentTarget.checked)}
        />
        <Textarea
          label="Комментарий"
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          minRows={2}
          autosize
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={!responsible.length}
            loading={go.isPending}
            onClick={() => go.mutate(undefined)}
            data-testid="reassign-submit"
          >
            Сохранить
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- заместители и контроль 2-й линии

/** Заместители по согласованию (M-TKT-09): оператор назначает себе на период отсутствия, администратор — любому. */
export function SubstitutesPanel({ all = false }: { all?: boolean }) {
  const { me } = useAuth();
  const list = useList(`/approval-substitutes${all ? '?all=true' : ''}`);
  const operators = useList('/operators');
  const [userId, setUserId] = useState<string | null>(null);
  const [substituteId, setSubstituteId] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const add = useAction(
    () =>
      post('/approval-substitutes', {
        ...(all && userId ? { userId } : {}),
        substituteId,
        ...(from ? { validFrom: from } : {}),
        ...(to ? { validTo: to } : {}),
      }),
    'Заместитель назначен',
  );
  const del = useAction((id: string) => api('DELETE', `/approval-substitutes/${id}`), 'Заместитель снят');
  const ops = options(operators.data, 'fullName');
  return (
    <Stack gap="xs" data-testid="substitutes">
      <Text size="sm" c="dimmed">
        Заместитель согласует тикеты вместо оператора на период отсутствия.
      </Text>
      <Group align="flex-end" gap="xs">
        {all && (
          <Select size="xs" label="Оператор" data={ops} value={userId} onChange={setUserId} searchable />
        )}
        <Select
          size="xs"
          label="Заместитель"
          data={ops.filter((o) => o.value !== me?.id)}
          value={substituteId}
          onChange={setSubstituteId}
          searchable
          data-testid="substitute"
        />
        <TextInput
          size="xs"
          type="date"
          label="С"
          value={from}
          onChange={(e) => setFrom(e.currentTarget.value)}
        />
        <TextInput
          size="xs"
          type="date"
          label="По"
          value={to}
          onChange={(e) => setTo(e.currentTarget.value)}
        />
        <Button
          size="xs"
          disabled={!substituteId || (all && !userId)}
          onClick={() => add.mutate(undefined)}
          data-testid="substitute-add"
        >
          Назначить
        </Button>
      </Group>
      <Table>
        <Table.Tbody>
          {(list.data ?? []).map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td>
                {String(s.userName)} → {String(s.substituteName)}
              </Table.Td>
              <Table.Td>
                {s.validFrom || s.validTo
                  ? `${fmtDate(s.validFrom) || '…'} — ${fmtDate(s.validTo) || '…'}`
                  : 'без ограничения'}
              </Table.Td>
              <Table.Td>
                {s.userId === me?.id || all ? (
                  <Button size="compact-xs" variant="subtle" color="red" onClick={() => del.mutate(s.id)}>
                    Снять
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

/** Контроль 2-й линии: «Все согласования» супервизора, «требуют переназначения», заместители, матрица (M-TKT-09, M-TKT-12a). */
export function TicketControlPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<string | null>(can('supervisor.approvals') ? 'approvals' : 'attention');
  const apply = useAction(
    () => post<{ changed: number; unchanged: number; unresolved: string[] }>('/tickets/apply-matrix'),
    'Матрица применена к открытым тикетам',
  );
  return (
    <Stack>
      <Title order={3}>Контроль 2-й линии</Title>
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List mb="sm">
          {can('supervisor.approvals') && (
            <Tabs.Tab value="approvals" data-testid="tab-approvals-all">
              Все согласования
            </Tabs.Tab>
          )}
          <Tabs.Tab value="attention" data-testid="tab-attention">
            Требуют переназначения
          </Tabs.Tab>
          {can('admin.users') && <Tabs.Tab value="substitutes">Заместители</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="approvals">
          <TicketList view="approvals_all" />
        </Tabs.Panel>
        <Tabs.Panel value="attention">
          <Stack>
            <Group>
              <Text size="sm" c="dimmed" style={{ flex: 1 }}>
                Открытые тикеты, у которых не осталось активного ответственного.
              </Text>
              {can('admin.matrix') && (
                <Button
                  size="xs"
                  variant="light"
                  loading={apply.isPending}
                  onClick={() => apply.mutate(undefined)}
                  data-testid="apply-matrix"
                >
                  Применить матрицу к открытым тикетам
                </Button>
              )}
            </Group>
            <TicketList view="attention" />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="substitutes">
          <SubstitutesPanel all />
        </Tabs.Panel>
      </Tabs>
      <Anchor size="xs" onClick={() => nav('/tickets')}>
        Кабинет 2-й линии
      </Anchor>
    </Stack>
  );
}
