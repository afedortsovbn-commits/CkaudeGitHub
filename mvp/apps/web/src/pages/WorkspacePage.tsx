import {
  Accordion,
  Anchor,
  Badge,
  Box,
  Button,
  ActionIcon,
  Card,
  Checkbox,
  Collapse,
  FileButton,
  Grid,
  Group,
  Indicator,
  Menu,
  MultiSelect,
  Paper,
  Popover,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconFilter,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMap2,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { errorText, get, openAttachment, patch, post, recordingUrl, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, options, useAction, useList, useRequired } from '../lib/data';
import { notify, onRealtime, useRealtime } from '../lib/realtime';
import { setFocusMode } from '../lib/focus';
import { ExternalDataPanel } from './IvrAdminPages';
import { renderTemplate, SlashList, useSlashTemplates } from '../components/AssistPanel';
import { HintPanel } from '../components/HintPanel';
import { AzsMapModal, type Station, type StationKind, useStations } from '../components/AzsMap';
import { softphone, useSoftphone } from '../lib/softphone';
import { setDraft } from '../lib/app-version';
import { EscalateModal, SubstitutesPanel, TicketList, useTicketCount } from './TicketPages';
import { MergeContactModal } from '../components/MergeContactModal';
import { OrgPicker, TopicPicker } from '../components/DictPickers';
import { COMMON_FIELD_KEYS, isCommonField } from '../lib/common-fields';
import { t } from '../lib/i18n';
import { orderTabs } from '../lib/nav';

const CHANNEL: Record<string, string> = {
  webchat: t.workspace.sayt,
  app: t.workspace.prilozhenie,
  telegram: 'Telegram',
  email: 'Email',
  voice: t.workspace.zvonok,
  api: t.workspace.vneshnyayaSistema,
  review: t.reviews.channel,
};
const stars = (n: number) => `${'★'.repeat(n)}${'☆'.repeat(Math.max(0, 5 - n))}`;

interface ReviewInfo {
  id: string;
  platform: string;
  rating: number | null;
  author: string | null;
  url: string | null;
  publishedAt: string | null;
  locationId: string | null;
  locationCode: string | null;
  stationType?: string | null;
  emitent?: string | null;
}

/** Отзыв с карт (Ф13, M-CH-10): площадка, оценка, объект, автор, ссылка на отзыв; ответ публикуется на площадке. */
function ReviewPanel({ conv }: { conv: Row }) {
  const r = conv.review as ReviewInfo | null;
  if (!r) return null;
  const low = r.rating !== null && r.rating <= 2;
  return (
    <Paper withBorder p="xs" data-testid="review-panel">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs">
          <Badge variant="light">{t.reviews.platforms[r.platform] ?? r.platform}</Badge>
          {/* Оценку Rocket Data по описанию заказчика не передаёт — показывается, только если пришла. */}
          {r.rating ? (
            <Text
              c={low ? 'red' : 'yellow.7'}
              fw={700}
              data-testid="review-rating"
              title={t.reviews.ratingTitle(r.rating)}
            >
              {stars(r.rating)}
            </Text>
          ) : null}
        </Group>
        {r.url ? (
          <a href={r.url} target="_blank" rel="noreferrer" data-testid="review-link">
            {t.reviews.openOnPlatform}
          </a>
        ) : null}
      </Group>
      <Text size="xs" c="dimmed" mt={4}>
        {r.author ?? t.reviews.noAuthor}
        {r.publishedAt
          ? ` · ${new Date(r.publishedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}`
          : ''}
        {t.reviews.objectLabel}
        <span data-testid="review-object">
          {conv.objectName
            ? String(conv.objectName)
            : t.reviews.notMatched(r.locationCode ?? r.locationId ?? '—')}
        </span>
      </Text>
      {r.stationType || r.emitent ? (
        <Text size="xs" c="dimmed" data-testid="review-station">
          {t.reviews.station(
            [r.stationType, r.locationCode && `№${r.locationCode}`].filter(Boolean).join(' '),
            r.emitent ?? '',
          )}
        </Text>
      ) : null}
    </Paper>
  );
}
const STATUS: Record<string, string> = {
  bot: t.workspace.uBotaVIvr,
  offered: t.workspace.predlozheno,
  queued: t.workspace.vOcheredi,
  active: t.workspace.vRabote,
  closed: t.workspace.zakryto,
  hold: t.workspace.uderzhanie,
  waiting_customer: t.workspace.zhdemKlienta,
  waiting_2nd_line: t.workspace.na2YLinii,
};
const time = (s: unknown) =>
  s ? new Date(String(s)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
const since = (s: unknown) => {
  if (!s) return '';
  const min = Math.floor((Date.now() - new Date(String(s)).getTime()) / 60000);
  return min < 1
    ? t.workspace.tolkoChto
    : min < 60
      ? t.workspace.min(min)
      : t.workspace.chMin(Math.floor(min / 60), min % 60);
};

interface Att {
  id: string;
  filename: string;
  size: number;
}

/** Статус оператора (M-OP-04): переключение «Готов»/«Перерыв»/«Офлайн»; «Постобработка» — только показ и таймер. */
/** Число обращений во вкладке (для подписи вкладки). */
function useCount(tab: string): number {
  const q = useQuery({
    queryKey: [`/conversations?tab=${tab}`],
    queryFn: () => get<Row[]>(`/conversations?tab=${tab}`),
    refetchInterval: 30_000,
  });
  return q.data?.length ?? 0;
}

/** Полупрозрачный цвет слева, уходящий в прозрачность вправо (как в списке 2-й линии). */
const fade = (h: number, s: number, l: number, a: number) =>
  `linear-gradient(90deg, hsla(${h}, ${s}%, ${l}%, ${a}) 0%, hsla(${h}, ${s}%, ${l}%, 0) 60%)`;
/**
 * Стадия обращения в списке: красные — идёт общение с клиентом (или предложено — клиент ждёт), жёлтые — общение
 * завершено, а карточка не закрыта. Они всегда сверху.
 */
const STAGE: Record<string, { rank: number; bg: string; hint: string }> = {
  offered: { rank: 0, bg: fade(0, 85, 62, 0.13), hint: t.workspace.stageOffered },
  talk: { rank: 0, bg: fade(0, 85, 62, 0.11), hint: t.workspace.stageTalk },
  wrapup: { rank: 1, bg: fade(45, 95, 55, 0.16), hint: t.workspace.stageWrapup },
};
const stageOf = (c: Row): string | null =>
  c.status === 'offered' ? 'offered' : ((c.stage as string | null | undefined) ?? null);

function List({
  tab,
  selected,
  onSelect,
  onTaken,
  important,
  callback,
}: {
  tab: string;
  selected: string | null;
  onSelect(id: string): void;
  /** Обращение взято в работу или принято — открыть его в режиме обработки. */
  onTaken(id: string): void;
  important: boolean;
  callback: boolean;
}) {
  const { me } = useAuth();
  const list = useList(
    `/conversations?tab=${tab}${important ? '&important=true' : ''}${callback ? '&callback=true' : ''}`,
  );
  // Необработанные — сверху (порядок внутри группы — как пришёл с сервера).
  const rows = useMemo(
    () =>
      (list.data ?? [])
        .map((c, i) => ({ c, i, rank: STAGE[stageOf(c) ?? '']?.rank ?? 2 }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map((x) => x.c),
    [list.data],
  );
  const take = useAction((id: string) => post(`/conversations/${id}/take`), t.workspace.dialogVzyatVRabotu);
  const accept = useAction(
    (id: string) => post(`/conversations/${id}/accept`),
    t.workspace.obrashcheniePrinyato,
  );
  const decline = useAction(
    (id: string) => post(`/conversations/${id}/decline`),
    t.workspace.obrashchenieOtkloneno,
  );
  return (
    <Stack gap={6}>
      {rows.length === 0 && (
        <Text c="dimmed" size="sm" ta="center" mt="md">
          {t.workspace.netObrashcheniy}
        </Text>
      )}
      {rows.map((c) => {
        const stage = STAGE[stageOf(c) ?? ''];
        const urgent = !!c.isUrgent && c.status !== 'closed';
        return (
          <Card
            key={c.id}
            withBorder
            padding="xs"
            title={stage?.hint}
            className={urgent ? 'cc-urgent' : undefined}
            data-urgent={urgent || undefined}
            style={{
              cursor: 'pointer',
              borderColor: selected === c.id ? 'var(--mantine-color-blue-5)' : undefined,
              boxShadow: selected === c.id ? '0 0 0 1px var(--mantine-color-blue-5)' : undefined,
              background: stage ? `${stage.bg}, var(--mantine-color-body)` : undefined,
            }}
            onClick={() => onSelect(c.id)}
            data-testid="conv-item"
            data-stage={stageOf(c) ?? undefined}
          >
            <Group justify="space-between" wrap="nowrap">
              <Text fw={600} size="sm" truncate>
                {String(c.contactName)}
              </Text>
              <Text size="xs" c="dimmed">
                {tab === 'queue' ? since(c.createdAt) : time(c.lastMessageAt)}
              </Text>
            </Group>
            <Text size="xs" c="dimmed" lineClamp={2}>
              {c.lastDirection === 'out' ? t.workspace.vy : ''}
              {String(c.lastMessage ?? '')}
            </Text>
            <Group gap={4} mt={4}>
              <Badge size="xs" variant="light">
                {CHANNEL[String(c.channelKind)] ?? String(c.channelKind)}
              </Badge>
              {c.reviewRating ? (
                <Badge size="xs" variant="outline" color={Number(c.reviewRating) <= 2 ? 'red' : 'yellow'}>
                  {stars(Number(c.reviewRating))}
                </Badge>
              ) : null}
              {c.isImportant ? (
                <Badge size="xs" color="red">
                  {t.workspace.osoboVazhnoe}
                </Badge>
              ) : null}
              {c.isUrgent ? (
                <Badge
                  size="xs"
                  color="red"
                  variant="filled"
                  className={urgent ? 'cc-urgent-blink' : undefined}
                  data-testid="badge-urgent"
                >
                  {t.workspace.urgentBadge}
                </Badge>
              ) : null}
              {c.callbackRequested ? (
                <Badge size="xs" color="grape" data-testid="badge-callback">
                  {t.workspace.perezvonit}
                </Badge>
              ) : null}
              {c.topicName ? (
                <Badge size="xs" variant="outline">
                  {String(c.topicName)}
                </Badge>
              ) : null}
              {c.status === 'offered' ? (
                <Badge size="xs" color="blue">
                  {t.workspace.predlozheno2}
                </Badge>
              ) : null}
              {tab !== 'mine' && c.assigneeName ? (
                <Badge size="xs" color="gray">
                  {String(c.assigneeName)}
                </Badge>
              ) : null}
            </Group>
            {tab === 'queue' && (
              <Button
                size="compact-xs"
                mt={6}
                data-testid="take"
                onClick={(e) => {
                  e.stopPropagation();
                  take.mutate(c.id, { onSuccess: () => onTaken(c.id) });
                }}
              >
                {t.workspace.vzyat}
              </Button>
            )}
            {c.status === 'offered' && c.assigneeId === me?.id && (
              <Group gap={4} mt={6}>
                <Button
                  size="compact-xs"
                  color="green"
                  data-testid="accept"
                  onClick={(e) => {
                    e.stopPropagation();
                    accept.mutate(c.id, { onSuccess: () => onTaken(c.id) });
                  }}
                >
                  {t.workspace.prinyat}
                </Button>
                <Button
                  size="compact-xs"
                  variant="light"
                  color="red"
                  data-testid="decline"
                  onClick={(e) => {
                    e.stopPropagation();
                    decline.mutate(c.id);
                  }}
                >
                  {t.workspace.otklonit}
                </Button>
              </Group>
            )}
          </Card>
        );
      })}
    </Stack>
  );
}

/** Подпись автоматического сообщения (Ф7): бот или правило автоответа. */
function autoLabel(m: Row): string {
  const meta = m.meta as { auto?: string; external?: string } | undefined;
  if (!meta?.auto) return '';
  if (meta.auto === 'bot') return meta.external ? t.workspace.vneshniyBot(meta.external) : t.workspace.bot;
  return t.workspace.avtootvet;
}

/** Отзыв (Ф13): оценка этой редакции и отметка «изменён автором». */
function reviewNote(m: Row): string {
  const r = (m.meta as { review?: { rating: number | null; edited?: boolean } } | undefined)?.review;
  if (!r) return '';
  return `${r.rating ? ` · ${stars(r.rating)}` : ''}${r.edited ? t.reviews.edited : ''}`;
}

/** Автор заметки: сотрудник, внешняя система (ключ API, Ф9) или система. */
function noteAuthor(m: Row): string {
  const ext = (m.meta as { external?: string } | undefined)?.external;
  if (ext) return t.workspace.vneshnyayaSistema2(ext);
  return String(m.authorName ?? t.workspace.sistema);
}

/** Доставка ответа во внешний канал (Telegram, email): ставится в очередь → отправлено / ошибка. */
function Delivery({ m }: { m: Row }) {
  if (m.deliveryStatus === 'sent')
    return (
      <span data-testid="delivery-sent" title={t.workspace.otpravlenoKlientu}>
        {' '}
        {t.workspace.otpravleno}
      </span>
    );
  if (m.deliveryStatus === 'failed')
    return (
      <span data-testid="delivery-failed" style={{ color: 'var(--mantine-color-red-7)' }}>
        {' '}
        {t.workspace.neDostavleno}
        {m.deliveryError ? `: ${String(m.deliveryError)}` : ''}
      </span>
    );
  if (m.deliveryStatus === 'pending')
    return <span data-testid="delivery-pending">{t.workspace.otpravlyaetsya}</span>;
  return null;
}

/** Пауза в переписке больше 3 часов — новая сессия (разделитель с датой). */
const SESSION_GAP_MS = 3 * 3600_000;
const when = (s: unknown) =>
  new Date(String(s)).toLocaleString('ru-RU', {
    timeZone: 'Europe/Minsk',
    dateStyle: 'short',
    timeStyle: 'short',
  });

function Divider2({
  label,
  color = 'gray',
  right,
}: {
  label: string;
  color?: string;
  right?: React.ReactNode;
}) {
  return (
    <Group gap={6} wrap="nowrap" my={4} data-testid="msg-divider">
      <Box style={{ flex: 1, borderTop: `1px dashed var(--mantine-color-${color}-4)` }} />
      <Text size="xs" c={`${color}.7`} fw={600}>
        {label}
      </Text>
      {right}
      <Box style={{ flex: 1, borderTop: `1px dashed var(--mantine-color-${color}-4)` }} />
    </Group>
  );
}

/** Предыдущие обращения клиента: свёрнуты, со статусом; по щелчку — переписка (бледнее текущей). */
function PrevConversations({ convId, render }: { convId: string; render(m: Row): React.ReactNode }) {
  const list = useList(`/conversations/${convId}/history`);
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <>
      {(list.data ?? []).map((c) => {
        const status =
          c.status !== 'closed'
            ? t.workspace.prevOpen
            : !c.answered
              ? t.workspace.prevNoAnswer
              : t.workspace.prevDone(String(c.dispositionName ?? ''));
        const isOpen = open.has(c.id);
        return (
          <Box key={c.id} data-testid="prev-conv">
            <Divider2
              label={`${t.workspace.prevConv(when(c.createdAt))} · ${status}`}
              color={c.status === 'closed' && c.answered ? 'gray' : 'orange'}
              right={
                <Anchor
                  size="xs"
                  onClick={() => {
                    const next = new Set(open);
                    if (isOpen) next.delete(c.id);
                    else next.add(c.id);
                    setOpen(next);
                  }}
                  data-testid="prev-conv-toggle"
                >
                  {isOpen ? t.workspace.prevHide : t.workspace.prevShow}
                </Anchor>
              }
            />
            {isOpen && (
              <Stack gap={6} style={{ opacity: 0.6 }}>
                {((c.messages as Row[]) ?? []).map((m) => render(m))}
              </Stack>
            )}
          </Box>
        );
      })}
    </>
  );
}

function Messages({ conv, typing, onTyping }: { conv: Row; typing: boolean; onTyping(): void }) {
  const { me, can } = useAuth();
  const msgs = useList(`/conversations/${conv.id}/messages`);
  const [text, setText] = useState('');
  const [noteMode, setNote] = useState(false);
  // Подсказка оператору (Ф14): супервизор пишет скрытое сообщение в чужом обращении — клиенту не уходит.
  const canHint =
    can('conversations.hint') &&
    !!conv.assigneeId &&
    conv.assigneeId !== me?.id &&
    ['active', 'offered'].includes(String(conv.status));
  const [hintMode, setHint] = useState(false);
  const hint = hintMode && canHint;
  const [hintsOpen, setHintsOpen] = useState(false);
  // Звонок: писать клиенту некуда — поле ответа работает как внутренняя заметка, главное место у подсказок.
  const voice = conv.channelKind === 'voice';
  const note = noteMode || hint || voice;
  const [files, setFiles] = useState<Att[]>([]);
  const [busy, setBusy] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  useEffect(() => {
    // Открыто обращение или пришло новое — показать последнее сообщение (после отрисовки, иначе высота ещё старая).
    // scrollTo в новых браузерах возвращает Promise — из эффекта его возвращать нельзя (React ждёт функцию очистки).
    const toEnd = () => {
      viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
    };
    toEnd();
    const r = requestAnimationFrame(() => requestAnimationFrame(toEnd));
    return () => cancelAnimationFrame(r);
  }, [msgs.data, typing, conv.id]);
  // Неотправленный ответ откладывает автообновление интерфейса до новой версии (Ф11, M-OP-11).
  const dirty = !!text.trim() || files.length > 0;
  useEffect(() => {
    setDraft(`reply:${String(conv.id)}`, dirty);
    return () => setDraft(`reply:${String(conv.id)}`, false);
  }, [conv.id, dirty]);
  const canWrite = note
    ? conv.status !== 'closed'
    : conv.assigneeId === me?.id && ['active', 'hold'].includes(String(conv.status));
  const slash = useSlashTemplates(text, String(conv.channelKind));
  const lastInSeq = Math.max(
    0,
    ...(msgs.data ?? []).filter((m) => m.direction === 'in').map((m) => Number(m.seq)),
  );
  const pickTemplate = (r: Row) => {
    setText(renderTemplate(String(r.body), conv, me?.fullName ?? ''));
    void post(`/templates/${r.id}/used`).catch(() => undefined);
  };
  const send = async () => {
    if (!text.trim() && !files.length) return;
    setBusy(true);
    try {
      if (hint) await post(`/conversations/${conv.id}/hint`, { body: text.trim() });
      else
        await post(`/conversations/${conv.id}/messages`, {
          body: text.trim(),
          attachmentIds: files.map((f) => f.id),
          note,
        });
      setText('');
      setFiles([]);
      void qc.invalidateQueries({ queryKey: [`/conversations/${conv.id}/messages`] });
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const pickTopic = (topicId: string) =>
    void patch(`/conversations/${conv.id}`, { topicId })
      .then(() =>
        qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/conversations') }),
      )
      .catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }));
  /** Одно сообщение переписки (и в текущем, и в предыдущих обращениях). */
  const renderMsg = (m: Row): React.ReactNode => {
    const isHint = !!(m.meta as { hint?: boolean } | undefined)?.hint;
    const dir = isHint ? 'hint' : String(m.direction);
    const style =
      dir === 'hint'
        ? { alignSelf: 'flex-end', background: 'var(--mantine-color-grape-1)' }
        : dir === 'in'
          ? { alignSelf: 'flex-start', background: 'var(--mantine-color-gray-1)' }
          : dir === 'out'
            ? { alignSelf: 'flex-end', background: 'var(--mantine-color-blue-1)' }
            : dir === 'note'
              ? { alignSelf: 'flex-end', background: 'var(--mantine-color-yellow-1)' }
              : { alignSelf: 'center', background: 'transparent' };
    return (
      <Paper
        key={m.id}
        p={dir === 'system' ? 0 : 'xs'}
        radius="md"
        maw="75%"
        style={style}
        data-testid={`msg-${dir}`}
      >
        {dir !== 'system' && (
          <Text size="xs" c="dimmed">
            {dir === 'in'
              ? `${String(conv.contactName)}${reviewNote(m)}`
              : dir === 'note'
                ? t.workspace.zametka(noteAuthor(m))
                : dir === 'hint'
                  ? t.workspace.podskazkaSupervizora(String(m.authorName ?? ''))
                  : autoLabel(m) || String(m.authorName ?? '')}{' '}
            · {time(m.sentAt)}
            {dir === 'out' && <Delivery m={m} />}
          </Text>
        )}
        <Text
          size={dir === 'system' ? 'xs' : 'sm'}
          c={dir === 'system' ? 'dimmed' : undefined}
          style={{ whiteSpace: 'pre-wrap' }}
        >
          {String(m.body)}
        </Text>
        {((m.meta as { buttons?: { id: string; label: string }[] } | undefined)?.buttons ?? []).length >
          0 && (
          <Group gap={4} mt={4}>
            {(m.meta as { buttons: { id: string; label: string }[] }).buttons.map((b) => (
              <Badge key={b.id} variant="outline" size="sm">
                {b.label}
              </Badge>
            ))}
          </Group>
        )}
        {(m.attachments as Att[]).map((a) => (
          <Text
            key={a.id}
            size="sm"
            c="blue"
            style={{ cursor: 'pointer' }}
            onClick={() => void openAttachment(a.id)}
          >
            📎 {a.filename} ({Math.ceil(a.size / 1024)}
            {t.workspace.kb}
          </Text>
        ))}
      </Paper>
    );
  };
  const showHints = conv.status !== 'closed' && (voice || (!note && canWrite));
  // Звонок: заметка — в правой колонке под сутью; здесь — ход разговора и подсказки (свёрнуты по умолчанию).
  const height = voice
    ? hintsOpen
      ? 140
      : 'calc(100vh - 210px)'
    : showHints
      ? hintsOpen
        ? 'calc(50vh - 110px)'
        : 'calc(100vh - 375px)'
      : 'calc(100vh - 330px)';
  return (
    <Stack h="100%" gap="xs">
      <ScrollArea h={height} viewportRef={viewport} type="auto">
        <Stack gap={6} p="xs" data-testid="messages">
          <PrevConversations convId={String(conv.id)} render={(m) => renderMsg(m)} />
          {(msgs.data ?? []).length > 0 && (
            <Divider2 label={t.workspace.currentConv(when((msgs.data ?? [])[0]!.sentAt))} color="blue" />
          )}
          {(msgs.data ?? []).map((m, i, all) => {
            const gap =
              i > 0 &&
              new Date(String(m.sentAt)).getTime() - new Date(String(all[i - 1]!.sentAt)).getTime() >
                SESSION_GAP_MS;
            return (
              <Fragment key={m.id}>
                {gap && <Divider2 label={t.workspace.newSession(when(m.sentAt))} />}
                {renderMsg(m)}
              </Fragment>
            );
          })}
        </Stack>
      </ScrollArea>
      {typing && (
        <Text size="xs" c="dimmed">
          {t.workspace.klientPechataet}
        </Text>
      )}
      {conv.status === 'closed' ? (
        <Text c="dimmed" size="sm">
          {t.workspace.obrashchenieZakryto}
        </Text>
      ) : !note && conv.status === 'offered' && conv.assigneeId === me?.id ? (
        <Text c="dimmed" size="sm">
          {t.workspace.primitePredlozhennoeObrashchenieChto}
        </Text>
      ) : !note && conv.assigneeId !== me?.id ? (
        <Text c="dimmed" size="sm">
          {t.workspace.vozmiteObrashchenieChtobyOtvetit}
        </Text>
      ) : null}
      {showHints && (
        <HintPanel
          conv={conv}
          lastInSeq={lastInSeq}
          voice={voice}
          canInsert={!voice && canWrite}
          height={voice ? 'calc(100vh - 400px)' : 'calc(30vh)'}
          opened={hintsOpen}
          onOpenChange={setHintsOpen}
          onPickTopic={pickTopic}
          onInsert={(t, sg) => {
            setNote(false);
            setText(t);
            if (sg?.type === 'template' && sg.refId)
              void post(`/templates/${sg.refId}/used`).catch(() => undefined);
          }}
        />
      )}
      {!voice && slash.open && <SlashList items={slash.items} onPick={pickTemplate} />}
      {!voice && (
        <>
          <Group gap={4}>
            {files.map((f) => (
              <Badge
                key={f.id}
                variant="light"
                rightSection={
                  <span
                    style={{ cursor: 'pointer' }}
                    onClick={() => setFiles(files.filter((x) => x.id !== f.id))}
                  >
                    ×
                  </span>
                }
              >
                {f.filename}
              </Badge>
            ))}
          </Group>
          <Group align="flex-end" gap="xs">
            <Textarea
              style={{ flex: 1 }}
              autosize
              minRows={2}
              maxRows={6}
              placeholder={
                hint
                  ? t.workspace.podskazkaOperatoruPlaceholder
                  : note
                    ? t.workspace.vnutrennyayaZametkaKlientEe
                    : conv.channelKind === 'review'
                      ? t.reviews.replyPlaceholder
                      : t.workspace.otvetKlientuShablonyEnter
              }
              value={text}
              data-testid="reply"
              onChange={(e) => {
                setText(e.currentTarget.value);
                if (!note) onTyping();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  // «/код» + Enter — подставить первый найденный шаблон, а не отправлять.
                  if (slash.open) {
                    if (slash.items[0]) pickTemplate(slash.items[0]);
                    return;
                  }
                  if (canWrite) void send();
                }
              }}
            />
            <Stack gap={4}>
              <FileButton
                onChange={async (f) => {
                  if (!f) return;
                  try {
                    setFiles([...files, await upload<Att>('/attachments', f)]);
                  } catch (e) {
                    notifications.show({ color: 'red', message: errorText(e) });
                  }
                }}
              >
                {(props) => (
                  <Button
                    {...props}
                    variant="default"
                    size="xs"
                    data-testid="attach"
                    disabled={hint || (!note && conv.channelKind === 'review')}
                  >
                    {t.workspace.fayl}
                  </Button>
                )}
              </FileButton>
              <Button
                size="xs"
                onClick={() => void send()}
                loading={busy}
                disabled={!canWrite}
                data-testid="send"
              >
                {t.workspace.otpravit}
              </Button>
            </Stack>
          </Group>
          <Group gap="md">
            <Switch
              size="xs"
              label={t.workspace.vnutrennyayaZametka}
              checked={noteMode && !hint}
              onChange={(e) => {
                setNote(e.currentTarget.checked);
                if (e.currentTarget.checked) setHint(false);
              }}
            />
            {canHint && (
              <Switch
                size="xs"
                color="grape"
                label={t.workspace.podskazkaOperatoru}
                checked={hint}
                onChange={(e) => {
                  setHint(e.currentTarget.checked);
                  if (e.currentTarget.checked) setNote(false);
                }}
                data-testid="hint-mode"
              />
            )}
          </Group>
        </>
      )}
    </Stack>
  );
}

function ContactCard({ conv, onOpen }: { conv: Row; onOpen(id: string): void }) {
  const { me, can } = useAuth();
  const [merging, setMerging] = useState(false);
  const c = useQuery({
    queryKey: [`/contacts/${conv.contactId}`],
    queryFn: () => get<Row>(`/contacts/${conv.contactId}`),
  });
  const history = useList(`/contacts/${conv.contactId}/conversations`);
  // Звонки прошлых обращений — по щелчку; у текущего обращения видны сразу.
  const [callsOpen, setCallsOpen] = useState<Set<string>>(new Set());
  useEffect(() => setCallsOpen(new Set()), [conv.id]);
  const [v, setV] = useState<Record<string, string>>({});
  useEffect(() => {
    if (c.data)
      setV({
        displayName: String(c.data.displayName ?? ''),
        phone: String(c.data.phone ?? ''),
        email: String(c.data.email ?? ''),
      });
  }, [c.data]);
  const save = useAction(() =>
    patch(`/contacts/${conv.contactId}`, {
      displayName: v.displayName || null,
      phone: v.phone || null,
      email: v.email || null,
    }),
  );
  return (
    <Stack gap="xs">
      <TextInput
        size="xs"
        label={t.workspace.imya}
        value={v.displayName ?? ''}
        onChange={(e) => setV({ ...v, displayName: e.currentTarget.value })}
      />
      <TextInput
        size="xs"
        label={t.workspace.telefon}
        value={v.phone ?? ''}
        onChange={(e) => setV({ ...v, phone: e.currentTarget.value })}
      />
      {v.phone && (
        <Button
          size="xs"
          variant="light"
          color="green"
          onClick={() => void softphone.call(v.phone!, conv.assigneeId === me?.id ? String(conv.id) : null)}
          data-testid="contact-call"
        >
          {t.workspace.pozvonit}
          {v.phone}
        </Button>
      )}
      <TextInput
        size="xs"
        label="Email"
        value={v.email ?? ''}
        onChange={(e) => setV({ ...v, email: e.currentTarget.value })}
      />
      <Group grow>
        <Button size="xs" variant="light" onClick={() => save.mutate(undefined)}>
          {t.workspace.sokhranitKlienta}
        </Button>
        {can('contacts.merge') && c.data && (
          <Button
            size="xs"
            variant="light"
            color="orange"
            onClick={() => setMerging(true)}
            data-testid="contact-merge"
          >
            {t.workspace.obedinitS}
          </Button>
        )}
      </Group>
      {c.data && <MergeContactModal contact={c.data} opened={merging} onClose={() => setMerging(false)} />}
      {((c.data?.consents as Row[] | undefined) ?? []).slice(0, 1).map((k) => (
        <Text size="xs" c="dimmed" key="consent" data-testid="contact-consent">
          {t.workspace.soglasieNaObrabotkuPdn}
          {String(k.textVersion)}
          {t.workspace.ot} {new Date(String(k.acceptedAt)).toLocaleDateString('ru-RU')} (
          {String(k.channelName)})
        </Text>
      ))}
      <ExternalDataPanel contactId={String(conv.contactId)} conversationId={String(conv.id)} />
      <Title order={6} mt="sm">
        {t.workspace.istoriyaObrashcheniy}
        {history.data?.length ?? 0})
      </Title>
      <Stack gap={4} data-testid="history">
        {(history.data ?? []).map((h) => {
          const current = h.id === conv.id;
          const voice = h.channelKind === 'voice';
          const open = current || callsOpen.has(h.id);
          return (
            <Box key={h.id}>
              <Text
                size="xs"
                style={{ cursor: 'pointer' }}
                fw={current ? 700 : 400}
                onClick={() => onOpen(h.id)}
              >
                {new Date(String(h.createdAt)).toLocaleDateString('ru-RU')} ·{' '}
                {CHANNEL[String(h.channelKind)] ?? String(h.channelKind)} ·{' '}
                {STATUS[String(h.status)] ?? String(h.status)}
                {h.topicName ? ` · ${String(h.topicName)}` : ''}
                {current ? ` · ${t.workspace.historyCurrent}` : ''}
                {voice && !current && (
                  <Anchor
                    size="xs"
                    ml={6}
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = new Set(callsOpen);
                      if (open) next.delete(h.id);
                      else next.add(h.id);
                      setCallsOpen(next);
                    }}
                    data-testid="history-calls-toggle"
                  >
                    {open ? t.workspace.historyHideCalls : t.workspace.zvonki}
                  </Anchor>
                )}
              </Text>
              {open && <CallsPanel convId={String(h.id)} />}
            </Box>
          );
        })}
      </Stack>
    </Stack>
  );
}

