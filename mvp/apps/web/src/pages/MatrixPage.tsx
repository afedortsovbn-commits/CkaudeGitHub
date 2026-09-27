import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  MultiSelect,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, options, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

const KINDS = [
  { value: 'responsible', label: 'Ответственный' },
  { value: 'curator', label: 'Куратор' },
];

function useTopicOptions() {
  const topics = useList('/topics');
  return (topics.data ?? []).map((r) => ({
    value: r.id,
    label: `${'— '.repeat(Number(r.level) - 1)}${String(r.name)}`,
  }));
}

function AssignModal({ onClose }: { onClose(): void }) {
  const links = useList('/enterprise-departments');
  const users = useList('/users?role=responsible');
  const topicOptions = useTopicOptions();
  const [v, setV] = useState({
    enterpriseDepartmentIds: [] as string[],
    topicIds: [] as string[],
    userIds: [] as string[],
    kind: 'responsible',
  });
  const save = useAction(
    () => post<{ affected: number }>('/responsibilities/bulk', v),
    'Назначения сохранены',
  );
  return (
    <Modal opened onClose={onClose} title="Назначить ответственных / кураторов" size="lg">
      <Stack>
        <MultiSelect
          label="Подразделения на предприятиях"
          data={(links.data ?? []).map((l) => ({
            value: l.id,
            label: `${String(l.enterpriseName)} — ${String(l.departmentName)}`,
          }))}
          value={v.enterpriseDepartmentIds}
          onChange={(x) => setV({ ...v, enterpriseDepartmentIds: x })}
          searchable
          data-testid="assign-eds"
        />
        <MultiSelect
          label="Темы / подтемы"
          data={topicOptions}
          value={v.topicIds}
          onChange={(x) => setV({ ...v, topicIds: x })}
          searchable
          data-testid="assign-topics"
        />
        <MultiSelect
          label="Сотрудники (роль 2-й линии)"
          data={(users.data ?? []).map((u) => ({
            value: u.id,
            label: `${String(u.fullName)} <${String(u.email)}>`,
          }))}
          value={v.userIds}
          onChange={(x) => setV({ ...v, userIds: x })}
          searchable
          data-testid="assign-users"
        />
        <Select
          label="Роль в матрице"
          data={KINDS}
          value={v.kind}
          onChange={(x) => setV({ ...v, kind: x ?? 'responsible' })}
          data-testid="assign-kind"
        />
        <Text size="xs" c="dimmed">
          Создаются все сочетания выбранных подразделений, тем и сотрудников. Назначение на тему действует на
          её подтемы, пока для подтемы не задано своё.
        </Text>
        <Button
          onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          loading={save.isPending}
          data-testid="assign-save"
        >
          Назначить
        </Button>
      </Stack>
    </Modal>
  );
}

function CopyModal({ onClose }: { onClose(): void }) {
  const enterprises = useList('/dict/enterprises');
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [res, setRes] = useState<{ copied: number; missingDepartmentIds: string[] } | null>(null);
  const copy = useAction(
    async () => setRes(await post('/responsibilities/copy', { fromEnterpriseId: from, toEnterpriseId: to })),
    'Скопировано',
  );
  return (
    <Modal opened onClose={onClose} title="Копировать назначения между предприятиями">
      <Stack>
        <Select label="С предприятия" data={options(enterprises.data)} value={from} onChange={setFrom} />
        <Select label="На предприятие" data={options(enterprises.data)} value={to} onChange={setTo} />
        <Button disabled={!from || !to} onClick={() => copy.mutate(undefined)}>
          Копировать
        </Button>
        {res && (
          <Alert color={res.missingDepartmentIds.length ? 'yellow' : 'green'}>
            Скопировано назначений: {res.copied}.
            {res.missingDepartmentIds.length > 0 &&
              ` Подразделений нет на целевом предприятии: ${res.missingDepartmentIds.length} — их назначения пропущены.`}
          </Alert>
        )}
      </Stack>
    </Modal>
  );
}

function DefaultsCheck() {
  const enterprises = useList('/dict/enterprises');
  const departments = useList('/dict/departments');
  const topicOptions = useTopicOptions();
  const [q, setQ] = useState<{ e: string | null; d: string | null; t: string | null }>({
    e: null,
    d: null,
    t: null,
  });
  const [res, setRes] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setErr(null);
    setRes(null);
    try {
      setRes(await get(`/responsibilities/defaults?enterpriseId=${q.e}&departmentId=${q.d}&topicId=${q.t}`));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };
  const names = (list: unknown) =>
    ((list as { fullName: string }[] | undefined) ?? []).map((u) => u.fullName).join(', ') ||
    '— не найдено, оператор выберет вручную';
  return (
    <Stack maw={700}>
      <Text size="sm" c="dimmed">
        Кого система подставит в тикет при передаче на 2-ю линию и какой срок предложит.
      </Text>
      <Group grow>
        <Select
          label="Предприятие"
          data={options(enterprises.data)}
          value={q.e}
          onChange={(e) => setQ({ ...q, e })}
        />
        <Select
          label="Подразделение"
          data={options(departments.data)}
          value={q.d}
          onChange={(d) => setQ({ ...q, d })}
        />
        <Select
          label="Тема"
          data={topicOptions}
          value={q.t}
          onChange={(tp) => setQ({ ...q, t: tp })}
          searchable
        />
      </Group>
      <Button onClick={() => void run()} disabled={!q.e || !q.d || !q.t}>
        Проверить подстановку
      </Button>
      {err && <Alert color="red">{err}</Alert>}
      {res && (
        <Alert color="blue" data-testid="defaults-result">
          <div>Ответственные: {names(res.responsibles)}</div>
          <div>Кураторы: {names(res.curators)}</div>
          <div>
            Срок ответа: {String(res.responseDays)} дн. (до {String(res.dueDate)})
          </div>
        </Alert>
      )}
    </Stack>
  );
}

