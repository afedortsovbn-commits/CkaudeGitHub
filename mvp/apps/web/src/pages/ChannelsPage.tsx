import { Badge, Button, Code, Modal, Table, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DictPage } from '../components/DictPage';
import type { FormField } from '../components/FormModal';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, options, useList } from '../lib/data';

/** Маска секрета от api: «не менять». */
const MASK = '********';

const KINDS = [
  { value: 'webchat', label: 'Чат на сайте' },
  { value: 'app', label: 'Чат в приложении' },
  { value: 'telegram', label: 'Telegram-бот' },
  { value: 'email', label: 'Электронная почта' },
  { value: 'voice', label: 'Телефон' },
  { value: 'api', label: 'Внешняя система (API)' },
];
const kindLabel = (k: unknown) => KINDS.find((x) => x.value === k)?.label ?? String(k ?? '');

const isChat = (v: Record<string, unknown>) => v.kind === 'webchat' || v.kind === 'app';
const isTg = (v: Record<string, unknown>) => v.kind === 'telegram';
const isMail = (v: Record<string, unknown>) => v.kind === 'email';
const isVoice = (v: Record<string, unknown>) => v.kind === 'voice';

const STATUS: Record<string, { color: string; label: string }> = {
  connected: { color: 'green', label: 'Подключён' },
  error: { color: 'red', label: 'Ошибка' },
  disabled: { color: 'gray', label: 'Выключен' },
};

const cfg = (r: Row) => (r.config ?? {}) as Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
/** Пустое поле секрета при изменении — оставить прежнее значение. */
const secret = (v: unknown, isCreate: boolean) => (v ? String(v) : isCreate ? undefined : MASK);
const secretHint = 'При изменении оставьте пустым, чтобы не менять';

function ChannelStatus({ row }: { row: Row }) {
  if (row.kind !== 'telegram' && row.kind !== 'email') return null;
  const s = STATUS[str(row.status)] ?? { color: 'gray', label: 'Нет данных' };
  return (
    <Tooltip label={str(row.statusDetail) || s.label} multiline maw={400} disabled={!row.statusDetail}>
      <Badge color={s.color} variant="light" data-testid="channel-status">
        {s.label}
      </Badge>
    </Tooltip>
  );
}

interface LogEntry {
  id: string;
  at: string;
  direction: 'in' | 'out' | 'system';
  ok: boolean;
  summary: string;
}

function ChannelLog({ channel, onClose }: { channel: Row | null; onClose(): void }) {
  const log = useQuery({
    queryKey: ['channel-log', channel?.id],
    queryFn: () =>
      get<{ status: string | null; statusDetail: string | null; entries: LogEntry[] }>(
        `/channels/${channel!.id}/log`,
      ),
    enabled: !!channel,
    refetchInterval: 5000,
  });
  const dir = { in: 'Приём', out: 'Отправка', system: 'Система' };
  return (
    <Modal opened={!!channel} onClose={onClose} title={`Журнал канала «${str(channel?.name)}»`} size="xl">
      {log.data?.statusDetail && (
        <Text size="sm" mb="sm">
          Состояние: {log.data.statusDetail}
        </Text>
      )}
      <Table striped data-testid="channel-log">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Время</Table.Th>
            <Table.Th>Событие</Table.Th>
            <Table.Th>Описание</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(log.data?.entries ?? []).map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>{new Date(e.at).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}</Table.Td>
              <Table.Td>
                <Badge color={e.ok ? 'blue' : 'red'} variant="light">
                  {dir[e.direction]}
                </Badge>
              </Table.Td>
              <Table.Td>{e.summary}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {log.data && !log.data.entries.length && <Text c="dimmed">Записей пока нет</Text>}
    </Modal>
  );
}