/**
 * Поля обращения, которых нет среди полей темы: записаны внешней системой (результат анализа по API, данные
 * формы внешнего канала, Ф9) — только чтение.
 */
function ExtraFields({ fields, defined }: { fields: Record<string, unknown>; defined: Row[] }) {
  const keys = new Set(defined.map((f) => String(f.key)));
  const extra = Object.entries(fields).filter(([k, v]) => !keys.has(k) && v !== null && v !== '');
  if (!extra.length) return null;
  return (
    <Paper withBorder p={6} data-testid="extra-fields">
      <Text size="xs" c="dimmed">
        {t.workspace.dannyeVneshnikhSistem}
      </Text>
      {extra.map(([k, v]) => (
        <Text size="xs" key={k} data-testid={`extra-field-${k}`}>
          <b>{k}:</b> {typeof v === 'object' ? JSON.stringify(v) : String(v)}
        </Text>
      ))}
    </Paper>
  );
}

/** Суть обращения — отдельное поле сразу под темой: его оператор заполняет всегда. */
const SUMMARY_KEY = 'issue_summary';
/** Логические блоки полей карточки: поле попадает в блок по ключу, остальные поля темы — в «Обращение». */
const BLOCK_KEYS: Record<string, string[]> = {
  client: ['client_name', 'client_phone', 'feedback_channel', 'company_name'],
  cards: ['bonus_card', 'fuel_card', 'contract_no', 'contract_office'],
  azs: ['azs_number', 'azs_region', 'ezs_station'],
};
/** Поля, свёрнутые по умолчанию, даже если тема требует их для 2-й линии (видны, когда обязательны сейчас). */
const COLLAPSED_KEYS = ['company_name', 'fuel_card'];
/** Поля, которые больше не показываются (могли остаться в старых обращениях). */
const RETIRED_KEYS = ['eq_number', 'in_faq'];
const BLOCK_ORDER = ['issue', 'client', 'cards', 'azs'];
const blockOf = (k: string) => Object.keys(BLOCK_KEYS).find((b) => BLOCK_KEYS[b]!.includes(k)) ?? 'issue';
/** Сколько полей в свёрнутом блоке АЗС без полей темы: предприятие и номер АЗС. */
const AZS_PICKER_FIELDS = 2;

