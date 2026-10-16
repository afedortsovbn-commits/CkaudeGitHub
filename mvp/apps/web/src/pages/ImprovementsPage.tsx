import {
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconBulb, IconRefresh } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { TopicPicker } from '../components/DictPickers';
import { get, patch, post } from '../lib/api';
import { type Row, useAction, useList, useRequired } from '../lib/data';
import { t } from '../lib/i18n';

const CATEGORY_COLOR: Record<string, string> = {
  software: 'grape',
  process: 'orange',
  knowledge: 'teal',
  staff: 'blue',
  automation: 'cyan',
};
const STATUS_COLOR: Record<string, string> = {
  new: 'gray',
  important: 'red',
  in_work: 'blue',
  done: 'green',
  rejected: 'dark',
};
const STATUSES = ['new', 'important', 'in_work', 'done', 'rejected'];
const fmt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('ru-RU') : '—');

function Proposals() {
  const [all, setAll] = useState(false);
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['/improvements', all],
    queryFn: () => get<{ lastRun: string | null; items: Row[] }>(`/improvements?all=${all}`),
  });
  const analyze = useAction(
    () => post<{ proposals: number; templates: number }>('/improvements/analyze'),
    t.improvements.analyzed,
  );
  const save = useAction((v: { id: string; status?: string; note?: string }) =>
    patch(`/improvements/${v.id}`, { status: v.status, note: v.note }),
  );
  const [noteFor, setNoteFor] = useState<Row | null>(null);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const items = (q.data?.items ?? []).filter(
    (r) => (category === 'all' || r.category === category) && (!status || r.status === status),
  );
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {t.improvements.hint}
      </Text>
      <Group justify="space-between" wrap="wrap">
        <Group gap="sm" wrap="wrap">
          <SegmentedControl
            size="xs"
            value={category}
            onChange={setCategory}
            data={[
              { value: 'all', label: t.improvements.allCategories },
              ...Object.keys(CATEGORY_COLOR).map((c) => ({ value: c, label: t.improvements.category[c]! })),
            ]}
            data-testid="impr-category"
          />
          <Select
            size="xs"
            w={170}
            placeholder={t.improvements.anyStatus}
            clearable
            value={status}
            onChange={setStatus}
            data={STATUSES.map((s) => ({ value: s, label: t.improvements.status[s]! }))}
          />
          <Switch
            size="xs"
            label={t.improvements.showOld}
            checked={all}
            onChange={(e) => setAll(e.currentTarget.checked)}
          />
        </Group>
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {t.improvements.lastRun(fmt(q.data?.lastRun))}
          </Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRefresh size={14} />}
            loading={analyze.isPending}
            onClick={() => analyze.mutate(undefined)}
            data-testid="impr-analyze"
          >
            {t.improvements.analyze}
          </Button>
          <Button size="xs" onClick={() => setCreating(true)} data-testid="impr-add">
            {t.improvements.add}
          </Button>
        </Group>
      </Group>
      <Table striped highlightOnHover data-testid="impr-table">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={110}>{t.improvements.colRating}</Table.Th>
            <Table.Th>{t.improvements.colProposal}</Table.Th>
            <Table.Th w={150}>{t.improvements.colCategory}</Table.Th>
            <Table.Th w={190}>{t.improvements.colStatus}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {!items.length && (
            <Table.Tr>
              <Table.Td colSpan={4}>
                <Text size="sm" c="dimmed" ta="center" py="md">
                  {q.isLoading ? t.improvements.loading : t.improvements.empty}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
          {items.map((r) => (
            <Table.Tr
              key={String(r.id)}
              data-testid="impr-row"
              opacity={r.status === 'rejected' || r.status === 'done' ? 0.55 : 1}
            >
              <Table.Td>
                <Tooltip label={t.improvements.ratingHint(Number(r.frequency))}>
                  <Stack gap={2}>
                    <Text size="sm" fw={700}>
                      {Number(r.rating)}
                    </Text>
                    <Progress
                      value={Number(r.rating)}
                      size="sm"
                      color={Number(r.rating) >= 70 ? 'red' : Number(r.rating) >= 40 ? 'orange' : 'gray'}
                    />
                  </Stack>
                </Tooltip>
              </Table.Td>
              <Table.Td>
                <Text size="sm" fw={600}>
                  {String(r.title)}
                </Text>
                <Text size="xs" c="dimmed">
                  {String(r.details)}
                </Text>
                <Group gap={6} mt={4}>
                  {r.topicName ? (
                    <Badge size="xs" variant="outline">
                      {String(r.topicName)}
                    </Badge>
                  ) : null}
                  {r.rule === 'manual' ? (
                    <Badge size="xs" variant="light" color="violet">
                      {t.improvements.manual}
                    </Badge>
                  ) : (
                    <Text size="10px" c="dimmed">
                      {t.improvements.seen(fmt(r.firstSeenAt), fmt(r.lastSeenAt))}
                    </Text>
                  )}
                  {r.isCurrent === false && r.rule !== 'manual' ? (
                    <Badge size="xs" color="gray">
                      {t.improvements.notCurrent}
                    </Badge>
                  ) : null}
                </Group>
                {r.note ? (
                  <Text size="xs" mt={4} c="blue.8" style={{ whiteSpace: 'pre-wrap' }}>
                    💬 {String(r.note)}
                  </Text>
                ) : null}
              </Table.Td>
              <Table.Td>
                <Badge color={CATEGORY_COLOR[String(r.category)]} variant="light">
                  {t.improvements.category[String(r.category)]}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Stack gap={4}>
                  <Select
                    size="xs"
                    value={String(r.status)}
                    onChange={(v) => v && save.mutate({ id: String(r.id), status: v })}
                    data={STATUSES.map((s) => ({ value: s, label: t.improvements.status[s]! }))}
                    allowDeselect={false}
                    styles={{
                      input: {
                        color: `var(--mantine-color-${STATUS_COLOR[String(r.status)]}-7)`,
                        fontWeight: 600,
                      },
                    }}
                    data-testid="impr-status"
                  />
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => {
                      setNoteFor(r);
                      setNote(String(r.note ?? ''));
                    }}
                  >
                    {r.note ? t.improvements.editNote : t.improvements.addNote}
                  </Button>
                </Stack>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={!!noteFor} onClose={() => setNoteFor(null)} title={t.improvements.noteTitle}>
        <Stack>
          <Textarea autosize minRows={3} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          <Button
            onClick={() =>
              noteFor && save.mutate({ id: String(noteFor.id), note }, { onSuccess: () => setNoteFor(null) })
            }
          >
            {t.save}
          </Button>
        </Stack>
      </Modal>
      {creating && <ManualProposal onClose={() => setCreating(false)} />}
    </Stack>
  );
}

function ManualProposal({ onClose }: { onClose(): void }) {
  const [v, setV] = useState({
    title: '',
    details: '',
    category: 'process',
    topicId: null as string | null,
    rating: 50,
  });
  const req = useRequired();
  const create = useAction(() => post('/improvements', v), t.improvements.added);
  return (
    <Modal opened onClose={onClose} title={t.improvements.add}>
      <Stack>
        <TextInput
          label={t.improvements.fTitle}
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.currentTarget.value })}
          withAsterisk
          error={req.error(!v.title.trim())}
        />
        <Textarea
          label={t.improvements.fDetails}
          autosize
          minRows={3}
          value={v.details}
          onChange={(e) => setV({ ...v, details: e.currentTarget.value })}
        />
        <Select
          label={t.improvements.colCategory}
          data={Object.keys(CATEGORY_COLOR).map((c) => ({ value: c, label: t.improvements.category[c]! }))}
          value={v.category}
          onChange={(c) => c && setV({ ...v, category: c })}
          allowDeselect={false}
        />
        <TopicPicker value={v.topicId} onChange={(x) => setV({ ...v, topicId: x })} />
        <NumberInput
          label={t.improvements.colRating}
          min={1}
          max={100}
          value={v.rating}
          onChange={(x) => setV({ ...v, rating: Number(x) || 50 })}
        />
        <Button
          loading={create.isPending}
          onClick={() =>
            req.check(v.title.trim() ? [] : [t.improvements.fTitle]) &&
            create.mutate(undefined, { onSuccess: onClose })
          }
        >
          {t.save}
        </Button>
      </Stack>
    </Modal>
  );
}

