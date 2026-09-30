import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorText, get, post, put } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';

const MASK = '********';

interface Settings {
  enabled: boolean;
  url: string | null;
  format: 'json' | 'csv';
  token: string | null;
  time: string;
  maxDeactivateShare: number;
}

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

const ACTION: Record<Change['action'], { label: string; color: string }> = {
  added: { label: 'добавлен', color: 'green' },
  updated: { label: 'изменён', color: 'blue' },
  deactivated: { label: 'деактивирован', color: 'red' },
  reactivated: { label: 'снова активен', color: 'teal' },
};
const FIELD: Record<string, string> = {
  name: 'название',
  address: 'адрес',
  enterpriseId: 'предприятие',
  externalIds: 'внешние идентификаторы',
  source: 'источник',
};
const fmt = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const dt = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' }) : '—';

function Summary({ r }: { r: RunResult }) {
  return (
    <Group gap="xs" data-testid="sync-summary">
      <Badge color={r.status === 'ok' ? 'green' : 'red'}>{r.status === 'ok' ? 'успешно' : 'ошибка'}</Badge>
      {r.dryRun && <Badge color="gray">проверка без изменений</Badge>}
      <Text size="sm">
        в выгрузке {r.total}: добавлено {r.added}, изменено {r.updated}, деактивировано {r.deactivated}, снова
        активно {r.reactivated}, пропущено {r.skipped}
      </Text>
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
            Замечания к выгрузке ({r.problems.length})
          </Text>
          <Table striped data-testid="sync-problems">
            <Table.Tbody>
              {r.problems.map((p, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{p.line ? `строка ${p.line}` : ''}</Table.Td>
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
            Изменения ({r.changes.length})
          </Text>
          <Table striped data-testid="sync-changes">
            <Table.Tbody>
              {r.changes.map((c, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{c.code}</Table.Td>
                  <Table.Td>{c.name}</Table.Td>
                  <Table.Td>
                    <Badge color={ACTION[c.action].color} variant="light">
                      {ACTION[c.action].label}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {Object.entries(c.fields ?? {})
                      .map(([k, v]) => `${FIELD[k] ?? k}: ${fmt(v.from)} → ${fmt(v.to)}`)
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
  const [v, setV] = useState<Settings | null>(null);
  const [token, setToken] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<'dry' | 'run' | null>(null);
  const [details, setDetails] = useState<RunResult | null>(null);
  useEffect(() => {
    if (s.data) setV(s.data);
  }, [s.data]);
  const save = useAction(
    () =>
      put('/objects/sync/settings', {
        enabled: v!.enabled,
        url: v!.url || null,
        format: v!.format,
        time: v!.time,
        maxDeactivateShare: v!.maxDeactivateShare,
        ...(token ? { token } : {}),
      }).then(() => setToken('')),
    'Настройки синхронизации сохранены',
  );
  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'dry' : 'run');
    try {
      const r = await post<RunResult>(`/objects/sync/run${dryRun ? '?dryRun=true' : ''}`);
      setResult(r);
      void qc.invalidateQueries();
      notifications.show({
        color: r.status === 'ok' ? 'green' : 'red',
        message:
          r.status === 'ok' ? (dryRun ? 'Проверка выполнена' : 'Синхронизация выполнена') : String(r.error),
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
      <Title order={3}>Синхронизация объектов</Title>
      <Text size="sm" c="dimmed" maw={900}>
        Справочник объектов (АЗС, ЭЗС) ежедневно загружается из внешней системы: новые объекты добавляются,
        изменённые обновляются, исчезнувшие из выгрузки или закрытые — деактивируются. Названия, адреса,
        предприятия и внешние идентификаторы синхронизируемых объектов вручную не меняются. Если выгрузка
        деактивировала бы слишком много объектов (или пришла пустой), запуск останавливается без изменений.
      </Text>
      <Stack maw={620} gap="xs">
        <Switch
          label="Ежедневная синхронизация включена"
          checked={v.enabled}
          onChange={(e) => setV({ ...v, enabled: e.currentTarget.checked })}
          data-testid="sync-enabled"
        />
        <TextInput
          label="Адрес выгрузки справочника (HTTP GET)"
          placeholder="https://erp.local/api/objects"
          value={v.url ?? ''}
          onChange={(e) => setV({ ...v, url: e.currentTarget.value })}
          data-testid="sync-url"
        />
        <SegmentedControl
          data={[
            { value: 'json', label: 'JSON' },
            { value: 'csv', label: 'CSV (как ручной импорт)' },
          ]}
          value={v.format}
          onChange={(x) => setV({ ...v, format: x as Settings['format'] })}
        />
        <PasswordInput
          label="Токен (Authorization: Bearer)"
          description={v.token === MASK ? 'Задан; оставьте пустым, чтобы не менять' : 'Не задан'}
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
        />
        <Group grow>
          <TextInput
            label="Время запуска (Europe/Minsk)"
            value={v.time}
            onChange={(e) => setV({ ...v, time: e.currentTarget.value })}
          />
          <NumberInput
            label="Предельная доля деактивации, %"
            min={0}
            max={100}
            value={Math.round(v.maxDeactivateShare * 100)}
            onChange={(x) => setV({ ...v, maxDeactivateShare: Number(x) / 100 })}
          />
        </Group>
        <Group>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>
            Сохранить
          </Button>
          <Button
            variant="outline"
            onClick={() => void run(true)}
            loading={busy === 'dry'}
            data-testid="sync-dry"
          >
            Проверить (без изменений)
          </Button>
          <Button
            color="orange"
            onClick={() => void run(false)}
            loading={busy === 'run'}
            data-testid="sync-run"
          >
            Синхронизировать сейчас
          </Button>
        </Group>
      </Stack>
      {result && <RunDetails r={result} />}
      <Title order={4} mt="md">
        Журнал запусков
      </Title>
      <Table striped data-testid="sync-runs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Начало</Table.Th>
            <Table.Th>Запуск</Table.Th>
            <Table.Th>Итог</Table.Th>
            <Table.Th>Добавлено</Table.Th>
            <Table.Th>Изменено</Table.Th>
            <Table.Th>Деактивировано</Table.Th>
            <Table.Th>Пропущено</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(runs.data ?? []).map((r: Row) => (
            <Table.Tr key={r.id}>
              <Table.Td>{dt(r.startedAt)}</Table.Td>
              <Table.Td>
                {r.trigger === 'schedule'
                  ? 'по расписанию'
                  : `вручную${r.startedByName ? ` (${String(r.startedByName)})` : ''}`}
                {r.dryRun ? ' · проверка' : ''}
              </Table.Td>
              <Table.Td>
                <Badge
                  color={r.status === 'ok' ? 'green' : r.status === 'error' ? 'red' : 'gray'}
                  variant="light"
                >
                  {r.status === 'ok' ? 'успешно' : r.status === 'error' ? 'ошибка' : 'выполняется'}
                </Badge>
              </Table.Td>
              <Table.Td>{String(r.added)}</Table.Td>
              <Table.Td>{String(r.updated)}</Table.Td>
              <Table.Td>{String(r.deactivated)}</Table.Td>
              <Table.Td>{String(r.skipped)}</Table.Td>
              <Table.Td>
                <Button size="xs" variant="subtle" onClick={() => void open(r.id)}>
                  Подробнее
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={!!details} onClose={() => setDetails(null)} title="Запуск синхронизации" size="xl">
        {details && <RunDetails r={details} />}
      </Modal>
    </Stack>
  );
}
