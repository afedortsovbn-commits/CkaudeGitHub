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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, authBlobUrl, errorText, get, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, options, useAction, useList, useRequired } from '../lib/data';
import { t } from '../lib/i18n';
import { OrgPicker, TopicPicker } from '../components/DictPickers';
import { COMMON_FIELD_KEYS, isCommonField } from '../lib/common-fields';
import { defaultFilter, filterQuery, type TicketFilter, TicketFilters } from '../components/TicketFilters';
import {
  IconAlertTriangle,
  IconArrowForwardUp,
  IconArrowUp,
  IconCircleCheck,
  IconClockPlus,
  IconExternalLink,
  IconMessages,
  IconPencil,
  IconPlayerPlay,
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

/**
 * Фон по оставшемуся сроку (п. 18): в работе — от светло-жёлтого через оранжевый к красному по мере приближения
 * срока; просроченные — красные; на согласовании и закрытые — без цвета.
 */
function deadlineColor(tk: Row): string | undefined {
  if (!['new', 'in_work', 'rework'].includes(String(tk.status))) return undefined;
  // Полупрозрачный цвет слева, уходящий в прозрачность вправо, — легче, чем сплошная заливка.
  const fade = (h: number, s: number, l: number, a: number) =>
    `linear-gradient(90deg, hsla(${h}, ${s}%, ${l}%, ${a}) 0%, hsla(${h}, ${s}%, ${l}%, 0) 60%)`;
  if (tk.isOverdue) return fade(0, 85, 62, 0.22);
  const total = Math.max(1, Number(tk.totalDays ?? 15));
  const left = Math.min(total, Math.max(0, Number(tk.daysLeft ?? total)));
  const used = 1 - left / total; // 0 — только поступило, 1 — срок сегодня
  const hue = Math.round(52 - used * 52); // жёлтый → оранжевый → красный
  return fade(hue, 95, 60, 0.08 + used * 0.12); // ближе к сроку — чуть насыщеннее
}

function TicketCard({ t: tk, selected, onOpen }: { t: Row; selected?: boolean; onOpen(id: string): void }) {
  const mine = tk.myRole as string | null;
  const status = String(tk.status);
  // Закрытые и на согласовании (работа ответственного завершена) — светло-серым.
  const dim = status === 'closed' || status === 'approval';
  const overdue = !!tk.isOverdue;
  const c = dim ? 'dimmed' : undefined;
  const fresh = !!tk.isNew;
  return (
    <Card
      withBorder
      padding="xs"
      onClick={() => onOpen(tk.id)}
      style={{
        cursor: 'pointer',
        borderLeft: `4px solid ${overdue ? 'var(--mantine-color-red-7)' : mine === 'responsible' ? 'var(--mantine-color-blue-6)' : mine === 'curator' ? 'var(--mantine-color-gray-5)' : 'transparent'}`,
        background: deadlineColor(tk),
        // Выбранное — заметно: толстая синяя рамка и тень.
        outline: selected ? '3px solid var(--mantine-color-blue-6)' : undefined,
        boxShadow: selected ? '0 2px 10px rgba(34, 139, 230, 0.45)' : undefined,
        opacity: dim && !selected ? 0.75 : undefined,
      }}
      data-testid="ticket-item"
      data-selected={selected || undefined}
      data-overdue={overdue || undefined}
      data-new={fresh || undefined}
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
        <Group gap={6} wrap="nowrap">
          {fresh && (
            <Text size="xs" fw={700} c="green.7" tt="uppercase" data-testid="ticket-new">
              {t.tickets.newMark}
            </Text>
          )}
          <StatusBadge status={status} testId="ticket-item-status" />
        </Group>
      </Group>
      <Text size="xs" lineClamp={1} c={c}>
        {String(tk.topicName)} · {String(tk.enterpriseName)} / {String(tk.departmentName)}
      </Text>
      <Text size="xs" c={dim ? 'dimmed' : 'dark.4'} lineClamp={2} data-testid="ticket-item-summary">
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

/** Прокручиваемый блок со стрелкой «В начало» (появляется, когда прокручено вниз). */
function ScrollBlock({ children, h, testId }: { children: React.ReactNode; h: string; testId: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  return (
    <Box pos="relative">
      <ScrollArea
        h={h}
        viewportRef={viewport}
        onScrollPositionChange={({ y }) => setScrolled(y > 150)}
        data-testid={testId}
      >
        {children}
      </ScrollArea>
      {scrolled && (
        <Tooltip label={t.tickets.toTop} withArrow>
          <ActionIcon
            pos="absolute"
            bottom={12}
            right={16}
            radius="xl"
            size="lg"
            variant="filled"
            onClick={() => viewport.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            aria-label={t.tickets.toTop}
            data-testid={`${testId}-top`}
          >
            <IconArrowUp size={18} />
          </ActionIcon>
        </Tooltip>
      )}
    </Box>
  );
}

/**
 * Обращения на 2-й линии (M-TKT-05): список с фильтрами значками и справа — сведения о выбранном. Ответственному и
 * куратору сразу открыто верхнее обращение; по умолчанию — «я ответственный»/«я куратор» и последние 30 дней.
 */
export function CabinetPage() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  // Только 2-я линия (не оператор, не супервизор, не администратор): по умолчанию — «я», верхнее открыто.
  const secondLine =
    can('tickets.work') && !can('conversations.work', 'supervisor.monitor', 'supervisor.approvals');
  const myKind = useQuery({
    queryKey: ['/tickets/my-kind'],
    queryFn: () => get<{ kind: 'responsible' | 'curator' }>('/tickets/my-kind'),
    enabled: secondLine,
  });
  const defaults = useMemo(
    () => defaultFilter(secondLine && me ? { id: me.id, kind: myKind.data?.kind ?? null } : undefined),
    [secondLine, me, myKind.data],
  );
  const [filter, setFilter] = useState<TicketFilter | null>(null);
  const f = filter ?? defaults;
  const ready = !secondLine || !!myKind.data || myKind.isError;
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [exporting, setExporting] = useState(false);
  const list = useList(`/tickets?view=cabinet${filterQuery(f)}`, ready);
  const preview = useQuery({
    queryKey: [`/tickets/${selected}`],
    queryFn: () => get<Row>(`/tickets/${selected}`),
    enabled: !!selected,
  });
  // Ответственному и куратору сразу открыто верхнее обращение (не взятое в работу и не отмеченное просмотренным).
  useEffect(() => {
    const rows = list.data ?? [];
    if (!secondLine || !rows.length) return;
    if (!selected || !rows.some((r) => r.id === selected)) {
      setSelected(rows[0]!.id);
      setPicked(false);
    }
  }, [list.data, secondLine, selected]);
  // Щелчок: обращение больше не «Новое»; «Новое» (или возвращённое) — берётся в работу (M-TKT-03).
  const openTicket = useTicketAction(
    (tid: string) => post(`/tickets/${tid}/open`),
    t.tickets.tiketVzyatVRabotu,
  );
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    const d = preview.data;
    if (!d || !picked || autoOpened.current === d.id) return;
    autoOpened.current = String(d.id);
    if ((d.can as Record<string, boolean> | undefined)?.open) openTicket.mutate(String(d.id));
  }, [preview.data, picked, openTicket]);
  const pick = (id: string) => {
    setSelected(id);
    setPicked(true);
    void post(`/tickets/${id}/seen`)
      .then(() => qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('/tickets?') }))
      .catch(() => undefined);
  };
  const exportXlsx = async () => {
    setExporting(true);
    try {
      const url = await authBlobUrl(`/tickets/export?view=cabinet${filterQuery(f)}`);
      const a = document.createElement('a');
      a.href = url;
      a.download = `obrashcheniya-2-linii-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notifications.show({ color: 'green', message: t.tickets.exportDone });
    } catch (e) {
      notifications.show({ color: 'red', title: t.error, message: errorText(e), autoClose: 8000 });
    } finally {
      setExporting(false);
    }
  };
  return (
    <Grid gutter="sm">
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Box mb="xs">
          <TicketFilters
            value={f}
            onChange={setFilter}
            onExport={() => void exportXlsx()}
            exporting={exporting}
          />
        </Box>
        <ScrollBlock h="calc(100vh - 200px)" testId="ticket-list-scroll">
          <Stack gap={6} p={4} data-testid="ticket-list">
            {(list.data ?? []).length === 0 && (
              <Text c="dimmed" size="sm">
                {t.tickets.netTiketov}
              </Text>
            )}
            {(list.data ?? []).map((tk) => (
              <TicketCard key={tk.id} t={tk} selected={selected === tk.id} onOpen={pick} />
            ))}
          </Stack>
        </ScrollBlock>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 7 }}>
        {preview.data ? (
          <ScrollBlock h="calc(100vh - 100px)" testId="ticket-preview-scroll">
            <Paper withBorder p="md" data-testid="ticket-preview">
              <Group justify="space-between" mb="xs">
                <Title order={4} data-testid="ticket-title">
                  {t.tickets.tiket}
                  {String(preview.data.number)}
                </Title>
                <StatusBadge status={String(preview.data.status)} />
              </Group>
              <TicketActions t={preview.data} onDialog={setDialog} />
              <ExtensionNotice t={preview.data} />
              <TicketFacts t={preview.data} />
              <TicketDialogs t={preview.data} dialog={dialog} onClose={() => setDialog(null)} />
            </Paper>
          </ScrollBlock>
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
  edited: t.tickets.histEdited,
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

/** Источник обращения (канал). */
const CHANNEL_LABEL: Record<string, string> = {
  webchat: t.workspace.sayt,
  app: t.workspace.prilozhenie,
  telegram: 'Telegram',
  email: 'Email',
  voice: t.workspace.zvonok,
  api: t.workspace.vneshnyayaSistema,
  review: t.reviews.channel,
};

/** Фамилия — первое слово ФИО (подпись автора заметки). */
const surname = (name: unknown) => String(name ?? '').split(' ')[0] ?? '';

function Line({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <Text size="sm">
      <b>{label}:</b> {String(value)}
    </Text>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <Box data-testid={testId}>
      <Text size="xs" fw={700} tt="uppercase" c="blue.8" mt={8} mb={2}>
        {title}
      </Text>
      <Stack gap={2}>{children}</Stack>
    </Box>
  );
}

/** Переписка с клиентом — в окне по кнопке. */
function DialogButton({ ticketId }: { ticketId: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Tooltip label={t.tickets.openDialog} withArrow>
        <ActionIcon
          variant="light"
          onClick={() => setOpened(true)}
          aria-label={t.tickets.openDialog}
          data-testid="open-dialog"
        >
          <IconMessages size={18} />
        </ActionIcon>
      </Tooltip>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t.tickets.perepiskaSKlientom} size="xl">
        {opened && <Conversation ticketId={ticketId} />}
      </Modal>
    </>
  );
}

/** Записи разговоров — в окне по кнопке (прослушивание фиксируется в журнале аудита). */
function RecordingsButton({ ticketId }: { ticketId: string }) {
  const [opened, setOpened] = useState(false);
  const list = useList(`/tickets/${ticketId}/recordings`, opened);
  const [src, setSrc] = useState<Record<string, string>>({});
  const play = async (id: string) => {
    try {
      const url = await authBlobUrl(`/tickets/${ticketId}/recordings/${id}`);
      setSrc((x) => ({ ...x, [id]: url }));
    } catch (e) {
      notifications.show({ color: 'red', title: t.error, message: errorText(e) });
    }
  };
  return (
    <>
      <Tooltip label={t.tickets.openRecordings} withArrow>
        <ActionIcon
          variant="light"
          color="green"
          onClick={() => setOpened(true)}
          aria-label={t.tickets.openRecordings}
          data-testid="open-recordings"
        >
          <IconPlayerPlay size={18} />
        </ActionIcon>
      </Tooltip>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t.tickets.openRecordings} size="lg">
        <Stack gap="xs">
          {(list.data ?? []).map((r) => (
            <Paper key={r.id} withBorder p="xs">
              <Text size="sm">
                {fmtTime(r.createdAt)} · {String(r.fromNumber ?? '')} → {String(r.toNumber ?? '')}
                {r.agentName ? ` · ${String(r.agentName)}` : ''}
                {r.durationS ? ` · ${String(r.durationS)} ${t.tickets.sec}` : ''}
              </Text>
              {r.deletedAt ? (
                <Text size="xs" c="dimmed">
                  {t.tickets.recDeleted}
                </Text>
              ) : src[r.id] ? (
                <audio controls autoPlay src={src[r.id]} style={{ width: '100%' }} />
              ) : (
                <Button size="compact-xs" variant="light" mt={4} onClick={() => void play(r.id)}>
                  {t.tickets.listen}
                </Button>
              )}
            </Paper>
          ))}
          {list.data && !list.data.length && (
            <Text size="sm" c="dimmed">
              {t.tickets.noRecordings}
            </Text>
          )}
        </Stack>
      </Modal>
    </>
  );
}

/** Исправление сути — только с правом «Редактирование обращений 2-й линии». */
function EditSummary({ t: tk }: { t: Row }) {
  const [opened, setOpened] = useState(false);
  const [text, setText] = useState('');
  const req = useRequired();
  const save = useTicketAction(
    () => post(`/tickets/${tk.id}/edit`, { version: tk.version, summary: text }),
    t.saved,
    () => setOpened(false),
  );
  return (
    <>
      <Tooltip label={t.tickets.editSummary} withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          onClick={() => {
            setText(String(tk.summary ?? ''));
            req.reset();
            setOpened(true);
          }}
          aria-label={t.tickets.editSummary}
          data-testid="edit-summary"
        >
          <IconPencil size={18} />
        </ActionIcon>
      </Tooltip>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t.tickets.editSummary} size="lg">
        <Stack gap="xs">
          <Textarea
            label={t.tickets.sut.replace(':', '')}
            withAsterisk
            error={req.error(!text.trim())}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            autosize
            minRows={4}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpened(false)}>
              {t.cancel}
            </Button>
            <Button
              loading={save.isPending}
              onClick={() =>
                req.check(!text.trim() ? [t.tickets.sut.replace(':', '')] : []) && save.mutate(undefined)
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

/** Заметки по обращению: видны сразу (без открытия обращения), у каждой — фамилия автора; добавить может участник. */
function Notes({ t: tk }: { t: Row }) {
  const can = (tk.can as Record<string, boolean> | undefined) ?? {};
  const [text, setText] = useState('');
  const add = useTicketAction(
    () => post(`/tickets/${tk.id}/comments`, { body: text, attachmentIds: [] }),
    t.tickets.noteAdded,
    () => setText(''),
  );
  const notes = ((tk.comments as Row[]) ?? []).filter((c) => c.kind === 'comment');
  return (
    <Paper withBorder p="xs" mt="xs" data-testid="ticket-notes">
      <Text size="sm" fw={600} mb={4}>
        {t.tickets.notes} {notes.length ? `(${notes.length})` : ''}
      </Text>
      <Stack gap={4}>
        {notes.map((n) => (
          <Text size="sm" key={n.id} style={{ whiteSpace: 'pre-wrap' }}>
            <b>{surname(n.authorName)}</b>{' '}
            <Text span size="xs" c="dimmed">
              {fmtTime(n.createdAt)}
            </Text>
            : {String(n.body)}
          </Text>
        ))}
        {!notes.length && (
          <Text size="xs" c="dimmed">
            {t.tickets.noNotes}
          </Text>
        )}
      </Stack>
      {can.comment && (
        <Group gap="xs" mt="xs" align="flex-end" wrap="nowrap">
          <Textarea
            size="xs"
            style={{ flex: 1 }}
            placeholder={t.tickets.notePlaceholder}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            autosize
            minRows={1}
            data-testid="note-text"
          />
          <Button
            size="xs"
            loading={add.isPending}
            onClick={() =>
              text.trim()
                ? add.mutate(undefined)
                : notifications.show({ color: 'red', message: t.tickets.noteEmpty })
            }
            data-testid="note-add"
          >
            {t.add}
          </Button>
        </Group>
      )}
    </Paper>
  );
}

/**
 * Сведения об обращении: на виду — срок, тема, подтема, суть (справа — диалог и запись), ответственный, способ и
 * суть ответа, вина и меры, заметки. «Подробнее» раскрывает всё остальное по разделам: клиент, обращение,
 * участники, ответ и документы, комментарии, история.
 */
function TicketFacts({ t: tk }: { t: Row }) {
  const c = (tk.conversation as Row | null) ?? null;
  const can = (tk.can as Record<string, boolean> | undefined) ?? {};
  const fields = ((c?.fields as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const labels = new Map(((tk.fieldDefs as Row[]) ?? []).map((f) => [String(f.key), String(f.label)]));
  const assignees = ((tk.assignees as Row[]) ?? []).filter((a) => a.isActive);
  const names = (kind: string) =>
    assignees
      .filter((a) => a.kind === kind)
      .map((a) => String(a.fullName))
      .join(', ') || '—';
  const [topic, ...sub] = String(tk.topicName ?? '').split(' / ');
  const docs = ((tk.comments as Row[]) ?? []).flatMap((x) => ((x.attachments as Att[]) ?? []).map((a) => a));
  const answered = ['approval', 'closed'].includes(String(tk.status));
  const topicFields = Object.entries(fields).filter(
    ([k, v]) => !isCommonField(k) && v !== null && v !== undefined && v !== '',
  );
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
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Text size="sm" style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
          <b>{t.tickets.sut}</b> {String(tk.summary)}
        </Text>
        <Group gap={4} wrap="nowrap">
          {can.edit && <EditSummary t={tk} />}
          <DialogButton ticketId={String(tk.id)} />
          {Number(c?.recordings ?? 0) > 0 && <RecordingsButton ticketId={String(tk.id)} />}
        </Group>
      </Group>
      <Text size="sm">
        <b>{t.tickets.otvetstvennyy}</b> {names('responsible')}
      </Text>
      <Text size="sm">
        <b>{t.tickets.source}:</b> {CHANNEL_LABEL[String(c?.channelKind)] ?? String(c?.channelKind ?? '—')}
      </Text>
      {/* Пока ответа нет (новое, в работе, на доработке) — способ закрытия и суть ответа светлые. */}
      <Text size="sm" c={answered ? undefined : 'dimmed'} data-testid="answer-method-line">
        <b>{t.tickets.sposobZakrytiya}</b> {String(tk.answerMethodName ?? '—')}
      </Text>
      <Text size="sm" c={answered ? undefined : 'dimmed'} style={{ whiteSpace: 'pre-wrap' }}>
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
      <Notes t={tk} />
      <Accordion variant="contained" chevronPosition="left" mt={6}>
        <Accordion.Item value="more" data-testid="ticket-more">
          <Accordion.Control py={4} data-testid="ticket-more-toggle">
            <Text size="sm">{t.tickets.more}</Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Section title={t.tickets.secClient} testId="sec-client">
              <Line label={t.tickets.clientName} value={c?.displayName ?? tk.contactName} />
              <Line label={t.tickets.clientPhone} value={c?.phone} />
              <Line label="E-mail" value={c?.email} />
              {COMMON_FIELD_KEYS.map((k) => (
                <Line key={k} label={t.workspace.commonFields[k] ?? k} value={fields[k]} />
              ))}
            </Section>
            <Section title={t.tickets.secRequest} testId="sec-request">
              <Line
                label={t.tickets.source}
                value={CHANNEL_LABEL[String(c?.channelKind)] ?? c?.channelKind}
              />
              <Line label={t.tickets.receivedAt} value={fmtTime(c?.createdAt)} />
              <Line label={t.tickets.passedAt} value={fmtTime(tk.createdAt)} />
              <Line
                label={t.tickets.napravleno.replace(':', '')}
                value={`${String(tk.enterpriseName)} / ${String(tk.departmentName)}`}
              />
              <Line label={t.tickets.object} value={c?.objectName} />
              {tk.isImportant ? <Line label={t.tickets.osoboVazhnoe2} value={t.tickets.guiltYes} /> : null}
              {topicFields.map(([k, v]) => (
                <Line
                  key={k}
                  label={labels.get(k) ?? k}
                  value={typeof v === 'object' ? JSON.stringify(v) : v}
                />
              ))}
            </Section>
            <Section title={t.tickets.secPeople} testId="sec-people">
              <Line label={t.tickets.otvetstvennye2.replace(':', '')} value={names('responsible')} />
              <Line label={t.tickets.kuratory2.replace(':', '')} value={names('curator')} />
              <Line label={t.tickets.peredal.replace(':', '')} value={tk.creatorName} />
            </Section>
            <Section title={t.tickets.secAnswer} testId="sec-answer">
              <Line label={t.tickets.sposobOtveta} value={tk.answerMethodName} />
              <Line label={t.tickets.sutOtveta} value={tk.answerSummary} />
              <Line label={t.tickets.answeredAt} value={fmtTime(tk.answeredAt)} />
              {Number(tk.returnsCount) > 0 && <Line label={t.tickets.returns} value={tk.returnsCount} />}
              {docs.length > 0 && (
                <Group gap="xs">
                  <Text size="sm" fw={700}>
                    {t.tickets.docs}:
                  </Text>
                  {docs.map((a) => (
                    <Anchor key={a.id} size="sm" onClick={() => void openTicketFile(String(tk.id), a.id)}>
                      📎 {a.filename}
                    </Anchor>
                  ))}
                </Group>
              )}
            </Section>
            <Section title={t.tickets.secLinks} testId="sec-links">
              <Group gap="xs">
                <DialogButton ticketId={String(tk.id)} />
                <Text size="sm">{t.tickets.openDialog}</Text>
                {Number(c?.recordings ?? 0) > 0 && (
                  <>
                    <RecordingsButton ticketId={String(tk.id)} />
                    <Text size="sm">{t.tickets.openRecordings}</Text>
                  </>
                )}
              </Group>
            </Section>
            <Section title={t.tickets.kommentariiIDokumenty}>
              <Comments t={tk} />
            </Section>
            <Section title={t.tickets.istoriya}>
              <History items={(tk.history as Row[]) ?? []} />
            </Section>
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
