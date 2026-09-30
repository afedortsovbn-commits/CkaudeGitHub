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
  { value: 'responsible', label: t.matrix.otvetstvennyy },
  { value: 'curator', label: t.matrix.kurator },
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
    t.matrix.naznacheniyaSokhraneny,
  );
  return (
    <Modal opened onClose={onClose} title={t.matrix.naznachitOtvetstvennykhKuratorov} size="lg">
      <Stack>
        <MultiSelect
          label={t.matrix.podrazdeleniyaNaPredpriyatiyakh}
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
          label={t.matrix.temyPodtemy}
          data={topicOptions}
          value={v.topicIds}
          onChange={(x) => setV({ ...v, topicIds: x })}
          searchable
          data-testid="assign-topics"
        />
        <MultiSelect
          label={t.matrix.sotrudnikiRol2Y}
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
          label={t.matrix.rolVMatritse}
          data={KINDS}
          value={v.kind}
          onChange={(x) => setV({ ...v, kind: x ?? 'responsible' })}
          data-testid="assign-kind"
        />
        <Text size="xs" c="dimmed">
          {t.matrix.sozdayutsyaVseSochetaniyaVybrannykh}
        </Text>
        <Button
          onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          loading={save.isPending}
          data-testid="assign-save"
        >
          {t.matrix.naznachit}
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
    t.matrix.skopirovano,
  );
  return (
    <Modal opened onClose={onClose} title={t.matrix.kopirovatNaznacheniyaMezhduPredpriya}>
      <Stack>
        <Select
          label={t.matrix.sPredpriyatiya}
          data={options(enterprises.data)}
          value={from}
          onChange={setFrom}
        />
        <Select
          label={t.matrix.naPredpriyatie}
          data={options(enterprises.data)}
          value={to}
          onChange={setTo}
        />
        <Button disabled={!from || !to} onClick={() => copy.mutate(undefined)}>
          {t.matrix.kopirovat}
        </Button>
        {res && (
          <Alert color={res.missingDepartmentIds.length ? 'yellow' : 'green'}>
            {t.matrix.skopirovanoNaznacheniy}
            {res.copied}.
            {res.missingDepartmentIds.length > 0 &&
              t.matrix.podrazdeleniyNetNaTselevom(res.missingDepartmentIds.length)}
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
    t.matrix.neNaydenoOperatorVyberet;
  return (
    <Stack maw={700}>
      <Text size="sm" c="dimmed">
        {t.matrix.kogoSistemaPodstavitV}
      </Text>
      <Group grow>
        <Select
          label={t.matrix.predpriyatie}
          data={options(enterprises.data)}
          value={q.e}
          onChange={(e) => setQ({ ...q, e })}
        />
        <Select
          label={t.matrix.podrazdelenie}
          data={options(departments.data)}
          value={q.d}
          onChange={(d) => setQ({ ...q, d })}
        />
        <Select
          label={t.matrix.tema}
          data={topicOptions}
          value={q.t}
          onChange={(tp) => setQ({ ...q, t: tp })}
          searchable
        />
      </Group>
      <Button onClick={() => void run()} disabled={!q.e || !q.d || !q.t}>
        {t.matrix.proveritPodstanovku}
      </Button>
      {err && <Alert color="red">{err}</Alert>}
      {res && (
        <Alert color="blue" data-testid="defaults-result">
          <div>
            {t.matrix.otvetstvennye}
            {names(res.responsibles)}
          </div>
          <div>
            {t.matrix.kuratory}
            {names(res.curators)}
          </div>
          <div>
            {t.matrix.srokOtveta}
            {String(res.responseDays)}
            {t.matrix.dnDo}
            {String(res.dueDate)})
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
              {t.matrix.kopirovatSPredpriyatiya}
            </Button>
            <Button onClick={() => setModal('assign')} data-testid="assign-open">
              {t.matrix.naznachit}
            </Button>
          </Group>
        )}
      </Group>
      <Group grow mb="md">
        <Select
          label={t.matrix.predpriyatie}
          data={options(enterprises.data)}
          value={f.enterpriseId}
          onChange={(v) => setF({ ...f, enterpriseId: v })}
          clearable
        />
        <Select
          label={t.matrix.podrazdelenie}
          data={options(departments.data)}
          value={f.departmentId}
          onChange={(v) => setF({ ...f, departmentId: v })}
          clearable
        />
        <Select
          label={t.matrix.temaSPodtemami}
          data={topicOptions}
          value={f.topicId}
          onChange={(v) => setF({ ...f, topicId: v })}
          clearable
          searchable
        />
        <Select
          label={t.matrix.rol}
          data={KINDS}
          value={f.kind}
          onChange={(v) => setF({ ...f, kind: v })}
          clearable
        />
      </Group>
      <Tabs defaultValue="list">
        <Tabs.List mb="md">
          <Tabs.Tab value="list">
            {t.matrix.naznacheniya}
            {list.data?.length ?? 0})
          </Tabs.Tab>
          <Tabs.Tab value="gaps">
            {t.matrix.bezOtvetstvennogo}
            {(gapData?.withoutAssignments.length ?? 0) + (gapData?.topicsWithoutResponsible.length ?? 0)})
          </Tabs.Tab>
          <Tabs.Tab value="check">{t.matrix.proverkaPodstanovki}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="list">
          {writable && selected.length > 0 && (
            <Button color="red" variant="light" mb="sm" onClick={() => deactivate.mutate(undefined)}>
              {t.matrix.snyatVybrannyeNaznacheniya}
              {selected.length})
            </Button>
          )}
          <Table striped data-testid="matrix-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                <Table.Th>{t.matrix.predpriyatie}</Table.Th>
                <Table.Th>{t.matrix.podrazdelenie}</Table.Th>
                <Table.Th>{t.matrix.tema}</Table.Th>
                <Table.Th>{t.matrix.sotrudnik}</Table.Th>
                <Table.Th>{t.matrix.rol}</Table.Th>
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
                    {String(r.userName)} {!r.userActive && <Badge color="gray">{t.matrix.otklyuchen}</Badge>}
                  </Table.Td>
                  <Table.Td>
                    {r.kind === 'responsible' ? (
                      <Badge>{t.matrix.otvetstvennyy}</Badge>
                    ) : (
                      <Badge color="grape">{t.matrix.kurator}</Badge>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Tabs.Panel>
        <Tabs.Panel value="gaps">
          <Title order={5}>{t.matrix.podrazdeleniyaBezNaznacheniy}</Title>
          {(gapData?.withoutAssignments ?? []).map((g) => (
            <Text key={String(g.enterpriseDepartmentId)} size="sm">
              {String(g.enterpriseName)} — {String(g.departmentName)}
            </Text>
          ))}
          <Title order={5} mt="md">
            {t.matrix.podtemyBezOtvetstvennogoV}
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
