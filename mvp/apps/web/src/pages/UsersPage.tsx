import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Group,
  MultiSelect,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { FormModal } from '../components/FormModal';
import { get, patch, post, put } from '../lib/api';
import { type Row, options, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

interface Rule {
  enterpriseIds: string[] | null;
  departmentIds: string[] | null;
  topicIds: string[] | null;
}
interface UserDetail extends Row {
  fullName: string;
  email: string;
  roles: string[];
  scopes: Rule[];
  queueIds: string[];
  seesUnclassified: boolean | null;
  totpEnabled: boolean;
  anonymizedAt: string | null;
}

const UNCLASSIFIED_OPTIONS = [
  { value: 'role', label: 'как в ролях' },
  { value: 'yes', label: 'видит' },
  { value: 'no', label: 'не видит' },
];

/** Неклассифицированные обращения (без предприятия и темы, В-52): отметка сотрудника важнее роли. */
function UnclassifiedSelect({ user }: { user: UserDetail }) {
  const cur = user.seesUnclassified === null ? 'role' : user.seesUnclassified ? 'yes' : 'no';
  const [v, setV] = useState(cur);
  useEffect(() => setV(cur), [cur]);
  const save = useAction((val: string) =>
    patch(`/users/${user.id}`, { seesUnclassified: val === 'role' ? null : val === 'yes' }),
  );
  return (
    <Group align="flex-end">
      <Select
        label="Неклассифицированные обращения (без предприятия и темы)"
        description="При ограниченной области. Область «всё» видит их всегда."
        data={UNCLASSIFIED_OPTIONS}
        value={v}
        onChange={(x) => x && setV(x)}
        allowDeselect={false}
        w={420}
        data-testid="unclassified-select"
      />
      <Button
        variant="light"
        onClick={() => save.mutate(v)}
        loading={save.isPending}
        data-testid="unclassified-save"
      >
        {t.save}
      </Button>
    </Group>
  );
}

/** Редактор областей видимости: пустое поле = «все». Правила объединяются по ИЛИ. */
function ScopeEditor({ user }: { user: UserDetail }) {
  const enterprises = useList('/dict/enterprises');
  const departments = useList('/dict/departments');
  const topics = useList('/topics');
  const templates = useList('/dict/scope-templates');
  const [rules, setRules] = useState<Rule[]>(user.scopes);
  useEffect(() => setRules(user.scopes), [user]);
  const save = useAction(() => put(`/users/${user.id}/scopes`, { rules }));
  const saveTemplate = useAction(
    (name: string) => post('/dict/scope-templates', { name, rules }),
    'Шаблон сохранён',
  );
  const apply = useAction((templateId: string) =>
    post(`/users/${user.id}/scopes/apply-template`, { templateId }),
  );
  const topicOptions = (topics.data ?? []).map((r) => ({
    value: r.id,
    label: `${'— '.repeat(Number(r.level) - 1)}${String(r.name)}`,
  }));
  const upd = (i: number, k: keyof Rule, v: string[]) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v.length ? v : null } : r)));
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Определяют, какие обращения, тикеты и данные сотрудник видит в списках, поиске и отчётах. Пустое поле
        — «все». Тема включает свои подтемы. Нет ни одного правила — сотрудник ничего не видит. Назначенный
        ответственный видит свои тикеты всегда.
      </Text>
      <UnclassifiedSelect user={user} />
      {rules.map((r, i) => (
        <Paper key={i} withBorder p="sm">
          <Group grow align="flex-start">
            <MultiSelect
              label="Предприятия"
              placeholder="все"
              data={options(enterprises.data)}
              value={r.enterpriseIds ?? []}
              onChange={(v) => upd(i, 'enterpriseIds', v)}
              searchable
            />
            <MultiSelect
              label="Подразделения"
              placeholder="все"
              data={options(departments.data)}
              value={r.departmentIds ?? []}
              onChange={(v) => upd(i, 'departmentIds', v)}
              searchable
            />
            <MultiSelect
              label="Темы"
              placeholder="все"
              data={topicOptions}
              value={r.topicIds ?? []}
              onChange={(v) => upd(i, 'topicIds', v)}
              searchable
            />
          </Group>
          <Button
            size="xs"
            variant="subtle"
            color="red"
            mt="xs"
            onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
          >
            Удалить правило
          </Button>
        </Paper>
      ))}
      <Group>
        <Button
          variant="outline"
          onClick={() =>
            setRules((rs) => [...rs, { enterpriseIds: null, departmentIds: null, topicIds: null }])
          }
        >
          Добавить правило
        </Button>
        <Button onClick={() => save.mutate(undefined)} loading={save.isPending} data-testid="save-scopes">
          Сохранить области
        </Button>
        <Button
          variant="subtle"
          onClick={() => {
            const name = window.prompt('Название шаблона');
            if (name) saveTemplate.mutate(name);
          }}
        >
          Сохранить как шаблон
        </Button>
      </Group>
      {(templates.data ?? []).length > 0 && (
        <Group>
          <Text size="sm">Применить шаблон:</Text>
          {(templates.data ?? []).map((tpl) => (
            <Button key={tpl.id} size="xs" variant="light" onClick={() => apply.mutate(tpl.id)}>
              {String(tpl.name)}
            </Button>
          ))}
        </Group>
      )}
    </Stack>
  );
}