export function MatrixPage() {
  const { can } = useAuth();
  const enterprises = useList('/dict/enterprises');
  const departments = useList('/dict/departments');
  const topicOptions = useTopicOptions();
  const [f, setF] = useState<{
    enterpriseId: string | null;
    departmentId: string | null;
    topicId: string | null;
    kind: string | null;
  }>({
    enterpriseId: null,
    departmentId: null,
    topicId: null,
    kind: null,
  });
  const qs = Object.entries(f)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const list = useList(`/responsibilities?${qs}`);
  const gaps = useList<{ withoutAssignments: Row[]; topicsWithoutResponsible: Row[] }>(
    `/responsibilities/gaps${f.enterpriseId ? `?enterpriseId=${f.enterpriseId}` : ''}`,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [modal, setModal] = useState<'assign' | 'copy' | null>(null);
  const deactivate = useAction(() =>
    post('/responsibilities/deactivate', { ids: selected }).then(() => setSelected([])),
  );
  const writable = can('admin.matrix');
  const gapData = gaps.data as unknown as
    | { withoutAssignments: Row[]; topicsWithoutResponsible: Row[] }
    | undefined;
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>{t.nav.matrix}</Title>
        {writable && (
          <Group>
            <Button variant="outline" onClick={() => setModal('copy')}>
              Копировать с предприятия
            </Button>
            <Button onClick={() => setModal('assign')} data-testid="assign-open">
              Назначить
            </Button>
          </Group>
        )}
      </Group>
      <Group grow mb="md">
        <Select
          label="Предприятие"
          data={options(enterprises.data)}
          value={f.enterpriseId}
          onChange={(v) => setF({ ...f, enterpriseId: v })}
          clearable
        />
        <Select
          label="Подразделение"
          data={options(departments.data)}
          value={f.departmentId}
          onChange={(v) => setF({ ...f, departmentId: v })}
          clearable
        />
        <Select
          label="Тема (с подтемами)"
          data={topicOptions}
          value={f.topicId}
          onChange={(v) => setF({ ...f, topicId: v })}
          clearable
          searchable
        />
        <Select
          label="Роль"
          data={KINDS}
          value={f.kind}
          onChange={(v) => setF({ ...f, kind: v })}
          clearable
        />
      </Group>
      <Tabs defaultValue="list">
        <Tabs.List mb="md">
          <Tabs.Tab value="list">Назначения ({list.data?.length ?? 0})</Tabs.Tab>
          <Tabs.Tab value="gaps">
            Без ответственного (
            {(gapData?.withoutAssignments.length ?? 0) + (gapData?.topicsWithoutResponsible.length ?? 0)})
          </Tabs.Tab>
          <Tabs.Tab value="check">Проверка подстановки</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="list">
          {writable && selected.length > 0 && (
            <Button color="red" variant="light" mb="sm" onClick={() => deactivate.mutate(undefined)}>
              Снять выбранные назначения ({selected.length})
            </Button>
          )}
          <Table striped data-testid="matrix-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                <Table.Th>Предприятие</Table.Th>
                <Table.Th>Подразделение</Table.Th>
                <Table.Th>Тема</Table.Th>
                <Table.Th>Сотрудник</Table.Th>
                <Table.Th>Роль</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(list.data ?? []).map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    {writable && (
                      <Checkbox
                        checked={selected.includes(r.id)}
                        onChange={(e) =>
                          setSelected((s) =>
                            e.currentTarget.checked ? [...s, r.id] : s.filter((x) => x !== r.id),
                          )
                        }
                      />
                    )}
                  </Table.Td>
                  <Table.Td>{String(r.enterpriseName)}</Table.Td>
                  <Table.Td>{String(r.departmentName)}</Table.Td>
                  <Table.Td>
                    {'— '.repeat(Number(r.topicLevel) - 1)}
                    {String(r.topicName)}
                  </Table.Td>
                  <Table.Td>
                    {String(r.userName)} {!r.userActive && <Badge color="gray">отключён</Badge>}
                  </Table.Td>
                  <Table.Td>
                    {r.kind === 'responsible' ? (
                      <Badge>Ответственный</Badge>
                    ) : (
                      <Badge color="grape">Куратор</Badge>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Tabs.Panel>
        <Tabs.Panel value="gaps">
          <Title order={5}>Подразделения без назначений</Title>
          {(gapData?.withoutAssignments ?? []).map((g) => (
            <Text key={String(g.enterpriseDepartmentId)} size="sm">
              {String(g.enterpriseName)} — {String(g.departmentName)}
            </Text>
          ))}
          <Title order={5} mt="md">
            Подтемы без ответственного (в используемых ветках)
          </Title>
          {(gapData?.topicsWithoutResponsible ?? []).map((g) => (
            <Text key={`${String(g.enterpriseDepartmentId)}-${String(g.topicId)}`} size="sm">
              {String(g.enterpriseName)} — {String(g.departmentName)}: {String(g.topicName)}
            </Text>
          ))}
        </Tabs.Panel>
        <Tabs.Panel value="check">
          <DefaultsCheck />
        </Tabs.Panel>
      </Tabs>
      {modal === 'assign' && <AssignModal onClose={() => setModal(null)} />}
      {modal === 'copy' && <CopyModal onClose={() => setModal(null)} />}
    </>
  );
}
