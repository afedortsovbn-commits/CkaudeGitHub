import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  FileButton,
  Group,
  List,
  Loader,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconUpload,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, errorText, get, post, putChunk } from '../lib/api';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

const tt = t.sysUpdate;
const CHUNK = 8 * 1024 * 1024;

interface Manifest {
  version: string;
  title: string;
  fromVersions: string[];
  stopsIntake: boolean;
  intakeStopMinutes: number;
  durationMinutes: number;
  changes: { id: string; title: string; important: boolean }[];
  blocks: {
    name: string;
    title: string;
    effect: string;
    downtimeSeconds: number;
    stopsIntake: boolean;
    note: string;
  }[];
  migrations: string[];
  warnings: { level: 'info' | 'warning' | 'critical'; text: string }[];
}
interface Upd {
  id: string;
  fileName: string;
  sizeBytes: string;
  receivedBytes: string;
  status: string;
  manifest: Manifest | null;
  error: string | null;
  step: string | null;
  log: string;
  fromVersion: string | null;
  currentVersion: string;
  compatible: boolean;
}
interface State {
  version: string;
  updater: { alive: boolean; dryRun: boolean } | null;
  items: {
    id: string;
    fileName: string;
    status: string;
    version: string | null;
    fromVersion: string | null;
    createdAt: string;
    uploadedByName: string | null;
  }[];
}

const STATUS_COLOR: Record<string, string> = {
  ready: 'blue',
  queued: 'yellow',
  running: 'yellow',
  done: 'green',
  failed: 'red',
  invalid: 'red',
  uploading: 'gray',
};

/** Загрузка файла частями с продолжением после обрыва (сервер говорит, с какого места продолжить). */
async function uploadFile(file: File, onProgress: (p: number) => void): Promise<string> {
  const { id } = await post<{ id: string }>('/system-update', { fileName: file.name, size: file.size });
  let offset = 0;
  let fails = 0;
  while (offset < file.size) {
    try {
      const r = await putChunk<{ received: number }>(
        `/system-update/${id}/chunk?offset=${offset}`,
        file.slice(offset, offset + CHUNK),
      );
      offset = r.received;
      fails = 0;
      onProgress(Math.round((offset / file.size) * 100));
    } catch (e) {
      const expected = (e as ApiError).details as { expected?: number } | undefined;
      if (e instanceof ApiError && e.code === 'bad_offset' && typeof expected?.expected === 'number') {
        offset = expected.expected;
        continue;
      }
      if (++fails > 5) throw e;
      await new Promise((ok) => setTimeout(ok, 2000 * fails));
    }
  }
  return id;
}

