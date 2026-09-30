import { Badge, Button, Code, Modal, Table, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DictPage } from '../components/DictPage';
import type { FormField } from '../components/FormModal';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, options, useList } from '../lib/data';
import { t } from '../lib/i18n';

/** Маска секрета от api: «не менять». */
const MASK = '********';

const KINDS = [
  { value: 'webchat', label: t.channels.chatNaSayte },
  { value: 'app', label: t.channels.chatVPrilozhenii },
  { value: 'telegram', label: t.channels.telegramBot },
  { value: 'email', label: t.channels.elektronnayaPochta },
  { value: 'voice', label: t.channels.telefon },
  { value: 'api', label: t.channels.vneshnyayaSistemaApi },
  { value: 'review', label: t.reviews.kindLabel },
];
const kindLabel = (k: unknown) => KINDS.find((x) => x.value === k)?.label ?? String(k ?? '');

const isChat = (v: Record<string, unknown>) => v.kind === 'webchat' || v.kind === 'app';
const isTg = (v: Record<string, unknown>) => v.kind === 'telegram';
const isMail = (v: Record<string, unknown>) => v.kind === 'email';
const isVoice = (v: Record<string, unknown>) => v.kind === 'voice';
const isReview = (v: Record<string, unknown>) => v.kind === 'review';
/** Каналы, которые обслуживает коннектор: у них есть состояние подключения и журнал обмена. */
const hasConnector = (k: unknown) => k === 'telegram' || k === 'email' || k === 'review';

const STATUS: Record<string, { color: string; label: string }> = {
  connected: { color: 'green', label: t.channels.podklyuchen },
  error: { color: 'red', label: t.error },
  disabled: { color: 'gray', label: t.channels.vyklyuchen },
};

const cfg = (r: Row) => (r.config ?? {}) as Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
/** Пустое поле секрета при изменении — оставить прежнее значение. */
const secret = (v: unknown, isCreate: boolean) => (v ? String(v) : isCreate ? undefined : MASK);
const secretHint = t.channels.priIzmeneniiOstavtePustym;

function ChannelStatus({ row }: { row: Row }) {
  if (!hasConnector(row.kind)) return null;
  const s = STATUS[str(row.status)] ?? { color: 'gray', label: t.channels.netDannykh };
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
  const dir = { in: t.channels.priem, out: t.channels.otpravka, system: t.channels.sistema };
  return (
    <Modal
      opened={!!channel}
      onClose={onClose}
      title={t.channels.zhurnalKanala(str(channel?.name))}
      size="xl"
    >
      {log.data?.statusDetail && (
        <Text size="sm" mb="sm">
          {t.channels.sostoyanie}
          {log.data.statusDetail}
        </Text>
      )}
      <Table striped data-testid="channel-log">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.channels.vremya}</Table.Th>
            <Table.Th>{t.channels.sobytie}</Table.Th>
            <Table.Th>{t.channels.opisanie}</Table.Th>
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
      {log.data && !log.data.entries.length && <Text c="dimmed">{t.channels.zapiseyPokaNet}</Text>}
    </Modal>
  );
}

