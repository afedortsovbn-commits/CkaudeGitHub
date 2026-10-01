import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  SegmentedControl,
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorText, get, post, put } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

const MASK = '********';

interface Settings {
  enabled: boolean;
  url: string | null;
  format: 'json' | 'csv' | 'asu';
  token: string | null;
  time: string;
  maxDeactivateShare: number;
  enterpriseCode?: string;
  enterpriseMap?: Record<string, string>;
}

/** Исключения «код предприятия выгрузки = код предприятия справочника» — по одному в строке. */
const mapToText = (m: Record<string, string>) =>
  Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
const textToMap = (s: string) =>
  Object.fromEntries(
    s
      .split(/\n|;/)
      .map((l) => l.split('=').map((x) => x.trim()))
      .filter((p) => p.length === 2 && p[0] && p[1]),
  ) as Record<string, string>;

interface Change {
  code: string;
  name: string;
  action: 'added' | 'updated' | 'deactivated' | 'reactivated';
  fields?: Record<string, { from: unknown; to: unknown }>;
}
interface Problem {
  line?: number;
  code?: string;
  message: string;
}
interface RunResult {
  runId: string | null;
  status: 'ok' | 'error' | 'skipped';
  dryRun: boolean;
  total: number;
  added: number;
  updated: number;
  deactivated: number;
  reactivated: number;
  skipped: number;
  error?: string | null;
  changes: Change[];
  problems: Problem[];
}

const ACTION_COLOR: Record<Change['action'], string> = {
  added: 'green',
  updated: 'blue',
  deactivated: 'red',
  reactivated: 'teal',
};
const fmt = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const dt = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' }) : '—';

function Summary({ r }: { r: RunResult }) {
  return (
    <Group gap="xs" data-testid="sync-summary">
      <Badge color={r.status === 'ok' ? 'green' : 'red'}>
        {r.status === 'ok' ? t.reviews.ok : t.reviews.error}
      </Badge>
      {r.dryRun && <Badge color="gray">{t.reviews.dryBadge}</Badge>}
      <Text size="sm">{t.reviews.summary(r)}</Text>
    </Group>
  );
}

