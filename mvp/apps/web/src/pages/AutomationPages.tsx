import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  MultiSelect,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { DictPage } from '../components/DictPage';
import { TopicPicker } from '../components/DictPickers';
import { patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { options, type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

const TEXT_CHANNELS = [
  { value: 'webchat', label: t.automation.chatNaSayte },
  { value: 'app', label: t.automation.chatVPrilozhenii },
  { value: 'telegram', label: 'Telegram' },
  { value: 'email', label: 'Email' },
];

// ------------------------------------------------------------------ шаблоны ответов (M-AUTO-01)

/** Шаблоны ответов: общие (администратор) и личные (любой оператор). Быстрый вызов — «/код» в поле ответа. */
export function TemplatesPage() {
  const { can, me } = useAuth();
  const admin = can('templates.manage');
  // Линия: операторам — шаблоны 1-й линии, ответственным — 2-й; администратору — обе.
  const first = can('conversations.work', 'templates.manage');
  const second = can('tickets.work', 'templates.manage');
  const [line, setLine] = useState<'first' | 'second'>(first ? 'first' : 'second');
  const [scope, setScope] = useState('all');
  const [q, setQ] = useState('');
  const [inactive, setInactive] = useState(false);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const list = useList(
    `/templates?line=${line}&scope=${line === 'second' ? 'all' : scope}${inactive ? '&active=all' : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  );
  const toggle = useAction((r: Row) => post(`/templates/${r.id}/${r.isActive ? 'deactivate' : 'activate'}`));
  const mayEdit = (r: Row) =>
    r.line === 'second' ? admin || r.createdBy === me?.id : r.shared ? admin : true;
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>{t.automation.shablonyOtvetov}</Title>
        <Group>
          {first && second && (
            <SegmentedControl
              size="xs"
              value={line}
              onChange={(v) => setLine(v as 'first' | 'second')}
              data={[
                { value: 'first', label: t.automation.lineFirst },
                { value: 'second', label: t.automation.lineSecond },
              ]}
              data-testid="template-line"
            />
          )}
          {line === 'first' && (
            <SegmentedControl
              size="xs"
              value={scope}
              onChange={setScope}
              data={[
                { value: 'all', label: t.all },
                { value: 'shared', label: t.automation.obshchie },
                { value: 'mine', label: t.automation.moi },
              ]}
            />
          )}
          <TextInput placeholder={t.search} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          <Switch
            label={t.showInactive}
            checked={inactive}
            onChange={(e) => setInactive(e.currentTarget.checked)}
          />
          <Button onClick={() => setEditing('new')} data-testid="template-new">
            {t.add}
          </Button>
        </Group>
      </Group>
      {line === 'second' ? (
        <Text size="sm" c="dimmed" mb="sm">
          {t.automation.lineSecondHint}
        </Text>
      ) : (
        <Text size="sm" c="dimmed" mb="sm">
          {t.automation.peremennye}
          <Code>{'{{client.name}}'}</Code>
          {t.automation.imyaKlienta}
          <Code>{'{{operator.name}}'}</Code>
          {t.automation.operator}
          <Code>{'{{conversation.topic}}'}</Code>
          {t.automation.temaVPoleOtveta}
          <Code>/</Code>
          {t.automation.iKodShablona}
        </Text>
      )}
      <Table striped highlightOnHover data-testid="templates">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.automation.nazvanie}</Table.Th>
            <Table.Th>{t.automation.kod}</Table.Th>
            <Table.Th>{t.automation.tekst}</Table.Th>
            <Table.Th>{t.automation.tema}</Table.Th>
            <Table.Th>{t.automation.vid}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((r) => (
            <Table.Tr key={r.id} style={{ opacity: r.isActive ? 1 : 0.5 }}>
              <Table.Td>{String(r.title)}</Table.Td>
              <Table.Td>{r.shortcut ? <Code>/{String(r.shortcut)}</Code> : '—'}</Table.Td>
              <Table.Td style={{ maxWidth: 420 }}>
                <Text size="sm" lineClamp={2}>
                  {String(r.body)}
                </Text>
              </Table.Td>
              <Table.Td style={{ maxWidth: 260 }}>
                <Text size="sm" lineClamp={2}>
                  {String(r.topicPathName ?? r.topicName ?? '—')}
                </Text>
              </Table.Td>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>
                <Badge variant="light" color={r.shared ? 'blue' : 'grape'}>
                  {r.shared ? t.automation.obshchiy : t.automation.lichnyy}
                </Badge>
              </Table.Td>
              <Table.Td>
                {mayEdit(r) && (
                  <Group gap="xs" justify="flex-end">
                    <Button size="xs" variant="light" onClick={() => setEditing(r)}>
                      {t.edit}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color={r.isActive ? 'red' : 'green'}
                      onClick={() => toggle.mutate(r)}
                    >
                      {r.isActive ? t.deactivate : t.activate}
                    </Button>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {editing && (
        <TemplateForm
          row={editing === 'new' ? null : editing}
          admin={admin}
          line={line}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function TemplateForm({
  row,
  admin,
  line,
  onClose,
}: {
  row: Row | null;
  admin: boolean;
  line: 'first' | 'second';
  onClose(): void;
}) {
  const second = (row?.line ?? line) === 'second';
  const [v, setV] = useState({
    title: String(row?.title ?? ''),
    shortcut: String(row?.shortcut ?? ''),
    body: String(row?.body ?? ''),
    topicId: (row?.topicId as string | null) ?? null,
    channelKinds: (row?.channelKinds as string[]) ?? [],
    shared: row ? !!row.shared : admin,
  });
  const save = useAction(async () => {
    const data = {
      title: v.title,
      body: v.body,
      shortcut: v.shortcut || null,
      topicId: v.topicId,
      channelKinds: v.channelKinds,
    };
    if (second) {
      const d = { title: v.title, body: v.body, topicId: v.topicId };
      return row ? patch(`/templates/${row.id}`, d) : post('/templates', { ...d, line: 'second' });
    }
    return row ? patch(`/templates/${row.id}`, data) : post('/templates', { ...data, shared: v.shared });
  });
  return (
    <Modal
      opened
      onClose={onClose}
      title={row ? t.automation.shablonIzmenenie : t.automation.novyyShablon}
      size="lg"
    >
      <Stack>
        <TextInput
          label={t.automation.nazvanie}
          required
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.currentTarget.value })}
          data-testid="template-title"
        />
        {!second && (
          <TextInput
            label={t.automation.kodBystrogoVyzovaBez}
            value={v.shortcut}
            onChange={(e) => setV({ ...v, shortcut: e.currentTarget.value })}
            data-testid="template-shortcut"
          />
        )}
        <Textarea
          label={t.automation.tekst}
          required
          autosize
          minRows={4}
          value={v.body}
          onChange={(e) => setV({ ...v, body: e.currentTarget.value })}
          data-testid="template-body"
        />
        <TopicPicker
          size="sm"
          label={t.automation.tema}
          description={second ? undefined : t.automation.podskazkaPodnimaetShablonVyshe}
          value={v.topicId}
          onChange={(x) => setV({ ...v, topicId: x })}
          clearable
          testId="template-topic"
        />
        {!second && (
          <MultiSelect
            label={t.automation.kanaly}
            description={t.automation.pustoVoVsekhTekstovykh}
            data={TEXT_CHANNELS}
            value={v.channelKinds}
            onChange={(x) => setV({ ...v, channelKinds: x })}
          />
        )}
        {!row && admin && !second && (
          <Switch
            label={t.automation.obshchiyShablonVidenVsem}
            checked={v.shared}
            onChange={(e) => setV({ ...v, shared: e.currentTarget.checked })}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            loading={save.isPending}
            disabled={!v.title.trim() || !v.body.trim()}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
            data-testid="template-save"
          >
            {row ? t.save : t.create}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ------------------------------------------------------------------ база знаний (M-AUTO-05)

export function KnowledgePage() {
  const { can } = useAuth();
  return (
    <>
      <Title order={3} mb="md">
        {t.automation.bazaZnaniy}
      </Title>
      <Tabs defaultValue="articles">
        <Tabs.List mb="md">
          <Tabs.Tab value="articles">{t.automation.stati}</Tabs.Tab>
          {can('kb.manage') && <Tabs.Tab value="categories">{t.automation.rubriki}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="articles">
          <Articles />
        </Tabs.Panel>
        <Tabs.Panel value="categories">
          <DictPage
            kind="kb-categories"
            title={t.automation.rubriki}
            hideTitle
            columns={[
              { key: 'name', label: t.automation.nazvanie },
              { key: 'sortOrder', label: t.automation.poryadok },
            ]}
            fields={[
              { key: 'name', label: t.automation.nazvanie, required: true },
              { key: 'sortOrder', label: t.automation.poryadok, type: 'number' },
            ]}
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function Articles() {
  const { can } = useAuth();
  const admin = can('kb.manage');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [inactive, setInactive] = useState(false);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [viewing, setViewing] = useState<Row | null>(null);
  const cats = useList('/dict/kb-categories');
  const list = useList(
    `/kb/articles?${inactive ? 'active=all&' : ''}${cat ? `categoryId=${cat}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`,
  );
  const toggle = useAction((r: Row) =>
    post(`/kb/articles/${r.id}/${r.isActive ? 'deactivate' : 'activate'}`),
  );
  return (
    <>
      <Group mb="md">
        <TextInput
          placeholder={t.automation.poiskPoStatyamPolnotekstovyy}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          w={320}
          data-testid="kb-search"
        />
        <Select
          placeholder={t.automation.rubrika}
          data={options(cats.data)}
          value={cat}
          onChange={setCat}
          clearable
        />
        {admin && (
          <>
            <Switch
              label={t.showInactive}
              checked={inactive}
              onChange={(e) => setInactive(e.currentTarget.checked)}
            />
            <Button onClick={() => setEditing('new')} data-testid="kb-new">
              {t.automation.novayaStatya}
            </Button>
          </>
        )}
      </Group>
      <Table striped highlightOnHover data-testid="kb-articles">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.automation.statya}</Table.Th>
            <Table.Th>{t.automation.rubrika}</Table.Th>
            <Table.Th>{t.automation.izmenena}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((r) => (
            <Table.Tr key={r.id} style={{ opacity: r.isActive ? 1 : 0.5 }}>
              <Table.Td>
                <Text size="sm" fw={500} style={{ cursor: 'pointer' }} onClick={() => setViewing(r)}>
                  {String(r.title)}
                </Text>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {String(r.body)}
                </Text>
              </Table.Td>
              <Table.Td>{String(r.categoryName ?? '—')}</Table.Td>
              <Table.Td>{new Date(String(r.updatedAt)).toLocaleDateString('ru-RU')}</Table.Td>
              <Table.Td>
                {admin && (
                  <Group gap="xs" justify="flex-end">
                    <Button size="xs" variant="light" onClick={() => setEditing(r)}>
                      {t.edit}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color={r.isActive ? 'red' : 'green'}
                      onClick={() => toggle.mutate(r)}
                    >
                      {r.isActive ? t.deactivate : t.activate}
                    </Button>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {viewing && (
        <Modal opened onClose={() => setViewing(null)} title={String(viewing.title)} size="lg">
          <Text style={{ whiteSpace: 'pre-wrap' }}>{String(viewing.body)}</Text>
        </Modal>
      )}
      {editing && (
        <ArticleForm
          row={editing === 'new' ? null : editing}
          cats={cats.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ArticleForm({ row, cats, onClose }: { row: Row | null; cats: Row[]; onClose(): void }) {
  const topics = useList('/topics');
  const [v, setV] = useState({
    title: String(row?.title ?? ''),
    body: String(row?.body ?? ''),
    categoryId: (row?.categoryId as string | null) ?? null,
    topicIds: (row?.topicIds as string[]) ?? [],
    keywords: String(row?.keywords ?? ''),
  });
  const save = useAction(async () => {
    const data = { ...v, keywords: v.keywords || null };
    return row ? patch(`/kb/articles/${row.id}`, data) : post('/kb/articles', data);
  });
  return (
    <Modal
      opened
      onClose={onClose}
      title={row ? t.automation.statyaIzmenenie : t.automation.novayaStatya}
      size="xl"
    >
      <Stack>
        <TextInput
          label={t.automation.zagolovok}
          required
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.currentTarget.value })}
          data-testid="kb-title"
        />
        <Select
          label={t.automation.rubrika}
          data={options(cats)}
          value={v.categoryId}
          onChange={(x) => setV({ ...v, categoryId: x })}
          clearable
        />
        <MultiSelect
          label={t.automation.temyObrashcheniy}
          description={t.automation.podskazkaPokazyvaetStatyuPo}
          data={topics.data?.map((x) => ({ value: x.id, label: String(x.pathName ?? x.name) })) ?? []}
          value={v.topicIds}
          onChange={(x) => setV({ ...v, topicIds: x })}
          searchable
        />
        <TextInput
          label={t.automation.klyuchevyeSlovaDlyaPoiska}
          description={t.automation.sinonimyIRazgovornyeFormy}
          value={v.keywords}
          onChange={(e) => setV({ ...v, keywords: e.currentTarget.value })}
        />
        <Textarea
          label={t.automation.tekstStati}
          required
          autosize
          minRows={8}
          value={v.body}
          onChange={(e) => setV({ ...v, body: e.currentTarget.value })}
          data-testid="kb-body"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            loading={save.isPending}
            disabled={!v.title.trim() || !v.body.trim()}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
            data-testid="kb-save"
          >
            {row ? t.save : t.create}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ------------------------------------------------------------------ правила автоответов (M-AUTO-02)

const RULE_KINDS = [
  { value: 'greeting', label: t.automation.privetstviePriPervomSoobshchenii },
  { value: 'queued', label: t.automation.vyVOcheredi },
  { value: 'queued_busy', label: t.automation.vseOperatoryZanyaty },
  { value: 'after_hours', label: t.automation.nerabocheeVremya },
  { value: 'keyword', label: t.automation.otvetNaKlyuchevyeSlova },
  { value: 'inactivity', label: t.automation.avtozakrytiePriMolchaniiKlienta },
];

export function AutoRepliesPage() {
  const channels = useList('/dict/channels');
  const schedules = useList('/dict/schedules');
  const textChannels = (channels.data ?? []).filter((c) => c.kind !== 'voice');
  return (
    <>
      <DictPage
        kind="auto-replies"
        title={t.automation.pravilaAvtootvetov}
        columns={[
          { key: 'name', label: t.automation.nazvanie },
          {
            key: 'kind',
            label: t.automation.vid,
            render: (r) => RULE_KINDS.find((k) => k.value === r.kind)?.label ?? '',
          },
          {
            key: 'channels',
            label: t.automation.kanaly,
            render: (r) =>
              [
                ...((r.channelIds as string[]) ?? []).map((id) =>
                  String(textChannels.find((c) => c.id === id)?.name ?? '?'),
                ),
                ...((r.channelKinds as string[]) ?? []).map(
                  (k) => TEXT_CHANNELS.find((x) => x.value === k)?.label ?? k,
                ),
              ].join(', ') || t.automation.vse,
          },
          {
            key: 'text',
            label: t.automation.tekst,
            render: (r) => (
              <Text size="sm" lineClamp={2} maw={380}>
                {String(r.text ?? '')}
              </Text>
            ),
          },
        ]}
        toForm={(r) => ({
          ...r,
          warnAfterSec: (r.params as Record<string, unknown>)?.warnAfterSec,
          closeAfterSec: (r.params as Record<string, unknown>)?.closeAfterSec,
          closeText: (r.params as Record<string, unknown>)?.closeText,
        })}
        fromForm={(v) => {
          const { warnAfterSec, closeAfterSec, closeText, ...rest } = v;
          return {
            ...rest,
            params:
              v.kind === 'inactivity'
                ? {
                    ...(warnAfterSec ? { warnAfterSec } : {}),
                    ...(closeAfterSec ? { closeAfterSec } : {}),
                    ...(closeText ? { closeText } : {}),
                  }
                : {},
          };
        }}
        createDefaults={{ kind: 'greeting', warnAfterSec: 300, closeAfterSec: 300 }}
        fields={[
          { key: 'name', label: t.automation.nazvanie, required: true },
          {
            key: 'kind',
            label: t.automation.vid,
            type: 'select',
            required: true,
            options: RULE_KINDS,
            description: t.automation.kindHint,
          },
          {
            key: 'channelIds',
            label: t.automation.kanalyEkzemplyary,
            type: 'multiselect',
            options: options(textChannels),
            description: t.automation.pustoVseKanalyS,
          },
          {
            key: 'channelKinds',
            label: t.automation.tipyKanalov,
            type: 'multiselect',
            options: TEXT_CHANNELS,
          },
          {
            key: 'scheduleId',
            label: t.automation.raspisanie,
            type: 'select',
            options: options(schedules.data),
            show: (v) => v.kind === 'after_hours',
            description: t.automation.soobshchenieOtpravlyaetsyaEsliObrash,
          },
          {
            key: 'matchType',
            label: t.automation.sravnenie,
            type: 'select',
            options: [
              { value: 'keyword', label: t.automation.slovaCherezZapyatuyu },
              { value: 'regex', label: t.automation.regulyarnoeVyrazhenie },
            ],
            show: (v) => v.kind === 'keyword',
          },
          {
            key: 'pattern',
            label: t.automation.klyuchevyeSlovaVyrazhenie,
            show: (v) => v.kind === 'keyword',
          },
          {
            key: 'text',
            label: t.automation.tekstAvtootveta,
            type: 'textarea',
            description: t.automation.peremennyeClientNameDlya,
          },
          {
            key: 'warnAfterSec',
            label: t.automation.predupreditPosleMolchaniyaKlienta,
            type: 'number',
            show: (v) => v.kind === 'inactivity',
          },
          {
            key: 'closeAfterSec',
            label: t.automation.zakrytPoslePreduprezhdeniyaS,
            type: 'number',
            show: (v) => v.kind === 'inactivity',
          },
          {
            key: 'closeText',
            label: t.automation.soobshcheniePriZakrytii,
            show: (v) => v.kind === 'inactivity',
          },
          { key: 'sortOrder', label: t.automation.poryadok, type: 'number' },
        ]}
      />
      <Text size="sm" c="dimmed" mt="md">
        {t.automation.pravilaDeystvuyutSrazuPosle}
      </Text>
    </>
  );
}

// ------------------------------------------------------------------ провайдеры подсказок (M-AI-01)

const PROVIDER_KINDS = [
  { value: 'builtin', label: t.automation.vstroennyyShablonyIBz },
  { value: 'openai', label: t.automation.llmOpenaiSovmestimyyApi },
  { value: 'http', label: t.automation.vneshniyProvayderAssistApi },
];
const MASK = '********';

export function AssistProvidersPage() {
  const [result, setResult] = useState<{
    name: string;
    ok: boolean;
    error?: string;
    ms: number;
    sample?: string;
  } | null>(null);
  const test = useAction(async (r: Row) => {
    const res = await post<{ ok: boolean; error?: string; ms: number; sample?: string }>(
      `/assist/providers/${r.id}/test`,
    );
    setResult({ name: String(r.name), ...res });
  }, t.automation.proverkaVypolnena);
  const cfg = (r: Row) => (r.config as Record<string, unknown>) ?? {};
  return (
    <>
      <DictPage
        kind="assist-providers"
        title={t.automation.podskazkiProvaydery}
        columns={[
          { key: 'name', label: t.automation.nazvanie },
          {
            key: 'kind',
            label: t.automation.vid,
            render: (r) => PROVIDER_KINDS.find((k) => k.value === r.kind)?.label ?? '',
          },
          {
            key: 'functions',
            label: t.automation.funktsii,
            render: (r) =>
              ((r.functions as string[]) ?? [])
                .map((f) => (f === 'draft' ? t.automation.chernovik : t.automation.podskazki))
                .join(', '),
          },
          { key: 'timeoutMs', label: t.automation.taymautMs },
          {
            key: 'check',
            label: t.automation.proverkaSvyazi,
            render: (r) =>
              r.lastCheckAt ? (
                <Badge color={r.lastCheckOk ? 'green' : 'red'} title={String(r.lastCheckError ?? '')}>
                  {r.lastCheckOk ? t.automation.svyazEst : t.automation.oshibka}
                </Badge>
              ) : (
                '—'
              ),
          },
        ]}
        rowActions={(r) => (
          <Button size="xs" variant="subtle" onClick={() => test.mutate(r)} data-testid="provider-test">
            {t.automation.proveritSvyaz}
          </Button>
        )}
        toForm={(r) => ({
          ...r,
          baseUrl: cfg(r).baseUrl ?? cfg(r).url,
          model: cfg(r).model,
          apiKey: (cfg(r).apiKey ?? cfg(r).token) ? MASK : '',
          systemPrompt: cfg(r).systemPrompt,
          allowExternal: cfg(r).allowExternal,
        })}
        fromForm={(v, editing) => {
          const kind = editing ? editing.kind : v.kind;
          const { baseUrl, model, apiKey, systemPrompt, allowExternal, ...rest } = v;
          const secret = apiKey === MASK ? MASK : apiKey || undefined;
          const config =
            kind === 'openai'
              ? {
                  baseUrl,
                  model,
                  apiKey: secret,
                  ...(systemPrompt ? { systemPrompt } : {}),
                  allowExternal: !!allowExternal,
                }
              : kind === 'http'
                ? { url: baseUrl, token: secret, allowExternal: !!allowExternal }
                : {};
          return { ...rest, ...(editing ? {} : { kind }), config };
        }}
        createDefaults={{ kind: 'openai', functions: ['suggest', 'draft'], timeoutMs: 5000 }}
        fields={[
          { key: 'name', label: t.automation.nazvanie, required: true },
          {
            key: 'kind',
            label: t.automation.vid,
            type: 'select',
            required: true,
            createOnly: true,
            options: PROVIDER_KINDS.filter((k) => k.value !== 'builtin'),
          },
          {
            key: 'functions',
            label: t.automation.funktsii,
            type: 'multiselect',
            options: [
              { value: 'suggest', label: t.automation.podskazkiVPaneliOperatora },
              { value: 'draft', label: t.automation.chernovikOtvetaKnopkaChernovik },
            ],
          },
          {
            key: 'baseUrl',
            label: t.automation.adres,
            placeholder: 'http://ollama:11434/v1',
            description: t.automation.llmBazovyyAdresOpenai,
            show: (v) => v.kind !== 'builtin',
          },
          { key: 'model', label: t.automation.model, show: (v) => v.kind === 'openai' },
          {
            key: 'apiKey',
            label: t.automation.klyuchToken,
            type: 'password',
            description: t.automation.khranitsyaZashifrovannymPustoBez,
            show: (v) => v.kind !== 'builtin',
          },
          {
            key: 'systemPrompt',
            label: t.automation.sistemnayaInstruktsiyaModeli,
            type: 'textarea',
            show: (v) => v.kind === 'openai',
          },
          {
            key: 'allowExternal',
            label: t.automation.razreshitAdresVneKontura,
            type: 'switch',
            show: (v) => v.kind !== 'builtin',
          },
          { key: 'timeoutMs', label: t.automation.taymautOtvetaMs, type: 'number' },
          { key: 'sortOrder', label: t.automation.poryadok, type: 'number' },
        ]}
      />
      <Text size="sm" c="dimmed" mt="md">
        {t.automation.provayderyOprashivayutsyaParallelnoK}
      </Text>
      {result && (
        <Modal opened onClose={() => setResult(null)} title={t.automation.proverkaSvyazi2(result.name)}>
          <Alert color={result.ok ? 'green' : 'red'} data-testid="provider-test-result">
            {result.ok ? t.automation.svyazEstMs(result.ms) : t.automation.oshibka2(result.error)}
          </Alert>
          {result.sample && (
            <Text size="sm" mt="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {result.sample}
            </Text>
          )}
        </Modal>
      )}
    </>
  );
}