/** Область АЗС по предприятию-владельцу (Минскавтозаправка — по адресу: город Минск или область). */
function azsRegion(enterprise: string, address: string): string | null {
  if (enterprise.includes(t.workspace.azsMinskAuto))
    return address.includes(t.workspace.azsMinskCity) ? t.workspace.azsMinskCity : t.workspace.azsMinskRegion;
  return t.workspace.azsRegionByEnterprise.find(([k]) => enterprise.includes(k))?.[1] ?? null;
}

/** Заметка к звонку — в правой колонке под сутью (клиент её не видит). */
function CallNote({ conv }: { conv: Row }) {
  const [text, setText] = useState('');
  // По умолчанию свёрнута — одна строка-ссылка; раскрывается плавно, курсор сразу в поле.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setText('');
    setOpen(false);
  }, [conv.id]);
  const dirty = !!text.trim();
  useEffect(() => {
    setDraft(`note:${String(conv.id)}`, dirty);
    return () => setDraft(`note:${String(conv.id)}`, false);
  }, [conv.id, dirty]);
  const save = useAction(
    () => post(`/conversations/${conv.id}/messages`, { body: text.trim(), attachmentIds: [], note: true }),
    t.workspace.callNoteSaved,
  );
  const submit = () => {
    if (dirty) save.mutate(undefined, { onSuccess: () => setText('') });
  };
  if (conv.status === 'closed') return null;
  const shown = open || dirty;
  return (
    <Box>
      <Anchor
        size="xs"
        fw={600}
        onClick={() => setOpen(!shown)}
        data-testid="call-note-toggle"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
      >
        {t.workspace.callNote}
        <IconChevronDown
          size={14}
          style={{ transition: 'transform 200ms ease', transform: shown ? 'rotate(180deg)' : 'none' }}
        />
      </Anchor>
      <Collapse in={shown} transitionDuration={240}>
        <Box pt={4} className={shown ? 'cc-reveal' : undefined}>
          <CallNoteInput
            text={text}
            setText={setText}
            submit={submit}
            dirty={dirty}
            pending={save.isPending}
            focus={open}
          />
        </Box>
      </Collapse>
    </Box>
  );
}

