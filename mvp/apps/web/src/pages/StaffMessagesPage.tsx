import {
  Badge,
  Button,
  Checkbox,
  Group,
  MultiSelect,
  Paper,
  Progress,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconClock } from '@tabler/icons-react';
import { useState } from 'react';
import { get, post } from '../lib/api';
import { type Row, useAction, useRequired } from '../lib/data';
import { t } from '../lib/i18n';
import { LEVEL_COLOR } from '../components/StaffMessageInbox';

const s = t.staffMessages;
const at = (iso: unknown) =>
  iso
    ? new Date(String(iso)).toLocaleString('ru-RU', {
        timeZone: 'Europe/Minsk',
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : '';

/** Получатели сообщения: кто прочитал (и когда), кто нет — непрочитавшие сверху; напомнить. */
function Recipients({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['/staff-messages', id],
    queryFn: () => get<Row[]>(`/staff-messages/${id}`),
    refetchInterval: 10_000,
  });
  const remind = useAction(() => post<{ reminded: number }>(`/staff-messages/${id}/remind`), s.remindedOk);
  const unread = (q.data ?? []).filter((r) => !r.readAt).length;
  return (
    <Stack gap="xs" mt="xs">
      {unread > 0 && (
        <Group justify="flex-end">
          <Button
            size="xs"
            variant="light"
            color="orange"
            loading={remind.isPending}
            onClick={() => remind.mutate(undefined)}
            data-testid="staff-remind"
          >
            {s.remind}
          </Button>
        </Group>
      )}
      <Table striped withTableBorder data-testid="staff-recipients">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{s.employee}</Table.Th>
            <Table.Th>{s.role}</Table.Th>
            <Table.Th>{s.status}</Table.Th>
            <Table.Th>{s.read}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(q.data ?? []).map((r) => (
            <Table.Tr
              key={String(r.userId)}
              data-testid="staff-recipient"
              data-read={r.readAt ? 'yes' : 'no'}
            >
              <Table.Td>{String(r.fullName)}</Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {String(r.roles ?? '')}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="xs">{s.agent[String(r.agentStatus)] ?? ''}</Text>
              </Table.Td>
              <Table.Td>
                {r.readAt ? (
                  <Group gap={4} c="green.7">
                    <IconCheck size={16} />
                    <Text size="sm">{s.readAt(at(r.readAt))}</Text>
                  </Group>
                ) : (
                  <Group gap={4} c="red.7">
                    <IconClock size={16} />
                    <Text size="sm" fw={600}>
                      {s.unread}
                    </Text>
                    {r.remindedAt ? (
                      <Text size="xs" c="dimmed">
                        ({s.reminded(at(r.remindedAt))})
                      </Text>
                    ) : null}
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

/** Рассылка сотрудникам: новое сообщение (важность, кому) и отправленные с отметками о прочтении. */
export function StaffMessagesPage() {
  const roles = useQuery({
    queryKey: ['/staff-messages/roles'],
    queryFn: () => get<Row[]>('/staff-messages/roles'),
  });
  const list = useQuery({
    queryKey: ['/staff-messages'],
    queryFn: () => get<Row[]>('/staff-messages'),
    refetchInterval: 10_000,
  });
  const [importance, setImportance] = useState('normal');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [toRoles, setToRoles] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const req = useRequired();
  const send = useAction(
    () =>
      post<{ recipients: number }>('/staff-messages', {
        importance,
        subject,
        body,
        roles: toRoles ? picked : [],
        onlineOnly,
      }),
    s.sentOk,
  );
  const submit = () => {
    if (
      !req.check([...(!subject.trim() ? [s.subject] : []), ...(toRoles && !picked.length ? [s.roles] : [])])
    )
      return;
    send.mutate(undefined, {
      onSuccess: () => {
        setSubject('');
        setBody('');
        req.reset();
      },
    });
  };
  return (
    <Stack maw={980}>
      <Text size="sm" c="dimmed">
        {s.intro}
      </Text>
      <Paper withBorder p="md" data-testid="staff-new">
        <Text fw={700} mb="xs">
          {s.newTitle}
        </Text>
        <Stack gap="sm">
          <div>
            <Text size="sm" fw={500} mb={4}>
              {s.importance}
            </Text>
            <SegmentedControl
              data={Object.entries(s.levels).map(([value, label]) => ({ value, label }))}
              value={importance}
              onChange={setImportance}
              color={LEVEL_COLOR[importance]}
              data-testid="staff-importance"
            />
            <Text size="xs" c="dimmed" mt={4}>
              {s.levelsHint}
            </Text>
          </div>
          <TextInput
            label={s.subject}
            withAsterisk
            value={subject}
            onChange={(e) => setSubject(e.currentTarget.value)}
            error={req.error(!subject.trim())}
            data-testid="staff-subject"
          />
          <Textarea
            label={s.body}
            autosize
            minRows={3}
            maxRows={10}
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            data-testid="staff-body"
          />
          <div>
            <Text size="sm" fw={500} mb={4}>
              {s.to}
            </Text>
            <SegmentedControl
              data={[
                { value: 'all', label: s.toAll },
                { value: 'roles', label: s.toRoles },
              ]}
              value={toRoles ? 'roles' : 'all'}
              onChange={(v) => setToRoles(v === 'roles')}
              data-testid="staff-to"
            />
          </div>
          {toRoles && (
            <MultiSelect
              label={s.roles}
              withAsterisk
              data={(roles.data ?? []).map((r) => ({
                value: String(r.code),
                label: `${String(r.name)} · ${s.roleUsers(Number(r.users))}`,
              }))}
              value={picked}
              onChange={setPicked}
              error={req.error(toRoles && !picked.length)}
              data-testid="staff-roles"
            />
          )}
          <Checkbox
            label={s.onlineOnly}
            checked={onlineOnly}
            onChange={(e) => setOnlineOnly(e.currentTarget.checked)}
            data-testid="staff-online"
          />
          <Group justify="flex-end">
            <Button
              color={LEVEL_COLOR[importance]}
              loading={send.isPending}
              onClick={submit}
              data-testid="staff-send"
            >
              {s.send}
            </Button>
          </Group>
        </Stack>
      </Paper>
      <Text fw={700}>{s.history}</Text>
      {!(list.data ?? []).length && (
        <Text size="sm" c="dimmed">
          {s.none}
        </Text>
      )}
      {(list.data ?? []).map((m) => {
        const total = Number(m.total);
        const read = Number(m.read);
        const isOpen = open === m.id;
        return (
          <Paper key={String(m.id)} withBorder p="sm" data-testid="staff-message">
            <UnstyledButton w="100%" onClick={() => setOpen(isOpen ? null : String(m.id))}>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Group gap="xs">
                    <Badge color={LEVEL_COLOR[String(m.importance)]} variant="light">
                      {s.levels[String(m.importance)]}
                    </Badge>
                    <Text fw={600} truncate>
                      {String(m.subject)}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {s.from(String(m.authorName), at(m.createdAt))}
                  </Text>
                </Stack>
                <Stack gap={4} w={220}>
                  <Text
                    size="sm"
                    ta="right"
                    fw={600}
                    c={read === total ? 'green.7' : 'orange.7'}
                    data-testid="staff-read-count"
                  >
                    {s.readOf(read, total)}
                  </Text>
                  <Progress
                    value={total ? (read / total) * 100 : 0}
                    color={read === total ? 'green' : 'orange'}
                  />
                </Stack>
              </Group>
            </UnstyledButton>
            {isOpen && (
              <>
                {m.body ? (
                  <Text size="sm" mt="xs" style={{ whiteSpace: 'pre-wrap' }}>
                    {String(m.body)}
                  </Text>
                ) : null}
                <Recipients id={String(m.id)} />
              </>
            )}
          </Paper>
        );
      })}
    </Stack>
  );
}
