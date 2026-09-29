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
import { patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { options, type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

const TEXT_CHANNELS = [
  { value: 'webchat', label: 'Чат на сайте' },
  { value: 'app', label: 'Чат в приложении' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'email', label: 'Email' },
];

// ------------------------------------------------------------------ шаблоны ответов (M-AUTO-01)

/** Шаблоны ответов: общие (администратор) и личные (любой оператор). Быстрый вызов — «/код» в поле ответа. */
export function TemplatesPage() {
  const { can } = useAuth();
  const admin = can('admin.directories');
  const [scope, setScope] = useState('all');
  const [q, setQ] = useState('');
  const [inactive, setInactive] = useState(false);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const list = useList(
    `/templates?scope=${scope}${inactive ? '&active=all' : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  );
  const toggle = useAction((r: Row) => post(`/templates/${r.id}/${r.isActive ? 'deactivate' : 'activate'}`));
  const mayEdit = (r: Row) => (r.shared ? admin : true);
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Шаблоны ответов</Title>
        <Group>
          <SegmentedControl
            size="xs"
            value={scope}
            onChange={setScope}
            data={[
              { value: 'all', label: 'Все' },
              { value: 'shared', label: 'Общие' },
              { value: 'mine', label: 'Мои' },
            ]}
          />
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
      <Text size="sm" c="dimmed" mb="sm">
        Переменные: <Code>{'{{client.name}}'}</Code> — имя клиента, <Code>{'{{operator.name}}'}</Code> —
        оператор, <Code>{'{{conversation.topic}}'}</Code> — тема. В поле ответа наберите <Code>/</Code> и код
        шаблона.
      </Text>
      <Table striped highlightOnHover data-testid="templates">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Название</Table.Th>
            <Table.Th>Код</Table.Th>
            <Table.Th>Текст</Table.Th>
            <Table.Th>Тема</Table.Th>
            <Table.Th>Вид</Table.Th>
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
              <Table.Td>{String(r.topicName ?? '—')}</Table.Td>
              <Table.Td>
                <Badge variant="light" color={r.shared ? 'blue' : 'grape'}>
                  {r.shared ? 'общий' : 'личный'}
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
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function TemplateForm({ row, admin, onClose }: { row: Row | null; admin: boolean; onClose(): void }) {
  const topics = useList('/topics');
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
    return row ? patch(`/templates/${row.id}`, data) : post('/templates', { ...data, shared: v.shared });
  });
  return (
    <Modal opened onClose={onClose} title={row ? 'Шаблон: изменение' : 'Новый шаблон'} size="lg">
      <Stack>
        <TextInput
          label="Название"
          required
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.currentTarget.value })}
          data-testid="template-title"
        />
        <TextInput
          label="Код быстрого вызова (без «/»)"
          value={v.shortcut}
          onChange={(e) => setV({ ...v, shortcut: e.currentTarget.value })}
          data-testid="template-shortcut"
        />
        <Textarea
          label="Текст"
          required
          autosize
          minRows={4}
          value={v.body}
          onChange={(e) => setV({ ...v, body: e.currentTarget.value })}
          data-testid="template-body"
        />
        <Select
          label="Тема"
          description="Подсказка поднимает шаблон выше, если у обращения эта тема"
          data={topics.data?.map((x) => ({ value: x.id, label: String(x.pathName ?? x.name) })) ?? []}
          value={v.topicId}
          onChange={(x) => setV({ ...v, topicId: x })}
          clearable
          searchable
        />
        <MultiSelect
          label="Каналы"
          description="Пусто — во всех текстовых каналах"
          data={TEXT_CHANNELS}
          value={v.channelKinds}
          onChange={(x) => setV({ ...v, channelKinds: x })}
        />
        {!row && admin && (
          <Switch
            label="Общий шаблон (виден всем операторам)"
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
        База знаний
      </Title>
      <Tabs defaultValue="articles">
        <Tabs.List mb="md">
          <Tabs.Tab value="articles">Статьи</Tabs.Tab>
          {can('admin.directories') && <Tabs.Tab value="categories">Рубрики</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="articles">
          <Articles />
        </Tabs.Panel>
        <Tabs.Panel value="categories">
          <DictPage
            kind="kb-categories"
            title="Рубрики"
            hideTitle
            columns={[
              { key: 'name', label: 'Название' },
              { key: 'sortOrder', label: 'Порядок' },
            ]}
            fields={[
              { key: 'name', label: 'Название', required: true },
              { key: 'sortOrder', label: 'Порядок', type: 'number' },
            ]}
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function Articles() {
  const { can } = useAuth();
  const admin = can('admin.directories');
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
          placeholder="Поиск по статьям (полнотекстовый)"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          w={320}
          data-testid="kb-search"
        />
        <Select placeholder="Рубрика" data={options(cats.data)} value={cat} onChange={setCat} clearable />
        {admin && (
          <>
            <Switch
              label={t.showInactive}
              checked={inactive}
              onChange={(e) => setInactive(e.currentTarget.checked)}
            />
            <Button onClick={() => setEditing('new')} data-testid="kb-new">
              Новая статья
            </Button>
          </>
        )}
      </Group>
      <Table striped highlightOnHover data-testid="kb-articles">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Статья</Table.Th>
            <Table.Th>Рубрика</Table.Th>
            <Table.Th>Изменена</Table.Th>
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
    <Modal opened onClose={onClose} title={row ? 'Статья: изменение' : 'Новая статья'} size="xl">
      <Stack>
        <TextInput
          label="Заголовок"
          required
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.currentTarget.value })}
          data-testid="kb-title"
        />
        <Select
          label="Рубрика"
          data={options(cats)}
          value={v.categoryId}
          onChange={(x) => setV({ ...v, categoryId: x })}
          clearable
        />
        <MultiSelect
          label="Темы обращений"
          description="Подсказка показывает статью по теме обращения"
          data={topics.data?.map((x) => ({ value: x.id, label: String(x.pathName ?? x.name) })) ?? []}
          value={v.topicIds}
          onChange={(x) => setV({ ...v, topicIds: x })}
          searchable
        />
        <TextInput
          label="Ключевые слова для поиска"
          description="Синонимы и разговорные формы через запятую"
          value={v.keywords}
          onChange={(e) => setV({ ...v, keywords: e.currentTarget.value })}
        />
        <Textarea
          label="Текст статьи"
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
  { value: 'greeting', label: 'Приветствие при первом сообщении' },
  { value: 'queued', label: '«Вы в очереди»' },
  { value: 'after_hours', label: 'Нерабочее время' },
  { value: 'keyword', label: 'Ответ на ключевые слова' },
  { value: 'inactivity', label: 'Автозакрытие при молчании клиента' },
];

export function AutoRepliesPage() {
  const channels = useList('/dict/channels');
  const schedules = useList('/dict/schedules');
  const textChannels = (channels.data ?? []).filter((c) => c.kind !== 'voice');
  return (
    <>
      <DictPage
        kind="auto-replies"
        title="Правила автоответов"
        columns={[
          { key: 'name', label: 'Название' },
          {
            key: 'kind',
            label: 'Вид',
            render: (r) => RULE_KINDS.find((k) => k.value === r.kind)?.label ?? '',
          },
          {
            key: 'channels',
            label: 'Каналы',
            render: (r) =>
              [
                ...((r.channelIds as string[]) ?? []).map((id) =>
                  String(textChannels.find((c) => c.id === id)?.name ?? '?'),
                ),
                ...((r.channelKinds as string[]) ?? []).map(
                  (k) => TEXT_CHANNELS.find((x) => x.value === k)?.label ?? k,
                ),
              ].join(', ') || 'все',
          },
          {
            key: 'text',
            label: 'Текст',
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
          { key: 'name', label: 'Название', required: true },
          { key: 'kind', label: 'Вид', type: 'select', required: true, options: RULE_KINDS },
          {
            key: 'channelIds',
            label: 'Каналы (экземпляры)',
            type: 'multiselect',
            options: options(textChannels),
            description: 'Пусто — все каналы (с учётом типов ниже)',
          },
          { key: 'channelKinds', label: 'Типы каналов', type: 'multiselect', options: TEXT_CHANNELS },
          {
            key: 'scheduleId',
            label: 'Расписание',
            type: 'select',
            options: options(schedules.data),
            show: (v) => v.kind === 'after_hours',
            description: 'Сообщение отправляется, если обращение пришло вне рабочего времени',
          },
          {
            key: 'matchType',
            label: 'Сравнение',
            type: 'select',
            options: [
              { value: 'keyword', label: 'Слова (через запятую)' },
              { value: 'regex', label: 'Регулярное выражение' },
            ],
            show: (v) => v.kind === 'keyword',
          },
          { key: 'pattern', label: 'Ключевые слова / выражение', show: (v) => v.kind === 'keyword' },
          {
            key: 'text',
            label: 'Текст автоответа',
            type: 'textarea',
            description: 'Переменные: {{client.name}}. Для автозакрытия — текст предупреждения клиенту.',
          },
          {
            key: 'warnAfterSec',
            label: 'Предупредить после молчания клиента, с',
            type: 'number',
            show: (v) => v.kind === 'inactivity',
          },
          {
            key: 'closeAfterSec',
            label: 'Закрыть после предупреждения, с',
            type: 'number',
            show: (v) => v.kind === 'inactivity',
          },
          {
            key: 'closeText',
            label: 'Сообщение при закрытии',
            show: (v) => v.kind === 'inactivity',
          },
          { key: 'sortOrder', label: 'Порядок', type: 'number' },
        ]}
      />
      <Text size="sm" c="dimmed" mt="md">
        Правила действуют сразу после сохранения. Приветствие, «нерабочее время» и «в очереди» отправляются
        один раз за обращение; ответ на ключевые слова — пока обращение ждёт оператора; автозакрытие — если
        последним писал оператор или бот, а клиент молчит.
      </Text>
    </>
  );
}

// ------------------------------------------------------------------ провайдеры подсказок (M-AI-01)

const PROVIDER_KINDS = [
  { value: 'builtin', label: 'Встроенный (шаблоны и БЗ)' },
  { value: 'openai', label: 'LLM: OpenAI-совместимый API' },
  { value: 'http', label: 'Внешний провайдер (Assist API)' },
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
  }, 'Проверка выполнена');
  const cfg = (r: Row) => (r.config as Record<string, unknown>) ?? {};
  return (
    <>
      <DictPage
        kind="assist-providers"
        title="Подсказки: провайдеры"
        columns={[
          { key: 'name', label: 'Название' },
          {
            key: 'kind',
            label: 'Вид',
            render: (r) => PROVIDER_KINDS.find((k) => k.value === r.kind)?.label ?? '',
          },
          {
            key: 'functions',
            label: 'Функции',
            render: (r) =>
              ((r.functions as string[]) ?? [])
                .map((f) => (f === 'draft' ? 'черновик' : 'подсказки'))
                .join(', '),
          },
          { key: 'timeoutMs', label: 'Таймаут, мс' },
          {
            key: 'check',
            label: 'Проверка связи',
            render: (r) =>
              r.lastCheckAt ? (
                <Badge color={r.lastCheckOk ? 'green' : 'red'} title={String(r.lastCheckError ?? '')}>
                  {r.lastCheckOk ? 'связь есть' : 'ошибка'}
                </Badge>
              ) : (
                '—'
              ),
          },
        ]}
        rowActions={(r) => (
          <Button size="xs" variant="subtle" onClick={() => test.mutate(r)} data-testid="provider-test">
            Проверить связь
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
          { key: 'name', label: 'Название', required: true },
          {
            key: 'kind',
            label: 'Вид',
            type: 'select',
            required: true,
            createOnly: true,
            options: PROVIDER_KINDS.filter((k) => k.value !== 'builtin'),
          },
          {
            key: 'functions',
            label: 'Функции',
            type: 'multiselect',
            options: [
              { value: 'suggest', label: 'Подсказки в панели оператора' },
              { value: 'draft', label: 'Черновик ответа (кнопка «Черновик»)' },
            ],
          },
          {
            key: 'baseUrl',
            label: 'Адрес',
            placeholder: 'http://ollama:11434/v1',
            description:
              'LLM — базовый адрес OpenAI-совместимого API (…/v1); внешний провайдер — URL POST-запроса',
            show: (v) => v.kind !== 'builtin',
          },
          { key: 'model', label: 'Модель', show: (v) => v.kind === 'openai' },
          {
            key: 'apiKey',
            label: 'Ключ / токен',
            type: 'password',
            description: 'Хранится зашифрованным; пусто — без ключа',
            show: (v) => v.kind !== 'builtin',
          },
          {
            key: 'systemPrompt',
            label: 'Системная инструкция модели',
            type: 'textarea',
            show: (v) => v.kind === 'openai',
          },
          {
            key: 'allowExternal',
            label: 'Разрешить адрес вне контура (облачная LLM — только по согласованию, В-05)',
            type: 'switch',
            show: (v) => v.kind !== 'builtin',
          },
          { key: 'timeoutMs', label: 'Таймаут ответа, мс', type: 'number' },
          { key: 'sortOrder', label: 'Порядок', type: 'number' },
        ]}
      />
      <Text size="sm" c="dimmed" mt="md">
        Провайдеры опрашиваются параллельно, каждый со своим таймаутом; отключённый, упавший или медленный
        провайдер не мешает оператору — подсказки встроенного провайдера показываются всегда. Включение и
        выключение действует сразу, без перезапуска.
      </Text>
      {result && (
        <Modal opened onClose={() => setResult(null)} title={`Проверка связи: ${result.name}`}>
          <Alert color={result.ok ? 'green' : 'red'} data-testid="provider-test-result">
            {result.ok ? `Связь есть (${result.ms} мс)` : `Ошибка: ${result.error}`}
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
