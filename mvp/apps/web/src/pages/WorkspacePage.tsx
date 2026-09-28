import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
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
import { softphone, useSoftphone } from '../lib/softphone';

const CHANNEL: Record<string, string> = {
  webchat: 'Сайт',
  app: 'Приложение',
  telegram: 'Telegram',
  email: 'Email',
  voice: 'Звонок',
};
const STATUS: Record<string, string> = {
  queued: 'В очереди',
  active: 'В работе',
  closed: 'Закрыто',
  hold: 'Удержание',
  waiting_customer: 'Ждём клиента',
};
const time = (s: unknown) =>
  s ? new Date(String(s)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
const since = (s: unknown) => {
  if (!s) return '';
  const min = Math.floor((Date.now() - new Date(String(s)).getTime()) / 60000);
  return min < 1 ? 'только что' : min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`;
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
  const setStatus = useAction((b: Record<string, unknown>) => post('/agent-status', b), 'Статус изменён');
  const cur = String(status.data?.status ?? 'offline');
  if (cur === 'wrap_up') {
    const until = status.data?.wrapUpUntil ? new Date(String(status.data.wrapUpUntil)).getTime() : 0;
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    return (
      <Badge color="yellow" variant="light" data-testid="agent-status">
        Постобработка · {left} с
      </Badge>
    );
  }
  return (
    <Group gap={4}>
      <SegmentedControl
        size="xs"
        data-testid="agent-status"
        value={cur}
        onChange={(v) =>
          setStatus.mutate(
            v === 'break' ? { status: 'break', reasonId: reasons.data?.[0]?.id } : { status: v },
          )
        }
        data={[
          { value: 'ready', label: 'Готов' },
          { value: 'break', label: 'Перерыв' },
          { value: 'offline', label: 'Офлайн' },
        ]}
      />
      {cur === 'break' && (
        <Select
          size="xs"
          w={170}
          placeholder="Причина"
          data-testid="agent-status-reason"
          data={options(reasons.data)}
          value={(status.data?.reasonId as string) ?? null}
          onChange={(v) => v && setStatus.mutate({ status: 'break', reasonId: v })}
        />
      )}
    </Group>
  );
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
  const list = useList(`/conversations?tab=${tab}${important ? '&important=true' : ''}`);
  const take = useAction((id: string) => post(`/conversations/${id}/take`), 'Диалог взят в работу');
  const accept = useAction((id: string) => post(`/conversations/${id}/accept`), 'Обращение принято');
  const decline = useAction((id: string) => post(`/conversations/${id}/decline`), 'Обращение отклонено');
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
          Нет обращений
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
            {c.lastDirection === 'out' ? 'Вы: ' : ''}
            {String(c.lastMessage ?? '')}
          </Text>
          <Group gap={4} mt={4}>
            <Badge size="xs" variant="light">
              {CHANNEL[String(c.channelKind)] ?? String(c.channelKind)}
            </Badge>
            {c.isImportant ? (
              <Badge size="xs" color="red">
                особо важное
              </Badge>
            ) : null}
            {c.isUrgent ? (
              <Badge size="xs" color="orange">
                срочное
              </Badge>
            ) : null}
            {c.topicName ? (
              <Badge size="xs" variant="outline">
                {String(c.topicName)}
              </Badge>
            ) : null}
            {c.status === 'offered' ? (
              <Badge size="xs" color="blue">
                предложено
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
              Взять
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
                Принять
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
                Отклонить
              </Button>
            </Group>
          )}
        </Card>
      ))}
    </Stack>
  );
}

/** Доставка ответа во внешний канал (Telegram, email): ставится в очередь → отправлено / ошибка. */
function Delivery({ m }: { m: Row }) {
  if (m.deliveryStatus === 'sent')
    return (
      <span data-testid="delivery-sent" title="Отправлено клиенту">
        {' '}
        · ✓ отправлено
      </span>
    );
  if (m.deliveryStatus === 'failed')
    return (
      <span data-testid="delivery-failed" style={{ color: 'var(--mantine-color-red-7)' }}>
        {' '}
        · ⚠ не доставлено{m.deliveryError ? `: ${String(m.deliveryError)}` : ''}
      </span>
    );
  if (m.deliveryStatus === 'pending') return <span data-testid="delivery-pending"> · отправляется…</span>;
  return null;
}

function Messages({ conv, typing, onTyping }: { conv: Row; typing: boolean; onTyping(): void }) {
  const { me } = useAuth();
  const msgs = useList(`/conversations/${conv.id}/messages`);
  const [text, setText] = useState('');
  const [note, setNote] = useState(false);
  const [files, setFiles] = useState<Att[]>([]);
  const [busy, setBusy] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  useEffect(() => viewport.current?.scrollTo({ top: viewport.current.scrollHeight }), [msgs.data, typing]);
  const canWrite = note
    ? conv.status !== 'closed'
    : conv.assigneeId === me?.id && ['active', 'hold'].includes(String(conv.status));
  const send = async () => {
    if (!text.trim() && !files.length) return;
    setBusy(true);
    try {
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
  return (
    <Stack h="100%" gap="xs">
      <ScrollArea h="calc(100vh - 330px)" viewportRef={viewport} type="auto">
        <Stack gap={6} p="xs" data-testid="messages">
          {(msgs.data ?? []).map((m) => {
            const dir = String(m.direction);
            const style =
              dir === 'in'
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
                      ? String(conv.contactName)
                      : dir === 'note'
                        ? `Заметка · ${String(m.authorName ?? 'система')}`
                        : String(m.authorName ?? '')}{' '}
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
                {(m.attachments as Att[]).map((a) => (
                  <Text
                    key={a.id}
                    size="sm"
                    c="blue"
                    style={{ cursor: 'pointer' }}
                    onClick={() => void openAttachment(a.id)}
                  >
                    📎 {a.filename} ({Math.ceil(a.size / 1024)} КБ)
                  </Text>
                ))}
              </Paper>
            );
          })}
        </Stack>
      </ScrollArea>
      {typing && (
        <Text size="xs" c="dimmed">
          Клиент печатает…
        </Text>
      )}
      {conv.status === 'closed' ? (
        <Text c="dimmed" size="sm">
          Обращение закрыто.
        </Text>
      ) : !note && conv.status === 'offered' && conv.assigneeId === me?.id ? (
        <Text c="dimmed" size="sm">
          Примите предложенное обращение, чтобы ответить клиенту (заметку можно оставить всегда).
        </Text>
      ) : !note && conv.assigneeId !== me?.id ? (
        <Text c="dimmed" size="sm">
          Возьмите обращение, чтобы ответить клиенту (заметку можно оставить всегда).
        </Text>
      ) : null}
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
            note
              ? 'Внутренняя заметка (клиент её не увидит)'
              : 'Ответ клиенту… (Enter — отправить, Shift+Enter — новая строка)'
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
              <Button {...props} variant="default" size="xs" data-testid="attach">
                📎 Файл
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
            Отправить
          </Button>
        </Stack>
      </Group>
      <Switch
        size="xs"
        label="Внутренняя заметка"
        checked={note}
        onChange={(e) => setNote(e.currentTarget.checked)}
      />
    </Stack>
  );
}

function ContactCard({ conv, onOpen }: { conv: Row; onOpen(id: string): void }) {
  const { me } = useAuth();
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
        label="Имя"
        value={v.displayName ?? ''}
        onChange={(e) => setV({ ...v, displayName: e.currentTarget.value })}
      />
      <TextInput
        size="xs"
        label="Телефон"
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
          Позвонить {v.phone}
        </Button>
      )}
      <TextInput
        size="xs"
        label="Email"
        value={v.email ?? ''}
        onChange={(e) => setV({ ...v, email: e.currentTarget.value })}
      />
      <Button size="xs" variant="light" onClick={() => save.mutate(undefined)}>
        Сохранить клиента
      </Button>
      <Title order={6} mt="sm">
        История обращений ({history.data?.length ?? 0})
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

function ConversationCard({ conv }: { conv: Row }) {
  const topics = useList('/topics');
  const enterprises = useList('/dict/enterprises');
  const eds = useList(
    conv.enterpriseId
      ? `/enterprise-departments?enterpriseId=${String(conv.enterpriseId)}`
      : '/enterprise-departments?enterpriseId=none',
    !!conv.enterpriseId,
  );
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
  const close = useAction(
    () =>
      post(`/conversations/${conv.id}/close`, {
        dispositionId: disp,
        ...(isPostponed && callbackAt ? { callbackAt: new Date(callbackAt).toISOString() } : {}),
      }),
    'Обращение закрыто',
  );
  const transfer = useAction(() => {
    const [kind, id] = String(to).split(':');
    return post(`/conversations/${conv.id}/transfer`, kind === 'u' ? { toUserId: id } : { toQueueId: id });
  }, 'Диалог передан');
  const topicOptions = (topics.data ?? []).map((t) => ({
    value: t.id,
    label: `${'— '.repeat(Number(t.level) - 1)}${String(t.name)}${t.isImportant ? ' ❗' : ''}`,
  }));
  const closed = conv.status === 'closed';
  return (
    <Stack gap="xs">
      <Select
        size="xs"
        label="Тема"
        data={topicOptions}
        value={(conv.topicId as string) ?? null}
        onChange={(v) => upd.mutate({ topicId: v })}
        searchable
        clearable
        disabled={closed}
        data-testid="topic"
      />
      <Select
        size="xs"
        label="Предприятие"
        data={options(enterprises.data)}
        value={(conv.enterpriseId as string) ?? null}
        onChange={(v) => upd.mutate({ enterpriseId: v, departmentId: null, objectId: null })}
        clearable
        disabled={closed}
      />
      <Group grow>
        <Select
          size="xs"
          label="Подразделение"
          data={(eds.data ?? []).map((e) => ({
            value: String(e.departmentId),
            label: String(e.departmentName),
          }))}
          value={(conv.departmentId as string) ?? null}
          onChange={(v) => upd.mutate({ departmentId: v })}
          clearable
          disabled={closed || !conv.enterpriseId}
        />
        <Select
          size="xs"
          label="Объект"
          data={options(objects.data)}
          value={(conv.objectId as string) ?? null}
          onChange={(v) => upd.mutate({ objectId: v })}
          clearable
          searchable
          disabled={closed || !conv.enterpriseId}
        />
      </Group>
      {(fields.data ?? []).map((f) => (
        <TextInput
          key={f.id}
          size="xs"
          label={`${String(f.label)}${f.requiredOnClose ? ' *' : ''}`}
          description={
            f.requiredOnEscalate && !f.requiredOnClose ? 'обязательно при передаче на 2-ю линию' : undefined
          }
          placeholder={(f.mask as string) ?? undefined}
          type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
          value={String(vals[String(f.key)] ?? '')}
          onChange={(e) => setVals({ ...vals, [String(f.key)]: e.currentTarget.value })}
          onBlur={() => upd.mutate({ fields: vals })}
          disabled={closed}
        />
      ))}
      <MultiSelect
        size="xs"
        label="Теги"
        data={options(tags.data)}
        value={(conv.tagIds as string[]) ?? []}
        onChange={(v) => upd.mutate({ tagIds: v })}
        disabled={closed}
      />
      <Group>
        <Tooltip label="Ставится автоматически по теме; можно выставить вручную">
          <Switch
            size="xs"
            label="Особо важное"
            checked={!!conv.isImportant}
            onChange={(e) => upd.mutate({ isImportant: e.currentTarget.checked })}
            disabled={closed}
          />
        </Tooltip>
        <Switch
          size="xs"
          label="Срочное"
          checked={!!conv.isUrgent}
          onChange={(e) => upd.mutate({ isUrgent: e.currentTarget.checked })}
          disabled={closed}
        />
      </Group>
      {!closed && (
        <>
          <Paper withBorder p="xs">
            <Select
              size="xs"
              label="Результат обработки"
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
                label="Дата и время перезвона"
                value={callbackAt}
                onChange={(e) => setCallbackAt(e.currentTarget.value)}
                data-testid="callback-at"
              />
            )}
            <Button
              size="xs"
              mt="xs"
              fullWidth
              color="green"
              disabled={!disp || (isPostponed && !callbackAt)}
              onClick={() => close.mutate(undefined)}
              data-testid="close"
            >
              Завершить обращение
            </Button>
          </Paper>
          <Paper withBorder p="xs">
            <Select
              size="xs"
              label="Передать"
              data={[
                {
                  group: 'Операторам',
                  items: (operators.data ?? []).map((o) => ({
                    value: `u:${o.id}`,
                    label: String(o.fullName),
                  })),
                },
                {
                  group: 'В очередь',
                  items: (queues.data ?? []).map((q) => ({ value: `q:${q.id}`, label: String(q.name) })),
                },
              ]}
              value={to}
              onChange={setTo}
              searchable
            />
            <Button
              size="xs"
              mt="xs"
              fullWidth
              variant="light"
              disabled={!to}
              onClick={() => transfer.mutate(undefined)}
            >
              Передать с контекстом
            </Button>
          </Paper>
        </>
      )}
    </Stack>
  );
}

const CALL_STATE: Record<string, string> = {
  queued: 'ожидает оператора',
  dialing: 'вызов',
  talking: 'разговор',
  external: 'переведён на внешний номер',
  ended: 'завершён',
};
const CALL_EVENT: Record<string, string> = {
  queued: 'в очереди',
  offered: 'вызов оператора',
  agent_connected: 'оператор ответил',
  agent_no_answer: 'оператор не ответил',
  agent_declined: 'оператор отклонил',
  hold: 'удержание',
  unhold: 'снято с удержания',
  transfer_queue: 'перевод в очередь',
  transfer_user: 'перевод оператору',
  transfer_external: 'прямой перевод',
  external_connected: 'подразделение ответило',
  listen: 'прослушивание супервизором',
  dialing_out: 'исходящий вызов',
  ended: 'завершён',
};

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
  recordings: { id: string; status: string; durationS: number | null }[];
  events: { at: string; type: string; userName: string | null }[];
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
      Прослушать запись
    </Button>
  );
}

/** Журнал вызовов обращения и записи разговоров (M-TEL-04/05); супервизору — прослушивание (M-TEL-10). */
function CallsPanel({ conv }: { conv: Row }) {
  const { can } = useAuth();
  const calls = useList<CallRow>(`/conversations/${conv.id}/calls`);
  const listen = useAction(
    (id: string) => post(`/calls/${id}/listen`),
    'Звонок прослушивания — ответьте в софтфоне',
  );
  if (!calls.data?.length)
    return (
      <Text c="dimmed" size="sm">
        Звонков нет
      </Text>
    );
  return (
    <Stack gap="sm" data-testid="calls">
      {calls.data.map((c) => (
        <Paper key={c.id} withBorder p="xs" data-testid="call-item">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              {c.direction === 'in' ? `Входящий ${c.fromNumber ?? ''}` : `Исходящий ${c.toNumber ?? ''}`}
            </Text>
            <Badge variant="light" data-testid="call-state">
              {CALL_STATE[c.state] ?? c.state}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            {time(c.startedAt)} · ожидание {c.waitS} с · разговор {c.talkS} с
            {c.agentName ? ` · ${c.agentName}` : ''}
          </Text>
          <Text size="xs" c="dimmed">
            {c.events.map((e) => `${time(e.at)} ${CALL_EVENT[e.type] ?? e.type}`).join(' → ')}
          </Text>
          {c.state === 'talking' && can('supervisor.monitor') && (
            <Button
              size="xs"
              mt={4}
              variant="light"
              onClick={() => listen.mutate(c.id)}
              data-testid="call-listen"
            >
              Прослушать разговор
            </Button>
          )}
          {c.recordings.map((r) =>
            r.status === 'uploaded' ? (
              <Recording key={r.id} id={r.id} />
            ) : (
              <Text key={r.id} size="xs" c="dimmed">
                Запись: {r.status === 'failed' ? 'не сохранилась' : 'обрабатывается…'}
              </Text>
            ),
          )}
        </Paper>
      ))}
    </Stack>
  );
}

export function WorkspacePage() {
  const { me, can } = useAuth();
  const [tab, setTab] = useState('mine');
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
          if (e.data.assigneeId === me?.id) notify('Новое сообщение', String(m.body ?? '').slice(0, 100));
          if (id === selected) setTypingContact(null);
        }
        if (e.event === 'conversation.created')
          notify('Новое обращение в очереди', 'Откройте вкладку «Очередь»');
        if (e.event === 'conversation.updated' && e.data.action === 'offered' && e.data.assigneeId === me?.id)
          notify('Вам предложено обращение', 'Примите или отклоните во вкладке «Мои»');
      }),
    [qc, me?.id, selected],
  );

  const tabs = useMemo(
    () => [
      { value: 'mine', label: 'Мои' },
      { value: 'queue', label: 'Очередь' },
      ...(can('supervisor.monitor') ? [{ value: 'active', label: 'Все открытые' }] : []),
      { value: 'closed', label: 'Закрытые' },
    ],
    [can],
  );

  return (
    <Grid gutter="sm">
      <Grid.Col span={3}>
        <Group justify="space-between" mb="xs">
          <Title order={4}>Обращения</Title>
          <Badge color={rt.connected ? 'green' : 'red'} variant="dot" data-testid="rt-status">
            {rt.connected ? 'онлайн' : 'нет связи'}
          </Badge>
        </Group>
        <Box mb="xs">
          <AgentStatusBar />
        </Box>
        <SegmentedControl
          fullWidth
          size="xs"
          data={tabs}
          value={tab}
          onChange={setTab}
          mb="xs"
          data-testid="tabs"
        />
        <ScrollArea h="calc(100vh - 190px)">
          <List tab={tab} selected={selected} onSelect={setSelected} />
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
                  {conv.data.assigneeName ? ` · ведёт ${String(conv.data.assigneeName)}` : ''}
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
                  Взять
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
                    Принять
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
                    Отклонить
                  </Button>
                </Group>
              )}
            </Group>
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
            Выберите обращение слева
          </Text>
        )}
      </Grid.Col>
      <Grid.Col span={4}>
        {conv.data && (
          <Tabs defaultValue="card">
            <Tabs.List mb="xs">
              <Tabs.Tab value="card">Обращение</Tabs.Tab>
              <Tabs.Tab value="contact">Клиент</Tabs.Tab>
              <Tabs.Tab value="calls" data-testid="tab-calls">
                Звонки
              </Tabs.Tab>
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