function UserDrawer({ id, onClose }: { id: string; onClose(): void }) {
  const [user, setUser] = useState<UserDetail | null>(null);
  const roles = useList('/users/roles');
  const enterprises = useList('/dict/enterprises');
  const departments = useList('/dict/departments');
  const queues = useList('/dict/queues');
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [pwd, setPwd] = useState('');
  const load = async () => {
    const u = await get<UserDetail>(`/users/${id}`);
    setUser(u);
    setForm(u);
  };
  useEffect(() => void load(), [id]);
  const saveMain = useAction(() =>
    patch(`/users/${id}`, {
      fullName: form.fullName,
      email: form.email,
      phone: form.phone || null,
      canLogin: !!form.canLogin,
      primaryEnterpriseId: form.primaryEnterpriseId || null,
      primaryDepartmentId: form.primaryDepartmentId || null,
    }).then(load),
  );
  const saveRoles = useAction(() => put(`/users/${id}/roles`, { roles: form.roles }).then(load));
  const resetTotp = useAction(
    () => post(`/users/${id}/totp/reset`).then(load),
    '2FA сброшена, сессии сотрудника завершены',
  );
  const anonymize = useAction(
    (reason: string) => post(`/users/${id}/anonymize`, { confirm: true, reason }).then(load),
    'Сотрудник обезличен',
  );
  const roleUnclassified = useAction((a: { code: string; on: boolean }) =>
    patch(`/users/roles/${a.code}`, { seesUnclassified: a.on }),
  );
  const saveQueues = useAction(() => put(`/users/${id}/queues`, { queueIds: form.queueIds }).then(load));
  const resetPwd = useAction(
    () => post(`/users/${id}/password`, { password: pwd }),
    'Пароль изменён, сессии сотрудника завершены',
  );
  const toggle = useAction(() =>
    post(`/users/${id}/${user?.isActive ? 'deactivate' : 'activate'}`).then(load),
  );
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  if (!user) return null;
  return (
    <Drawer opened onClose={onClose} position="right" size="xl" title={user.fullName}>
      {!user.isActive && (
        <Alert color="gray" mb="sm">
          Сотрудник отключён: вход невозможен.
        </Alert>
      )}
      <Tabs defaultValue="main">
        <Tabs.List mb="md">
          <Tabs.Tab value="main">Данные</Tabs.Tab>
          <Tabs.Tab value="roles">Роли</Tabs.Tab>
          <Tabs.Tab value="scopes">Области видимости</Tabs.Tab>
          <Tabs.Tab value="queues">Очереди</Tabs.Tab>
          <Tabs.Tab value="security">Доступ</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="main">
          <Stack>
            <TextInput
              label="ФИО"
              value={String(form.fullName ?? '')}
              onChange={(e) => set('fullName', e.currentTarget.value)}
            />
            <TextInput
              label="Email (обязателен для ответственных и кураторов)"
              value={String(form.email ?? '')}
              onChange={(e) => set('email', e.currentTarget.value)}
            />
            <TextInput
              label="Телефон"
              value={String(form.phone ?? '')}
              onChange={(e) => set('phone', e.currentTarget.value)}
            />
            <Group grow>
              <MultiSelect
                label="Основное предприятие"
                maxValues={1}
                data={options(enterprises.data)}
                value={form.primaryEnterpriseId ? [String(form.primaryEnterpriseId)] : []}
                onChange={(v) => set('primaryEnterpriseId', v[0] ?? null)}
              />
              <MultiSelect
                label="Основное подразделение"
                maxValues={1}
                data={options(departments.data)}
                value={form.primaryDepartmentId ? [String(form.primaryDepartmentId)] : []}
                onChange={(v) => set('primaryDepartmentId', v[0] ?? null)}
              />
            </Group>
            <Switch
              label="Может входить в систему"
              checked={!!form.canLogin}
              onChange={(e) => set('canLogin', e.currentTarget.checked)}
            />
            <Button onClick={() => saveMain.mutate(undefined)} loading={saveMain.isPending}>
              {t.save}
            </Button>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="roles">
          <Stack>
            {(roles.data ?? []).map((r) => (
              <Checkbox
                key={String(r.code)}
                label={String(r.name)}
                description={(r.permissions as string[]).join(', ')}
                checked={((form.roles as string[]) ?? []).includes(String(r.code))}
                onChange={(e) => {
                  const cur = new Set((form.roles as string[]) ?? []);
                  if (e.currentTarget.checked) cur.add(String(r.code));
                  else cur.delete(String(r.code));
                  set('roles', [...cur]);
                }}
              />
            ))}
            <Button onClick={() => saveRoles.mutate(undefined)} loading={saveRoles.isPending}>
              Сохранить роли
            </Button>
            <Text size="sm" fw={500} mt="md">
              Роли видят неклассифицированные обращения (для всех сотрудников с ролью)
            </Text>
            {(roles.data ?? [])
              .filter((r) => !(r.permissions as string[]).includes('scope.all'))
              .map((r) => (
                <Switch
                  key={`u-${String(r.code)}`}
                  label={String(r.name)}
                  checked={(r.permissions as string[]).includes('scope.unclassified')}
                  onChange={(e) =>
                    roleUnclassified.mutate({ code: String(r.code), on: e.currentTarget.checked })
                  }
                />
              ))}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="scopes">
          <ScopeEditor user={user} />
        </Tabs.Panel>
        <Tabs.Panel value="queues">
          <Stack>
            <MultiSelect
              label="Очереди сотрудника"
              data={options(queues.data)}
              value={(form.queueIds as string[]) ?? []}
              onChange={(v) => set('queueIds', v)}
            />
            <Button onClick={() => saveQueues.mutate(undefined)}>{t.save}</Button>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="security">
          <Stack>
            <PasswordInput
              label="Новый пароль (не короче 8 символов)"
              value={pwd}
              onChange={(e) => setPwd(e.currentTarget.value)}
            />
            <Button onClick={() => resetPwd.mutate(undefined)} disabled={pwd.length < 8}>
              Задать пароль
            </Button>
            <Group>
              <Text size="sm">Вход с кодом (2FA):</Text>
              <Badge color={user.totpEnabled ? 'green' : 'gray'} data-testid="user-totp">
                {user.totpEnabled ? 'включён' : 'выключен'}
              </Badge>
              {user.totpEnabled ? (
                <Button size="xs" variant="outline" onClick={() => resetTotp.mutate(undefined)}>
                  Сбросить (потерян телефон)
                </Button>
              ) : null}
            </Group>
            {user.lockedUntil ? (
              <Button variant="outline" onClick={() => void post(`/users/${id}/unlock`).then(load)}>
                Снять блокировку входа
              </Button>
            ) : null}
            <Button
              color={user.isActive ? 'red' : 'green'}
              variant="outline"
              onClick={() => toggle.mutate(undefined)}
            >
              {user.isActive ? 'Отключить (уволить)' : 'Включить'}
            </Button>
            {!user.isActive && !user.anonymizedAt && (
              <Button
                color="red"
                variant="subtle"
                onClick={() => {
                  const reason = window.prompt('Обезличить сотрудника (необратимо). Основание:');
                  if (reason) anonymize.mutate(reason);
                }}
              >
                Обезличить (ФИО, email, телефон)
              </Button>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Drawer>
  );
}

export function UsersPage() {
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const list = useList(
    `/users?active=${showInactive ? 'all' : 'true'}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  );
  const roles = useList('/users/roles');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const create = useAction((v: Record<string, unknown>) => post<Row>('/users', v).then((u) => setOpen(u.id)));
  const roleName = new Map((roles.data ?? []).map((r) => [String(r.code), String(r.name)]));
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>{t.nav.users}</Title>
        <Group>
          <TextInput placeholder={t.search} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          <Switch
            label={t.showInactive}
            checked={showInactive}
            onChange={(e) => setShowInactive(e.currentTarget.checked)}
          />
          <Button onClick={() => setCreating(true)}>{t.add}</Button>
        </Group>
      </Group>
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>ФИО</Table.Th>
            <Table.Th>Email</Table.Th>
            <Table.Th>Роли</Table.Th>
            <Table.Th>Статус</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((u) => (
            <Table.Tr key={u.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(u.id)}>
              <Table.Td>{String(u.fullName)}</Table.Td>
              <Table.Td>{String(u.email)}</Table.Td>
              <Table.Td>
                {(u.roles as string[]).map((r) => (
                  <Badge key={r} mr={4} variant="light">
                    {roleName.get(r) ?? r}
                  </Badge>
                ))}
              </Table.Td>
              <Table.Td>
                {u.isActive ? <Badge color="green">Активен</Badge> : <Badge color="gray">Отключён</Badge>}
                {u.lockedUntil ? (
                  <Badge color="orange" ml={4}>
                    Вход заблокирован
                  </Badge>
                ) : null}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <FormModal
        opened={creating}
        title="Новый сотрудник"
        isCreate
        fields={[
          { key: 'fullName', label: 'ФИО', required: true },
          { key: 'email', label: 'Email', required: true },
          { key: 'phone', label: 'Телефон' },
          { key: 'password', label: 'Пароль (не короче 8 символов)', type: 'password' },
          {
            key: 'roles',
            label: 'Роли',
            type: 'multiselect',
            options: (roles.data ?? []).map((r) => ({ value: String(r.code), label: String(r.name) })),
          },
        ]}
        loading={create.isPending}
        onClose={() => setCreating(false)}
        onSubmit={(v) => create.mutate({ ...v, canLogin: true }, { onSuccess: () => setCreating(false) })}
      />
      {open && <UserDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
