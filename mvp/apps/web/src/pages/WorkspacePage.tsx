import {
  Accordion,
  Badge,
  Box,
  Button,
  Card,
  Chip,
  FileButton,
  Grid,
  Group,
  MultiSelect,
  Paper,
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
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorText, get, openAttachment, patch, post, recordingUrl, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, options, useAction, useList } from '../lib/data';
import { notify, onRealtime, useRealtime } from '../lib/realtime';
import { ExternalDataPanel } from './IvrAdminPages';
import { renderTemplate, SlashList, useSlashTemplates } from '../components/AssistPanel';
import { HintPanel } from '../components/HintPanel';
import { softphone, useSoftphone } from '../lib/softphone';
import { setDraft } from '../lib/app-version';
import { EscalateModal, SubstitutesPanel, TicketList, useTicketCount } from './TicketPages';
import { MergeContactModal } from '../components/MergeContactModal';
import { OrgPicker, TopicPicker } from '../components/DictPickers';
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

const BREAK_POLL_MS = 5000;

/** Статус оператора (M-OP-04): переключение «Готов»/«Перерыв»/«Офлайн»; «Постобработка» — только показ и таймер. */
function AgentStatusBar() {
  const reasons = useList('/dict/break-reasons');
  const status = useQuery({
    queryKey: ['/agent-status/me'],
    queryFn: () => get<Row>('/agent-status/me'),
    refetchInterval: BREAK_POLL_MS,
  });
  const setStatus = useAction(
    (b: Record<string, unknown>) => post('/agent-status', b),
    t.workspace.statusIzmenen,
  );
  const cur = String(status.data?.status ?? 'offline');
  if (cur === 'wrap_up') {
    const until = status.data?.wrapUpUntil ? new Date(String(status.data.wrapUpUntil)).getTime() : 0;
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    return (
      <Badge color="yellow" variant="light" data-testid="agent-status">
        {t.workspace.postobrabotka}
        {left}
        {t.workspace.s}
      </Badge>
    );
  }
  return (
    <Group gap={4}>
      <SegmentedControl
        size="xs"
        data-testid="agent-status"
        value={cur}
        onChange={(v) => {
          // Интеграция со статусом (Ф5b): «Готов» без подключённого телефона — звонки не придут, чаты — да.
          if (v === 'ready' && softphone.getSnapshot().reg !== 'registered')
            notifications.show({
              color: 'yellow',
              title: t.workspace.telefonNePodklyuchen,
              message: t.workspace.zvonkiPostupatNeBudut,
              autoClose: 8000,
            });
          setStatus.mutate(
            v === 'break' ? { status: 'break', reasonId: reasons.data?.[0]?.id } : { status: v },
          );
        }}
        data={[
          { value: 'ready', label: t.workspace.gotov },
          { value: 'break', label: t.workspace.pereryv },
          { value: 'offline', label: t.workspace.oflayn },
        ]}
      />
      {cur === 'break' && (
        <Select
          size="xs"
          w={170}
          placeholder={t.workspace.prichina}
          data-testid="agent-status-reason"
          data={options(reasons.data)}
          value={(status.data?.reasonId as string) ?? null}
          onChange={(v) => v && setStatus.mutate({ status: 'break', reasonId: v })}
        />
      )}
    </Group>
  );
}

/** Число обращений во вкладке (для подписи вкладки). */
function useCount(tab: string): number {
  const q = useQuery({
    queryKey: [`/conversations?tab=${tab}`],
    queryFn: () => get<Row[]>(`/conversations?tab=${tab}`),
    refetchInterval: 30_000,
  });
  return q.data?.length ?? 0;
}