function CallNoteInput({
  text,
  setText,
  submit,
  dirty,
  pending,
  focus,
}: {
  text: string;
  setText(v: string): void;
  submit(): void;
  dirty: boolean;
  pending: boolean;
  focus: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <Box>
      <Textarea
        ref={ref}
        size="xs"
        placeholder={t.workspace.callNotePlaceholder}
        autosize
        minRows={2}
        maxRows={5}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        data-testid="call-note"
      />
      <Group justify="flex-end" mt={4}>
        <Button
          size="compact-xs"
          variant="light"
          onClick={submit}
          disabled={!dirty}
          loading={pending}
          data-testid="call-note-save"
        >
          {t.workspace.saveNote}
        </Button>
      </Group>
    </Box>
  );
}

/** Что выбирается в карточке по теме: своя настройка темы, иначе — родительской; по умолчанию — только АЗС. */
function kindsFor(topicId: unknown, topics: Row[] | undefined): StationKind[] {
  const byId = new Map((topics ?? []).map((x) => [String(x.id), x]));
  for (
    let x = byId.get(String(topicId ?? ''));
    x;
    x = x.parentId ? byId.get(String(x.parentId)) : undefined
  ) {
    const k = ((x.objectKinds as string[] | null) ?? []).filter(
      (v): v is StationKind => v === 'azs' || v === 'ezs',
    );
    if (k.length) return k;
  }
  return ['azs'];
}

/**
 * Объект обращения — АЗС или ЭЗС (что разрешено темой). АЗС: предприятие-владелец (из списка) и номер (только
 * цифры) — по ним находится АЗС и её адрес. ЭЗС: поиск по названию и адресу. И то и другое — щелчком на карте.
 * Выбор АЗС заполняет и поля темы «№ и адрес АЗС», «Область нахождения АЗС».
 */
function StationPicker({
  conv,
  kinds,
  closed,
  onPick,
  onOrg,
}: {
  conv: Row;
  kinds: StationKind[];
  closed: boolean;
  onPick(s: Station): void;
  onOrg(enterpriseId: string | null, departmentId: string | null): void;
}) {
  const { stations } = useStations();
  const [mapOpen, setMapOpen] = useState(false);
  const cur = stations.find((s) => String(s.obj.id) === String(conv.objectId ?? ''));
  // Вид: как у выбранного объекта, если тема его разрешает; иначе — первый разрешённый.
  const [kind, setKind] = useState<StationKind>(kinds[0]!);
  const kindsKey = kinds.join();
  useEffect(() => {
    setKind(cur && kinds.includes(cur.kind) ? cur.kind : kinds[0]!);
  }, [conv.id, cur?.kind, kindsKey]);
  const [num, setNum] = useState('');
  useEffect(() => setNum(cur?.kind === 'azs' ? cur.num : ''), [conv.id, cur?.num, cur?.kind]);
  const [problem, setProblem] = useState('');
  useEffect(() => setProblem(''), [conv.id, kind]);
  const azs = stations.filter((s) => s.kind === 'azs');
  const ezsOptions = useMemo(
    () =>
      stations
        .filter((s) => s.kind === 'ezs')
        .map((s) => ({ value: String(s.obj.id), label: `${s.title}${s.address ? ` — ${s.address}` : ''}` })),
    [stations],
  );
  const find = () => {
    if (!num || (cur?.kind === 'azs' && num === cur.num)) return;
    const all = azs.filter((s) => s.num === num);
    const own = conv.enterpriseId ? all.filter((s) => s.obj.enterpriseId === conv.enterpriseId) : all;
    if (own.length === 1) {
      setProblem('');
      onPick(own[0]!);
    } else if (!all.length) setProblem(t.workspace.azsNotFoundAny(num));
    else if (!own.length) setProblem(t.workspace.azsNotFound(num));
    else setProblem(t.workspace.azsMany(num, own.length));
  };
  const mapButton = (
    <Button
      size="xs"
      variant="light"
      color={kind === 'ezs' ? 'green' : 'blue'}
      leftSection={<IconMap2 size={16} />}
      onClick={() => setMapOpen(true)}
      disabled={closed}
      data-testid="azs-map-open"
    >
      {t.workspace.azsMapOpen}
    </Button>
  );
  return (
    <Stack gap={6}>
      {kinds.length > 1 && (
        <SegmentedControl
          size="xs"
          data={kinds.map((k) => ({ value: k, label: t.org.objectKinds[k] ?? k }))}
          value={kind}
          onChange={(v) => setKind(v as StationKind)}
          disabled={closed}
          data-testid="station-kind"
        />
      )}
      <OrgPicker
        enterpriseId={(conv.enterpriseId as string) ?? null}
        departmentId={(conv.departmentId as string) ?? null}
        onChange={onOrg}
        clearable
        disabled={closed}
        testId="org"
      />
      {kind === 'azs' ? (
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            label={t.workspace.azsNumber}
            placeholder={t.workspace.azsNumberPlaceholder}
            inputMode="numeric"
            value={num}
            onChange={(e) => {
              setNum(e.currentTarget.value.replace(/\D/g, ''));
              setProblem('');
            }}
            onBlur={find}
            onKeyDown={(e) => e.key === 'Enter' && find()}
            disabled={closed}
            error={problem || undefined}
            data-testid="azs-number"
          />
          {mapButton}
        </Group>
      ) : (
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <Select
            size="xs"
            style={{ flex: 1 }}
            label={t.workspace.ezsStation}
            placeholder={t.workspace.ezsStationPlaceholder}
            data={ezsOptions}
            value={cur?.kind === 'ezs' ? String(cur.obj.id) : null}
            onChange={(v) => {
              const s = stations.find((x) => String(x.obj.id) === v);
              if (s) onPick(s);
            }}
            searchable
            limit={50}
            nothingFoundMessage={t.workspace.ezsNothing}
            disabled={closed}
            data-testid="ezs-station"
          />
          {mapButton}
        </Group>
      )}
      {cur && cur.kind === kind && (
        <Text size="xs" c="dimmed" data-testid="azs-address">
          {cur.kind === 'azs' ? t.workspace.azsLabel(cur.num, cur.address) : `${cur.title}, ${cur.address}`}
          {cur.enterprise ? ` · ${cur.enterprise}` : ''}
        </Text>
      )}
      <AzsMapModal
        opened={mapOpen}
        kind={kind}
        onClose={() => setMapOpen(false)}
        currentId={(conv.objectId as string) ?? null}
        onPick={(s) => {
          setMapOpen(false);
          setProblem('');
          onPick(s);
        }}
      />
    </Stack>
  );
}

