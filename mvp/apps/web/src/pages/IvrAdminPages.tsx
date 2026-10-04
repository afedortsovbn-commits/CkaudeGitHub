import {
  ActionIcon,
  Badge,
  Button,
  Code,
  FileButton,
  Group,
  Modal,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { DictPage } from '../components/DictPage';
import { authBlobUrl, errorText, get, patch, post, upload } from '../lib/api';
import { toIvrWav } from '../lib/audio-convert';
import { useAuth } from '../lib/auth';
import { options, type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

// ------------------------------------------------------------------ прослушивание файла

/** Кнопка «прослушать» для файла аудиобиблиотеки. */
export function AudioPreview({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (url) return <audio controls autoPlay src={url} style={{ height: 30, maxWidth: 240 }} />;
  return (
    <ActionIcon
      variant="light"
      title={t.ivr.proslushat}
      onClick={() =>
        void authBlobUrl(`/ivr/audio/${id}/file`)
          .then(setUrl)
          .catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }))
      }
    >
      ▶
    </ActionIcon>
  );
}

async function uploadAudio(file: File, query: string) {
  const wav = await toIvrWav(file);
  const name = file.name.replace(/\.[^.]+$/, '');
  return upload(
    `/ivr/audio?${query}${query ? '&' : ''}name=${encodeURIComponent(name)}`,
    new File([wav], `${name}.wav`, { type: 'audio/wav' }),
  );
}

// ------------------------------------------------------------------ аудиобиблиотека (M-IVR-04)

