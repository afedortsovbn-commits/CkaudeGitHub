import {
  Accordion,
  ActionIcon,
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
  Radio,
  ScrollArea,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, authBlobUrl, errorText, get, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, options, useAction, useList, useRequired } from '../lib/data';
import { t } from '../lib/i18n';
import { OrgPicker, TopicPicker } from '../components/DictPickers';
import { DEFAULT_FILTER, filterQuery, type TicketFilter, TicketFilters } from '../components/TicketFilters';
import {
  IconAlertTriangle,
  IconArrowForwardUp,
  IconCircleCheck,
  IconClockPlus,
  IconExternalLink,
  IconTemplate,
} from '@tabler/icons-react';

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
  const req = useRequired();
  useEffect(() => {
    if (!opened) return;
    setEnterpriseId((conv.enterpriseId as string) ?? null);
    setDepartmentId((conv.departmentId as string) ?? null);
    setTopicId((conv.topicId as string) ?? null);
    // Суть — из поля карточки «Суть обращения», если оператор его заполнил (можно изменить).
    setSummary(String((conv.fields as Record<string, unknown> | null)?.issue_summary ?? ''));
    req.reset();
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
          withAsterisk
          error={req.error(!departmentId)}
          testId="esc-org"
        />
        <TopicPicker
          size="sm"
          value={topicId}
          onChange={setTopicId}
          withAsterisk
          error={req.error(!topicId)}
          testId="esc-topic"
        />
        <Textarea
          label={t.tickets.sutObrashcheniyaDlyaOtvetstvennykh}
          description={t.tickets.otvetstvennyeVidyatEtuSut}
          withAsterisk
          error={req.error(!summary.trim())}
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
          withAsterisk
          error={req.error(!responsible.length)}
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
            onClick={() =>
              req.check([
                ...(!departmentId ? [t.tree.org] : []),
                ...(!topicId ? [t.tree.topic] : []),
                ...(!summary.trim() ? [t.tickets.sutObrashcheniyaDlyaOtvetstvennykh] : []),
                ...(!responsible.length ? [t.tickets.otvetstvennye] : []),
              ]) && send.mutate(undefined)
            }
            loading={send.isPending}
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
  const status = String(tk.status);
  // Закрытые и на согласовании (работа ответственного завершена) — светло-серым; просроченные — красным.
  const dim = status === 'closed' || status === 'approval';
  const overdue = !!tk.isOverdue;
  const c = dim ? 'dimmed' : undefined;
  return (
    <Card
      withBorder
      padding="xs"
      onClick={() => onOpen(tk.id)}
      style={{
        cursor: 'pointer',
        borderLeft: `4px solid ${overdue ? 'var(--mantine-color-red-6)' : mine === 'responsible' ? 'var(--mantine-color-blue-6)' : mine === 'curator' ? 'var(--mantine-color-gray-5)' : 'transparent'}`,
        // Выбранное — заметно: заливка и толстая рамка.
        borderColor: selected ? 'var(--mantine-color-blue-6)' : undefined,
        borderWidth: selected ? 2 : undefined,
        boxShadow: selected ? '0 0 0 2px var(--mantine-color-blue-3)' : undefined,
        background: selected
          ? 'var(--mantine-color-blue-light)'
          : overdue
            ? 'var(--mantine-color-red-light)'
            : undefined,
        opacity: dim && !selected ? 0.75 : undefined,
      }}
      data-testid="ticket-item"
      data-selected={selected || undefined}
      data-overdue={overdue || undefined}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap={6} wrap="nowrap">
          <Text fw={700} size="sm" c={c}>
            №{String(tk.number)}
          </Text>
          {tk.isImportant ? (
            <Badge color={dim ? 'gray' : 'red'} size="xs" variant={dim ? 'outline' : 'filled'}>
              {t.tickets.osoboVazhnoe}
            </Badge>
          ) : null}
          {mine ? (
            <Badge
              size="xs"
              variant={dim ? 'outline' : mine === 'responsible' ? 'filled' : 'light'}
              color={dim ? 'gray' : 'blue'}
            >
              {mine === 'responsible' ? t.tickets.yaOtvetstvennyy : t.tickets.yaKurator}
            </Badge>
          ) : null}
        </Group>
        <StatusBadge status={status} testId="ticket-item-status" />
      </Group>
      <Text size="xs" lineClamp={1} c={c}>
        {String(tk.topicName)} · {String(tk.enterpriseName)} / {String(tk.departmentName)}
      </Text>
      <Text size="xs" c="dimmed" lineClamp={1}>
        {String(tk.contactName)}: {String(tk.summary)}
      </Text>
      <Group justify="space-between">
        <Deadline t={tk} />
        {Number(tk.returnsCount) > 0 && (
          <Text size="xs" c={dim ? 'dimmed' : 'orange'}>
            {t.tickets.vozvratov}
            {String(tk.returnsCount)}
          </Text>
        )}
      </Group>
    </Card>
  );
}

/** Значок-переключатель «только особо важные»: включён — красный. */
function ImportantToggle({ value, onChange }: { value: boolean; onChange(v: boolean): void }) {
  return (
    <Tooltip label={value ? t.tickets.fltImportantOn : t.tickets.fltImportantOff} withArrow>
      <ActionIcon
        variant={value ? 'filled' : 'default'}
        color="red"
        onClick={() => onChange(!value)}
        aria-label={t.tickets.tolkoOsoboVazhnye}
        data-testid="flt-important"
      >
        <IconAlertTriangle size={18} />
      </ActionIcon>
    </Tooltip>
  );
}

/** Список обращений 2-й линии для вкладок оператора и супервизора; клик — переход в обращение. */
export function TicketList({ view, extra = '' }: { view: string; extra?: string }) {
  const nav = useNavigate();
  const [important, setImportant] = useState(false);
  const list = useList(`/tickets?view=${view}${extra}${important ? '&important=true' : ''}`);
  return (
    <Stack gap={6}>
      <Group justify="flex-end">
        <ImportantToggle value={important} onChange={setImportant} />
      </Group>
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

/** Количество обращений во вкладке (для подписи). */
export function useTicketCount(view: string, extra = ''): number {
  const list = useList(`/tickets?view=${view}${extra}`);
  return (list.data ?? []).length;
}

// ---------------------------------------------------------------- обращения на 2-й линии

/** Обращения на 2-й линии (M-TKT-05): список с фильтрами значками, краткая информация, переход в обращение. */
export function CabinetPage() {
  const nav = useNavigate();
  const [filter, setFilter] = useState<TicketFilter>(DEFAULT_FILTER);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const list = useList(`/tickets?view=cabinet${filterQuery(filter)}`);
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
        <Box mb="xs">
          <TicketFilters value={filter} onChange={setFilter} />
        </Box>
        <ScrollArea h="calc(100vh - 250px)">
          <Stack gap={6} p={4} data-testid="ticket-list">
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
            <TicketActions
              t={preview.data}
              onDialog={setDialog}
              onOpenFull={() => nav(`/tickets/${selected}`)}
            />
            <ExtensionNotice t={preview.data} />
            <TicketFacts t={preview.data} />
            <TicketDialogs t={preview.data} dialog={dialog} onClose={() => setDialog(null)} />
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
  extension_requested: t.tickets.histExtRequested,
  extension_declined: t.tickets.histExtDeclined,
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

/**
 * Сведения об обращении: на виду — тема, подтема, суть, срок, статус, способ закрытия и суть ответа,
 * ответственный; остальное (направлено, клиент, кураторы, кто передал, история) — свёрнуто.
 */
function TicketFacts({ t: tk }: { t: Row }) {
  const c = tk.conversation as Row | null;
  const assignees = ((tk.assignees as Row[]) ?? []).filter((a) => a.isActive);
  const names = (kind: string) =>
    assignees
      .filter((a) => a.kind === kind)
      .map((a) => String(a.fullName))
      .join(', ') || '—';
  const [topic, ...sub] = String(tk.topicName ?? '').split(' / ');
  return (
    <Stack gap={4} data-testid="ticket-facts">
      <Deadline t={tk} />
      <Text size="sm">
        <b>{t.tickets.tema2}</b> {topic}
      </Text>
      {sub.length > 0 && (
        <Text size="sm">
          <b>{t.tickets.podtema}</b> {sub.join(' / ')}
        </Text>
      )}
      <Text size="sm">
        <b>{t.tickets.sut}</b> {String(tk.summary)}
      </Text>
      <Text size="sm">
        <b>{t.tickets.otvetstvennyy}</b> {names('responsible')}
      </Text>
      <Text size="sm">
        <b>{t.tickets.sposobZakrytiya}</b> {String(tk.answerMethodName ?? '—')}
      </Text>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        <b>{t.tickets.sutOtveta2}</b> {String(tk.answerSummary ?? '—')}
      </Text>
      {tk.staffGuilty !== null && tk.staffGuilty !== undefined && (
        <Text size="sm" data-testid="ticket-guilt">
          <b>{t.tickets.guilt}:</b> {tk.staffGuilty ? t.tickets.guiltYes : t.tickets.guiltNo}
          {((tk.measures as string[]) ?? []).length > 0 &&
            ` · ${t.tickets.measuresLabel}: ${((tk.measures as string[]) ?? []).map((m) => t.tickets.measure[m] ?? m).join(', ')}`}
        </Text>
      )}
      {tk.answerSummary ? <AnswerToTemplate t={tk} /> : null}
      <Accordion variant="contained" chevronPosition="left" mt={6}>
        <Accordion.Item value="more" data-testid="ticket-more">
          <Accordion.Control py={4} data-testid="ticket-more-toggle">
            <Text size="sm">{t.tickets.more}</Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap={4}>
              <Text size="sm">
                <b>{t.tickets.napravleno}</b> {String(tk.enterpriseName)} / {String(tk.departmentName)}
              </Text>
              <Text size="sm">
                <b>{t.tickets.klient}</b>{' '}
                {[c?.displayName, c?.phone, c?.email].filter(Boolean).join(', ') || String(tk.contactName)}
              </Text>
              <Text size="sm">
                <b>{t.tickets.kuratory2}</b> {names('curator')}
              </Text>
              <Text size="sm">
                <b>{t.tickets.peredal}</b> {String(tk.creatorName)}
              </Text>
              <Divider my={4} />
              <Text fw={600} size="sm">
                {t.tickets.istoriya}
              </Text>
              <History items={(tk.history as Row[]) ?? []} />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

/** Готовый ответ ответственного — в шаблоны 2-й линии по теме обращения (для всех предприятий). */
function AnswerToTemplate({ t: tk }: { t: Row }) {
  const { can } = useAuth();
  const [opened, setOpened] = useState(false);
  const topicShort =
    String(tk.topicName ?? '')
      .split(' / ')
      .pop() ?? '';
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const req = useRequired();
  const save = useAction(
    () => post('/templates', { title, body, topicId: tk.topicId, line: 'second' }),
    t.tickets.tplSaved,
  );
  if (!can('tickets.work', 'templates.manage')) return null;
  return (
    <>
      <Group>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconTemplate size={14} />}
          onClick={() => {
            setTitle(`${topicShort}: ${String(tk.answerSummary).slice(0, 60)}`);
            setBody(String(tk.answerSummary));
            req.reset();
            setOpened(true);
          }}
          data-testid="answer-to-template"
        >
          {t.tickets.tplFromAnswer}
        </Button>
      </Group>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t.tickets.tplFromAnswerTitle}>
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            {t.tickets.tplFromAnswerHint}
          </Text>
          <TextInput
            label={t.tickets.tplName}
            withAsterisk
            error={req.error(!title.trim())}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <Textarea
            label={t.tickets.sutOtveta}
            withAsterisk
            error={req.error(!body.trim())}
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            autosize
            minRows={3}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpened(false)}>
              {t.cancel}
            </Button>
            <Button
              loading={save.isPending}
              onClick={() =>
                req.check([
                  ...(!title.trim() ? [t.tickets.tplName] : []),
                  ...(!body.trim() ? [t.tickets.sutOtveta] : []),
                ]) && save.mutate(undefined, { onSuccess: () => setOpened(false) })
              }
            >
              {t.save}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/** Последний запрос продления срока, по которому ещё нет решения (продлено или отказано). */
function pendingExtension(tk: Row): { dueDate: string; comment: string } | null {
  let pending: { dueDate: string; comment: string } | null = null;
  for (const h of (tk.history as Row[]) ?? []) {
    const d = (h.details as { dueDate?: string; comment?: string } | null) ?? {};
    if (h.action === 'extension_requested') pending = { dueDate: d.dueDate ?? '', comment: d.comment ?? '' };
    else if (h.action === 'extension_declined' || h.action === 'reassigned') pending = null;
  }
  return pending;
}

/** Запрос продления срока: решающему — «Продлить»/«Отклонить», ответственному — что запрос ждёт решения. */
function ExtensionNotice({ t: tk }: { t: Row }) {
  const can = (tk.can as Record<string, boolean> | undefined) ?? {};
  const p = pendingExtension(tk);
  const approve = useTicketAction(
    () => post(`/tickets/${tk.id}/reassign`, { version: tk.version, dueDate: p?.dueDate }),
    t.tickets.extApproved,
  );
  const decline = useTicketAction(
    () => post(`/tickets/${tk.id}/extension/decline`, {}),
    t.tickets.extDeclined,
  );
  if (!p || tk.status === 'closed') return null;
  return (
    <Alert color="yellow" variant="light" my="xs" data-testid="extension-notice">
      <Text size="sm">{t.tickets.extPending(fmtDate(p.dueDate), p.comment)}</Text>
      {can.reassign ? (
        <Group gap="xs" mt="xs">
          <Button
            size="xs"
            color="green"
            loading={approve.isPending}
            onClick={() => approve.mutate(undefined)}
            data-testid="extension-approve"
          >
            {t.tickets.extApprove(fmtDate(p.dueDate))}
          </Button>
          <Button
            size="xs"
            variant="light"
            color="red"
            loading={decline.isPending}
            onClick={() => decline.mutate(undefined)}
            data-testid="extension-decline"
          >
            {t.tickets.extDecline}
          </Button>
        </Group>
      ) : (
        <Text size="xs" c="dimmed">
          {t.tickets.extWait}
        </Text>
      )}
    </Alert>
  );
}

/** Действия над обращением кнопками со значками — по правам (`can` из API). */
function TicketActions({
  t: tk,
  onDialog,
  onOpenFull,
}: {
  t: Row;
  onDialog(d: Dialog): void;
  onOpenFull?(): void;
}) {
  const can = (tk.can as Record<string, boolean> | undefined) ?? {};
  return (
    <Group gap="xs" mb="xs" data-testid="ticket-actions">
      {onOpenFull && (
        <Button
          size="xs"
          leftSection={<IconExternalLink size={16} />}
          onClick={onOpenFull}
          data-testid="ticket-open-full"
        >
          {t.tickets.otkrytObrashchenieTselikom}
        </Button>
      )}
      {can.close && (
        <Tooltip label={t.tickets.btnCloseHint} withArrow>
          <Button
            size="xs"
            color="green"
            leftSection={<IconCircleCheck size={16} />}
            onClick={() => onDialog('close')}
            data-testid="ticket-close"
          >
            {t.tickets.btnClose}
          </Button>
        </Tooltip>
      )}
      {can.redirect && (
        <Button
          size="xs"
          variant="light"
          leftSection={<IconArrowForwardUp size={16} />}
          onClick={() => onDialog('redirect')}
          data-testid="ticket-redirect"
        >
          {t.tickets.btnRedirect}
        </Button>
      )}
      {can.extend && (
        <Button
          size="xs"
          variant="light"
          color="orange"
          leftSection={<IconClockPlus size={16} />}
          onClick={() => onDialog('extend')}
          data-testid="ticket-extend"
        >
          {t.tickets.btnExtend}
        </Button>
      )}
      {can.approve && (
        <>
          <Button size="xs" color="green" onClick={() => onDialog('approve')} data-testid="ticket-approve">
            {t.tickets.prinyat}
          </Button>
          <Button
            size="xs"
            color="orange"
            variant="light"
            onClick={() => onDialog('return')}
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
          onClick={() => onDialog('reassign')}
          data-testid="ticket-reassign"
        >
          {t.tickets.otvetstvennyeISrok}
        </Button>
      )}
    </Group>
  );
}

/** Все диалоги действий над обращением. */
function TicketDialogs({ t: tk, dialog, onClose }: { t: Row; dialog: Dialog; onClose(): void }) {
  return (
    <>
      <CloseDialog t={tk} opened={dialog === 'close'} onClose={onClose} />
      <RedirectDialog t={tk} opened={dialog === 'redirect'} onClose={onClose} />
      <ExtensionDialog t={tk} opened={dialog === 'extend'} onClose={onClose} />
      <ApproveDialog t={tk} mode="approve" opened={dialog === 'approve'} onClose={onClose} />
      <ApproveDialog t={tk} mode="return" opened={dialog === 'return'} onClose={onClose} />
      <ReassignDialog t={tk} opened={dialog === 'reassign'} onClose={onClose} />
    </>
  );
}

/** Запрос продления срока: новый срок и причина обязательны (звёздочки красные, пустое — подсвечено). */
function ExtensionDialog({ t: tk, opened, onClose }: { t: Row; opened: boolean; onClose(): void }) {
  const [due, setDue] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!opened) return;
    setDue('');
    setReason('');
    setTried(false);
  }, [opened]);
  const send = useTicketAction(
    () => post(`/tickets/${tk.id}/extension`, { dueDate: due, reason }),
    t.tickets.extSent,
    onClose,
  );
  const minDue = String(tk.dueDate ?? '');
  const dueBad = !due || due <= minDue;
  const submit = () => {
    setTried(true);
    if (dueBad || !reason.trim()) {
      notifications.show({ color: 'red', message: t.tickets.fillRequired });
      return;
    }
    send.mutate(undefined);
  };
  return (
    <Modal opened={opened} onClose={onClose} title={t.tickets.extTitle}>
      <Stack gap="xs" data-testid="extension-form">
        <Deadline t={tk} />
        <TextInput
          type="date"
          label={t.tickets.extNewDue}
          withAsterisk
          min={minDue}
          value={due}
          onChange={(e) => setDue(e.currentTarget.value)}
          error={tried && dueBad ? t.tickets.required : undefined}
          data-testid="extension-due"
        />
        <Textarea
          label={t.tickets.extReason}
          withAsterisk
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          error={tried && !reason.trim() ? t.tickets.required : undefined}
          minRows={2}
          autosize
          data-testid="extension-reason"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button loading={send.isPending} onClick={submit} data-testid="extension-submit">
            {t.tickets.extSend}
          </Button>
        </Group>
      </Stack>
    </Modal>
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

type Dialog = 'close' | 'redirect' | 'return' | 'approve' | 'reassign' | 'extend' | null;

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
        <TicketActions t={tk} onDialog={setDialog} />
      </Group>
      <ExtensionNotice t={tk} />
      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Paper withBorder p="md">
            <TicketFacts t={tk} />
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
      <TicketDialogs t={tk} dialog={dialog} onClose={() => setDialog(null)} />
    </Stack>
  );
}

function CloseDialog({ t: tk, opened, onClose }: { t: Row; opened: boolean; onClose(): void }) {
  const methods = useList('/dict/answer-methods');
  const [method, setMethod] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [files, setFiles] = useState<Att[]>([]);
  const [guilty, setGuilty] = useState<string | null>(null);
  const [measures, setMeasures] = useState<string[]>([]);
  const req = useRequired();
  const realMeasures = measures.filter((m) => m !== 'none');
  // Шаблоны и примеры ответов 2-й линии по теме обращения (и темам выше), общие без темы — в конце.
  const tpls = useList(`/templates?line=second&forTopic=${String(tk.topicId)}`, opened);
  const [asTpl, setAsTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const topicShort =
    String(tk.topicName ?? '')
      .split(' / ')
      .pop() ?? '';
  const saveTpl = useAction((b: Record<string, unknown>) => post('/templates', b), t.tickets.tplSaved);
  const close = useTicketAction(
    () =>
      post(`/tickets/${tk.id}/close`, {
        version: tk.version,
        answerMethodId: method,
        answerSummary: summary,
        attachmentIds: files.map((f) => f.id),
        staffGuilty: guilty === 'yes',
        measures,
      }),
    t.tickets.tiketOtpravlenNaSoglasovanie,
    () => {
      if (asTpl && summary.trim())
        saveTpl.mutate({
          title: tplName.trim() || `${topicShort}: ${summary.trim().slice(0, 60)}`,
          body: summary.trim(),
          topicId: tk.topicId,
          line: 'second',
        });
      onClose();
      setSummary('');
      setFiles([]);
      setAsTpl(false);
      setTplName('');
      setGuilty(null);
      setMeasures([]);
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
          withAsterisk
          error={req.error(!method)}
          data-testid="answer-method"
        />
        <Paper withBorder p="xs" data-testid="answer-templates">
          <Text size="sm" fw={600} mb={4}>
            {t.tickets.tplTitle}
          </Text>
          {(tpls.data ?? []).length === 0 && (
            <Text size="xs" c="dimmed">
              {t.tickets.tplNone}
            </Text>
          )}
          <ScrollArea.Autosize mah={180}>
            <Stack gap={6}>
              {(tpls.data ?? []).map((tp) => (
                <Group key={tp.id} justify="space-between" wrap="nowrap" align="flex-start">
                  <Box style={{ flex: 1 }}>
                    <Text size="sm" fw={500}>
                      {String(tp.title)}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={2}>
                      {String(tp.body)}
                    </Text>
                  </Box>
                  <Button
                    size="compact-xs"
                    variant="light"
                    onClick={() => {
                      setSummary(String(tp.body));
                      void post(`/templates/${tp.id}/used`).catch(() => undefined);
                    }}
                    data-testid="answer-template-insert"
                  >
                    {t.tickets.tplInsert}
                  </Button>
                </Group>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </Paper>
        <Textarea
          label={t.tickets.sutOtveta}
          withAsterisk
          error={req.error(!summary.trim())}
          value={summary}
          onChange={(e) => setSummary(e.currentTarget.value)}
          minRows={4}
          autosize
          data-testid="answer-summary"
        />
        <Group align="flex-start" grow>
          <Radio.Group
            label={t.tickets.guilt}
            withAsterisk
            value={guilty}
            onChange={setGuilty}
            error={req.error(!guilty)}
            data-testid="close-guilt"
          >
            <Group mt={6}>
              <Radio value="yes" label={t.tickets.guiltYes} data-testid="close-guilt-yes" />
              <Radio value="no" label={t.tickets.guiltNo} data-testid="close-guilt-no" />
            </Group>
          </Radio.Group>
          <MultiSelect
            label={t.tickets.measuresLabel}
            description={t.tickets.measuresHint}
            withAsterisk
            data={Object.entries(t.tickets.measure).map(([value, label]) => ({ value, label }))}
            value={measures}
            // «Не применялись» и меры взаимоисключающие: последнее выбранное вытесняет противоположное.
            onChange={(v) => {
              const added = v.find((x) => !measures.includes(x));
              setMeasures(added === 'none' ? ['none'] : v.filter((x) => x !== 'none'));
            }}
            error={req.error(!measures.length)}
            data-testid="close-measures"
          />
        </Group>
        <Files value={files} onChange={setFiles} />
        {realMeasures.length > 0 && !files.length && (
          <Alert color="yellow" variant="light" data-testid="measures-doc-hint">
            {t.tickets.measuresDocHint}
          </Alert>
        )}
        <Checkbox
          label={t.tickets.tplSaveAs(topicShort)}
          checked={asTpl}
          onChange={(e) => setAsTpl(e.currentTarget.checked)}
          data-testid="answer-save-template"
        />
        {asTpl && (
          <TextInput
            size="xs"
            label={t.tickets.tplName}
            placeholder={`${topicShort}: ${summary.trim().slice(0, 60)}`}
            value={tplName}
            onChange={(e) => setTplName(e.currentTarget.value)}
            data-testid="answer-template-name"
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            color="green"
            loading={close.isPending}
            onClick={() =>
              req.check([
                ...(!method ? [t.tickets.sposobOtveta] : []),
                ...(!summary.trim() ? [t.tickets.sutOtveta] : []),
                ...(!guilty ? [t.tickets.guilt] : []),
                ...(!measures.length ? [t.tickets.measuresLabel] : []),
              ]) && close.mutate(undefined)
            }
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
  const req = useRequired();
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
          withAsterisk={mode === 'return'}
          error={mode === 'return' ? req.error(!comment.trim()) : undefined}
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
              loading={back.isPending}
              onClick={() =>
                req.check(!comment.trim() ? [t.tickets.chtoNuzhnoDorabotat] : []) && back.mutate(undefined)
              }
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
  const req = useRequired();
  useEffect(() => {
    if (!opened) return;
    req.reset();
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
          error={req.error(!changed && !responsible.length)}
          data-testid="redirect-responsible"
        />
        <Textarea
          label={t.tickets.kommentariy2}
          withAsterisk
          error={req.error(!comment.trim())}
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
            loading={go.isPending}
            onClick={() =>
              req.check([
                ...(!changed && !responsible.length ? [t.tickets.otvetstvennyyVruchnuyu] : []),
                ...(!comment.trim() ? [t.tickets.kommentariy2] : []),
              ]) && go.mutate(undefined)
            }
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
  const req = useRequired();
  useEffect(() => {
    if (!opened) return;
    req.reset();
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
          withAsterisk
          error={req.error(!responsible.length)}
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
            loading={go.isPending}
            onClick={() =>
              req.check(!responsible.length ? [t.tickets.otvetstvennye] : []) && go.mutate(undefined)
            }
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