function ConversationCard({ conv }: { conv: Row }) {
  const topics = useList('/topics');
  const tags = useList('/dict/tags');
  const dispositions = useList('/dict/dispositions');
  const fields = useList(
    conv.topicId ? `/topics/${String(conv.topicId)}/effective-fields` : '/none',
    !!conv.topicId,
  );
  const operators = useList('/operators');
  const queues = useList('/dict/queues');
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [disp, setDisp] = useState<string | null>(null);
  const [callbackAt, setCallbackAt] = useState('');
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => setVals((conv.fields as Record<string, unknown>) ?? {}), [conv.id, conv.fields]);
  const upd = useAction((b: Record<string, unknown>) => patch(`/conversations/${conv.id}`, b));
  const behavior = dispositions.data?.find((d) => d.id === disp)?.behavior;
  const isPostponed = behavior === 'postponed';
  const isEscalate = behavior === 'escalate';
  const escalateDisp = dispositions.data?.find((d) => d.behavior === 'escalate');
  // Раскрытые блоки полей («ещё N»): по умолчанию видны только обязательные и уже заполненные поля.
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(new Set());
  useEffect(() => setOpenBlocks(new Set()), [conv.id]);
  const toggleBlock = (b: string) => {
    const next = new Set(openBlocks);
    if (next.has(b)) next.delete(b);
    else next.add(b);
    setOpenBlocks(next);
  };
  const [escalating, setEscalating] = useState(false);
  const req = useRequired();
  useEffect(() => req.reset(), [conv.id]);
  const empty = (k: string) => vals[k] === undefined || vals[k] === null || String(vals[k]).trim() === '';
  const requiredNow = (f: Row) => !!f.requiredOnClose || (isEscalate && !!f.requiredOnEscalate);
  // Что клиент сообщил сам (номер звонка, имя из чата) — подставляется в поля темы, оператор может изменить.
  const contact = useQuery({
    queryKey: [`/contacts/${String(conv.contactId)}`],
    queryFn: () => get<Row>(`/contacts/${String(conv.contactId)}`),
    enabled: !!conv.contactId,
  });
  const [prefilled, setPrefilled] = useState<string[]>([]);
  const prefillFor = useRef('');
  useEffect(() => {
    const defs = fields.data;
    const c = contact.data;
    if (!defs || !c || conv.status === 'closed') return;
    const key = `${String(conv.id)}:${String(conv.topicId)}`;
    if (prefillFor.current === key) return;
    prefillFor.current = key;
    const phone = String(c.phone ?? '');
    const email = String(c.email ?? '');
    const name = String(c.displayName ?? '');
    const known = (f: Row): string => {
      const k = String(f.key);
      if (k === 'client_phone' || f.type === 'phone') return phone;
      if (k === 'client_email' || f.type === 'email') return email;
      if (k === 'client_name' || k === 'fio') return name && name !== phone ? name : '';
      return '';
    };
    const cur = (conv.fields as Record<string, unknown>) ?? {};
    const next = { ...cur };
    const filled: string[] = [];
    for (const f of defs) {
      const k = String(f.key);
      const v = known(f);
      if (v && (cur[k] === undefined || cur[k] === null || cur[k] === '')) {
        next[k] = v;
        filled.push(k);
      }
    }
    setPrefilled(filled);
    if (!filled.length) return;
    setVals(next);
    patch(`/conversations/${String(conv.id)}`, { fields: next }).catch((e: unknown) =>
      notifications.show({ color: 'red', title: t.error, message: errorText(e) }),
    );
  }, [fields.data, contact.data, conv.id, conv.topicId, conv.fields, conv.status]);
  /** Что не заполнено для передачи на 2-ю линию или для закрытия — подписи полей. */
  const missingFor = (escalate: boolean): string[] => [
    ...(!conv.topicId && (escalate || behavior !== 'no_reply_needed') ? [t.workspace.topicField] : []),
    ...(fields.data ?? [])
      .filter(
        (f) =>
          (escalate ? f.requiredOnEscalate : f.requiredOnClose) &&
          empty(String(f.key)) &&
          !RETIRED_KEYS.includes(String(f.key)),
      )
      .map((f) => String(f.label)),
    ...(!escalate && isPostponed && !callbackAt ? [t.workspace.callbackField] : []),
  ];
  const close = useAction(
    () =>
      post(`/conversations/${conv.id}/close`, {
        dispositionId: disp,
        ...(isPostponed && callbackAt ? { callbackAt: new Date(callbackAt).toISOString() } : {}),
      }),
    t.workspace.obrashchenieZakryto2,
  );
  const transfer = useAction(() => {
    const [kind, id] = String(to).split(':');
    return post(`/conversations/${conv.id}/transfer`, kind === 'u' ? { toUserId: id } : { toQueueId: id });
  }, t.workspace.dialogPeredan);
  // «Тема › Подтема»: в длинном справочнике одинаковые подтемы («Иные вопросы») различаются по теме.
  const byId = new Map((topics.data ?? []).map((x) => [String(x.id), x]));
  const topicLabel = (() => {
    const x = byId.get(String(conv.topicId ?? ''));
    if (!x) return '';
    const parent = x.parentId ? byId.get(String(x.parentId)) : undefined;
    return `${parent ? `${String(parent.name)} › ` : ''}${String(x.name)}${x.isImportant ? ' ❗' : ''}`;
  })();
  const closed = conv.status === 'closed';
  const tagMissing = !!conv.queueRequireTag && !((conv.tagIds as string[]) ?? []).length;
  const ticket = conv.ticket as { id: string; number: number; status: string } | null;
  const extrasOpen =
    !!conv.queueRequireTag || !!conv.isUrgent || ((conv.tagIds as string[]) ?? []).length > 0;
  const saveField = (k: string, v: unknown) => {
    const next = { ...vals, [k]: v };
    setVals(next);
    upd.mutate({ fields: next });
  };
  /** Сохранить введённое (по уходу из поля) — только если что-то изменилось. */
  const commit = () => {
    const before = (conv.fields as Record<string, unknown>) ?? {};
    if (Object.keys(vals).some((k) => String(vals[k] ?? '') !== String(before[k] ?? '')))
      upd.mutate({ fields: vals });
  };
  const defOf = (k: string) => (fields.data ?? []).find((f) => String(f.key) === k);
  const kinds = kindsFor(conv.topicId, topics.data);
  const summaryDef = defOf(SUMMARY_KEY);
  const summaryMust = !!summaryDef && requiredNow(summaryDef);
  /** Поля темы «№ и адрес АЗС», «Область нахождения АЗС» по выбранной АЗС (only — только пустые). */
  const stationFields = (s: Station, base: Record<string, unknown>, only: boolean) => {
    const next = { ...base };
    if (s.kind !== 'azs') return next;
    const blank = (k: string) => !only || base[k] === undefined || base[k] === null || String(base[k]) === '';
    if (defOf('azs_number') && blank('azs_number')) next.azs_number = t.workspace.azsLabel(s.num, s.address);
    const region = azsRegion(s.enterprise, s.address);
    const regionDef = defOf('azs_region');
    if (
      regionDef &&
      region &&
      blank('azs_region') &&
      (regionDef.options as string[] | undefined)?.includes(region)
    )
      next.azs_region = region;
    return next;
  };
  // АЗС выбрана раньше темы (или тему сменили) — поля АЗС новой темы заполняются по ней.
  const { stations } = useStations(!!conv.objectId && !closed);
  const stationFor = useRef('');
  useEffect(() => {
    const s = stations.find((x) => String(x.obj.id) === String(conv.objectId ?? ''));
    if (!s || !fields.data || closed) return;
    const key = `${String(conv.id)}:${String(conv.topicId)}:${String(conv.objectId)}`;
    if (stationFor.current === key) return;
    stationFor.current = key;
    const cur = (conv.fields as Record<string, unknown>) ?? {};
    const next = stationFields(s, cur, true);
    if (JSON.stringify(next) === JSON.stringify(cur)) return;
    setVals((v) => ({ ...v, ...next }));
    patch(`/conversations/${String(conv.id)}`, { fields: next }).catch((e: unknown) =>
      notifications.show({ color: 'red', title: t.error, message: errorText(e) }),
    );
  }, [stations, fields.data, conv.id, conv.topicId, conv.objectId, conv.fields, closed]);
  /** АЗС выбрана: предприятие, объект и поля темы «№ и адрес АЗС», «Область нахождения АЗС» — одним сохранением. */
  const pickStation = (s: Station) => {
    const next = stationFields(s, vals, false);
    setVals(next);
    const sameEnt = String(s.obj.enterpriseId) === String(conv.enterpriseId ?? '');
    upd.mutate({
      enterpriseId: s.obj.enterpriseId,
      ...(sameEnt ? {} : { departmentId: null }),
      objectId: s.obj.id,
      fields: next,
    });
  };

  // Поля темы и общие поля обращения — по логическим блокам.
  interface Item {
    key: string;
    def?: Row;
    label: string;
    common: boolean;
  }
  const items: Item[] = [
    ...(fields.data ?? [])
      .filter(
        (f) =>
          !isCommonField(String(f.key)) &&
          String(f.key) !== SUMMARY_KEY &&
          !RETIRED_KEYS.includes(String(f.key)),
      )
      .map((f) => ({ key: String(f.key), def: f, label: String(f.label), common: false })),
    // Способ обратной связи нужен только 2-й линии — показывается при передаче на неё.
    ...COMMON_FIELD_KEYS.filter((k) => k !== 'feedback_channel' || isEscalate).map((k) => ({
      key: k,
      def: defOf(k),
      label: t.workspace.commonFields[k] ?? k,
      common: true,
    })),
  ];
  /**
   * Видно без раскрытия блока: обязательное по теме (в т.ч. для 2-й линии), заполненное или подставленное.
   * Предприятие клиента и № топливной карты свёрнуты, пока не обязательны прямо сейчас и не заполнены.
   */
  const main = (i: Item) =>
    COLLAPSED_KEYS.includes(i.key)
      ? (!!i.def && requiredNow(i.def)) || !empty(i.key)
      : !!i.def?.requiredOnClose || !!i.def?.requiredOnEscalate || !empty(i.key) || prefilled.includes(i.key);
  // Незаполненное обязательное — оранжевая рамка сразу; после нажатия «Завершить»/«Передать» — красная.
  // При передаче на 2-ю линию поля, обязательные только для неё, дополнительно выделены фиолетовым.
  const look = (i: Item) => {
    const must = !!i.def && requiredNow(i.def);
    const forEscalation = isEscalate && !!i.def?.requiredOnEscalate && !i.def?.requiredOnClose;
    return {
      ...(forEscalation ? { label: { color: 'var(--mantine-color-violet-7)', fontWeight: 600 } } : {}),
      ...(must && empty(i.key) && !closed
        ? { input: { borderColor: 'var(--mantine-color-orange-5)', borderWidth: 2 } }
        : forEscalation
          ? { input: { borderColor: 'var(--mantine-color-violet-4)' } }
          : {}),
    };
  };
  const renderField = (i: Item) => {
    const k = i.key;
    const must = !!i.def && requiredNow(i.def);
    const error = req.error(must && empty(k));
    const description = prefilled.includes(k) ? t.workspace.prefilled : undefined;
    const common = {
      size: 'xs' as const,
      label: i.label,
      description,
      disabled: closed,
      withAsterisk: must,
      error,
      styles: error ? undefined : look(i),
      'data-testid': i.common ? `common-${k}` : `field-${k}`,
    };
    if (k === 'feedback_channel')
      return (
        <Select
          key={k}
          {...common}
          data={t.workspace.feedbackChannels}
          value={(vals[k] as string) ?? null}
          onChange={(v) => saveField(k, v)}
          clearable
          searchable
        />
      );
    if (i.def?.type === 'select' && Array.isArray(i.def.options))
      return (
        <Select
          key={k}
          {...common}
          data={(i.def.options as string[]).map(String)}
          value={(vals[k] as string) ?? null}
          onChange={(v) => saveField(k, v)}
          clearable
        />
      );
    return (
      <TextInput
        key={k}
        {...common}
        placeholder={(i.def?.mask as string) ?? undefined}
        type={i.def?.type === 'date' ? 'date' : i.def?.type === 'number' ? 'number' : 'text'}
        value={String(vals[k] ?? '')}
        onChange={(e) => setVals({ ...vals, [k]: e.currentTarget.value })}
        onBlur={commit}
      />
    );
  };
  const renderBlock = (b: string) => {
    const all = items.filter((i) => blockOf(i.key) === b);
    const isOpen = openBlocks.has(b);
    const shown = all.filter(main);
    const rest = all.filter((i) => !main(i));
    const azs = b === 'azs';
    // АЗС/ЭЗС видны сразу, только если тема требует их заполнить или они уже выбраны; иначе блок свёрнут целиком.
    const azsShown =
      azs &&
      (all.some((i) => !!i.def?.requiredOnClose || !!i.def?.requiredOnEscalate || !empty(i.key)) ||
        !!conv.enterpriseId ||
        !!conv.objectId);
    const hidden = rest.length + (azs && !azsShown ? AZS_PICKER_FIELDS : 0);
    if (!all.length && !azs) return null;
    const picker = azs && (
      <StationPicker
        conv={conv}
        kinds={kinds}
        closed={closed}
        onPick={pickStation}
        onOrg={(e, d) =>
          upd.mutate({
            enterpriseId: e,
            departmentId: d,
            ...(e !== conv.enterpriseId ? { objectId: null } : {}),
          })
        }
      />
    );
    return (
      <Box key={b} data-testid={`block-${b}`}>
        <Group justify="space-between" gap={4} mb={shown.length || azsShown ? 2 : 0}>
          <Text size="xs" fw={700} c="dimmed">
            {azs ? kinds.map((k) => t.org.objectKinds[k] ?? k).join(' / ') : t.workspace.blocks[b]}
          </Text>
          {hidden > 0 && (
            <Anchor
              size="xs"
              fw={600}
              onClick={() => toggleBlock(b)}
              data-testid="block-more"
              data-open={isOpen || undefined}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
            >
              {isOpen ? t.workspace.blockLess : t.workspace.blockMore(hidden)}
              <IconChevronDown
                size={14}
                style={{ transition: 'transform 200ms ease', transform: isOpen ? 'rotate(180deg)' : 'none' }}
              />
            </Anchor>
          )}
        </Group>
        <Stack gap={6}>
          {azsShown && picker}
          {shown.map(renderField)}
        </Stack>
        {/* Свёрнутое раскрывается плавно и на миг подсвечивается — видно, что именно появилось. */}
        {hidden > 0 && (
          <Collapse in={isOpen} transitionDuration={260}>
            <Stack
              gap={6}
              pt={6}
              px={4}
              pb={4}
              className={isOpen ? 'cc-reveal' : undefined}
              key={isOpen ? 'open' : 'closed'}
            >
              {azs && !azsShown && picker}
              {rest.map(renderField)}
            </Stack>
          </Collapse>
        )}
      </Box>
    );
  };

  return (
    <Stack gap="sm">
      <EscalateModal conv={conv} opened={escalating} onClose={() => setEscalating(false)} />
      {conv.isUrgent && !closed ? (
        <Paper
          p="xs"
          bg="red.6"
          c="white"
          className="cc-urgent"
          data-testid="urgent-banner"
          style={{ border: '1px solid var(--mantine-color-red-7)' }}
        >
          <Group gap={6} wrap="nowrap">
            <IconAlertTriangle size={18} className="cc-urgent-blink" />
            <Text size="sm" fw={700}>
              {t.workspace.urgentBanner}
            </Text>
          </Group>
        </Paper>
      ) : null}
      {(!!ticket || !!conv.chatCsat) && (
        <Group gap={6}>
          {ticket && (
            <Badge color="violet" variant="light" data-testid="conv-ticket">
              {t.workspace.n2YaLiniyaTiket}
              {String(ticket.number)}
            </Badge>
          )}
          {conv.chatCsat ? (
            <Badge color="yellow" variant="light" data-testid="chat-csat">
              {t.workspace.otsenkaKlienta}
              {String(conv.chatCsat)}
              {t.workspace.iz5}
            </Badge>
          ) : null}
        </Group>
      )}
      {/* Главное, что заполняет оператор, — сразу вверху без прокрутки: тема, суть, заметка к звонку. */}
      <Paper
        withBorder
        p="xs"
        style={!conv.topicId && !closed ? { borderColor: 'var(--mantine-color-blue-4)' } : undefined}
      >
        <Stack gap={6}>
          <TopicPicker
            size="sm"
            label={t.workspace.stepTopic}
            description={!conv.topicId && !closed ? t.workspace.stepTopicHint : undefined}
            placeholder={t.workspace.stepTopicPlaceholder}
            value={(conv.topicId as string) ?? null}
            onChange={(v) => upd.mutate({ topicId: v })}
            clearable
            disabled={closed}
            withAsterisk
            error={req.error(!conv.topicId)}
            testId="topic"
          />
          {topicLabel ? (
            <Text size="xs" c="dimmed" data-testid="topic-full">
              {topicLabel}
            </Text>
          ) : null}
          <Textarea
            size="sm"
            label={t.workspace.issueSummary}
            placeholder={t.workspace.issueSummaryPlaceholder}
            autosize
            minRows={3}
            maxRows={8}
            value={String(vals[SUMMARY_KEY] ?? '')}
            onChange={(e) => setVals({ ...vals, [SUMMARY_KEY]: e.currentTarget.value })}
            onBlur={commit}
            disabled={closed}
            withAsterisk={summaryMust}
            error={req.error(summaryMust && empty(SUMMARY_KEY))}
            styles={
              summaryMust && empty(SUMMARY_KEY) && !closed && !req.error(true)
                ? { input: { borderColor: 'var(--mantine-color-orange-5)', borderWidth: 2 } }
                : undefined
            }
            data-testid="issue-summary"
          />
          {conv.channelKind === 'voice' && <CallNote conv={conv} />}
        </Stack>
      </Paper>
      {/* Передача на 2-ю линию — заметный переключатель: с ним отмечены поля, обязательные для передачи. */}
      {!closed && conv.status !== 'waiting_2nd_line' && escalateDisp && (
        <Paper
          withBorder
          p="xs"
          style={{
            borderColor: isEscalate ? 'var(--mantine-color-violet-5)' : undefined,
            borderWidth: isEscalate ? 2 : 1,
          }}
          bg={isEscalate ? 'violet.0' : undefined}
          data-testid="escalate-toggle-box"
        >
          <Switch
            size="md"
            color="violet"
            label={<Text fw={600}>{t.workspace.escalateToggle}</Text>}
            description={isEscalate ? t.workspace.escalateMarked : t.workspace.escalateToggleHint}
            checked={isEscalate}
            onChange={(e) => setDisp(e.currentTarget.checked ? String(escalateDisp.id) : null)}
            data-testid="escalate-toggle"
          />
        </Paper>
      )}
      <Paper withBorder p="xs" data-testid="topic-fields">
        {conv.topicId ? (
          <Stack gap="xs">{BLOCK_ORDER.map(renderBlock)}</Stack>
        ) : (
          <Text size="xs" c="dimmed" data-testid="fields-after-topic">
            {t.workspace.fieldsAfterTopic}
          </Text>
        )}
      </Paper>
      <ExtraFields
        fields={(conv.fields as Record<string, unknown>) ?? {}}
        defined={[
          ...(fields.data ?? []),
          ...[...COMMON_FIELD_KEYS, SUMMARY_KEY, ...BLOCK_KEYS.azs!, ...RETIRED_KEYS].map((k) => ({
            id: k,
            key: k,
          })),
        ]}
      />
      <Accordion variant="contained" defaultValue={extrasOpen ? 'extra' : null} chevronPosition="left">
        <Accordion.Item value="extra">
          <Accordion.Control py={4}>
            <Text size="sm">
              {t.workspace.stepExtra}
              {conv.isImportant ? ' · ❗' : ''}
              {conv.isUrgent ? ` · ${t.workspace.srochnoe2}` : ''}
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap={6}>
              <MultiSelect
                size="xs"
                label={t.workspace.tegi2}
                withAsterisk={!!conv.queueRequireTag}
                description={conv.queueRequireTag ? t.workspace.vEtoyOcherediTeg : undefined}
                data={options(tags.data)}
                value={(conv.tagIds as string[]) ?? []}
                onChange={(v) => upd.mutate({ tagIds: v })}
                disabled={closed}
                data-testid="tags"
              />
              <Group>
                <Tooltip label={t.workspace.stavitsyaAvtomaticheskiPoTeme}>
                  <Switch
                    size="xs"
                    label={t.workspace.osoboVazhnoe2}
                    checked={!!conv.isImportant}
                    onChange={(e) => upd.mutate({ isImportant: e.currentTarget.checked })}
                    disabled={closed}
                  />
                </Tooltip>
                <Switch
                  size="xs"
                  label={t.workspace.srochnoe2}
                  checked={!!conv.isUrgent}
                  onChange={(e) => upd.mutate({ isUrgent: e.currentTarget.checked })}
                  disabled={closed}
                />
              </Group>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      {!closed && conv.status !== 'waiting_2nd_line' && (
        <>
          <Paper withBorder p="xs" style={{ borderColor: 'var(--mantine-color-green-4)' }}>
            <Select
              size="sm"
              label={t.workspace.stepFinish}
              description={!conv.topicId ? t.workspace.stepFinishNoTopic : undefined}
              data={options(dispositions.data)}
              value={disp}
              onChange={setDisp}
              data-testid="disposition"
            />
            {isPostponed && (
              <TextInput
                size="xs"
                mt="xs"
                type="datetime-local"
                label={t.workspace.dataIVremyaPerezvona}
                value={callbackAt}
                onChange={(e) => setCallbackAt(e.currentTarget.value)}
                withAsterisk
                error={req.error(!callbackAt)}
                data-testid="callback-at"
              />
            )}
            {isEscalate ? (
              <Button
                mt="xs"
                fullWidth
                color="violet"
                disabled={tagMissing}
                onClick={() => req.check(missingFor(true)) && setEscalating(true)}
                data-testid="escalate"
              >
                {t.workspace.peredatNa2Yu}
              </Button>
            ) : (
              <Button
                mt="xs"
                fullWidth
                color="green"
                disabled={!disp || tagMissing}
                onClick={() => req.check(missingFor(false)) && close.mutate(undefined)}
                data-testid="close"
              >
                {t.workspace.zavershitObrashchenie}
              </Button>
            )}
          </Paper>
          <Accordion variant="contained" chevronPosition="left">
            <Accordion.Item value="transfer">
              <Accordion.Control py={4} data-testid="transfer-open">
                <Text size="sm">{t.workspace.stepTransfer}</Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Select
                  size="xs"
                  label={t.workspace.peredat}
                  data={[
                    {
                      group: t.workspace.operatoram,
                      items: (operators.data ?? []).map((o) => ({
                        value: `u:${o.id}`,
                        label: String(o.fullName),
                      })),
                    },
                    {
                      group: t.workspace.vOchered,
                      items: (queues.data ?? []).map((q) => ({ value: `q:${q.id}`, label: String(q.name) })),
                    },
                  ]}
                  value={to}
                  onChange={setTo}
                  searchable
                  data-testid="conv-transfer-target"
                />
                <Button
                  size="xs"
                  mt="xs"
                  fullWidth
                  variant="light"
                  disabled={!to}
                  onClick={() => transfer.mutate(undefined)}
                  data-testid="conv-transfer"
                >
                  {t.workspace.peredatSKontekstom}
                </Button>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </>
      )}
    </Stack>
  );
}