const FIELDS: FormField[] = [
  { key: 'kind', label: 'Тип', type: 'select', required: true, createOnly: true, options: KINDS },
  { key: 'name', label: 'Название', required: true },
  // Чат на сайте и в приложении
  { key: 'publicKey', label: 'Ключ виджета (латиница, от 8 символов)', required: true, show: isChat },
  {
    key: 'allowedOrigins',
    label: 'Разрешённые сайты через запятую (https://site.by) или *',
    show: isChat,
  },
  { key: 'greeting', label: 'Приветствие', type: 'textarea', show: isChat },
  { key: 'consentText', label: 'Текст согласия на обработку ПДн', type: 'textarea', show: isChat },
  {
    key: 'consentVersion',
    label: 'Версия текста согласия',
    description: 'Измените при изменении текста — клиенты дадут согласие заново',
    show: isChat,
  },
  { key: 'maxFileMb', label: 'Макс. размер файла, МБ', type: 'number', show: isChat },
  // Telegram
  {
    key: 'botToken',
    label: 'Токен бота (от @BotFather)',
    type: 'password',
    description: `Хранится в зашифрованном виде. ${secretHint}`,
    show: isTg,
  },
  {
    key: 'tgMode',
    label: 'Режим получения сообщений',
    type: 'select',
    required: true,
    options: [
      { value: 'polling', label: 'Опрос (long polling) — не требует входящего доступа из интернета' },
      { value: 'webhook', label: 'Webhook — Telegram присылает сообщения на адрес КЦ' },
    ],
    show: isTg,
  },
  {
    key: 'apiRoot',
    label: 'Адрес Bot API',
    description: 'Пусто — api.telegram.org; иначе — адрес локального Bot API-сервера',
    placeholder: 'https://api.telegram.org',
    show: isTg,
  },
  // Телефон (Ф5)
  {
    key: 'dids',
    label: 'Номера, на которые звонят клиенты (через запятую)',
    description: 'Как их передаёт SIP-транк, например +375171234567; для демо-страницы и SIPp — 1000',
    required: true,
    show: isVoice,
  },
  { key: 'record', label: 'Записывать разговоры', type: 'switch', show: isVoice },
  // Email
  { key: 'address', label: 'Адрес ящика', required: true, show: isMail },
  { key: 'displayName', label: 'Имя отправителя в ответах', show: isMail },
  { key: 'imapHost', label: 'IMAP: сервер', required: true, show: isMail },
  { key: 'imapPort', label: 'IMAP: порт', type: 'number', required: true, show: isMail },
  { key: 'imapSecure', label: 'IMAP: TLS (IMAPS)', type: 'switch', show: isMail },
  { key: 'imapUser', label: 'IMAP: пользователь', required: true, show: isMail },
  { key: 'imapPassword', label: 'IMAP: пароль', type: 'password', description: secretHint, show: isMail },
  { key: 'mailbox', label: 'Папка входящих', show: isMail },
  { key: 'smtpHost', label: 'SMTP: сервер', required: true, show: isMail },
  { key: 'smtpPort', label: 'SMTP: порт', type: 'number', required: true, show: isMail },
  { key: 'smtpSecure', label: 'SMTP: TLS (SMTPS, порт 465)', type: 'switch', show: isMail },
  { key: 'smtpUser', label: 'SMTP: пользователь (пусто — без авторизации)', show: isMail },
  { key: 'smtpPassword', label: 'SMTP: пароль', type: 'password', description: secretHint, show: isMail },
  {
    key: 'tlsInsecure',
    label: 'Не проверять TLS-сертификат почтового сервера (самоподписанный в закрытом контуре)',
    type: 'switch',
    show: isMail,
  },
];

/** Запись → значения формы; секреты не показываются (пустое поле — «не менять»). */
const toForm = (r: Row) => {
  const c = cfg(r);
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    queueId: r.queueId,
    botFlowId: r.botFlowId,
    botWebhookId: r.botWebhookId,
    publicKey: c.public_key,
    allowedOrigins: ((c.allowed_origins as string[]) ?? []).join(', '),
    consentText: c.consent_text,
    consentVersion: c.consent_version,
    greeting: c.greeting,
    maxFileMb: c.max_file_mb,
    tgMode: c.mode ?? 'polling',
    apiRoot: c.api_root,
    address: c.address,
    displayName: c.display_name,
    imapHost: c.imap_host,
    imapPort: c.imap_port,
    imapSecure: c.imap_secure,
    imapUser: c.imap_user,
    mailbox: c.mailbox,
    smtpHost: c.smtp_host,
    smtpPort: c.smtp_port,
    smtpSecure: c.smtp_secure,
    smtpUser: c.smtp_user,
    tlsInsecure: c.tls_insecure,
    dids: ((c.dids as string[]) ?? []).join(', '),
    record: c.record ?? true,
    // секреты не показываются: пустое поле — «не менять»
  };
};

/** Значения формы → запись с вложенным config по типу канала. */
const fromForm = (v: Record<string, unknown>, editing: Row | null) => {
  const isCreate = !editing;
  const { name, queueId } = v;
  // Тип при изменении берётся из редактируемой записи (поле «Тип» показывается только при создании).
  const k = editing ? editing.kind : v.kind;
  const base = {
    ...(isCreate ? { kind: k } : {}),
    name,
    queueId,
    ...(k !== 'voice' ? { botFlowId: v.botFlowId ?? null, botWebhookId: v.botWebhookId ?? null } : {}),
  };
  // Внешняя система (Ф9): сообщения приходят по ключу API с правом «Внешний канал».
  if (k === 'api') return { ...base, config: {} };
  if (k === 'telegram')
    return {
      ...base,
      config: {
        bot_token: secret(v.botToken, isCreate),
        mode: v.tgMode ?? 'polling',
        ...(v.apiRoot ? { api_root: v.apiRoot } : {}),
      },
    };
  if (k === 'voice')
    return {
      ...base,
      config: {
        dids: str(v.dids)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        record: !!v.record,
      },
    };
  if (k === 'email')
    return {
      ...base,
      config: {
        address: v.address,
        ...(v.displayName ? { display_name: v.displayName } : {}),
        imap_host: v.imapHost,
        imap_port: v.imapPort,
        imap_secure: !!v.imapSecure,
        imap_user: v.imapUser,
        imap_password: secret(v.imapPassword, isCreate),
        mailbox: v.mailbox || 'INBOX',
        smtp_host: v.smtpHost,
        smtp_port: v.smtpPort,
        smtp_secure: !!v.smtpSecure,
        ...(v.smtpUser ? { smtp_user: v.smtpUser, smtp_password: secret(v.smtpPassword, isCreate) } : {}),
        tls_insecure: !!v.tlsInsecure,
      },
    };
  return {
    ...base,
    config: {
      // сохраняем поля, которых нет в форме (например, app_secret чата в приложении)
      ...(editing ? cfg(editing) : {}),
      ...(v.publicKey ? { public_key: v.publicKey } : {}),
      allowed_origins: str(v.allowedOrigins)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      ...(v.consentText ? { consent_text: v.consentText } : {}),
      consent_version: str(v.consentVersion || '1'),
      ...(v.greeting ? { greeting: v.greeting } : {}),
      ...(v.maxFileMb ? { max_file_mb: v.maxFileMb } : {}),
    },
  };
};

