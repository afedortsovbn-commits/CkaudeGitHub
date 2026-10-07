import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  CopyButton,
  FileButton,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, authBlobUrl, errorText, get, patch, post, upload } from '../lib/api';
import { options, type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

/**
 * Интеграции (Ф9): ключи публичного API, подписки webhooks, внешние боты (Bot Gateway), экспорт и импорт
 * конфигурации, документация API.
 */

interface Catalog {
  permissions: { code: string; title: string }[];
  events: { code: string; title: string }[];
}
const useCatalog = () =>
  useQuery({ queryKey: ['/integrations-catalog'], queryFn: () => get<Catalog>('/integrations-catalog') });

const dt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('ru-RU') : '—');

/** Показ секрета один раз (ключ API, секрет подписи). */
function SecretOnce({
  title,
  value,
  hint,
  onClose,
}: {
  title: string;
  value: string | null;
  hint: string;
  onClose(): void;
}) {
  return (
    <Modal opened={!!value} onClose={onClose} title={title} size="lg">
      <Stack>
        <Alert color="yellow">{hint}</Alert>
        <Code block data-testid="secret-value" style={{ wordBreak: 'break-all' }}>
          {value}
        </Code>
        <Group justify="flex-end">
          <CopyButton value={value ?? ''}>
            {({ copied, copy }) => (
              <Button variant="light" onClick={copy}>
                {copied ? t.integrations.skopirovano : t.integrations.skopirovat}
              </Button>
            )}
          </CopyButton>
          <Button onClick={onClose}>{t.integrations.gotovo}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ------------------------------------------------------------------ ключи API (M-INT-01)

export function ApiKeysPage() {
  const list = useList('/api-keys');
  const cat = useCatalog();
  const channels = useList('/dict/channels');
  const enterprises = useList('/dict/enterprises');
  const apiChannels = (channels.data ?? []).filter((c) => c.kind === 'api');
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const [v, setV] = useState<Record<string, unknown>>({});
  const [shown, setShown] = useState<string | null>(null);
  const open = (r: Row | 'new') => {
    setEdit(r);
    setV(
      r === 'new'
        ? { permissions: [], enterpriseIds: [] }
        : {
            name: r.name,
            permissions: r.permissions,
            channelId: r.channelId,
            enterpriseIds: ((r.scopeRules as { enterpriseIds: string[] | null }[] | null) ?? []).flatMap(
              (x) => x.enterpriseIds ?? [],
            ),
          },
    );
  };
  const body = () => {
    const ents = (v.enterpriseIds as string[]) ?? [];
    return {
      name: v.name,
      permissions: v.permissions,
      channelId: v.channelId ?? null,
      scopeRules: ents.length ? [{ enterpriseIds: ents, departmentIds: null, topicIds: null }] : null,
    };
  };
  const save = useAction(async () => {
    if (edit === 'new') {
      const r = await post<{ key: string }>('/api-keys', body());
      setShown(r.key);
    } else if (edit) await patch(`/api-keys/${edit.id}`, body());
    setEdit(null);
  });
  const revoke = useAction((r: Row) => post(`/api-keys/${r.id}/revoke`), t.integrations.klyuchOtozvan);
  const permTitle = (c: string) => cat.data?.permissions.find((p) => p.code === c)?.title ?? c;
  return (
    <>
      <Group justify="space-between" mb="md">
        <span />
        <Button onClick={() => open('new')} data-testid="key-create">
          {t.integrations.vypustitKlyuch}
        </Button>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        {t.integrations.klyuchDaetVneshneySisteme}
        <a href="/api-docs">{t.integrations.dokumentatsiya}</a>
        {t.integrations.sVybrannymiPravamiI}
      </Text>
      <Table striped data-testid="keys">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.integrations.nazvanie}</Table.Th>
            <Table.Th>{t.integrations.klyuch}</Table.Th>
            <Table.Th>{t.integrations.prava}</Table.Th>
            <Table.Th>{t.integrations.kanal}</Table.Th>
            <Table.Th>{t.integrations.oblast}</Table.Th>
            <Table.Th>{t.integrations.ispolzovan}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((r) => (
            <Table.Tr key={r.id} data-testid="key-row" opacity={r.revokedAt ? 0.5 : 1}>
              <Table.Td>{String(r.name)}</Table.Td>
              <Table.Td>
                <Code>{String(r.prefix)}…</Code>
              </Table.Td>
              <Table.Td>
                <Group gap={4}>
                  {((r.permissions as string[]) ?? []).map((p) => (
                    <Badge key={p} variant="light" size="sm" title={permTitle(p)}>
                      {p}
                    </Badge>
                  ))}
                </Group>
              </Table.Td>
              <Table.Td>{String(r.channelName ?? '—')}</Table.Td>
              <Table.Td>
                {r.scopeRules ? t.integrations.ogranichena : t.integrations.vseObrashcheniya}
              </Table.Td>
              <Table.Td>{dt(r.lastUsedAt)}</Table.Td>
              <Table.Td>
                {r.revokedAt ? (
                  <Badge color="gray">{t.integrations.otozvan}</Badge>
                ) : (
                  <Group gap={4} wrap="nowrap">
                    <Button size="xs" variant="subtle" onClick={() => open(r)}>
                      {t.edit}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => {
                        if (confirm(t.integrations.otozvatKlyuchEtoNeobratimo(String(r.name))))
                          revoke.mutate(r);
                      }}
                    >
                      {t.integrations.otozvat}
                    </Button>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal
        opened={!!edit}
        onClose={() => setEdit(null)}
        title={edit === 'new' ? t.integrations.novyyKlyuchApi : t.integrations.klyuchApi}
      >
        <Stack>
          <TextInput
            label={t.integrations.nazvanieKtoPolzuetsyaKlyuchom}
            required
            value={String(v.name ?? '')}
            onChange={(e) => setV({ ...v, name: e.currentTarget.value })}
          />
          <Checkbox.Group
            label={t.integrations.prava}
            value={(v.permissions as string[]) ?? []}
            onChange={(x) => setV({ ...v, permissions: x })}
          >
            <Stack gap={6} mt={6}>
              {(cat.data?.permissions ?? []).map((p) => (
                <Checkbox key={p.code} value={p.code} label={`${p.title} (${p.code})`} />
              ))}
            </Stack>
          </Checkbox.Group>
          <Select
            label={t.integrations.vneshniyKanal}
            description={t.integrations.dlyaPravaVneshniyKanal}
            data={options(apiChannels)}
            value={(v.channelId as string) ?? null}
            onChange={(x) => setV({ ...v, channelId: x })}
            clearable
          />
          <MultiSelect
            label={t.integrations.oblastVidimostiPredpriyatiya}
            description={t.integrations.pustoVseObrashcheniya}
            data={options(enterprises.data)}
            value={(v.enterpriseIds as string[]) ?? []}
            onChange={(x) => setV({ ...v, enterpriseIds: x })}
          />
          <Group justify="flex-end">
            <Button onClick={() => save.mutate(undefined)} loading={save.isPending} data-testid="key-save">
              {edit === 'new' ? t.integrations.vypustit : t.save}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <SecretOnce
        title={t.integrations.klyuchApiVypushchen}
        value={shown}
        hint={t.integrations.skopiruyteKlyuchSeychasBolshe}
        onClose={() => setShown(null)}
      />
    </>
  );
}

// ------------------------------------------------------------------ webhooks и внешние боты (M-INT-02, M-AI-02)

const STATUS_COLOR: Record<string, string> = { sent: 'green', pending: 'yellow', failed: 'red' };
const STATUS_LABEL: Record<string, string> = {
  sent: t.integrations.dostavleno,
  pending: t.integrations.vOcheredi,
  failed: t.integrations.neDostavleno,
};

function SubState({ r }: { r: Row }) {
  if (!r.isActive) return <Badge color="gray">{t.integrations.otklyuchena}</Badge>;
  if (Number(r.failures) > 0)
    return (
      <Badge color="red" title={String(r.lastError ?? '')} data-testid="sub-state">
        {t.integrations.sboy}
        {String(r.lastError ?? '')}
        {t.integrations.povtor}
        {dt(r.nextProbeAt)}
      </Badge>
    );
  return (
    <Badge color="green" data-testid="sub-state">
      {t.integrations.rabotaet}
    </Badge>
  );
}

function Deliveries({ sub, onClose }: { sub: Row | null; onClose(): void }) {
  const [status, setStatus] = useState<string | null>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const list = useQuery({
    queryKey: ['deliveries', sub?.id, status],
    queryFn: () => get<Row[]>(`/webhooks/${sub!.id}/deliveries${status ? `?status=${status}` : ''}`),
    enabled: !!sub,
    refetchInterval: 3000,
  });
  const retry = useAction(
    (deliveryId?: string) => post(`/webhooks/${sub!.id}/retry`, deliveryId ? { deliveryId } : {}),
    t.integrations.postavlenoNaPovtor,
  );
  return (
    <Modal
      opened={!!sub}
      onClose={onClose}
      title={t.integrations.zhurnalDostavki(String(sub?.name ?? ''))}
      size="80rem"
    >
      <Group mb="sm">
        <Select
          placeholder={t.integrations.vseStatusy}
          data={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))}
          value={status}
          onChange={setStatus}
          clearable
          w={200}
        />
        <Button variant="light" onClick={() => retry.mutate(undefined)} data-testid="retry-all">
          {t.integrations.povtoritSeychas}
        </Button>
        <Text size="xs" c="dimmed">
          {t.integrations.nedostavlennoePovtoryaetsyaAvtomatic}
        </Text>
      </Group>
      <ScrollArea h={480}>
        <Table striped data-testid="deliveries">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t.integrations.kogda}</Table.Th>
              <Table.Th>{t.integrations.sobytie}</Table.Th>
              <Table.Th>{t.integrations.status}</Table.Th>
              <Table.Th>{t.integrations.popytok}</Table.Th>
              <Table.Th>{t.integrations.otvet}</Table.Th>
              <Table.Th>{t.error}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(list.data ?? []).map((d) => (
              <Table.Tr key={d.id} data-testid="delivery-row">
                <Table.Td>{dt(d.createdAt)}</Table.Td>
                <Table.Td>
                  {String(d.eventType)}
                  {d.isTest ? t.integrations.test : ''}
                </Table.Td>
                <Table.Td>
                  <Badge color={STATUS_COLOR[String(d.status)]} variant="light">
                    {STATUS_LABEL[String(d.status)]}
                  </Badge>
                </Table.Td>
                <Table.Td>{String(d.attempts)}</Table.Td>
                <Table.Td>
                  {d.lastStatus ? String(d.lastStatus) : '—'}
                  {d.durationMs != null ? t.integrations.ms(String(d.durationMs)) : ''}
                </Table.Td>
                <Table.Td style={{ maxWidth: 260 }}>{String(d.lastError ?? '')}</Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() =>
                        void get<Row>(`/webhooks/${sub!.id}/deliveries/${d.id}`).then((x) =>
                          setPayload(x.payload),
                        )
                      }
                    >
                      {t.integrations.dannye}
                    </Button>
                    {d.status !== 'sent' && !d.isTest && (
                      <Button size="xs" variant="subtle" onClick={() => retry.mutate(d.id)}>
                        {t.integrations.povtorit}
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      <Modal
        opened={payload !== null}
        onClose={() => setPayload(null)}
        title={t.integrations.teloZaprosa}
        size="xl"
      >
        <Code block>{JSON.stringify(payload, null, 2)}</Code>
      </Modal>
    </Modal>
  );
}

const headersText = (h: unknown) =>
  Object.entries((h as Record<string, string>) ?? {})
    .map(([k, x]) => `${k}: ${x}`)
    .join('\n');
const parseHeaders = (s: string) =>
  Object.fromEntries(
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );

function SubscriptionsPage({ kind }: { kind: 'events' | 'bot' }) {
  const bot = kind === 'bot';
  // Состояние получателей меняется само (сбой, восстановление) — список перечитывается.
  const list = useQuery({
    queryKey: [`/webhooks?kind=${kind}`],
    queryFn: () => get<Row[]>(`/webhooks?kind=${kind}`),
    refetchInterval: 3000,
  });
  const cat = useCatalog();
  const channels = useList('/dict/channels');
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const [v, setV] = useState<Record<string, unknown>>({});
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<Row | null>(null);
  const open = (r: Row | 'new') => {
    setEdit(r);
    setV(
      r === 'new'
        ? { eventTypes: [], channelIds: [], timeoutMs: 5000, botTimeoutS: 30, headers: '' }
        : { ...r, headers: headersText(r.headers) },
    );
  };
  const body = () => ({
    name: v.name,
    url: v.url,
    timeoutMs: Number(v.timeoutMs ?? 5000),
    headers: parseHeaders(String(v.headers ?? '')),
    ...(bot
      ? { botTimeoutS: Number(v.botTimeoutS ?? 30) }
      : { eventTypes: v.eventTypes ?? [], channelIds: v.channelIds ?? [] }),
  });
  const save = useAction(async () => {
    if (edit === 'new') {
      const r = await post<{ secret: string }>('/webhooks', { kind, ...body() });
      setSecret(r.secret);
    } else if (edit) await patch(`/webhooks/${edit.id}`, body());
    setEdit(null);
  });
  const toggle = useAction((r: Row) => post(`/webhooks/${r.id}/${r.isActive ? 'deactivate' : 'activate'}`));
  const rotate = useAction(async (r: Row) => {
    const x = await post<{ secret: string }>(`/webhooks/${r.id}/rotate-secret`);
    setSecret(x.secret);
  }, t.integrations.sekretZamenen);
  const test = async (r: Row) => {
    try {
      const x = await post<{ ok: boolean; status: number | null; error: string | null; durationMs: number }>(
        `/webhooks/${r.id}/test`,
      );
      notifications.show({
        color: x.ok ? 'green' : 'red',
        title: x.ok ? t.integrations.proverkaProshla : t.integrations.proverkaNeProshla,
        message: x.ok ? t.integrations.otvetZaMs(x.status, x.durationMs) : String(x.error),
      });
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    }
  };
  const eventOptions = (cat.data?.events ?? []).map((e) => ({
    value: e.code,
    label: `${e.title} (${e.code})`,
  }));
  return (
    <>
      <Group justify="space-between" mb="md">
        <span />
        <Button onClick={() => open('new')} data-testid="sub-create">
          {bot ? t.integrations.podklyuchitBota : t.integrations.dobavitPodpisku}
        </Button>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        {bot ? t.integrations.vneshniyBotPoluchaetKhod : t.integrations.sistemaOtpravlyaetSobytiyaNa}{' '}
        {t.integrations.formatIProverkaPodpisi}
        <a href="/api-docs">{t.integrations.dokumentatsiiApi}</a>.
      </Text>
      <Table striped data-testid="subs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.integrations.nazvanie}</Table.Th>
            <Table.Th>{t.integrations.adres}</Table.Th>
            <Table.Th>{bot ? t.integrations.kanaly : t.integrations.sobytiya}</Table.Th>
            <Table.Th>{t.integrations.sostoyanie}</Table.Th>
            <Table.Th>{t.integrations.vOcherediNeDostavleno}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((r) => (
            <Table.Tr key={r.id} data-testid="sub-row">
              <Table.Td>{String(r.name)}</Table.Td>
              <Table.Td style={{ wordBreak: 'break-all' }}>
                <Code>{String(r.url)}</Code>
              </Table.Td>
              <Table.Td>
                {bot
                  ? ((r.botChannels as string[]) ?? []).join(', ') || '—'
                  : ((r.eventTypes as string[]) ?? []).join(', ') || t.integrations.vse}
              </Table.Td>
              <Table.Td>
                <SubState r={r} />
              </Table.Td>
              <Table.Td data-testid="sub-counts">
                {String(r.pending)} / {String(r.failed)}
              </Table.Td>
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  <Button size="xs" variant="subtle" onClick={() => setLog(r)} data-testid="sub-log">
                    {t.integrations.zhurnal}
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => void test(r)} data-testid="sub-test">
                    {t.integrations.test2}
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => open(r)}>
                    {t.edit}
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => rotate.mutate(r)}>
                    {t.integrations.novyySekret}
                  </Button>
                  <Switch
                    checked={!!r.isActive}
                    onChange={() => toggle.mutate(r)}
                    label={r.isActive ? t.integrations.vkl : t.integrations.vykl}
                    data-testid="sub-toggle"
                  />
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal
        opened={!!edit}
        onClose={() => setEdit(null)}
        title={
          edit === 'new' ? (bot ? t.integrations.novyyVneshniyBot : t.integrations.novayaPodpiska) : t.edit
        }
        size="lg"
      >
        <Stack>
          <TextInput
            label={t.integrations.nazvanie}
            required
            value={String(v.name ?? '')}
            onChange={(e) => setV({ ...v, name: e.currentTarget.value })}
          />
          <TextInput
            label={t.integrations.adresPoluchatelyaUrl}
            required
            placeholder="https://crm.example/cc-events"
            value={String(v.url ?? '')}
            onChange={(e) => setV({ ...v, url: e.currentTarget.value })}
          />
          {!bot && (
            <>
              <MultiSelect
                label={t.integrations.sobytiya}
                description={t.integrations.pustoVseSobytiya}
                data={eventOptions}
                value={(v.eventTypes as string[]) ?? []}
                onChange={(x) => setV({ ...v, eventTypes: x })}
                searchable
              />
              <MultiSelect
                label={t.integrations.tolkoKanaly}
                description={t.integrations.pustoVseKanaly}
                data={options(channels.data)}
                value={(v.channelIds as string[]) ?? []}
                onChange={(x) => setV({ ...v, channelIds: x })}
              />
            </>
          )}
          {bot && (
            <NumberInput
              label={t.integrations.zhdatOtvetaBotaS}
              description={t.integrations.neOtvetilDialogUkhodit}
              min={5}
              max={3600}
              value={Number(v.botTimeoutS ?? 30)}
              onChange={(x) => setV({ ...v, botTimeoutS: Number(x) })}
            />
          )}
          <NumberInput
            label={t.integrations.taymautZaprosaMs}
            min={500}
            max={30000}
            value={Number(v.timeoutMs ?? 5000)}
            onChange={(x) => setV({ ...v, timeoutMs: Number(x) })}
          />
          <Textarea
            label={t.integrations.dopolnitelnyeZagolovki}
            description={t.integrations.poOdnomuNaStroku}
            autosize
            minRows={2}
            value={String(v.headers ?? '')}
            onChange={(e) => setV({ ...v, headers: e.currentTarget.value })}
          />
          <Group justify="flex-end">
            <Button onClick={() => save.mutate(undefined)} loading={save.isPending} data-testid="sub-save">
              {t.save}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <SecretOnce
        title={t.integrations.sekretPodpisi}
        value={secret}
        hint={t.integrations.sekretNuzhenPoluchatelyuDlya}
        onClose={() => setSecret(null)}
      />
      <Deliveries sub={log} onClose={() => setLog(null)} />
    </>
  );
}

export const WebhooksPage = () => <SubscriptionsPage kind="events" key="events" />;
export const ExternalBotsPage = () => <SubscriptionsPage kind="bot" key="bot" />;

// ------------------------------------------------------------------ экспорт и импорт (M-ADM-05)

interface ImportReport {
  dryRun: boolean;
  sections: { key: string; title: string; created: number; updated: number; unchanged: number }[];
  remapped: number;
  warnings: string[];
}

export function ConfigTransferPage() {
  const [audio, setAudio] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const url = await authBlobUrl(`/config/export${audio ? '' : '?audio=false'}`);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cc-config-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const run = async (f: File, dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await upload<ImportReport>(
        `/config/import${dryRun ? '?dryRun=true' : ''}`,
        new File([f], f.name, { type: 'application/octet-stream' }),
      );
      setReport(r);
      if (!dryRun) {
        notifications.show({ color: 'green', message: t.integrations.konfiguratsiyaImportirovana });
        setFile(null);
      }
    } catch (e) {
      setReport(null);
      notifications.show({
        color: 'red',
        title: t.integrations.importNevozmozhen,
        message: e instanceof ApiError ? errorText(e) : String(e),
        autoClose: 10000,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack maw={900}>
      <Paper withBorder p="md">
        <Stack>
          <Text fw={600}>{t.integrations.eksport}</Text>
          <Text size="sm" c="dimmed">
            {t.integrations.faylJsonSNastroykami}
          </Text>
          <Switch
            checked={audio}
            onChange={(e) => setAudio(e.currentTarget.checked)}
            label={t.integrations.vklyuchitAudiofaylyIvr}
          />
          <Group>
            <Button onClick={() => void download()} loading={busy} data-testid="export">
              {t.integrations.skachatKonfiguratsiyu}
            </Button>
          </Group>
        </Stack>
      </Paper>
      <Paper withBorder p="md">
        <Stack>
          <Text fw={600}>{t.integrations.import}</Text>
          <Text size="sm" c="dimmed">
            {t.integrations.snachalaProverkaSistemaPokazhet}
          </Text>
          <Group>
            <FileButton
              accept="application/json,.json"
              onChange={(f) => {
                setFile(f);
                setReport(null);
                if (f) void run(f, true);
              }}
            >
              {(props) => (
                <Button variant="light" {...props} data-testid="import-file">
                  {t.integrations.vybratFayl}
                </Button>
              )}
            </FileButton>
            {file && <Text size="sm">{file.name}</Text>}
            {file && report?.dryRun && (
              <Button onClick={() => void run(file, false)} loading={busy} data-testid="import-run">
                {t.integrations.importirovat}
              </Button>
            )}
          </Group>
          {report && (
            <>
              <Alert color={report.dryRun ? 'blue' : 'green'} data-testid="import-report-title">
                {report.dryRun ? t.integrations.proverkaFaylaIzmeneniyPoka : t.integrations.importVypolnen}
                {report.remapped ? t.integrations.sopostavlenoPoNazvaniyu(report.remapped) : ''}
              </Alert>
              {report.warnings.map((w) => (
                <Alert key={w} color="yellow">
                  {w}
                </Alert>
              ))}
              <Table striped data-testid="import-report">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t.integrations.razdel}</Table.Th>
                    <Table.Th>{t.integrations.novykh}</Table.Th>
                    <Table.Th>{t.integrations.izmenitsya}</Table.Th>
                    <Table.Th>{t.integrations.bezIzmeneniy}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {report.sections.map((s) => (
                    <Table.Tr key={s.key}>
                      <Table.Td>{s.title}</Table.Td>
                      <Table.Td>{s.created}</Table.Td>
                      <Table.Td>{s.updated}</Table.Td>
                      <Table.Td>{s.unchanged}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}

// ------------------------------------------------------------------ документация API (OpenAPI)

type Obj = Record<string, unknown>;

/** Небольшая разметка описания: заголовки «## », списки «- », `код`. */
function Doc({ text }: { text: string }) {
  return (
    <Stack gap={6}>
      {text.split('\n\n').map((block, i) => {
        if (block.startsWith('## '))
          return (
            <Title order={4} key={i}>
              {block.slice(3)}
            </Title>
          );
        if (block.startsWith('### ')) {
          const [head, ...rest] = block.split('\n');
          return (
            <div key={i}>
              <Text fw={600}>{head!.slice(4)}</Text>
              <Doc text={rest.join('\n')} />
            </div>
          );
        }
        const lines = block.split('\n');
        if (lines.every((l) => l.startsWith('- ')))
          return (
            <ul key={i} style={{ margin: 0 }}>
              {lines.map((l) => (
                <li key={l}>
                  <Inline text={l.slice(2)} />
                </li>
              ))}
            </ul>
          );
        return (
          <Text size="sm" key={i}>
            <Inline text={block} />
          </Text>
        );
      })}
    </Stack>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`]+`)/)
        .map((p, i) =>
          p.startsWith('`') ? <Code key={i}>{p.slice(1, -1)}</Code> : <span key={i}>{p}</span>,
        )}
    </>
  );
}

const METHOD_COLOR: Record<string, string> = { get: 'blue', post: 'green', patch: 'orange', put: 'orange' };

export function ApiDocsPage() {
  const spec = useQuery({ queryKey: ['/openapi.json'], queryFn: () => get<Obj>('/openapi.json') });
  const [schema, setSchema] = useState<string | null>(null);
  if (!spec.data) return <Text>{t.integrations.zagruzka}</Text>;
  const info = spec.data.info as { title: string; version: string; description: string };
  const paths = spec.data.paths as Record<string, Record<string, Obj>>;
  const schemas = (spec.data.components as { schemas: Record<string, Obj> }).schemas;
  const refName = (s: unknown) => {
    const r = (s as { $ref?: string } | undefined)?.$ref;
    return r ? r.split('/').pop()! : null;
  };
  const SchemaLink = ({ s }: { s: unknown }) => {
    const name = refName(s);
    if (name)
      return (
        <Button size="compact-xs" variant="light" onClick={() => setSchema(name)}>
          {name}
        </Button>
      );
    const items = refName((s as { items?: unknown } | undefined)?.items);
    if (items)
      return (
        <Button size="compact-xs" variant="light" onClick={() => setSchema(items)}>
          {items}[]
        </Button>
      );
    return <Code>{JSON.stringify(s)}</Code>;
  };
  return (
    <Stack maw={1100} data-testid="api-docs">
      <Group justify="space-between">
        <Title order={2}>
          {info.title} <Badge>{info.version}</Badge>
        </Title>
        <Button component="a" href="/api/v1/openapi.json" target="_blank" variant="light">
          openapi.json
        </Button>
      </Group>
      <Paper withBorder p="md">
        <Doc text={info.description} />
      </Paper>
      <Title order={3}>{t.integrations.metody}</Title>
      {Object.entries(paths).flatMap(([path, ops]) =>
        Object.entries(ops).map(([method, o]) => {
          const body = (o.requestBody as { content?: Record<string, { schema: unknown }> } | undefined)
            ?.content?.['application/json']?.schema;
          const responses = o.responses as Record<string, Obj>;
          return (
            <Paper withBorder p="sm" key={`${method} ${path}`} data-testid="api-op">
              <Group gap="xs">
                <Badge color={METHOD_COLOR[method] ?? 'gray'}>{method.toUpperCase()}</Badge>
                <Code>{path}</Code>
                <Text fw={600}>{String(o.summary)}</Text>
                {(o.tags as string[])?.map((t) => (
                  <Badge key={t} variant="outline" size="sm">
                    {t}
                  </Badge>
                ))}
              </Group>
              {o.description ? <Doc text={String(o.description)} /> : null}
              {((o.parameters as Obj[]) ?? []).length > 0 && (
                <Text size="sm" mt={4}>
                  {t.integrations.parametry}{' '}
                  {(o.parameters as Obj[]).map((p) => (
                    <Code key={String(p.name)} mr={4}>
                      {String(p.name)} ({String(p.in)})
                    </Code>
                  ))}
                </Text>
              )}
              {body ? (
                <Group gap={4} mt={4}>
                  <Text size="sm">{t.integrations.teloZaprosa2}</Text>
                  <SchemaLink s={body} />
                </Group>
              ) : null}
              <Group gap={4} mt={4}>
                <Text size="sm">{t.integrations.otvety}</Text>
                {Object.entries(responses).map(([code, r]) => {
                  const sch = (r.content as Record<string, { schema: unknown }> | undefined)?.[
                    'application/json'
                  ]?.schema;
                  return (
                    <Group gap={2} key={code}>
                      <Badge
                        variant="light"
                        color={code.startsWith('2') ? 'green' : 'gray'}
                        title={String(r.description)}
                      >
                        {code}
                      </Badge>
                      {sch && code.startsWith('2') ? <SchemaLink s={sch} /> : null}
                    </Group>
                  );
                })}
              </Group>
            </Paper>
          );
        }),
      )}
      <Title order={3}>{t.integrations.skhemy}</Title>
      <Group gap={6}>
        {Object.keys(schemas).map((n) => (
          <Button key={n} size="xs" variant="default" onClick={() => setSchema(n)}>
            {n}
          </Button>
        ))}
      </Group>
      <Modal opened={!!schema} onClose={() => setSchema(null)} title={schema ?? ''} size="xl">
        <Code block>{JSON.stringify(schema ? schemas[schema] : null, null, 2)}</Code>
      </Modal>
    </Stack>
  );
}