const CALL_STATE: Record<string, string> = {
  ivr: t.workspace.vIvr,
  queued: t.workspace.ozhidaetOperatora,
  dialing: t.workspace.vyzov,
  talking: t.workspace.razgovor,
  external: t.workspace.perevedenNaVneshniyNomer,
  ended: t.workspace.zavershen,
};
const CALL_EVENT: Record<string, string> = {
  queued: t.workspace.vOcheredi2,
  offered: t.workspace.vyzovOperatora,
  agent_connected: t.workspace.operatorOtvetil,
  agent_no_answer: t.workspace.operatorNeOtvetil,
  agent_declined: t.workspace.operatorOtklonil,
  hold: t.workspace.uderzhanie2,
  unhold: t.workspace.snyatoSUderzhaniya,
  transfer_queue: t.workspace.perevodVOchered,
  transfer_user: t.workspace.perevodOperatoru,
  transfer_external: t.workspace.pryamoyPerevod,
  external_connected: t.workspace.podrazdelenieOtvetilo,
  listen: t.workspace.proslushivanieSupervizorom,
  dialing_out: t.workspace.iskhodyashchiyVyzov,
  ended: t.workspace.zavershen,
  ivr_start: 'IVR',
  queue_left: t.workspace.ushelIzOcherediPo,
  agent_done: t.workspace.operatorZavershilKlientV,
  csat: t.workspace.otsenka,
  voicemail: t.workspace.golosovoeSoobshchenie,
  callback_requested: t.workspace.zakazPerezvona,
  transfer_failed: t.workspace.perevodNeSostoyalsya,
  ivr_resumed: t.workspace.prodolzhenPoslePereklyucheniya,
  consult_start: t.workspace.konsultatsiya,
  consult_connected: t.workspace.adresatKonsultatsiiOtvetil,
  consult_end: t.workspace.konsultatsiyaBezPerevoda,
  position: t.workspace.pozitsiyaVOcheredi,
  supervisor_listen: t.workspace.supervizorSlushaet,
  supervisor_whisper: t.workspace.supervizorSufliruet,
  supervisor_barge: t.workspace.supervizorVmeshalsya,
  supervisor_left: t.workspace.supervizorOtklyuchilsya,
  takeover: t.workspace.perekhvatSupervizorom,
};
/** В кратком журнале стадий — без шагов IVR (они — отдельной строкой «Путь по IVR»). */
const IVR_STEP = new Set(['ivr', 'ivr_dtmf', 'ivr_http']);