function Details({ id, onChanged }: { id: string; onChanged(): void }) {
  const q = useQuery({
    queryKey: [`/system-update/${id}`],
    queryFn: () => get<Upd>(`/system-update/${id}`),
    refetchInterval: (query) =>
      ['queued', 'running', 'uploading'].includes(String((query.state.data as Upd | undefined)?.status))
        ? 2000
        : false,
  });
  const [read, setRead] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const start = useAction(() => post(`/system-update/${id}/start`, { confirmed: true }), tt.started);
  const cancel = useAction(() => post(`/system-update/${id}/cancel`), tt.cancelled);
  const u = q.data;
  useEffect(() => {
    if (u && ['done', 'failed'].includes(u.status)) onChanged();
  }, [u?.status]);
  if (!u) return <Loader />;
  const m = u.manifest;
  const active = ['queued', 'running'].includes(u.status);
  return (
    <Paper withBorder p="md" data-testid="update-details">
      <Group justify="space-between" mb="sm">
        <div>
          <Text fw={700} size="lg">
            {m?.title || u.fileName}
          </Text>
          {m && (
            <Text size="sm" c="dimmed">
              {tt.version(u.fromVersion ?? u.currentVersion, m.version)} · {tt.duration(m.durationMinutes)}
            </Text>
          )}
        </div>
        <Badge size="lg" color={STATUS_COLOR[u.status] ?? 'gray'} data-testid="update-status">
          {tt.status[u.status] ?? u.status}
        </Badge>
      </Group>
      {u.status === 'invalid' && (
        <Alert color="red" icon={<IconAlertOctagon />} title={tt.invalid}>
          {u.error}
        </Alert>
      )}
      {m && (
        <Stack gap="sm">
          {!u.compatible && (
            <Alert color="red" icon={<IconAlertOctagon />}>
              {tt.incompatible(m.fromVersions.join(', '))}
            </Alert>
          )}
          {m.stopsIntake ? (
            <Alert
              color="red"
              variant="filled"
              icon={<IconAlertOctagon size={28} />}
              styles={{ message: { fontSize: 18, fontWeight: 700 } }}
              data-testid="update-intake-stop"
            >
              {tt.intakeStop(m.intakeStopMinutes)}
            </Alert>
          ) : (
            <Alert color="green" icon={<IconCircleCheck />} data-testid="update-intake-ok">
              {tt.intakeOk}
            </Alert>
          )}
          {m.warnings.length > 0 && (
            <Stack gap={6}>
              <Text fw={700}>{tt.warnings}</Text>
              {m.warnings.map((w, i) => (
                <Alert
                  key={i}
                  color={w.level === 'critical' ? 'red' : w.level === 'warning' ? 'orange' : 'blue'}
                  variant={w.level === 'critical' ? 'filled' : 'light'}
                  icon={w.level === 'info' ? <IconInfoCircle /> : <IconAlertTriangle />}
                  styles={w.level === 'info' ? undefined : { message: { fontWeight: 600 } }}
                >
                  {w.text}
                </Alert>
              ))}
            </Stack>
          )}
          <Text fw={700}>{tt.blocks}</Text>
          <Table withTableBorder data-testid="update-blocks">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{tt.colBlock}</Table.Th>
                <Table.Th>{tt.colEffect}</Table.Th>
                <Table.Th w={110}>{tt.colDowntime}</Table.Th>
                <Table.Th>{tt.colNote}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {m.blocks.map((b) => (
                <Table.Tr
                  key={b.name}
                  style={
                    b.stopsIntake
                      ? { background: 'var(--mantine-color-red-light)' }
                      : b.effect === 'stop' || b.effect === 'restart'
                        ? { background: 'var(--mantine-color-orange-light)' }
                        : undefined
                  }
                >
                  <Table.Td fw={600}>{b.title}</Table.Td>
                  <Table.Td>
                    {tt.effect[b.effect] ?? b.effect}
                    {b.stopsIntake && (
                      <Badge ml={6} color="red" variant="filled" size="sm">
                        {tt.stopsIntakeBadge}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>{b.downtimeSeconds ? tt.downtime(b.downtimeSeconds) : tt.noDowntime}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{b.note}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Text fw={700}>{tt.changes(m.changes.length)}</Text>
          <List spacing={4} size="sm" data-testid="update-changes">
            {m.changes.map((c, i) => (
              <List.Item key={i}>
                {c.important && (
                  <Badge color="red" size="sm" mr={6}>
                    {tt.important}
                  </Badge>
                )}
                {c.id && <b>{c.id}: </b>}
                {c.title}
              </List.Item>
            ))}
          </List>
          <Text size="sm">{m.migrations.length ? tt.migrations(m.migrations.length) : tt.noMigrations}</Text>
          {m.migrations.length > 0 && (
            <Text size="xs" c="dimmed">
              {m.migrations.join(', ')}
            </Text>
          )}
          <Text size="sm" c="dimmed">
            {tt.backupNote}
          </Text>
        </Stack>
      )}
      {(active || u.log) && (
        <Stack gap={6} mt="md">
          {u.step && (
            <Group gap="xs">
              {u.status === 'running' && <Loader size="xs" />}
              <Text size="sm">
                {tt.step}: <b>{u.step}</b>
              </Text>
            </Group>
          )}
          <Text fw={700} size="sm">
            {tt.log}
          </Text>
          <ScrollArea.Autosize mah={360} type="auto">
            <Code block data-testid="update-log">
              {u.log || '…'}
            </Code>
          </ScrollArea.Autosize>
        </Stack>
      )}
      {u.status === 'done' && m && (
        <Alert mt="md" color="green" icon={<IconCircleCheck />}>
          {tt.doneText(m.version)}
        </Alert>
      )}
      {u.status === 'failed' && (
        <Alert mt="md" color="red" icon={<IconAlertOctagon />} title={tt.failedText}>
          {u.error}
        </Alert>
      )}
      {['ready', 'queued', 'uploading', 'invalid'].includes(u.status) && (
        <Group justify="space-between" mt="md">
          {u.status === 'ready' ? (
            <Checkbox
              label={tt.readConfirm}
              checked={read}
              onChange={(e) => setRead(e.currentTarget.checked)}
              data-testid="update-read"
            />
          ) : (
            <span />
          )}
          <Group>
            <Button
              variant="default"
              loading={cancel.isPending}
              onClick={() => cancel.mutate(undefined, { onSuccess: onChanged })}
            >
              {tt.cancel}
            </Button>
            {u.status === 'ready' && (
              <Button
                color={m?.stopsIntake ? 'red' : 'blue'}
                onClick={() =>
                  read ? setConfirm(true) : notifications.show({ color: 'yellow', message: tt.readConfirm })
                }
                data-testid="update-start"
              >
                {tt.start}
              </Button>
            )}
          </Group>
        </Group>
      )}
      <Modal opened={confirm} onClose={() => setConfirm(false)} title={tt.startTitle}>
        {m?.stopsIntake && (
          <Alert color="red" variant="filled" mb="sm" icon={<IconAlertOctagon />}>
            {tt.startIntake}
          </Alert>
        )}
        <Text size="sm">{tt.startText(m?.version ?? '')}</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirm(false)}>
            {t.cancel}
          </Button>
          <Button
            color={m?.stopsIntake ? 'red' : 'blue'}
            loading={start.isPending}
            onClick={() =>
              start.mutate(undefined, {
                onSuccess: () => {
                  setConfirm(false);
                  void q.refetch();
                  onChanged();
                },
              })
            }
            data-testid="update-confirm"
          >
            {tt.start}
          </Button>
        </Group>
      </Modal>
    </Paper>
  );
}

/** Обновление системы из файла (Д-065). */
export function SystemUpdatePage() {
  const st = useQuery({
    queryKey: ['/system-update'],
    queryFn: () => get<State>('/system-update'),
    refetchInterval: 10_000,
  });
  const [sel, setSel] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const s = st.data;
  // По умолчанию открыто последнее незавершённое обновление.
  const current =
    sel ?? s?.items.find((x) => ['ready', 'queued', 'running', 'uploading'].includes(x.status))?.id ?? null;
  const pick = async (f: File | null) => {
    if (!f) return;
    setProgress(0);
    try {
      const id = await uploadFile(f, setProgress);
      setSel(id);
      notifications.show({ color: 'green', message: tt.uploadOk });
    } catch (e) {
      notifications.show({ color: 'red', title: tt.uploadErr, message: errorText(e), autoClose: 10_000 });
    } finally {
      setProgress(null);
      void st.refetch();
    }
  };
  const up = s?.updater;
  return (
    <Stack maw={1200} data-testid="system-update-page">
      <Title order={3}>{tt.title}</Title>
      <Text size="sm" c="dimmed">
        {tt.intro}
      </Text>
      <Paper withBorder p="md">
        <Group justify="space-between">
          <Group gap="lg">
            <Text>
              {tt.current}: <b data-testid="update-current">{s?.version ?? '…'}</b>
            </Text>
            <Badge
              color={!up ? 'gray' : !up.alive ? 'red' : up.dryRun ? 'yellow' : 'green'}
              variant="light"
              data-testid="updater-state"
            >
              {!up ? tt.updaterNone : !up.alive ? tt.updaterDown : up.dryRun ? tt.updaterDry : tt.updaterOk}
            </Badge>
          </Group>
          <FileButton onChange={(f) => void pick(f)} accept=".ccupd">
            {(props) => (
              <Button
                {...props}
                leftSection={<IconUpload size={16} />}
                loading={progress !== null}
                data-testid="update-pick"
              >
                {tt.pick}
              </Button>
            )}
          </FileButton>
        </Group>
        {progress !== null && (
          <Stack gap={4} mt="sm">
            <Text size="sm">{tt.uploading(progress)}</Text>
            <Progress value={progress} animated />
          </Stack>
        )}
      </Paper>
      {current && <Details key={current} id={current} onChanged={() => void st.refetch()} />}
      <Paper withBorder p="md">
        <Text fw={700} mb="sm">
          {tt.history}
        </Text>
        {!s?.items.length ? (
          <Text size="sm" c="dimmed">
            {tt.empty}
          </Text>
        ) : (
          <Table withTableBorder highlightOnHover data-testid="update-history">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{tt.colDate}</Table.Th>
                <Table.Th>{tt.colVersion}</Table.Th>
                <Table.Th>{tt.colFile}</Table.Th>
                <Table.Th>{tt.colStatus}</Table.Th>
                <Table.Th>{tt.colWho}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {s.items.map((x) => (
                <Table.Tr key={x.id} style={{ cursor: 'pointer' }} onClick={() => setSel(x.id)}>
                  <Table.Td>{new Date(x.createdAt).toLocaleString('ru-RU')}</Table.Td>
                  <Table.Td>
                    {x.fromVersion ?? '?'} → {x.version ?? '?'}
                  </Table.Td>
                  <Table.Td>{x.fileName}</Table.Td>
                  <Table.Td>
                    <Badge color={STATUS_COLOR[x.status] ?? 'gray'} variant="light">
                      {tt.status[x.status] ?? x.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{x.uploadedByName ?? ''}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}