const FIELDS: FormField[] = [
  { key: 'kind', label: t.channels.tip, type: 'select', required: true, createOnly: true, options: KINDS },
  { key: 'name', label: t.channels.nazvanie, required: true },
  // Чат на сайте и в приложении
  { key: 'publicKey', label: t.channels.klyuchVidzhetaLatinitsaOt, required: true, show: isChat },
  {
    key: 'allowedOrigins',
    label: t.channels.razreshennyeSaytyCherezZapyatuyu,
    show: isChat,
  },
  { key: 'greeting', label: t.channels.privetstvie, type: 'textarea', show: isChat },
  { key: 'consentText', label: t.channels.tekstSoglasiyaNaObrabotku, type: 'textarea', show: isChat },
  {
    key: 'consentVersion',
    label: t.channels.versiyaTekstaSoglasiya,
    description: t.channels.izmenitePriIzmeneniiTeksta,
    show: isChat,
  },
  { key: 'maxFileMb', label: t.channels.maksRazmerFaylaMb, type: 'number', show: isChat },
  // Telegram
  {
    key: 'botToken',
    label: t.channels.tokenBotaOtBotfather,
    type: 'password',
    description: t.channels.khranitsyaVZashifrovannomVide(secretHint),
    show: isTg,
  },
  {
    key: 'tgMode',
    label: t.channels.rezhimPolucheniyaSoobshcheniy,
    type: 'select',
    required: true,
    options: [
      { value: 'polling', label: t.channels.oprosLongPollingNe },
      { value: 'webhook', label: t.channels.webhookTelegramPrisylaetSoobshcheniy },
    ],
    show: isTg,
  },
  {
    key: 'apiRoot',
    label: t.channels.adresBotApi,
    description: t.channels.pustoApiTelegramOrg,
    placeholder: 'https://api.telegram.org',
    show: isTg,
  },
  // Телефон (Ф5)
  {
    key: 'dids',
    label: t.channels.nomeraNaKotoryeZvonyat,
    description: t.channels.kakIkhPeredaetSip,
    required: true,
    show: isVoice,
  },
  { key: 'record', label: t.channels.zapisyvatRazgovory, type: 'switch', show: isVoice },
  // Отзывы с карт через Rocket Data (Ф13)
  {
    key: 'rdApiUrl',
    label: t.reviews.apiUrl,
    required: true,
    placeholder: 'https://api.rocketdata.io',
    description: t.reviews.apiUrlHint,
    show: isReview,
  },
  {
    key: 'rdApiToken',
    label: t.reviews.apiToken,
    type: 'password',
    description: t.channels.khranitsyaVZashifrovannomVide(secretHint),
    show: isReview,
  },
  { key: 'rdPollS', label: t.reviews.pollS, type: 'number', required: true, show: isReview },
  { key: 'rdInitialDays', label: t.reviews.initialDays, type: 'number', show: isReview },
  {
    key: 'rdLowRating',
    label: t.reviews.lowRating,
    type: 'number',
    description: t.reviews.lowRatingHint,
    show: isReview,
  },
  { key: 'rdSkipAnswered', label: t.reviews.skipAnswered, type: 'switch', show: isReview },
  // Email
  { key: 'address', label: t.channels.adresYashchika, required: true, show: isMail },
  { key: 'displayName', label: t.channels.imyaOtpravitelyaVOtvetakh, show: isMail },
  { key: 'imapHost', label: t.channels.imapServer, required: true, show: isMail },
  { key: 'imapPort', label: t.channels.imapPort, type: 'number', required: true, show: isMail },
  { key: 'imapSecure', label: 'IMAP: TLS (IMAPS)', type: 'switch', show: isMail },
  { key: 'imapUser', label: t.channels.imapPolzovatel, required: true, show: isMail },
  {
    key: 'imapPassword',
    label: t.channels.imapParol,
    type: 'password',
    description: secretHint,
    show: isMail,
  },
  { key: 'mailbox', label: t.channels.papkaVkhodyashchikh, show: isMail },
  { key: 'smtpHost', label: t.channels.smtpServer, required: true, show: isMail },
  { key: 'smtpPort', label: t.channels.smtpPort, type: 'number', required: true, show: isMail },
  { key: 'smtpSecure', label: t.channels.smtpTlsSmtpsPort, type: 'switch', show: isMail },
  { key: 'smtpUser', label: t.channels.smtpPolzovatelPustoBez, show: isMail },
  {
    key: 'smtpPassword',
    label: t.channels.smtpParol,
    type: 'password',
    description: secretHint,
    show: isMail,
  },
  {
    key: 'tlsInsecure',
    label: t.channels.neProveryatTlsSertifikat,
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
    rdApiUrl: c.api_url,
    rdPollS: c.poll_interval_s ?? 300,
    rdInitialDays: c.initial_days ?? 7,
    rdLowRating: c.low_rating_max ?? 2,
    rdSkipAnswered: c.skip_answered ?? true,
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
  if (k === 'review')
    return {
      ...base,
      config: {
        api_url: v.rdApiUrl,
        api_token: secret(v.rdApiToken, isCreate),
        poll_interval_s: Number(v.rdPollS ?? 300),
        initial_days: Number(v.rdInitialDays ?? 7),
        low_rating_max: Number(v.rdLowRating ?? 2),
        skip_answered: !!v.rdSkipAnswered,
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
  rdPollS: 300,
  rdInitialDays: 7,
  rdLowRating: 2,
  rdSkipAnswered: true,
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
        title={t.channels.kanaly}
        columns={[
          { key: 'name', label: t.channels.nazvanie },
          { key: 'kind', label: t.channels.tip, render: (r) => kindLabel(r.kind) },
          {
            key: 'address',
            label: t.channels.adresKlyuch,
            render: (r) => {
              const c = cfg(r);
              if (r.kind === 'email') return str(c.address);
              if (r.kind === 'voice') return ((c.dids as string[]) ?? []).join(', ');
              if (r.kind === 'telegram') return c.mode === 'webhook' ? 'webhook' : t.channels.opros;
              if (r.kind === 'api') return t.channels.poKlyuchuApi;
              if (r.kind === 'review') return str(c.api_url);
              return <Code>{str(c.public_key)}</Code>;
            },
          },
          {
            key: 'bot',
            label: t.channels.bot,
            render: (r) =>
              String(
                bots.data?.find((b) => b.id === r.botFlowId)?.name ??
                  extBots.data?.find((b) => b.id === r.botWebhookId)?.name ??
                  '—',
              ),
          },
          { key: 'conn', label: t.channels.podklyuchenie, render: (r) => <ChannelStatus row={r} /> },
        ]}
        rowActions={(r) =>
          hasConnector(r.kind) ? (
            <Button size="xs" variant="subtle" onClick={() => setLogOf(r)}>
              {t.channels.zhurnal}
            </Button>
          ) : null
        }
        toForm={toForm}
        fromForm={fromForm}
        createDefaults={CREATE_DEFAULTS}
        fields={[
          ...FIELDS.slice(0, 2),
          {
            key: 'queueId',
            label: t.channels.ocheredPoUmolchaniyu,
            type: 'select',
            options: options(queues.data),
          },
          {
            key: 'botFlowId',
            label: t.channels.bot,
            type: 'select',
            options: options(bots.data),
            description: t.channels.novyeObrashcheniyaSnachalaVedet,
            show: (v) => v.kind !== 'voice' && v.kind !== 'review',
          },
          {
            key: 'botWebhookId',
            label: t.channels.vneshniyBot,
            type: 'select',
            options: options(extBots.data),
            description: t.channels.botVneshneySistemyBot,
            show: (v) => v.kind !== 'voice' && v.kind !== 'review' && !v.botFlowId,
          },
          ...FIELDS.slice(2),
        ]}
      />
      <ChannelLog channel={logOf} onClose={() => setLogOf(null)} />
      <Text size="sm" mt="md">
        {t.channels.kodDlyaSayta} <Code>{t.channels.scriptSrcHttpsAdres}</Code>
        {t.channels.demoStranitsa}{' '}
        <a href="/widget/demo.html" target="_blank" rel="noreferrer">
          /widget/demo.html
        </a>
        {t.channels.dlyaWebviewPrilozheniya}
        <Code>{t.channels.widgetMobileHtmlKey}</Code>
        {t.channels.telegramBotIPochtovyy}
        {t.reviews.channelsNote}
      </Text>
    </>
  );
}
