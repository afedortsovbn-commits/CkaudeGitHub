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
import { t } from '../lib/i18n';
import { OrgPicker, TopicPicker } from '../components/DictPickers';

// ---------------------------------------------------------------- общее

export const TICKET_STATUS: Record<string, { label: string; color: string }> = {
  new: { label: t.tickets.novyy, color: 'blue' },
  in_work: { label: t.tickets.vRabote, color: 'cyan' },
  approval: { label: t.tickets.naSoglasovanii, color: 'violet' },
  rework: { label: t.tickets.naDorabotke, color: 'orange' },
  closed: { label: t.tickets.zakryt, color: 'gray' },
};

const dayWord = (n: number) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return t.tickets.dney;
  if (b > 1 && b < 5) return t.tickets.dnya;
  return b === 1 ? t.tickets.den : t.tickets.dney;
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
export function Deadline({ t: tk }: { t: Row }) {
  const status = String(tk.status);
  if (status === 'closed')
    return (
      <Text size="xs" c="dimmed">
        {t.tickets.zakryt2}
        {tk.closedInTime === false ? t.tickets.sNarusheniemSroka : tk.closedInTime ? t.tickets.vSrok : ''}
      </Text>
    );
  if (status === 'approval')
    return (
      <Text size="xs" c="violet" data-testid="deadline">
        {t.tickets.ozhidaetSoglasovaniya}
        {Number(tk.approvalWaitDays ?? 0)} {dayWord(Number(tk.approvalWaitDays ?? 0))}
      </Text>
    );
  const left = Number(tk.daysLeft);
  const overdue = left < 0;
  return (
    <Text
      size="xs"
      c={overdue ? 'red' : left <= 2 ? 'orange' : 'green'}
      fw={overdue ? 700 : 500}
      data-testid="deadline"
    >
      {overdue
        ? t.tickets.prosrochenoNa(-left, dayWord(-left))
        : left === 0
          ? t.tickets.srokIstekaetSegodnya
          : t.tickets.ostalos(left, dayWord(left))}{' '}
      {t.tickets.do}
      {fmtDate(tk.dueDate)}
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
      notifications.show({ color: 'red', title: t.error, message: errorText(e), autoClose: 8000 });
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
            {t.tickets.prilozhitDokument}
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
    t.tickets.obrashcheniePeredanoNa2,
    onClose,
  );
  const peopleOptions = (people.data ?? []).map((p) => ({ value: p.id, label: String(p.fullName) }));
  return (
    <Modal opened={opened} onClose={onClose} title={t.tickets.peredatNa2Yu} size="lg">
      <Stack gap="xs" data-testid="escalate-form">
        <OrgPicker
          size="sm"
          enterpriseId={enterpriseId}
          departmentId={departmentId}
          onChange={(e, d) => {
            setEnterpriseId(e);
            setDepartmentId(d);
          }}
          requireDepartment
          testId="esc-org"
        />
        <TopicPicker size="sm" value={topicId} onChange={setTopicId} testId="esc-topic" />
        <Textarea
          label={t.tickets.sutObrashcheniyaDlyaOtvetstvennykh}
          description={t.tickets.otvetstvennyeVidyatEtuSut}
          value={summary}
          onChange={(e) => setSummary(e.currentTarget.value)}
          minRows={3}
          autosize
          data-testid="esc-summary"
        />
        <MultiSelect
          label={t.tickets.otvetstvennye}
          description={
            ready && defaults.data && !defaults.data.responsibleIds.length
              ? t.tickets.poMatritseOtvetstvennykhNe
              : t.tickets.podstavlenyPoMatritseMozhno
          }
          data={peopleOptions}
          value={responsible}
          onChange={setResponsible}
          searchable
          data-testid="esc-responsible"
        />
        <MultiSelect
          label={t.tickets.kuratory}
          data={peopleOptions}
          value={curators}
          onChange={setCurators}
          searchable
          data-testid="esc-curators"
        />
        <TextInput
          type="date"
          label={t.tickets.srokOtveta}
          description={t.tickets.poUmolchaniyuSrokTemy}
          value={due}
          onChange={(e) => setDue(e.currentTarget.value)}
          data-testid="esc-due"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            onClick={() => send.mutate(undefined)}
            loading={send.isPending}
            disabled={!ready || !summary.trim() || !responsible.length}
            data-testid="esc-submit"
          >
            {t.tickets.peredat}
          </Button>
        </Group>
        <Text size="xs" c="dimmed" hidden={!!responsible.length}>
          {t.tickets.bezOtvetstvennogoTiketNe}
        </Text>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- списки

function TicketCard({ t: tk, selected, onOpen }: { t: Row; selected?: boolean; onOpen(id: string): void }) {
  const mine = tk.myRole as string | null;
  return (
    <Card
      withBorder
      padding="xs"
      onClick={() => onOpen(tk.id)}
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
            №{String(tk.number)}
          </Text>
          {tk.isImportant ? (
            <Badge color="red" size="xs" variant="filled">
              {t.tickets.osoboVazhnoe}
            </Badge>
          ) : null}
          {mine ? (
            <Badge size="xs" variant={mine === 'responsible' ? 'filled' : 'light'} color="blue">
              {mine === 'responsible' ? t.tickets.yaOtvetstvennyy : t.tickets.yaKurator}
            </Badge>
          ) : null}
        </Group>
        <StatusBadge status={String(tk.status)} testId="ticket-item-status" />
      </Group>
      <Text size="xs" lineClamp={1}>
        {String(tk.topicName)} · {String(tk.enterpriseName)} / {String(tk.departmentName)}
      </Text>
      <Text size="xs" c="dimmed" lineClamp={1}>
        {String(tk.contactName)}: {String(tk.summary)}
      </Text>
      <Group justify="space-between">
        <Deadline t={tk} />
        {Number(tk.returnsCount) > 0 && (
          <Text size="xs" c="orange">
            {t.tickets.vozvratov}
            {String(tk.returnsCount)}
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
        label={t.tickets.tolkoOsoboVazhnye}
        checked={important}
        onChange={(e) => setImportant(e.currentTarget.checked)}
      />
      {(list.data ?? []).length === 0 && (
        <Text c="dimmed" size="sm">
          {t.tickets.netTiketov}
        </Text>
      )}
      {(list.data ?? []).map((tk) => (
        <TicketCard key={tk.id} t={tk} onOpen={(id) => nav(`/tickets/${id}`)} />
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
  { value: 'all', label: t.all, q: '' },
  { value: 'resp', label: t.tickets.yaOtvetstvennyy2, q: '&role=responsible' },
  { value: 'cur', label: t.tickets.yaKurator2, q: '&role=curator' },
  { value: 'overdue', label: t.tickets.prosrochennye, q: '&overdue=true' },
  { value: 'rework', label: t.tickets.naDorabotke, q: '&status=rework' },
  { value: 'important', label: t.tickets.osoboVazhnye, q: '&important=true' },
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
          {t.tickets.kabinet2YLinii}
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
            placeholder={t.tickets.predpriyatie}
            data={options(enterprises.data)}
            value={enterpriseId}
            onChange={setEnterpriseId}
            clearable
          />
          <Select
            size="xs"
            placeholder={t.tickets.podrazdelenie}
            data={options(departments.data)}
            value={departmentId}
            onChange={setDepartmentId}
            clearable
          />
        </Group>
        <Group grow gap="xs" mb="xs">
          <Select
            size="xs"
            placeholder={t.tickets.tema}
            data={(topics.data ?? []).map((topic) => ({
              value: topic.id,
              label: `${'— '.repeat(Number(topic.level) - 1)}${String(topic.name)}`,
            }))}
            value={topicId}
            onChange={setTopicId}
            searchable
            clearable
          />
          <Select
            size="xs"
            placeholder={t.tickets.status}
            data={Object.entries(TICKET_STATUS).map(([value, s]) => ({ value, label: s.label }))}
            value={status}
            onChange={setStatus}
            clearable
          />
          <TextInput
            size="xs"
            type="date"
            placeholder={t.tickets.srokDo}
            value={dueTo}
            onChange={(e) => setDueTo(e.currentTarget.value)}
          />
        </Group>
        <ScrollArea h="calc(100vh - 270px)">
          <Stack gap={6} data-testid="ticket-list">
            {(list.data ?? []).length === 0 && (
              <Text c="dimmed" size="sm">
                {t.tickets.netTiketov}
              </Text>
            )}
            {(list.data ?? []).map((tk) => (
              <TicketCard key={tk.id} t={tk} selected={selected === tk.id} onOpen={setSelected} />
            ))}
          </Stack>
        </ScrollArea>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 7 }}>
        {preview.data ? (
          <Paper withBorder p="md" data-testid="ticket-preview">
            <Group justify="space-between" mb="xs">
              <Title order={4}>
                {t.tickets.tiket}
                {String(preview.data.number)}
              </Title>
              <StatusBadge status={String(preview.data.status)} testId="ticket-preview-status" />
            </Group>
            <TicketFacts t={preview.data} />
            <Divider my="xs" />
            <Text fw={600} size="sm">
              {t.tickets.istoriya}
            </Text>
            <History items={(preview.data.history as Row[]).slice(-6)} />
            <Button mt="md" onClick={() => nav(`/tickets/${selected}`)} data-testid="ticket-open-full">
              {t.tickets.otkrytObrashchenieTselikom}
            </Button>
          </Paper>
        ) : (
          <Text c="dimmed">{t.tickets.vyberiteTiketSlevaZdes}</Text>
        )}
      </Grid.Col>
    </Grid>
  );
}

// ---------------------------------------------------------------- карточка тикета

const ACTION: Record<string, string> = {
  created: t.tickets.peredanNa2Yu,
  opened: t.tickets.vzyatVRabotu,
  answered: t.tickets.zakrytOtvetstvennymNaSoglasovanie,
  approved: t.tickets.prinyatTiketZakryt,
  returned: t.tickets.vozvrashchenNaDorabotku,
  redirected: t.tickets.pereadresovan,
  reassigned: t.tickets.izmenenyOtvetstvennyeSrok,
  commented: t.tickets.kommentariy,
  auto_reassigned: t.tickets.otvetstvennyePereschitanyAvtomatiche,
  assignee_removed: t.tickets.isklyuchenIzNaznachennykh,
  needs_reassign: t.tickets.trebuetPerenaznacheniya,
  matrix_applied: t.tickets.primenenaMatritsa,
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

function TicketFacts({ t: tk }: { t: Row }) {
  const c = tk.conversation as Row | null;
  const assignees = ((tk.assignees as Row[]) ?? []).filter((a) => a.isActive);
  return (
    <Stack gap={4}>
      <Deadline t={tk} />
      <Text size="sm">
        <b>{t.tickets.tema2}</b> {String(tk.topicName)}
      </Text>
      <Text size="sm">
        <b>{t.tickets.napravleno}</b> {String(tk.enterpriseName)} / {String(tk.departmentName)}
      </Text>
      <Text size="sm">
        <b>{t.tickets.sut}</b> {String(tk.summary)}
      </Text>
      <Text size="sm">
        <b>{t.tickets.klient}</b>{' '}
        {[c?.displayName, c?.phone, c?.email].filter(Boolean).join(', ') || String(tk.contactName)}
      </Text>
      <Text size="sm">
        <b>{t.tickets.otvetstvennye2}</b>{' '}
        {assignees
          .filter((a) => a.kind === 'responsible')
          .map((a) => String(a.fullName))
          .join(', ') || '—'}
      </Text>
      <Text size="sm">
        <b>{t.tickets.kuratory2}</b>{' '}
        {assignees
          .filter((a) => a.kind === 'curator')
          .map((a) => String(a.fullName))
          .join(', ') || '—'}
      </Text>
      <Text size="sm">
        <b>{t.tickets.peredal}</b> {String(tk.creatorName)}
      </Text>
      {tk.answerSummary ? (
        <Alert
          color="violet"
          variant="light"
          title={t.tickets.otvetKlientu(String(tk.answerMethodName ?? ''))}
        >
          {String(tk.answerSummary)}
        </Alert>
      ) : null}
    </Stack>
  );
}

type Att = { id: string; filename: string };

function Comments({ t: tk }: { t: Row }) {
  const KIND: Record<string, string> = {
    answer: t.tickets.otvetKlientu2,
    return: t.tickets.vozvratNaDorabotku,
    redirect: t.tickets.pereadresatsiya,
    comment: t.tickets.kommentariy2,
    system: t.tickets.sistema,
  };
  return (
    <Stack gap="xs" data-testid="ticket-comments">
      {((tk.comments as Row[]) ?? []).map((c) => (
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
            <Anchor key={a.id} size="xs" mr="xs" onClick={() => void openTicketFile(tk.id, a.id)}>
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
              ? t.tickets.klient2
              : m.direction === 'out'
                ? String(m.authorName ?? t.tickets.operator)
                : m.direction === 'note'
                  ? t.tickets.zametkaOperatora
                  : t.tickets.sistema}{' '}
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
  const tk = q.data;
  const can = (tk?.can as Record<string, boolean> | undefined) ?? {};
  const open = useTicketAction(() => post(`/tickets/${id}/open`), t.tickets.tiketVzyatVRabotu);
  // Ответственный или куратор открыл «Новый» (или возвращённый) тикет — он переходит «В работе» (M-TKT-03).
  // Только при открытии страницы: фоновое обновление по событию (например, возврат на доработку, пока страница
  // открыта) не должно само брать тикет в работу.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!tk || autoOpened.current === id) return;
    autoOpened.current = id ?? null;
    if (can.open) open.mutate(undefined);
  }, [tk, id, can.open, open]);
  const send = useTicketAction(
    () => post(`/tickets/${id}/comments`, { body: comment, attachmentIds: files.map((f) => f.id) }),
    t.tickets.kommentariyDobavlen,
    () => {
      setComment('');
      setFiles([]);
    },
  );
  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  if (!tk) return null;
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group>
          <Button variant="subtle" size="xs" onClick={() => nav(-1)}>
            {t.tickets.nazad}
          </Button>
          <Title order={3} data-testid="ticket-title">
            {t.tickets.tiket}
            {String(tk.number)}
          </Title>
          <StatusBadge status={String(tk.status)} />
          {tk.isImportant ? (
            <Badge color="red" variant="filled">
              {t.tickets.osoboVazhnoe}
            </Badge>
          ) : null}
        </Group>
        <Group gap="xs">
          {can.close && (
            <Button size="xs" color="green" onClick={() => setDialog('close')} data-testid="ticket-close">
              {t.tickets.zakrytOtvetKlientuDan}
            </Button>
          )}
          {can.redirect && (
            <Button
              size="xs"
              variant="light"
              onClick={() => setDialog('redirect')}
              data-testid="ticket-redirect"
            >
              {t.tickets.pereadresovat}
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
                {t.tickets.prinyat}
              </Button>
              <Button
                size="xs"
                color="orange"
                variant="light"
                onClick={() => setDialog('return')}
                data-testid="ticket-return"
              >
                {t.tickets.vernutNaDorabotku}
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
              {t.tickets.otvetstvennyeISrok}
            </Button>
          )}
        </Group>
      </Group>
      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Paper withBorder p="md">
            <TicketFacts t={tk} />
          </Paper>
          <Paper withBorder p="md" mt="sm">
            <Text fw={600} size="sm" mb={4}>
              {t.tickets.istoriya}
            </Text>
            <History items={(tk.history as Row[]) ?? []} />
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Tabs defaultValue="messages">
            <Tabs.List mb="xs">
              <Tabs.Tab value="messages">{t.tickets.perepiskaSKlientom}</Tabs.Tab>
              <Tabs.Tab value="comments" data-testid="tab-ticket-comments">
                {t.tickets.kommentariiIDokumenty}
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="messages">
              <ScrollArea h="55vh">
                <Conversation ticketId={String(tk.id)} />
              </ScrollArea>
            </Tabs.Panel>
            <Tabs.Panel value="comments">
              <Comments t={tk} />
              {can.comment && (
                <Stack gap="xs" mt="sm">
                  <Textarea
                    placeholder={t.tickets.kommentariyKTiketu}
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
                    {t.add}
                  </Button>
                </Stack>
              )}
            </Tabs.Panel>
          </Tabs>
        </Grid.Col>
      </Grid>
      <CloseDialog t={tk} opened={dialog === 'close'} onClose={() => setDialog(null)} />
      <RedirectDialog t={tk} opened={dialog === 'redirect'} onClose={() => setDialog(null)} />
      <ApproveDialog t={tk} mode="approve" opened={dialog === 'approve'} onClose={() => setDialog(null)} />
      <ApproveDialog t={tk} mode="return" opened={dialog === 'return'} onClose={() => setDialog(null)} />
      <ReassignDialog t={tk} opened={dialog === 'reassign'} onClose={() => setDialog(null)} />
    </Stack>
  );
}

function CloseDialog({ t: tk, opened, onClose }: { t: Row; opened: boolean; onClose(): void }) {
  const methods = useList('/dict/answer-methods');
  const [method, setMethod] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [files, setFiles] = useState<Att[]>([]);
  const close = useTicketAction(
    () =>
      post(`/tickets/${tk.id}/close`, {
        version: tk.version,
        answerMethodId: method,
        answerSummary: summary,
        attachmentIds: files.map((f) => f.id),
      }),
    t.tickets.tiketOtpravlenNaSoglasovanie,
    () => {
      onClose();
      setSummary('');
      setFiles([]);
    },
  );
  return (
    <Modal opened={opened} onClose={onClose} title={t.tickets.zakrytieTiketaKakI} size="lg">
      <Stack gap="xs" data-testid="close-form">
        <Alert color="blue" variant="light">
          {t.tickets.sistemaOtvetKlientuNe}
        </Alert>
        <Select
          label={t.tickets.sposobOtveta}
          data={options(methods.data)}
          value={method}
          onChange={setMethod}
          data-testid="answer-method"
        />
        <Textarea
          label={t.tickets.sutOtveta}
          value={summary}
          onChange={(e) => setSummary(e.currentTarget.value)}
          minRows={4}
          autosize
          data-testid="answer-summary"
        />
        <Files value={files} onChange={setFiles} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            color="green"
            disabled={!method || !summary.trim()}
            loading={close.isPending}
            onClick={() => close.mutate(undefined)}
            data-testid="close-submit"
          >
            {t.tickets.otpravitNaSoglasovanie}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ApproveDialog({
  t: tk,
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
    () => post(`/tickets/${tk.id}/approve`, { version: tk.version, ...(comment.trim() ? { comment } : {}) }),
    t.tickets.tiketPrinyatIZakryt,
    done,
  );
  const back = useTicketAction(
    () =>
      post(`/tickets/${tk.id}/return`, {
        version: tk.version,
        comment,
        attachmentIds: files.map((f) => f.id),
      }),
    t.tickets.tiketVozvrashchenNaDorabotku,
    done,
  );
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={mode === 'approve' ? t.tickets.prinyatOtvet : t.tickets.vernutNaDorabotku}
      size="lg"
    >
      <Stack gap="xs" data-testid={`${mode}-form`}>
        {tk.answerSummary ? (
          <Alert
            color="violet"
            variant="light"
            title={t.tickets.otvetOtvetstvennogo(String(tk.answerMethodName ?? ''))}
          >
            {String(tk.answerSummary)}
          </Alert>
        ) : null}
        <Text size="xs" c="dimmed">
          {t.tickets.provertePrilozhenyLiNuzhnye}
        </Text>
        <Textarea
          label={mode === 'approve' ? t.tickets.kommentariyNeobyazatelno : t.tickets.chtoNuzhnoDorabotat}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          minRows={3}
          autosize
          data-testid={`${mode}-comment`}
        />
        {mode === 'return' && <Files value={files} onChange={setFiles} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          {mode === 'approve' ? (
            <Button
              color="green"
              loading={approve.isPending}
              onClick={() => approve.mutate(undefined)}
              data-testid="approve-submit"
            >
              {t.tickets.prinyat}
            </Button>
          ) : (
            <Button
              color="orange"
              disabled={!comment.trim()}
              loading={back.isPending}
              onClick={() => back.mutate(undefined)}
              data-testid="return-submit"
            >
              {t.tickets.vernutNaDorabotku}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

function RedirectDialog({ t: tk, opened, onClose }: { t: Row; opened: boolean; onClose(): void }) {
  const people = useList('/tickets/assignable');
  const [enterpriseId, setEnterpriseId] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [responsible, setResponsible] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (!opened) return;
    setEnterpriseId(String(tk.enterpriseId));
    setDepartmentId(String(tk.departmentId));
    setTopicId(String(tk.topicId));
    setResponsible([]);
    setComment('');
  }, [opened, tk.enterpriseId, tk.departmentId, tk.topicId]);
  const dims: Record<string, string> = {};
  if (enterpriseId && enterpriseId !== tk.enterpriseId) dims.enterpriseId = enterpriseId;
  if (departmentId && departmentId !== tk.departmentId) dims.departmentId = departmentId;
  if (topicId && topicId !== tk.topicId) dims.topicId = topicId;
  const changed = Object.keys(dims).length > 0;
  const go = useTicketAction(
    () =>
      post(`/tickets/${tk.id}/redirect`, {
        version: tk.version,
        comment,
        ...dims,
        ...(responsible.length ? { responsibleIds: responsible } : {}),
      }),
    t.tickets.tiketPereadresovan,
    onClose,
  );
  return (
    <Modal opened={opened} onClose={onClose} title={t.tickets.pereadresatsiyaTiketa} size="lg">
      <Stack gap="xs" data-testid="redirect-form">
        <Text size="xs" c="dimmed">
          {t.tickets.smenaTemyPodrazdeleniyaIli}
        </Text>
        <OrgPicker
          size="sm"
          enterpriseId={enterpriseId}
          departmentId={departmentId}
          onChange={(e, d) => {
            setEnterpriseId(e);
            setDepartmentId(d);
          }}
          requireDepartment
          testId="redirect-org"
        />
        <TopicPicker size="sm" value={topicId} onChange={setTopicId} testId="redirect-topic" />
        <MultiSelect
          label={t.tickets.otvetstvennyyVruchnuyu}
          description={
            changed ? t.tickets.pustoOtvetstvennyePodstavyatsyaPo : t.tickets.vyberiteDrugogoOtvetstvennogo
          }
          data={(people.data ?? []).map((p) => ({ value: p.id, label: String(p.fullName) }))}
          value={responsible}
          onChange={setResponsible}
          searchable
          data-testid="redirect-responsible"
        />
        <Textarea
          label={t.tickets.kommentariyObyazatelen}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          minRows={2}
          autosize
          data-testid="redirect-comment"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            disabled={!comment.trim() || (!changed && !responsible.length)}
            loading={go.isPending}
            onClick={() => go.mutate(undefined)}
            data-testid="redirect-submit"
          >
            {t.tickets.pereadresovat}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ReassignDialog({ t: tk, opened, onClose }: { t: Row; opened: boolean; onClose(): void }) {
  const people = useList('/tickets/assignable');
  const [responsible, setResponsible] = useState<string[]>([]);
  const [curators, setCurators] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const [important, setImportant] = useState(false);
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (!opened) return;
    const act = ((tk.assignees as Row[]) ?? []).filter((a) => a.isActive);
    setResponsible(act.filter((a) => a.kind === 'responsible').map((a) => String(a.userId)));
    setCurators(act.filter((a) => a.kind === 'curator').map((a) => String(a.userId)));
    setDue(String(tk.dueDate));
    setImportant(!!tk.isImportant);
    setComment('');
  }, [opened, tk.assignees, tk.dueDate, tk.isImportant]);
  const go = useTicketAction(
    () =>
      post(`/tickets/${tk.id}/reassign`, {
        version: tk.version,
        responsibleIds: responsible,
        curatorIds: curators.filter((c) => !responsible.includes(c)),
        ...(due && due !== tk.dueDate ? { dueDate: due } : {}),
        ...(important !== !!tk.isImportant ? { isImportant: important } : {}),
        ...(comment.trim() ? { comment } : {}),
      }),
    t.tickets.izmeneniyaSokhraneny,
    onClose,
  );
  const opts = (people.data ?? []).map((p) => ({ value: p.id, label: String(p.fullName) }));
  return (
    <Modal opened={opened} onClose={onClose} title={t.tickets.otvetstvennyeSrokIVazhnost} size="lg">
      <Stack gap="xs" data-testid="reassign-form">
        <MultiSelect
          label={t.tickets.otvetstvennye}
          data={opts}
          value={responsible}
          onChange={setResponsible}
          searchable
          data-testid="reassign-responsible"
        />
        <MultiSelect
          label={t.tickets.kuratory}
          data={opts}
          value={curators}
          onChange={setCurators}
          searchable
        />
        <TextInput
          type="date"
          label={t.tickets.srokOtveta}
          value={due}
          onChange={(e) => setDue(e.currentTarget.value)}
          data-testid="reassign-due"
        />
        <Checkbox
          label={t.tickets.osoboVazhnoe2}
          checked={important}
          onChange={(e) => setImportant(e.currentTarget.checked)}
        />
        <Textarea
          label={t.tickets.kommentariy2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          minRows={2}
          autosize
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            disabled={!responsible.length}
            loading={go.isPending}
            onClick={() => go.mutate(undefined)}
            data-testid="reassign-submit"
          >
            {t.save}
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
    t.tickets.zamestitelNaznachen,
  );
  const del = useAction(
    (id: string) => api('DELETE', `/approval-substitutes/${id}`),
    t.tickets.zamestitelSnyat,
  );
  const ops = options(operators.data, 'fullName');
  return (
    <Stack gap="xs" data-testid="substitutes">
      <Text size="sm" c="dimmed">
        {t.tickets.zamestitelSoglasuetTiketyVmesto}
      </Text>
      <Group align="flex-end" gap="xs">
        {all && (
          <Select
            size="xs"
            label={t.tickets.operator}
            data={ops}
            value={userId}
            onChange={setUserId}
            searchable
          />
        )}
        <Select
          size="xs"
          label={t.tickets.zamestitel}
          data={ops.filter((o) => o.value !== me?.id)}
          value={substituteId}
          onChange={setSubstituteId}
          searchable
          data-testid="substitute"
        />
        <TextInput
          size="xs"
          type="date"
          label={t.tickets.s}
          value={from}
          onChange={(e) => setFrom(e.currentTarget.value)}
        />
        <TextInput
          size="xs"
          type="date"
          label={t.tickets.po}
          value={to}
          onChange={(e) => setTo(e.currentTarget.value)}
        />
        <Button
          size="xs"
          disabled={!substituteId || (all && !userId)}
          onClick={() => add.mutate(undefined)}
          data-testid="substitute-add"
        >
          {t.tickets.naznachit}
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
                  : t.tickets.bezOgranicheniya}
              </Table.Td>
              <Table.Td>
                {s.userId === me?.id || all ? (
                  <Button size="compact-xs" variant="subtle" color="red" onClick={() => del.mutate(s.id)}>
                    {t.tickets.snyat}
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
    t.tickets.matritsaPrimenenaKOtkrytym,
  );
  return (
    <Stack>
      <Title order={3}>{t.tickets.kontrol2YLinii}</Title>
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List mb="sm">
          {can('supervisor.approvals') && (
            <Tabs.Tab value="approvals" data-testid="tab-approvals-all">
              {t.tickets.vseSoglasovaniya}
            </Tabs.Tab>
          )}
          <Tabs.Tab value="attention" data-testid="tab-attention">
            {t.tickets.trebuyutPerenaznacheniya}
          </Tabs.Tab>
          {can('admin.users') && <Tabs.Tab value="substitutes">{t.tickets.zamestiteli}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="approvals">
          <TicketList view="approvals_all" />
        </Tabs.Panel>
        <Tabs.Panel value="attention">
          <Stack>
            <Group>
              <Text size="sm" c="dimmed" style={{ flex: 1 }}>
                {t.tickets.otkrytyeTiketyUKotorykh}
              </Text>
              {can('admin.matrix') && (
                <Button
                  size="xs"
                  variant="light"
                  loading={apply.isPending}
                  onClick={() => apply.mutate(undefined)}
                  data-testid="apply-matrix"
                >
                  {t.tickets.primenitMatritsuKOtkrytym}
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
        {t.tickets.kabinet2YLinii}
      </Anchor>
    </Stack>
  );
}