const CREATE_DEFAULTS = {
  kind: 'webchat',
  consentVersion: '1',
  tgMode: 'polling',
  imapPort: 993,
  imapSecure: true,
  mailbox: 'INBOX',
  smtpPort: 465,
  smtpSecure: true,
  record: true,
};

/** Экземпляры каналов: веб-чат, чат в приложении, Telegram-боты, почтовые ящики (M-CH-07). */
export function ChannelsPage() {
  const { can } = useAuth();
  const queues = useList('/dict/queues');
  const bots = useList('/flows?kind=text');
  // Внешние боты (Bot Gateway, Ф9) — «Администрирование → Внешние боты».
  const extBots = useList('/webhooks?kind=bot', can('admin.settings'));
  const [logOf, setLogOf] = useState<Row | null>(null);

  return (
    <>
      <DictPage
        kind="channels"
        title="Каналы"
        columns={[
          { key: 'name', label: 'Название' },
          { key: 'kind', label: 'Тип', render: (r) => kindLabel(r.kind) },
          {
            key: 'address',
            label: 'Адрес / ключ',
            render: (r) => {
              const c = cfg(r);
              if (r.kind === 'email') return str(c.address);
              if (r.kind === 'voice') return ((c.dids as string[]) ?? []).join(', ');
              if (r.kind === 'telegram') return c.mode === 'webhook' ? 'webhook' : 'опрос';
              if (r.kind === 'api') return 'по ключу API';
              return <Code>{str(c.public_key)}</Code>;
            },
          },
          {
            key: 'bot',
            label: 'Бот',
            render: (r) =>
              String(
                bots.data?.find((b) => b.id === r.botFlowId)?.name ??
                  extBots.data?.find((b) => b.id === r.botWebhookId)?.name ??
                  '—',
              ),
          },
          { key: 'conn', label: 'Подключение', render: (r) => <ChannelStatus row={r} /> },
        ]}
        rowActions={(r) =>
          r.kind === 'telegram' || r.kind === 'email' ? (
            <Button size="xs" variant="subtle" onClick={() => setLogOf(r)}>
              Журнал
            </Button>
          ) : null
        }
        toForm={toForm}
        fromForm={fromForm}
        createDefaults={CREATE_DEFAULTS}
        fields={[
          ...FIELDS.slice(0, 2),
          { key: 'queueId', label: 'Очередь по умолчанию', type: 'select', options: options(queues.data) },
          {
            key: 'botFlowId',
            label: 'Бот',
            type: 'select',
            options: options(bots.data),
            description: 'Новые обращения сначала ведёт бот (опубликованная версия), затем — оператор',
            show: (v) => v.kind !== 'voice',
          },
          {
            key: 'botWebhookId',
            label: 'Внешний бот',
            type: 'select',
            options: options(extBots.data),
            description: 'Бот внешней системы (Bot Gateway); действует, если сценарный бот не выбран',
            show: (v) => v.kind !== 'voice' && !v.botFlowId,
          },
          ...FIELDS.slice(2),
        ]}
      />
      <ChannelLog channel={logOf} onClose={() => setLogOf(null)} />
      <Text size="sm" mt="md">
        Код для сайта:{' '}
        <Code>{'<script src="https://<адрес-кц>/widget/widget.js" data-key="<ключ>" async></script>'}</Code>.
        Демо-страница:{' '}
        <a href="/widget/demo.html" target="_blank" rel="noreferrer">
          /widget/demo.html
        </a>
        , для WebView приложения — <Code>/widget/mobile.html?key=&lt;ключ&gt;</Code>. Telegram-бот и почтовый
        ящик начинают работать без перезапуска через несколько секунд после сохранения; состояние подключения
        и журнал — в колонке «Подключение» и по кнопке «Журнал».
      </Text>
    </>
  );
}