/** Путь клиента по IVR: узлы с выходами, нажатые цифры, результат запросов во внешние системы. */
function ivrPath(events: CallRow['events']): string {
  const out: string[] = [];
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'ivr' && !d.exit && d.name) out.push(String(d.name));
    else if (e.type === 'ivr_dtmf') out.push(`[${String(d.digit)}]`);
    else if (e.type === 'ivr_http')
      out.push(d.ok ? t.workspace.otvetPoluchen : t.workspace.oshibka(String(d.error ?? '')));
  }
  return out.join(' → ');
}

interface CallRow {
  id: string;
  direction: 'in' | 'out';
  state: string;
  fromNumber: string | null;
  toNumber: string | null;
  startedAt: string;
  agentName: string | null;
  waitS: number;
  talkS: number;
  endReason: string | null;
  recordings: {
    id: string;
    kind?: string;
    status: string;
    durationS: number | null;
    deletedAt?: string | null;
  }[];
  events: { at: string; type: string; userName: string | null; data?: Record<string, unknown> }[];
}

function Recording({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (url) return <audio controls src={url} style={{ width: '100%' }} data-testid="recording-audio" />;
  return (
    <Button
      size="xs"
      variant="light"
      onClick={() =>
        void recordingUrl(id)
          .then(setUrl)
          .catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }))
      }
      data-testid="recording-play"
    >
      {t.workspace.proslushatZapis}
    </Button>
  );
}

/** Журнал вызовов обращения и записи разговоров (M-TEL-04/05); супервизору — прослушивание (M-TEL-10). */
function CallsPanel({ convId }: { convId: string }) {
  const { can } = useAuth();
  const calls = useList<CallRow>(`/conversations/${convId}/calls`);
  const listen = useAction(
    (id: string) => post(`/calls/${id}/listen`),
    t.workspace.zvonokProslushivaniyaOtvetteV,
  );
  if (!calls.data?.length) return null;
  return (
    <Stack
      gap="xs"
      pl="xs"
      mt={4}
      style={{ borderLeft: '2px solid var(--mantine-color-gray-3)' }}
      data-testid="calls"
    >
      {calls.data.map((c) => (
        <Paper key={c.id} withBorder p="xs" data-testid="call-item">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              {c.direction === 'in'
                ? t.workspace.vkhodyashchiy(c.fromNumber ?? '')
                : t.workspace.iskhodyashchiy(c.toNumber ?? '')}
            </Text>
            <Badge variant="light" data-testid="call-state">
              {CALL_STATE[c.state] ?? c.state}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            {time(c.startedAt)}
            {t.workspace.ozhidanie}
            {c.waitS}
            {t.workspace.sRazgovor}
            {c.talkS}
            {t.workspace.s}
            {c.agentName ? ` · ${c.agentName}` : ''}
          </Text>
          <Text size="xs" c="dimmed">
            {c.events
              .filter((e) => !IVR_STEP.has(e.type))
              .map(
                (e) =>
                  `${time(e.at)} ${CALL_EVENT[e.type] ?? e.type}${e.data?.consult ? t.workspace.posleKonsultatsii : ''}${e.type === 'csat' ? t.workspace.iz52(String(e.data?.score)) : ''}${e.type === 'position' ? ` ${String(e.data?.position)}` : ''}`,
              )
              .join(' → ')}
          </Text>
          {c.events.some((e) => e.type === 'ivr') && (
            <Text size="xs" data-testid="call-ivr-path">
              {t.workspace.putPoIvr}
              {ivrPath(c.events)}
            </Text>
          )}
          {c.events
            .filter((e) => e.type === 'csat')
            .map((e) => (
              <Badge key={e.at} color="yellow" variant="light" data-testid="call-csat">
                {t.workspace.otsenkaKlienta}
                {String(e.data?.score)}
                {t.workspace.iz5}
              </Badge>
            ))}
          {c.state === 'talking' && can('supervisor.monitor') && (
            <Button
              size="xs"
              mt={4}
              variant="light"
              onClick={() => listen.mutate(c.id)}
              data-testid="call-listen"
            >
              {t.workspace.proslushatRazgovor}
            </Button>
          )}
          {c.recordings.map((r) =>
            r.deletedAt ? (
              <Text key={r.id} size="xs" c="dimmed" data-testid="recording-deleted">
                {t.workspace.zapisUdalenaSrokKhraneniya}
              </Text>
            ) : r.status === 'uploaded' ? (
              <Box key={r.id}>
                {r.kind === 'voicemail' && (
                  <Text size="xs" fw={600}>
                    {t.workspace.golosovoeSoobshchenieKlienta}
                  </Text>
                )}
                <Recording id={r.id} />
              </Box>
            ) : (
              <Text key={r.id} size="xs" c="dimmed">
                {t.workspace.zapis}
                {r.status === 'failed' ? t.workspace.neSokhranilas : t.workspace.obrabatyvaetsya}
              </Text>
            ),
          )}
        </Paper>
      ))}
    </Stack>
  );
}

/** Высота панелей рабочего места: экран минус шапка и отступы. */
const PANEL_H = 'calc(100vh - 88px)';
/** Статусы, в которых обращение «в работе» у оператора (режим обработки). */
const WORK_STATUSES = ['active', 'hold', 'waiting_customer'];