export function AudioLibraryPage() {
  const { can } = useAuth();
  const [all, setAll] = useState(false);
  const list = useList(`/ivr/audio?active=${all ? 'all' : 'true'}`);
  const fragments = useList<{ key: string; label: string; group?: string; audioId: string | null }>(
    '/ivr/fragments',
  );
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState<Row | null>(null);
  const [name, setName] = useState('');
  const toggle = useAction((r: Row) => post(`/ivr/audio/${r.id}/${r.isActive ? 'deactivate' : 'activate'}`));
  const saveName = useAction((r: Row) => patch(`/ivr/audio/${r.id}`, { name }));
  const writable = can('ivr.manage');
  const doUpload = async (file: File | null, query = '') => {
    if (!file) return;
    setBusy(true);
    try {
      await uploadAudio(file, query);
      notifications.show({ color: 'green', message: t.ivr.faylZagruzhen });
      void list.refetch();
      void fragments.refetch();
    } catch (e) {
      notifications.show({ color: 'red', title: t.ivr.neUdalosZagruzit, message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>{t.ivr.audiobibliotekaIvr}</Title>
        <Group>
          <Switch label={t.showInactive} checked={all} onChange={(e) => setAll(e.currentTarget.checked)} />
          {writable && (
            <FileButton onChange={(f) => void doUpload(f)} accept="audio/*">
              {(props) => (
                <Button {...props} loading={busy} data-testid="audio-upload">
                  {t.ivr.zagruzitFrazu}
                </Button>
              )}
            </FileButton>
          )}
        </Group>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t.ivr.lyuboyAudiofaylMp3Wav}
      </Text>
      <Tabs defaultValue="prompts">
        <Tabs.List mb="sm">
          <Tabs.Tab value="prompts">{t.ivr.frazy}</Tabs.Tab>
          <Tabs.Tab value="fragments">{t.ivr.fragmentyChisel}</Tabs.Tab>
          <Tabs.Tab value="position">{t.ivr.pozitsiyaVOcheredi}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="prompts">
          <Table striped data-testid="audio-list">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t.ivr.nazvanie}</Table.Th>
                <Table.Th>{t.release.duration}</Table.Th>
                <Table.Th>{t.ivr.status}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(list.data ?? [])
                .filter((r) => r.kind === 'prompt')
                .map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>{String(r.name)}</Table.Td>
                    <Table.Td>
                      {(Number(r.durationMs) / 1000).toFixed(1)}
                      {t.ivr.s}
                    </Table.Td>
                    <Table.Td>
                      <Badge color={r.isActive ? 'green' : 'gray'}>
                        {r.isActive ? t.ivr.aktiven : t.ivr.otklyuchen}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" justify="flex-end">
                        <AudioPreview id={r.id} />
                        {writable && (
                          <>
                            <Button
                              size="xs"
                              variant="light"
                              onClick={() => {
                                setRename(r);
                                setName(String(r.name));
                              }}
                            >
                              {t.ivr.pereimenovat}
                            </Button>
                            <Button
                              size="xs"
                              variant="subtle"
                              color={r.isActive ? 'red' : 'green'}
                              onClick={() => toggle.mutate(r)}
                            >
                              {r.isActive ? t.deactivate : t.activate}
                            </Button>
                          </>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Tabs.Panel>
        <Tabs.Panel value="fragments">
          <Text size="sm" c="dimmed" mb="sm">
            {t.ivr.izFragmentovSobirayutsyaChisla}
          </Text>
          <Table striped>
            <Table.Tbody>
              {(fragments.data ?? [])
                .filter((f) => f.group !== 'position')
                .map((f) => (
                  <Table.Tr key={f.key}>
                    <Table.Td w={200}>{f.label}</Table.Td>
                    <Table.Td>
                      <Code>{f.key}</Code>
                    </Table.Td>
                    <Table.Td>
                      {f.audioId ? (
                        <Badge color="green">{t.ivr.zagruzhen}</Badge>
                      ) : (
                        <Badge color="orange">{t.ivr.net}</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" justify="flex-end">
                        {f.audioId && <AudioPreview id={f.audioId} />}
                        {writable && (
                          <FileButton
                            onChange={(file) =>
                              void doUpload(file, `kind=fragment&fragmentKey=${encodeURIComponent(f.key)}`)
                            }
                            accept="audio/*"
                          >
                            {(props) => (
                              <Button {...props} size="xs" variant="light" loading={busy}>
                                {t.ivr.zagruzit}
                              </Button>
                            )}
                          </FileButton>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Tabs.Panel>
        <Tabs.Panel value="position">
          <Text size="sm" c="dimmed" mb="sm">
            {t.ivr.pozitsiyaVOcherediOpisanie}
          </Text>
          <Table striped>
            <Table.Tbody>
              {(fragments.data ?? [])
                .filter((f) => f.group === 'position')
                .map((f) => (
                  <Table.Tr key={f.key}>
                    <Table.Td w={200}>{f.label}</Table.Td>
                    <Table.Td>
                      <Code>{f.key}</Code>
                    </Table.Td>
                    <Table.Td>
                      {f.audioId ? (
                        <Badge color="green">{t.ivr.zagruzhen}</Badge>
                      ) : (
                        <Badge color="orange">{t.ivr.net}</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" justify="flex-end">
                        {f.audioId && <AudioPreview id={f.audioId} />}
                        {writable && (
                          <FileButton
                            onChange={(file) =>
                              void doUpload(file, `kind=fragment&fragmentKey=${encodeURIComponent(f.key)}`)
                            }
                            accept="audio/*"
                          >
                            {(props) => (
                              <Button {...props} size="xs" variant="light" loading={busy}>
                                {t.ivr.zagruzit}
                              </Button>
                            )}
                          </FileButton>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Tabs.Panel>
      </Tabs>
      <Modal opened={!!rename} onClose={() => setRename(null)} title={t.ivr.nazvanieFrazy}>
        <Stack>
          <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Button onClick={() => rename && saveName.mutate(rename, { onSuccess: () => setRename(null) })}>
            {t.save}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ объявления о сбоях

const localDt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('ru-RU') : '—');
const toIso = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};
const toInput = (v: unknown) => {
  if (!v) return '';
  const d = new Date(String(v));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Глобальные объявления о сбоях (M-IVR-04): менеджер (супервизор) включает и выключает их кнопкой, без правки
 * сценария; звучат в узле «Объявления о сбоях» в заданный период.
 */
export function AnnouncementsPage() {
  const audio = useList('/ivr/audio');
  const flows = useList('/flows?kind=voice');
  const now = Date.now();
  return (
    <DictPage
      kind="announcements"
      title={t.ivr.obyavleniyaOSboyakh}
      writePerm={['announcements.manage', 'supervisor.monitor']}
      columns={[
        { key: 'name', label: t.ivr.nazvanie },
        {
          key: 'audioId',
          label: t.ivr.fraza,
          render: (r) => (
            <Group gap="xs">
              <AudioPreview id={String(r.audioId)} />
              <Text size="sm">{String(audio.data?.find((a) => a.id === r.audioId)?.name ?? '')}</Text>
            </Group>
          ),
        },
        {
          key: 'period',
          label: t.ivr.period,
          render: (r) => {
            const live =
              r.isActive &&
              (!r.startsAt || Date.parse(String(r.startsAt)) <= now) &&
              (!r.endsAt || Date.parse(String(r.endsAt)) > now);
            return (
              <Group gap="xs">
                <Text size="sm">
                  {localDt(r.startsAt)} — {localDt(r.endsAt)}
                </Text>
                {live && <Badge color="red">{t.ivr.zvuchitSeychas}</Badge>}
              </Group>
            );
          },
        },
        {
          key: 'flowIds',
          label: t.ivr.stsenarii,
          render: (r) =>
            (r.flowIds as string[] | undefined)?.length
              ? (r.flowIds as string[])
                  .map((id) => flows.data?.find((f) => f.id === id)?.name ?? id)
                  .join(', ')
              : t.ivr.vse,
        },
      ]}
      fields={[
        { key: 'name', label: t.ivr.nazvanie, required: true },
        {
          key: 'audioId',
          label: t.ivr.frazaIzAudiobiblioteki,
          type: 'select',
          required: true,
          options: options(audio.data),
        },
        { key: 'startsAt', label: t.ivr.nachaloPustoSrazu, placeholder: t.ivr.ggggMmDdtchchMm },
        { key: 'endsAt', label: t.ivr.okonchaniePustoPokaNe, placeholder: t.ivr.ggggMmDdtchchMm },
        {
          key: 'flowIds',
          label: t.ivr.tolkoVStsenariyakhPusto,
          type: 'multiselect',
          options: options(flows.data),
        },
        { key: 'sortOrder', label: t.ivr.poryadok, type: 'number' },
      ]}
      toForm={(r) => ({ ...r, startsAt: toInput(r.startsAt), endsAt: toInput(r.endsAt) })}
      fromForm={(v) => ({ ...v, startsAt: toIso(v.startsAt), endsAt: toIso(v.endsAt) })}
    />
  );
}

// ------------------------------------------------------------------ интеграционные операции (M-INT-03)

const json = (v: unknown) => JSON.stringify(v ?? null, null, 2);
function parseJson(label: string, v: unknown, fallback: unknown) {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    throw new Error(t.ivr.nekorrektnyyJson(label));
  }
}

function TestOperation({ op, onClose }: { op: Row; onClose(): void }) {
  const inputs = (op.inputs as { name: string; label: string; sample?: string }[]) ?? [];
  const [v, setV] = useState<Record<string, string>>(
    Object.fromEntries(inputs.map((i) => [i.name, i.sample ?? ''])),
  );
  const [res, setRes] = useState<Record<string, unknown> | null>(null);
  const run = useAction(
    async () => setRes(await post<Record<string, unknown>>(`/integrations/${op.id}/test`, { input: v })),
    t.ivr.zaprosVypolnen,
  );
  return (
    <Modal opened onClose={onClose} title={t.ivr.proverka(String(op.name))} size="lg">
      <Stack>
        {inputs.map((i) => (
          <TextInput
            key={i.name}
            label={i.label || i.name}
            value={v[i.name] ?? ''}
            onChange={(e) => setV({ ...v, [i.name]: e.currentTarget.value })}
            data-testid={`op-input-${i.name}`}
          />
        ))}
        <Button onClick={() => run.mutate(undefined)} loading={run.isPending} data-testid="op-run">
          {t.ivr.vypolnit}
        </Button>
        {res && (
          <>
            <Group>
              <Badge color={res.ok ? 'green' : 'red'} data-testid="op-result">
                {res.ok ? t.ivr.uspekh : t.ivr.oshibka}
              </Badge>
              <Text size="sm">
                {res.httpStatus ? `HTTP ${String(res.httpStatus)} · ` : ''}
                {String(res.durationMs)}
                {t.ivr.ms}
                {res.error ? `· ${String(res.error)}` : ''}
              </Text>
            </Group>
            <Text size="sm" fw={600}>
              {t.ivr.peremennyeStsenariya}
            </Text>
            <Code block data-testid="op-outputs">
              {json(res.outputs)}
            </Code>
            {res.response !== undefined && (
              <>
                <Text size="sm" fw={600}>
                  {t.ivr.otvetSistemyDlyaNastroyki}
                </Text>
                <Code block>{json(res.response).slice(0, 4000)}</Code>
              </>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}

function OperationLog({ op, onClose }: { op: Row; onClose(): void }) {
  const log = useList(`/integrations/${op.id}/log`);
  return (
    <Modal opened onClose={onClose} title={t.ivr.zhurnal(String(op.name))} size="lg">
      <Table striped>
        <Table.Tbody>
          {(log.data ?? []).map((r, i) => (
            <Table.Tr key={i}>
              <Table.Td>{new Date(String(r.at)).toLocaleString('ru-RU')}</Table.Td>
              <Table.Td>
                {{ ivr: 'IVR', bot: t.ivr.bot, card: t.ivr.kartochka, test: t.ivr.proverka2 }[
                  String(r.source)
                ] ?? String(r.source)}
              </Table.Td>
              <Table.Td>
                <Badge color={r.ok ? 'green' : 'red'}>{r.ok ? t.ivr.uspekh : t.ivr.oshibka}</Badge>
              </Table.Td>
              <Table.Td>
                {String(r.durationMs)}
                {t.ivr.ms2}
              </Table.Td>
              <Table.Td>{String(r.error ?? '')}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Modal>
  );
}

/** Интеграционные операции: описание HTTP-операции без программирования, проверка, журнал. */
export function IntegrationsPage() {
  const [test, setTest] = useState<Row | null>(null);
  const [log, setLog] = useState<Row | null>(null);
  return (
    <>
      <DictPage
        kind="integrations"
        title={t.ivr.integratsionnyeOperatsii}
        columns={[
          { key: 'code', label: t.ivr.kod },
          { key: 'name', label: t.ivr.nazvanie },
          { key: 'url', label: t.ivr.zapros, render: (r) => `${String(r.method)} ${String(r.url)}` },
          { key: 'showInCard', label: t.ivr.vKartochke, render: (r) => (r.showInCard ? t.ivr.da : '') },
        ]}
        rowActions={(r) => (
          <>
            <Button size="xs" variant="light" color="teal" onClick={() => setTest(r)} data-testid="op-test">
              {t.ivr.proverit}
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setLog(r)}>
              {t.ivr.zhurnal2}
            </Button>
          </>
        )}
        fields={[
          { key: 'code', label: t.ivr.kod, required: true, placeholder: 'selfservice.balance' },
          { key: 'name', label: t.ivr.nazvanie, required: true },
          {
            key: 'method',
            label: t.ivr.metod,
            type: 'select',
            options: ['GET', 'POST', 'PUT'].map((m) => ({ value: m, label: m })),
          },
          {
            key: 'url',
            label: t.ivr.urlShablon,
            required: true,
            description: t.ivr.vkhodnyeParametryImyaNaprimer,
          },
          {
            key: 'inputsJson',
            label: t.ivr.vkhodnyeParametryJson,
            type: 'textarea',
            description: t.ivr.namePhoneLabelTelefon,
          },
          {
            key: 'outputsJson',
            label: t.ivr.rezultatPeremennyeJson,
            type: 'textarea',
            description: t.ivr.putVOtveteName,
          },
          {
            key: 'headersJson',
            label: t.ivr.zagolovkiJson,
            type: 'textarea',
            description: '{"X-Client": "cc"}',
          },
          { key: 'body', label: t.ivr.teloZaprosaDlyaPost, type: 'textarea' },
          {
            key: 'authType',
            label: t.ivr.avtorizatsiya,
            type: 'select',
            options: [
              { value: 'none', label: t.no },
              { value: 'bearer', label: t.ivr.bearerToken },
              { value: 'basic', label: t.ivr.loginIParolBasic },
              { value: 'header', label: t.ivr.klyuchVZagolovke },
            ],
          },
          { key: 'authUsername', label: t.ivr.login, show: (v) => v.authType === 'basic' },
          { key: 'authHeader', label: t.ivr.imyaZagolovka, show: (v) => v.authType === 'header' },
          {
            key: 'authSecret',
            label: t.ivr.sekretTokenParolKlyuch,
            type: 'password',
            show: (v) => !!v.authType && v.authType !== 'none',
            description: t.ivr.khranitsyaZashifrovannymPustoePole,
          },
          { key: 'timeoutMs', label: t.ivr.taymautMs, type: 'number' },
          {
            key: 'fallbackJson',
            label: t.ivr.znacheniyaPriOshibkeJson,
            type: 'textarea',
            description: t.ivr.peremennyePriSboeTaymaute,
          },
          { key: 'showInCard', label: t.ivr.pokazyvatVKartochkeKlienta, type: 'switch' },
          {
            key: 'cardInput',
            label: t.ivr.parametrVKotoryyPodstavit,
            show: (v) => !!v.showInCard,
          },
        ]}
        createDefaults={{
          method: 'GET',
          authType: 'none',
          timeoutMs: 3000,
          inputsJson: '[]',
          outputsJson: '[]',
        }}
        toForm={(r) => {
          const auth = (r.auth ?? {}) as Record<string, unknown>;
          return {
            ...r,
            inputsJson: json(r.inputs),
            outputsJson: json(r.outputs),
            headersJson: json(r.headers),
            fallbackJson: json(r.fallback),
            authType: auth.type ?? 'none',
            authUsername: auth.username ?? '',
            authHeader: auth.header ?? '',
            authSecret: '',
          };
        }}
        fromForm={(v, editing) => {
          const {
            inputsJson,
            outputsJson,
            headersJson,
            fallbackJson,
            authType,
            authUsername,
            authHeader,
            authSecret,
            ...rest
          } = v;
          const type = String(authType ?? 'none');
          const auth: Record<string, unknown> = { type };
          if (type === 'basic') auth.username = authUsername ?? '';
          if (type === 'header') auth.header = authHeader ?? '';
          if (type !== 'none')
            auth.secret = authSecret ? String(authSecret) : editing ? '********' : undefined;
          return {
            ...rest,
            inputs: parseJson(t.ivr.vkhodnyeParametry, inputsJson, []),
            outputs: parseJson(t.ivr.rezultat, outputsJson, []),
            headers: parseJson(t.ivr.zagolovki, headersJson, {}),
            fallback: parseJson(t.ivr.znacheniyaPriOshibke, fallbackJson, {}),
            auth,
          };
        }}
      />
      {test && <TestOperation op={test} onClose={() => setTest(null)} />}
      {log && <OperationLog op={log} onClose={() => setLog(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ панель внешних данных (M-CARD-07)

interface ExternalBlock {
  operationId: string;
  name: string;
  ok: boolean;
  error: string | null;
  fields: { name: string; label: string; value: string }[];
}

export function ExternalDataPanel({
  contactId,
  conversationId,
}: {
  contactId: string;
  conversationId?: string;
}) {
  const q = useQuery({
    queryKey: [`/contacts/${contactId}/external-data`],
    queryFn: () =>
      get<ExternalBlock[]>(
        `/contacts/${contactId}/external-data${conversationId ? `?conversationId=${conversationId}` : ''}`,
      ),
    staleTime: 60_000,
  });
  const blocks = useMemo(() => q.data ?? [], [q.data]);
  if (!blocks.length && !q.isFetching) return null;
  return (
    <Stack gap={6} data-testid="external-data">
      <Group justify="space-between">
        <Title order={6}>{t.ivr.dannyeIzVneshnikhSistem}</Title>
        <Button size="compact-xs" variant="subtle" onClick={() => void q.refetch()} loading={q.isFetching}>
          {t.update.reload}
        </Button>
      </Group>
      {blocks.map((b) => (
        <Stack key={b.operationId} gap={2}>
          <Text size="xs" fw={600}>
            {b.name}
          </Text>
          {b.ok ? (
            b.fields.map((f) => (
              <Text key={f.name} size="xs">
                {f.label}: <b>{f.value || '—'}</b>
              </Text>
            ))
          ) : (
            <Text size="xs" c="red">
              {t.ivr.nedostupno}
              {b.error}
            </Text>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