function RunDetails({ r }: { r: RunResult }) {
  return (
    <Stack gap="xs">
      <Summary r={r} />
      {r.error && (
        <Alert color="red" data-testid="sync-error">
          {r.error}
        </Alert>
      )}
      {r.problems.length > 0 && (
        <>
          <Text fw={600} size="sm">
            {t.reviews.problems(r.problems.length)}
          </Text>
          <Table striped data-testid="sync-problems">
            <Table.Tbody>
              {r.problems.map((p, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{p.line ? t.reviews.line(p.line) : ''}</Table.Td>
                  <Table.Td>{p.code ?? ''}</Table.Td>
                  <Table.Td>{p.message}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
      {r.changes.length > 0 && (
        <>
          <Text fw={600} size="sm">
            {t.reviews.changes(r.changes.length)}
          </Text>
          <Table striped data-testid="sync-changes">
            <Table.Tbody>
              {r.changes.map((c, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{c.code}</Table.Td>
                  <Table.Td>{c.name}</Table.Td>
                  <Table.Td>
                    <Badge color={ACTION_COLOR[c.action]} variant="light">
                      {t.reviews.actions[c.action]}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {Object.entries(c.fields ?? {})
                      .map(([k, v]) => `${t.reviews.fields[k] ?? k}: ${fmt(v.from)} → ${fmt(v.to)}`)
                      .join('; ')}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </Stack>
  );
}

/**
 * Синхронизация справочника объектов (Ф13, M-ORG-06): источник во внешней системе заказчика, ежедневный запуск,
 * запуск вручную и проверка без изменений, журнал запусков с перечнем изменений.
 */
export function ObjectSyncPage() {
  const qc = useQueryClient();
  const s = useQuery({
    queryKey: ['/objects/sync/settings'],
    queryFn: () => get<Settings>('/objects/sync/settings'),
  });
  const runs = useList('/objects/sync/runs');
  const enterprises = useList('/dict/enterprises');
  const [v, setV] = useState<Settings | null>(null);
  const [mapText, setMapText] = useState('');
  const [token, setToken] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<'dry' | 'run' | null>(null);
  const [details, setDetails] = useState<RunResult | null>(null);
  useEffect(() => {
    if (s.data) {
      setV(s.data);
      setMapText(mapToText(s.data.enterpriseMap ?? {}));
    }
  }, [s.data]);
  const save = useAction(
    () =>
      put('/objects/sync/settings', {
        enabled: v!.enabled,
        url: v!.url || null,
        format: v!.format,
        time: v!.time,
        maxDeactivateShare: v!.maxDeactivateShare,
        enterpriseCode: v!.enterpriseCode || t.reviews.defaultEnterprise,
        enterpriseMap: textToMap(mapText),
        ...(token ? { token } : {}),
      }).then(() => setToken('')),
    t.reviews.saved,
  );
  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'dry' : 'run');
    try {
      const r = await post<RunResult>(`/objects/sync/run${dryRun ? '?dryRun=true' : ''}`);
      setResult(r);
      void qc.invalidateQueries();
      notifications.show({
        color: r.status === 'ok' ? 'green' : 'red',
        message: r.status === 'ok' ? (dryRun ? t.reviews.dryDone : t.reviews.runDone) : String(r.error),
      });
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const open = async (id: string) => setDetails(await get<RunResult>(`/objects/sync/runs/${id}`));
  if (!v) return null;
  return (
    <Stack>
      <Title order={3}>{t.reviews.syncTitle}</Title>
      <Text size="sm" c="dimmed" maw={900}>
        {t.reviews.syncIntro}
      </Text>
      <Stack maw={620} gap="xs">
        <Switch
          label={t.reviews.syncEnabled}
          checked={v.enabled}
          onChange={(e) => setV({ ...v, enabled: e.currentTarget.checked })}
          data-testid="sync-enabled"
        />
        <TextInput
          label={t.reviews.syncUrl}
          placeholder="https://erp.local/api/objects"
          value={v.url ?? ''}
          onChange={(e) => setV({ ...v, url: e.currentTarget.value })}
          data-testid="sync-url"
        />
        <SegmentedControl
          data={[
            { value: 'asu', label: t.reviews.formatAsu },
            { value: 'json', label: 'JSON' },
            { value: 'csv', label: t.reviews.formatCsv },
          ]}
          value={v.format}
          onChange={(x) => setV({ ...v, format: x as Settings['format'] })}
          data-testid="sync-format"
        />
        {v.format === 'asu' && (
          <>
            <Select
              label={t.reviews.enterpriseCode}
              description={t.reviews.enterpriseCodeHint}
              data={(enterprises.data ?? []).map((e: Row) => ({
                value: String(e.code),
                label: `${String(e.name)} (${String(e.code)})`,
              }))}
              value={v.enterpriseCode || t.reviews.defaultEnterprise}
              onChange={(x) => setV({ ...v, enterpriseCode: x ?? '' })}
              searchable
              allowDeselect={false}
              data-testid="sync-enterprise"
            />
            <Textarea
              label={t.reviews.enterpriseMap}
              description={t.reviews.enterpriseMapHint}
              placeholder="20=MALANKA"
              autosize
              minRows={2}
              value={mapText}
              onChange={(e) => setMapText(e.currentTarget.value)}
            />
          </>
        )}
        <PasswordInput
          label={t.reviews.token}
          description={v.token === MASK ? t.reviews.tokenSet : t.reviews.tokenNotSet}
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
        />
        <Group grow>
          <TextInput
            label={t.reviews.time}
            value={v.time}
            onChange={(e) => setV({ ...v, time: e.currentTarget.value })}
          />
          <NumberInput
            label={t.reviews.maxShare}
            min={0}
            max={100}
            value={Math.round(v.maxDeactivateShare * 100)}
            onChange={(x) => setV({ ...v, maxDeactivateShare: Number(x) / 100 })}
          />
        </Group>
        <Group>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>
            {t.reviews.save}
          </Button>
          <Button
            variant="outline"
            onClick={() => void run(true)}
            loading={busy === 'dry'}
            data-testid="sync-dry"
          >
            {t.reviews.dryRun}
          </Button>
          <Button
            color="orange"
            onClick={() => void run(false)}
            loading={busy === 'run'}
            data-testid="sync-run"
          >
            {t.reviews.runNow}
          </Button>
        </Group>
      </Stack>
      {result && <RunDetails r={result} />}
      <Title order={4} mt="md">
        {t.reviews.runsTitle}
      </Title>
      <Table striped data-testid="sync-runs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.reviews.colStart}</Table.Th>
            <Table.Th>{t.reviews.colTrigger}</Table.Th>
            <Table.Th>{t.reviews.colResult}</Table.Th>
            <Table.Th>{t.reviews.colAdded}</Table.Th>
            <Table.Th>{t.reviews.colUpdated}</Table.Th>
            <Table.Th>{t.reviews.colDeactivated}</Table.Th>
            <Table.Th>{t.reviews.colSkipped}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(runs.data ?? []).map((r: Row) => (
            <Table.Tr key={r.id}>
              <Table.Td>{dt(r.startedAt)}</Table.Td>
              <Table.Td>
                {r.trigger === 'schedule'
                  ? t.reviews.bySchedule
                  : t.reviews.manual(r.startedByName ? String(r.startedByName) : '')}
                {r.dryRun ? t.reviews.dryMark : ''}
              </Table.Td>
              <Table.Td>
                <Badge
                  color={r.status === 'ok' ? 'green' : r.status === 'error' ? 'red' : 'gray'}
                  variant="light"
                >
                  {r.status === 'ok'
                    ? t.reviews.ok
                    : r.status === 'error'
                      ? t.reviews.error
                      : t.reviews.running}
                </Badge>
              </Table.Td>
              <Table.Td>{String(r.added)}</Table.Td>
              <Table.Td>{String(r.updated)}</Table.Td>
              <Table.Td>{String(r.deactivated)}</Table.Td>
              <Table.Td>{String(r.skipped)}</Table.Td>
              <Table.Td>
                <Button size="xs" variant="subtle" onClick={() => void open(r.id)}>
                  {t.reviews.details}
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={!!details} onClose={() => setDetails(null)} title={t.reviews.runModal} size="xl">
        {details && <RunDetails r={details} />}
      </Modal>
    </Stack>
  );
}