export function WorkspacePage() {
  const { me, can } = useAuth();
  // Виды списка — в порядке из интерфейса роли; первый открывается по умолчанию.
  const wsUi = me?.ui?.workspace;
  const [tab, setTab] = useState(wsUi?.listTabs?.[0] ?? 'mine');
  const [selected, setSelected] = useState<string | null>(null);
  const [typingContact, setTypingContact] = useState<string | null>(null);
  const [important, setImportant] = useState(false);
  const [callback, setCallback] = useState(false);
  const qc = useQueryClient();
  const rt = useRealtime(true);
  // «Нет связи» — только если связи нет дольше нескольких секунд (при входе и коротких переподключениях не мигает).
  const [rtOfflineLong, setRtOfflineLong] = useState(false);
  useEffect(() => {
    if (rt.connected) {
      setRtOfflineLong(false);
      return;
    }
    const id = setTimeout(() => setRtOfflineLong(true), 5000);
    return () => clearTimeout(id);
  }, [rt.connected]);
  const conv = useQuery({
    queryKey: [`/conversations/${selected}`],
    queryFn: () => get<Row>(`/conversations/${selected}`),
    enabled: !!selected,
  });
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastTyping = useRef(0);
  const phone = useSoftphone();
  // Входящий звонок: обращение звонящего открывается сразу (карточка клиента по АОН).
  const ringingConv = phone.call && !phone.call.listen ? phone.call.conversationId : null;
  useEffect(() => {
    if (ringingConv) setSelected(ringingConv);
  }, [ringingConv]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default')
      void Notification.requestPermission();
  }, []);

  useEffect(
    () =>
      onRealtime((e) => {
        if (e.type === 'typing' && e.from === 'client') {
          setTypingContact(e.contactId ?? null);
          clearTimeout(typingTimer.current);
          typingTimer.current = setTimeout(() => setTypingContact(null), 4000);
          return;
        }
        if (e.type !== 'event' || !e.data) return;
        const id = String(e.data.conversationId);
        void qc.invalidateQueries({
          predicate: (q) =>
            String(q.queryKey[0]).startsWith('/conversations') ||
            String(q.queryKey[0]).startsWith('/contacts'),
        });
        const m = e.data.message as Row | undefined;
        if (e.event === 'conversation.message_created' && m?.direction === 'in') {
          if (e.data.assigneeId === me?.id)
            notify(t.workspace.novoeSoobshchenie, String(m.body ?? '').slice(0, 100));
          if (id === selected) setTypingContact(null);
        }
        // Звонок в IVR (статус «bot») ещё не в очереди — уведомим, когда сценарий поставит его в очередь.
        if (e.event === 'conversation.created' && e.data.status !== 'bot')
          notify(t.workspace.novoeObrashchenieVOcheredi, t.workspace.otkroyteVkladkuOchered);
        if (e.event === 'conversation.updated' && e.data.action === 'bot_handoff')
          notify(t.workspace.novoeObrashchenieVOcheredi, t.workspace.botPeredalDialogOperatoru);
        if (e.event === 'conversation.updated' && e.data.action === 'offered' && e.data.assigneeId === me?.id)
          notify(t.workspace.vamPredlozhenoObrashchenie, t.workspace.primiteIliOtkloniteVo);
      }),
    [qc, me?.id, selected],
  );

  const secondLine = tab === 'approvals' || tab === 'created';
  const nApprovals = useTicketCount('approvals');
  // Счётчики (M-OP-02): списки обновляются по событиям realtime и раз в 30 с — чат попадает в «Постобработку»
  // по времени молчания клиента, без события.
  const nQueue = useCount('queue');
  const nMine = useCount('mine');
  const nHold = useCount('hold');
  const nWrapup = useCount('wrapup');
  const allTabs = useMemo(
    () => [
      { value: 'mine', label: t.workspace.moi },
      { value: 'queue', label: t.workspace.ochered },
      { value: 'bot', label: t.workspace.uBota },
      ...(can('supervisor.monitor') ? [{ value: 'active', label: t.workspace.vseOtkrytye }] : []),
      { value: 'closed', label: t.workspace.zakrytye },
    ],
    [can],
  );
  const tabs = useMemo(() => orderTabs(allTabs, wsUi?.listTabs), [allTabs, wsUi]);
  const hasQueue = tabs.some((x) => x.value === 'queue');
  // Выпадающий список видов: основные (из интерфейса роли), «мои» по стадиям, 2-я линия.
  const views = [
    ...tabs
      .filter((x) => x.value !== 'queue')
      .map((x) => ({ ...x, n: x.value === 'mine' ? nMine : 0, group: 'main' })),
    { value: 'hold', label: t.workspace.uderzhanie, n: nHold, group: 'work' },
    { value: 'wrapup', label: t.workspace.postobrabotka3, n: nWrapup, group: 'work' },
    { value: 'approvals', label: t.workspace.naSoglasovanii2, n: nApprovals, group: '2nd' },
    { value: 'created', label: t.workspace.peredannye, n: 0, group: '2nd' },
  ];
  const curView = tab === 'queue' ? null : views.find((v) => v.value === tab);
  const filtersOn = important || callback;
  const rightTabs = useMemo(
    () =>
      orderTabs(
        [
          { value: 'card', label: t.workspace.obrashchenie, testId: 'tab-card' },
          { value: 'contact', label: t.workspace.klient, testId: 'tab-contact' },
        ],
        wsUi?.rightTabs,
      ),
    [wsUi],
  );

  // Режим обработки: обращение взято в работу — список скрыт (его можно показать кнопкой), меню свёрнуто.
  const working =
    !!conv.data &&
    String(conv.data.id) === selected &&
    conv.data.assigneeId === me?.id &&
    WORK_STATUSES.includes(String(conv.data.status));
  const [listHidden, setListHidden] = useState(false);
  const focus = working && listHidden;
  // Обращение закрыто, передано или открыто чужое/закрытое — список снова виден.
  useEffect(() => {
    if (conv.data && String(conv.data.id) === selected && !working) setListHidden(false);
  }, [conv.data, selected, working]);
  // Взятие в работу без кнопки на экране (ответ на звонок, принятие в шапке) — обращение стало «в работе».
  const prevConv = useRef<{ id: string | null; status: string | null }>({ id: null, status: null });
  useEffect(() => {
    const d = conv.data;
    const cur = { id: d ? String(d.id) : null, status: d ? String(d.status) : null };
    const prev = prevConv.current;
    prevConv.current = cur;
    if (
      d &&
      d.assigneeId === me?.id &&
      prev.id === cur.id &&
      cur.status === 'active' &&
      ['queued', 'offered', 'bot'].includes(String(prev.status))
    )
      setListHidden(true);
  }, [conv.data, me?.id]);
  useEffect(() => {
    setFocusMode(focus);
  }, [focus]);
  useEffect(() => () => setFocusMode(false), []);
  const startWork = (id: string) => {
    setSelected(id);
    setListHidden(true);
  };

  return (
    <Grid gutter="md">
      {!focus && (
        <Grid.Col span={3} data-testid="conv-list-col">
          {/* Список обращений — отдельная серая панель, чтобы не сливался с обработкой обращения. */}
          <Paper
            withBorder
            radius="md"
            p="xs"
            bg="gray.0"
            h={PANEL_H}
            style={{ display: 'flex', flexDirection: 'column' }}
            data-testid="conv-list-panel"
          >
            <Group gap={6} wrap="nowrap" mb="xs">
              <Menu position="bottom-start" withinPortal>
                <Menu.Target>
                  <Button
                    size="xs"
                    variant={curView ? 'white' : 'subtle'}
                    color="dark"
                    rightSection={<IconChevronDown size={14} />}
                    style={{ flex: 1, minWidth: 0 }}
                    justify="space-between"
                    title={t.workspace.listViewHint}
                    data-testid="list-view"
                  >
                    {curView
                      ? `${curView.label}${curView.n ? ` (${curView.n})` : ''}`
                      : t.workspace.listViewHint}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  {views.map((v, i) => (
                    <Fragment key={v.value}>
                      {i > 0 && views[i - 1]!.group !== v.group ? <Menu.Divider /> : null}
                      <Menu.Item
                        onClick={() => setTab(v.value)}
                        fw={tab === v.value ? 700 : undefined}
                        rightSection={
                          v.n ? (
                            <Badge size="xs" variant="light" color={v.value === 'mine' ? 'blue' : 'orange'}>
                              {v.n}
                            </Badge>
                          ) : null
                        }
                        data-testid={`view-${v.value}`}
                      >
                        {v.label}
                      </Menu.Item>
                    </Fragment>
                  ))}
                </Menu.Dropdown>
              </Menu>
              {hasQueue && (
                <Tooltip label={t.workspace.queueBtnHint}>
                  <Button
                    size="xs"
                    px={8}
                    variant={tab === 'queue' ? 'filled' : nQueue ? 'light' : 'default'}
                    color={nQueue ? 'orange' : 'gray'}
                    onClick={() => setTab('queue')}
                    rightSection={
                      <Badge
                        size="sm"
                        circle={nQueue < 10}
                        color={nQueue ? 'orange' : 'gray'}
                        variant="filled"
                      >
                        {nQueue}
                      </Badge>
                    }
                    data-testid="queue-open"
                  >
                    {t.workspace.queueBtn}
                  </Button>
                </Tooltip>
              )}
              {!secondLine && (
                <Popover position="bottom-end" withArrow>
                  <Popover.Target>
                    <Indicator disabled={!filtersOn} color="red" size={8} offset={3}>
                      <ActionIcon
                        size="md"
                        variant={filtersOn ? 'filled' : 'default'}
                        aria-label={t.workspace.filters}
                        title={t.workspace.filters}
                        data-testid="list-filters"
                      >
                        <IconFilter size={16} />
                      </ActionIcon>
                    </Indicator>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <Stack gap={6}>
                      <Text size="xs" c="dimmed">
                        {t.workspace.filtersOnlyHint}
                      </Text>
                      <Checkbox
                        size="xs"
                        label={t.workspace.filterImportant}
                        checked={important}
                        onChange={(e) => setImportant(e.currentTarget.checked)}
                        data-testid="filter-important"
                      />
                      <Checkbox
                        size="xs"
                        label={t.workspace.filterCallback}
                        checked={callback}
                        onChange={(e) => setCallback(e.currentTarget.checked)}
                        data-testid="filter-callback"
                      />
                    </Stack>
                  </Popover.Dropdown>
                </Popover>
              )}
              {/* Связь с сервером для мгновенных обновлений: есть — маленькая зелёная точка, нет — заметная плашка. */}
              {rt.connected || !rtOfflineLong ? (
                <Tooltip label={rt.connected ? t.workspace.onlayn : t.workspace.rtConnecting}>
                  <Box
                    w={8}
                    h={8}
                    style={{
                      borderRadius: '50%',
                      flex: 'none',
                      background: `var(--mantine-color-${rt.connected ? 'green' : 'gray'}-6)`,
                    }}
                    data-testid="rt-status"
                  >
                    <VisuallyHidden>
                      {rt.connected ? t.workspace.onlayn : t.workspace.rtConnecting}
                    </VisuallyHidden>
                  </Box>
                </Tooltip>
              ) : (
                <Tooltip label={t.workspace.rtOfflineHint} multiline w={280} withArrow>
                  <Badge
                    color="red"
                    variant="filled"
                    size="sm"
                    style={{ flex: 'none' }}
                    data-testid="rt-status"
                  >
                    {t.workspace.rtOffline}
                  </Badge>
                </Tooltip>
              )}
            </Group>
            <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
              {secondLine ? (
                <Stack gap="xs">
                  <TicketList
                    view={tab}
                    extra={tab === 'created' ? '&status=new,in_work,approval,rework' : ''}
                  />
                  {tab === 'approvals' && (
                    <Paper withBorder p="xs">
                      <Text size="sm" fw={600} mb={4}>
                        {t.workspace.zamestitelNaPeriodOtsutstviya}
                      </Text>
                      <SubstitutesPanel />
                    </Paper>
                  )}
                </Stack>
              ) : (
                <List
                  tab={tab}
                  selected={selected}
                  onSelect={setSelected}
                  onTaken={startWork}
                  important={important}
                  callback={callback}
                />
              )}
            </ScrollArea>
          </Paper>
        </Grid.Col>
      )}
      <Grid.Col span={focus ? 7 : 5}>
        {conv.data ? (
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                {working && (
                  <Tooltip label={focus ? t.workspace.focusHint : t.workspace.focusHideList} withArrow>
                    <Indicator
                      disabled={!focus || !nQueue}
                      label={nQueue}
                      size={16}
                      color="orange"
                      offset={4}
                    >
                      <Button
                        size="xs"
                        variant={focus ? 'light' : 'default'}
                        px={8}
                        leftSection={
                          focus ? (
                            <IconLayoutSidebarLeftExpand size={16} />
                          ) : (
                            <IconLayoutSidebarLeftCollapse size={16} />
                          )
                        }
                        onClick={() => setListHidden(!focus)}
                        data-testid="focus-toggle-list"
                        data-focus={focus || undefined}
                      >
                        {focus ? t.workspace.focusShowList : t.workspace.focusHideList}
                      </Button>
                    </Indicator>
                  </Tooltip>
                )}
                <Box style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text fw={700} truncate>
                      {String(conv.data.contactName)}
                    </Text>
                    {conv.data.isUrgent && conv.data.status !== 'closed' ? (
                      <Badge color="red" variant="filled" size="sm" className="cc-urgent-blink">
                        {t.workspace.urgentBadge}
                      </Badge>
                    ) : null}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {CHANNEL[String(conv.data.channelKind)]} ·{' '}
                    {STATUS[String(conv.data.status)] ?? String(conv.data.status)}
                    {conv.data.assigneeName ? t.workspace.vedet(String(conv.data.assigneeName)) : ''}
                  </Text>
                </Box>
              </Group>
              {conv.data.status === 'queued' && (
                <Button
                  size="xs"
                  onClick={() =>
                    void post(`/conversations/${selected}/take`).then(() => {
                      setListHidden(true);
                      return qc.invalidateQueries();
                    })
                  }
                  data-testid="take-open"
                >
                  {t.workspace.vzyat}
                </Button>
              )}
              {can('conversations.takeover') &&
                conv.data.assigneeId !== me?.id &&
                ['queued', 'offered', 'active', 'bot'].includes(String(conv.data.status)) && (
                  <Button
                    size="xs"
                    color="orange"
                    variant="light"
                    data-testid="takeover"
                    onClick={() =>
                      void post(`/conversations/${selected}/takeover`)
                        .then(() => qc.invalidateQueries())
                        .catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }))
                    }
                  >
                    {t.workspace.perekhvatit}
                  </Button>
                )}
              {conv.data.status === 'offered' && conv.data.assigneeId === me?.id && (
                <Group gap={4}>
                  <Button
                    size="xs"
                    color="green"
                    data-testid="accept-open"
                    onClick={() =>
                      void post(`/conversations/${selected}/accept`).then(() => {
                        setListHidden(true);
                        return qc.invalidateQueries();
                      })
                    }
                  >
                    {t.workspace.prinyat}
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    data-testid="decline-open"
                    onClick={() =>
                      void post(`/conversations/${selected}/decline`).then(() => {
                        setSelected(null);
                        void qc.invalidateQueries();
                      })
                    }
                  >
                    {t.workspace.otklonit}
                  </Button>
                </Group>
              )}
            </Group>
            {conv.data.channelKind === 'review' && <ReviewPanel conv={conv.data} />}
            <Messages
              conv={conv.data}
              typing={typingContact === conv.data.contactId}
              onTyping={() => {
                if (Date.now() - lastTyping.current > 2000) {
                  lastTyping.current = Date.now();
                  rt.send({ type: 'typing', conversationId: selected, contactId: conv.data?.contactId });
                }
              }}
            />
          </Stack>
        ) : (
          <Text c="dimmed" mt="xl" ta="center">
            {t.workspace.vyberiteObrashchenieSleva}
          </Text>
        )}
      </Grid.Col>
      <Grid.Col span={focus ? 5 : 4}>
        {conv.data && (
          <Tabs defaultValue={rightTabs[0]?.value ?? 'card'}>
            <Tabs.List mb="xs">
              {rightTabs.map((x) => (
                <Tabs.Tab key={x.value} value={x.value} data-testid={x.testId}>
                  {x.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <ScrollArea h="calc(100vh - 140px)" type="auto" offsetScrollbars>
              <Tabs.Panel value="card">
                <ConversationCard conv={conv.data} />
              </Tabs.Panel>
              <Tabs.Panel value="contact">
                <ContactCard conv={conv.data} onOpen={setSelected} />
              </Tabs.Panel>
            </ScrollArea>
          </Tabs>
        )}
      </Grid.Col>
    </Grid>
  );
}