function List({
  tab,
  selected,
  onSelect,
}: {
  tab: string;
  selected: string | null;
  onSelect(id: string): void;
}) {
  const { me } = useAuth();
  const [important, setImportant] = useState(false);
  const [callback, setCallback] = useState(false);
  const list = useList(
    `/conversations?tab=${tab}${important ? '&important=true' : ''}${callback ? '&callback=true' : ''}`,
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
      <Group gap={4}>
        <Chip size="xs" variant="outline" checked={important} onChange={setImportant}>
          {t.workspace.filterImportant}
        </Chip>
        <Chip
          size="xs"
          variant="outline"
          checked={callback}
          onChange={setCallback}
          data-testid="filter-callback"
        >
          {t.workspace.filterCallback}
        </Chip>
      </Group>
      {(list.data ?? []).length === 0 && (
        <Text c="dimmed" size="sm">
          {t.workspace.netObrashcheniy}
        </Text>
      )}
      {(list.data ?? []).map((c) => (
        <Card
          key={c.id}
          withBorder
          padding="xs"
          style={{
            cursor: 'pointer',
            borderColor: selected === c.id ? 'var(--mantine-color-blue-5)' : undefined,
          }}
          onClick={() => onSelect(c.id)}
          data-testid="conv-item"
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
              <Badge size="xs" color="orange">
                {t.workspace.srochnoe}
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
                take.mutate(c.id, { onSuccess: () => onSelect(c.id) });
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
                  accept.mutate(c.id, { onSuccess: () => onSelect(c.id) });
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
      ))}
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
  // Звонок: писать клиенту некуда — поле ответа работает как внутренняя заметка, главное место у подсказок.
  const voice = conv.channelKind === 'voice';
  const note = noteMode || hint || voice;
  const [files, setFiles] = useState<Att[]>([]);
  const [busy, setBusy] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  useEffect(() => {
    // scrollTo в новых браузерах возвращает Promise — из эффекта его возвращать нельзя (React ждёт функцию очистки).
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [msgs.data, typing]);
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
  const showHints = conv.status !== 'closed' && (voice || (!note && canWrite));
  return (
    <Stack h="100%" gap="xs">
      <ScrollArea
        h={voice ? 70 : showHints ? 'calc(50vh - 110px)' : 'calc(100vh - 330px)'}
        viewportRef={viewport}
        type="auto"
      >
        <Stack gap={6} p="xs" data-testid="messages">
          {(msgs.data ?? []).map((m) => {
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
                {((m.meta as { buttons?: { id: string; label: string }[] } | undefined)?.buttons ?? [])
                  .length > 0 && (
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
          height={voice ? 'calc(100vh - 380px)' : 'calc(30vh)'}
          onPickTopic={pickTopic}
          onInsert={(t, sg) => {
            setNote(false);
            setText(t);
            if (sg?.type === 'template' && sg.refId)
              void post(`/templates/${sg.refId}/used`).catch(() => undefined);
          }}
        />
      )}
      {slash.open && <SlashList items={slash.items} onPick={pickTemplate} />}
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
          minRows={voice ? 1 : 2}
          maxRows={6}
          placeholder={
            hint
              ? t.workspace.podskazkaOperatoruPlaceholder
              : voice
                ? t.workspace.callNotePlaceholder
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
            {voice ? t.workspace.saveNote : t.workspace.otpravit}
          </Button>
        </Stack>
      </Group>
      <Group gap="md" display={voice ? 'none' : undefined}>
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
        {(history.data ?? []).map((h) => (
          <Text
            key={h.id}
            size="xs"
            style={{ cursor: 'pointer' }}
            fw={h.id === conv.id ? 700 : 400}
            onClick={() => onOpen(h.id)}
          >
            {new Date(String(h.createdAt)).toLocaleDateString('ru-RU')} ·{' '}
            {CHANNEL[String(h.channelKind)] ?? String(h.channelKind)} ·{' '}
            {STATUS[String(h.status)] ?? String(h.status)}
            {h.topicName ? ` · ${String(h.topicName)}` : ''}
          </Text>
        ))}
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

function ConversationCard({ conv }: { conv: Row }) {
  const topics = useList('/topics');
  const objects = useList(
    conv.enterpriseId ? `/dict/objects?enterpriseId=${String(conv.enterpriseId)}` : '/dict/objects',
    !!conv.enterpriseId,
  );
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
  const isPostponed = dispositions.data?.find((d) => d.id === disp)?.behavior === 'postponed';
  const isEscalate = dispositions.data?.find((d) => d.id === disp)?.behavior === 'escalate';
  const [escalating, setEscalating] = useState(false);
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
  // Порядок — как в справочнике тем (порядок темы, затем её подтемы), а не по алфавиту.
  const rank = (x: Row): [number, string, number, number, string] => {
    const parent = x.parentId ? byId.get(String(x.parentId)) : undefined;
    const root = parent ?? x;
    return [
      Number(root.sortOrder ?? 0),
      String(root.name),
      parent ? 1 : 0,
      Number(x.sortOrder ?? 0),
      String(x.name),
    ];
  };
  const cmp = (a: Row, b: Row) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      const d =
        typeof ra[i] === 'number'
          ? (ra[i] as number) - (rb[i] as number)
          : String(ra[i]).localeCompare(String(rb[i]), 'ru');
      if (d) return d;
    }
    return 0;
  };
  const topicOptions = [...(topics.data ?? [])].sort(cmp).map((x) => {
    const parent = x.parentId ? byId.get(String(x.parentId)) : undefined;
    const label = parent ? `${String(parent.name)} › ${String(x.name)}` : String(x.name);
    return { value: String(x.id), label: `${label}${x.isImportant ? ' ❗' : ''}` };
  });
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
  return (
    <Stack gap="sm">
      <EscalateModal conv={conv} opened={escalating} onClose={() => setEscalating(false)} />
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
      <Paper
        withBorder
        p="xs"
        style={!conv.topicId && !closed ? { borderColor: 'var(--mantine-color-blue-4)' } : undefined}
      >
        <TopicPicker
          size="sm"
          label={t.workspace.stepTopic}
          description={!conv.topicId && !closed ? t.workspace.stepTopicHint : undefined}
          placeholder={t.workspace.stepTopicPlaceholder}
          value={(conv.topicId as string) ?? null}
          onChange={(v) => upd.mutate({ topicId: v })}
          clearable
          disabled={closed}
          testId="topic"
        />
        {conv.topicId ? (
          <Text size="xs" c="dimmed" mt={4} data-testid="topic-full">
            {topicOptions.find((o) => o.value === String(conv.topicId))?.label}
          </Text>
        ) : null}
      </Paper>
      {!!conv.topicId && (fields.data ?? []).length > 0 && (
        <Paper withBorder p="xs" data-testid="topic-fields">
          <Text size="sm" fw={600}>
            {t.workspace.stepAsk}
          </Text>
          <Text size="xs" c="dimmed" mb={4}>
            {t.workspace.stepAskHint}
          </Text>
          <Stack gap={6}>
            {(fields.data ?? []).map((f) => {
              const k = String(f.key);
              const label = `${String(f.label)}${f.requiredOnClose ? ' *' : f.requiredOnEscalate ? ' ★' : ''}`;
              const description = undefined;
              return f.type === 'select' && Array.isArray(f.options) ? (
                <Select
                  key={String(f.id)}
                  size="xs"
                  label={label}
                  description={description}
                  data={(f.options as string[]).map(String)}
                  value={(vals[k] as string) ?? null}
                  onChange={(v) => saveField(k, v)}
                  clearable
                  disabled={closed}
                />
              ) : (
                <TextInput
                  key={String(f.id)}
                  size="xs"
                  label={label}
                  description={description}
                  placeholder={(f.mask as string) ?? undefined}
                  type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
                  value={String(vals[k] ?? '')}
                  onChange={(e) => setVals({ ...vals, [k]: e.currentTarget.value })}
                  onBlur={() => upd.mutate({ fields: vals })}
                  disabled={closed}
                />
              );
            })}
          </Stack>
        </Paper>
      )}
      <ExtraFields fields={(conv.fields as Record<string, unknown>) ?? {}} defined={fields.data ?? []} />
      <Paper withBorder p="xs">
        <Text size="sm" fw={600} mb={4}>
          {t.workspace.stepWhere}
        </Text>
        <Stack gap={6}>
          <OrgPicker
            enterpriseId={(conv.enterpriseId as string) ?? null}
            departmentId={(conv.departmentId as string) ?? null}
            onChange={(e, d) =>
              upd.mutate({
                enterpriseId: e,
                departmentId: d,
                ...(e !== conv.enterpriseId ? { objectId: null } : {}),
              })
            }
            clearable
            disabled={closed}
            testId="org"
          />
          <Select
            size="xs"
            label={t.workspace.obekt}
            data={options(objects.data)}
            value={(conv.objectId as string) ?? null}
            onChange={(v) => upd.mutate({ objectId: v })}
            clearable
            searchable
            disabled={closed || !conv.enterpriseId}
          />
        </Stack>
      </Paper>
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
                label={conv.queueRequireTag ? t.workspace.tegi : t.workspace.tegi2}
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
                data-testid="callback-at"
              />
            )}
            {isEscalate ? (
              <Button
                mt="xs"
                fullWidth
                color="violet"
                disabled={tagMissing}
                onClick={() => setEscalating(true)}
                data-testid="escalate"
              >
                {t.workspace.peredatNa2Yu}
              </Button>
            ) : (
              <Button
                mt="xs"
                fullWidth
                color="green"
                disabled={!disp || (isPostponed && !callbackAt) || tagMissing}
                onClick={() => close.mutate(undefined)}
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
function CallsPanel({ conv }: { conv: Row }) {
  const { can } = useAuth();
  const calls = useList<CallRow>(`/conversations/${conv.id}/calls`);
  const listen = useAction(
    (id: string) => post(`/calls/${id}/listen`),
    t.workspace.zvonokProslushivaniyaOtvetteV,
  );
  if (!calls.data?.length)
    return (
      <Text c="dimmed" size="sm">
        {t.workspace.zvonkovNet}
      </Text>
    );
  return (
    <Stack gap="sm" data-testid="calls">
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

/** Второстепенная вкладка списка: подпись и число, выделение — если выбрана. */
function SubTab({
  value,
  cur,
  onPick,
  n,
  label,
}: {
  value: string;
  cur: string;
  onPick(v: string): void;
  n: number;
  label: string;
}) {
  return (
    <Button
      size="compact-xs"
      variant={cur === value ? 'filled' : n ? 'light' : 'subtle'}
      color={n && cur !== value ? 'orange' : 'gray'}
      onClick={() => onPick(value)}
    >
      {label}
      {n ? ` (${n})` : ''}
    </Button>
  );
}

export function WorkspacePage() {
  const { me, can } = useAuth();
  // Вкладки списка и карточки — в порядке из интерфейса роли; первая открывается по умолчанию.
  const wsUi = me?.ui?.workspace;
  const [tab, setTab] = useState(wsUi?.listTabs?.[0] ?? 'mine');
  const [selected, setSelected] = useState<string | null>(null);
  const [typingContact, setTypingContact] = useState<string | null>(null);
  const qc = useQueryClient();
  const rt = useRealtime(true);
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
  const workTab = tab === 'hold' || tab === 'wrapup';
  const nApprovals = useTicketCount('approvals');
  // Счётчики «Удержание»/«Постобработка» (M-OP-02): списки обновляются по событиям realtime и раз в 30 с —
  // чат попадает в «Постобработку» по времени молчания клиента, без события.
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
  const rightTabs = useMemo(
    () =>
      orderTabs(
        [
          { value: 'card', label: t.workspace.obrashchenie },
          { value: 'contact', label: t.workspace.klient },
          { value: 'calls', label: t.workspace.zvonki, testId: 'tab-calls' },
        ],
        wsUi?.rightTabs,
      ),
    [wsUi],
  );

  return (
    <Grid gutter="sm">
      <Grid.Col span={3}>
        <Group justify="space-between" mb="xs">
          <Title order={4}>{t.workspace.obrashcheniya}</Title>
          <Badge color={rt.connected ? 'green' : 'red'} variant="dot" data-testid="rt-status">
            {rt.connected ? t.workspace.onlayn : t.workspace.netSvyazi}
          </Badge>
        </Group>
        <Box mb="xs">
          <AgentStatusBar />
        </Box>
        <SegmentedControl
          fullWidth
          size="xs"
          data={tabs}
          value={secondLine || workTab ? '' : tab}
          onChange={setTab}
          mb={4}
          data-testid="tabs"
        />
        <Group gap={4} mb="xs" wrap="wrap">
          <Group gap={4} data-testid="tabs-work">
            <SubTab value="hold" cur={tab} onPick={setTab} n={nHold} label={t.workspace.uderzhanie} />
            <SubTab value="wrapup" cur={tab} onPick={setTab} n={nWrapup} label={t.workspace.postobrabotka3} />
          </Group>
          <Group gap={4} data-testid="tabs-2nd-line">
            <SubTab
              value="approvals"
              cur={tab}
              onPick={setTab}
              n={nApprovals}
              label={t.workspace.naSoglasovanii2}
            />
            <SubTab value="created" cur={tab} onPick={setTab} n={0} label={t.workspace.peredannye} />
          </Group>
        </Group>
        <ScrollArea h="calc(100vh - 230px)">
          {secondLine ? (
            <Stack gap="xs">
              <TicketList view={tab} extra={tab === 'created' ? '&status=new,in_work,approval,rework' : ''} />
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
            <List tab={tab} selected={selected} onSelect={setSelected} />
          )}
        </ScrollArea>
      </Grid.Col>
      <Grid.Col span={5}>
        {conv.data ? (
          <Stack gap="xs">
            <Group justify="space-between">
              <Box>
                <Text fw={700}>{String(conv.data.contactName)}</Text>
                <Text size="xs" c="dimmed">
                  {CHANNEL[String(conv.data.channelKind)]} ·{' '}
                  {STATUS[String(conv.data.status)] ?? String(conv.data.status)}
                  {conv.data.assigneeName ? t.workspace.vedet(String(conv.data.assigneeName)) : ''}
                </Text>
              </Box>
              {conv.data.status === 'queued' && (
                <Button
                  size="xs"
                  onClick={() =>
                    void post(`/conversations/${selected}/take`).then(() => qc.invalidateQueries())
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
                      void post(`/conversations/${selected}/accept`).then(() => qc.invalidateQueries())
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
      <Grid.Col span={4}>
        {conv.data && (
          <Tabs defaultValue={rightTabs[0]?.value ?? 'card'}>
            <Tabs.List mb="xs">
              {rightTabs.map((x) => (
                <Tabs.Tab key={x.value} value={x.value} data-testid={'testId' in x ? x.testId : undefined}>
                  {x.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <ScrollArea h="calc(100vh - 170px)">
              <Tabs.Panel value="card">
                <ConversationCard conv={conv.data} />
              </Tabs.Panel>
              <Tabs.Panel value="contact">
                <ContactCard conv={conv.data} onOpen={setSelected} />
              </Tabs.Panel>
              <Tabs.Panel value="calls">
                <CallsPanel conv={conv.data} />
              </Tabs.Panel>
            </ScrollArea>
          </Tabs>
        )}
      </Grid.Col>
    </Grid>
  );
}