function TemplateCandidates() {
  const [status, setStatus] = useState('new');
  const list = useList(`/improvements/templates?status=${status}`);
  const [accepting, setAccepting] = useState<Row | null>(null);
  const [form, setForm] = useState({ title: '', body: '' });
  const accept = useAction(
    (r: Row) => post(`/improvements/templates/${r.id}/accept`, { ...form, topicId: r.topicId ?? null }),
    t.improvements.tplSaved,
  );
  const reject = useAction(
    (r: Row) => post(`/improvements/templates/${r.id}/reject`),
    t.improvements.tplRejected,
  );
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {t.improvements.tplHint}
      </Text>
      <SegmentedControl
        size="xs"
        w={360}
        value={status}
        onChange={setStatus}
        data={[
          { value: 'new', label: t.improvements.tplNew },
          { value: 'accepted', label: t.improvements.tplAccepted },
          { value: 'rejected', label: t.improvements.tplRejectedTab },
        ]}
      />
      {!(list.data ?? []).length && (
        <Text size="sm" c="dimmed">
          {t.improvements.tplEmpty}
        </Text>
      )}
      {(list.data ?? []).map((r) => (
        <Paper key={String(r.id)} withBorder p="sm" data-testid="tpl-candidate">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Stack gap={4} style={{ flex: 1 }}>
              <Group gap={6}>
                <Badge variant="light">{t.improvements.tplUses(Number(r.uses), Number(r.operators))}</Badge>
                {r.topicName ? (
                  <Badge variant="outline" size="sm">
                    {String(r.topicName)}
                  </Badge>
                ) : null}
              </Group>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {String(r.body)}
              </Text>
            </Stack>
            {status === 'new' && (
              <Stack gap={4}>
                <Button
                  size="xs"
                  onClick={() => {
                    setAccepting(r);
                    setForm({ title: String(r.body).slice(0, 60), body: String(r.body) });
                  }}
                  data-testid="tpl-accept"
                >
                  {t.improvements.tplAccept}
                </Button>
                <Button size="xs" variant="subtle" color="gray" onClick={() => reject.mutate(r)}>
                  {t.improvements.tplReject}
                </Button>
              </Stack>
            )}
          </Group>
        </Paper>
      ))}
      <Modal
        opened={!!accepting}
        onClose={() => setAccepting(null)}
        title={t.improvements.tplAccept}
        size="lg"
      >
        <Stack>
          <TextInput
            label={t.improvements.tplTitle}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
          />
          <Textarea
            label={t.improvements.tplBody}
            description={t.improvements.tplBodyHint}
            autosize
            minRows={4}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.currentTarget.value })}
          />
          <Button
            loading={accept.isPending}
            onClick={() => accepting && accept.mutate(accepting, { onSuccess: () => setAccepting(null) })}
            data-testid="tpl-accept-save"
          >
            {t.save}
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}

/** Предложения по улучшению (Д-098) и кандидаты в шаблоны ответов (Д-099). */
export function ImprovementsPage() {
  return (
    <Stack>
      <Group gap="xs">
        <IconBulb size={22} />
        <Title order={3}>{t.improvements.pageTitle}</Title>
      </Group>
      <Tabs defaultValue="proposals" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="proposals">{t.improvements.tabProposals}</Tabs.Tab>
          <Tabs.Tab value="templates" data-testid="impr-tab-templates">
            {t.improvements.tabTemplates}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="proposals" pt="sm">
          <Proposals />
        </Tabs.Panel>
        <Tabs.Panel value="templates" pt="sm">
          <TemplateCandidates />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
