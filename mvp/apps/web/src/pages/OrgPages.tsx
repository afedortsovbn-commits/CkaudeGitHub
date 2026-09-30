import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  MultiSelect,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { DictPage } from '../components/DictPage';
import { get, post, put, patch } from '../lib/api';
import { type Row, type TicketRef, options, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

export function EnterprisesPage() {
  return (
    <DictPage
      kind="enterprises"
      title={t.nav.enterprises}
      columns={[
        { key: 'code', label: 'Код' },
        { key: 'name', label: 'Название' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Телефон' },
      ]}
      fields={[
        { key: 'code', label: 'Код', required: true },
        { key: 'name', label: 'Название', required: true },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Телефон' },
      ]}
    />
  );
}

/** Подразделение → в каких предприятиях (мультивыбор) + атрибуты связки. */
function DepartmentEnterprises({ dep, onClose }: { dep: Row; onClose(): void }) {
  const enterprises = useList('/dict/enterprises');
  const links = useList(`/enterprise-departments?departmentId=${dep.id}`);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (links.data) setSelected(links.data.map((l) => String(l.enterpriseId)));
  }, [links.data]);
  // Отключаемые связки: перед сохранением узнаём их открытые тикеты, чтобы предупредить (M-TKT-12a).
  const save = useAction(async () => {
    const removed = (links.data ?? []).filter((l) => !selected.includes(String(l.enterpriseId)));
    const affected = (
      await Promise.all(
        removed.map((l) => get<TicketRef[]>(`/tickets-impact?enterpriseDepartmentId=${l.id}`)),
      )
    ).flat();
    await put(`/departments/${dep.id}/enterprises`, { enterpriseIds: selected });
    return { openTickets: affected };
  });
  const saveLink = useAction((l: { id: string; transferNumber: string; email: string }) =>
    patch(`/enterprise-departments/${l.id}`, {
      transferNumber: l.transferNumber || null,
      email: l.email || null,
    }),
  );
  return (
    <Modal opened onClose={onClose} title={`«${String(dep.name)}» — предприятия`} size="xl">
      <Stack>
        <Group align="end">
          <MultiSelect
            style={{ flex: 1 }}
            label="Предприятия, в которых есть подразделение"
            data={options(enterprises.data)}
            value={selected}
            onChange={setSelected}
            searchable
            data-testid="dep-enterprises"
          />
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>
            {t.save}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          Номер или очередь для прямого перевода звонка и email задаются для каждой пары «подразделение на
          предприятии».
        </Text>
        <Table>
          <Table.Tbody>
            {(links.data ?? []).map((l) => (
              <LinkRow key={l.id} link={l} onSave={(v) => saveLink.mutate({ id: l.id, ...v })} />
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </Modal>
  );
}

function LinkRow({
  link,
  onSave,
}: {
  link: Row;
  onSave(v: { transferNumber: string; email: string }): void;
}) {
  const [num, setNum] = useState(String(link.transferNumber ?? ''));
  const [email, setEmail] = useState(String(link.email ?? ''));
  return (
    <Table.Tr>
      <Table.Td>{String(link.enterpriseName)}</Table.Td>
      <Table.Td>
        <TextInput
          size="xs"
          placeholder="Номер для перевода"
          value={num}
          onChange={(e) => setNum(e.currentTarget.value)}
        />
      </Table.Td>
      <Table.Td>
        <TextInput
          size="xs"
          placeholder="Email подразделения"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      </Table.Td>
      <Table.Td>
        <Button size="xs" variant="light" onClick={() => onSave({ transferNumber: num, email })}>
          {t.save}
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

export function DepartmentsPage() {
  const [dep, setDep] = useState<Row | null>(null);
  const links = useList('/enterprise-departments');
  const byDep = new Map<string, string[]>();
  for (const l of links.data ?? [])
    byDep.set(String(l.departmentId), [
      ...(byDep.get(String(l.departmentId)) ?? []),
      String(l.enterpriseName),
    ]);
  return (
    <>
      <DictPage
        kind="departments"
        title={t.nav.departments}
        columns={[
          { key: 'code', label: 'Код' },
          { key: 'name', label: 'Название' },
          {
            key: 'enterprises',
            label: 'Предприятия',
            render: (r) => (
              <Group gap={4}>
                {(byDep.get(r.id) ?? []).map((n) => (
                  <Badge key={n} variant="outline">
                    {n}
                  </Badge>
                ))}
              </Group>
            ),
          },
        ]}
        fields={[
          { key: 'code', label: 'Код', required: true },
          { key: 'name', label: 'Название', required: true },
        ]}
        rowActions={(r) => (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setDep(r)}
            data-testid={`dep-links-${String(r.code)}`}
          >
            Предприятия
          </Button>
        )}
      />
      {dep && <DepartmentEnterprises dep={dep} onClose={() => setDep(null)} />}
    </>
  );
}

const SOURCE: Record<string, string> = {
  manual: 'вручную',
  import: 'импорт CSV',
  sync: 'синхронизация',
};

export function ObjectsPage() {
  const enterprises = useList('/dict/enterprises?active=all');
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState('code;name;address;enterprise_code\n');
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    errors: { line: number; message: string }[];
  } | null>(null);
  const imp = useAction(async () => setResult(await post('/objects/import', { csv })), 'Импорт выполнен');
  const entName = new Map((enterprises.data ?? []).map((e) => [e.id, String(e.name)]));
  return (
    <>
      <DictPage
        kind="objects"
        title={t.nav.objects}
        columns={[
          { key: 'code', label: 'Код' },
          { key: 'name', label: 'Название' },
          { key: 'address', label: 'Адрес' },
          {
            key: 'enterpriseId',
            label: 'Предприятие',
            render: (r) => entName.get(String(r.enterpriseId)) ?? '',
          },
          {
            key: 'source',
            label: 'Источник',
            render: (r) => SOURCE[String(r.source)] ?? String(r.source ?? ''),
          },
          {
            key: 'rocketdata',
            label: 'Точка Rocket Data',
            render: (r) => String((r.externalIds as Record<string, string> | undefined)?.rocketdata ?? ''),
          },
        ]}
        fields={[
          {
            key: 'enterpriseId',
            label: 'Предприятие',
            type: 'select',
            required: true,
            options: options(enterprises.data),
          },
          { key: 'code', label: 'Код', required: true },
          { key: 'name', label: 'Название', required: true },
          { key: 'address', label: 'Адрес' },
          {
            key: 'rocketdata',
            label: 'Идентификатор точки в Rocket Data',
            description: 'По нему отзыв с карт сопоставляется объекту (иначе — по коду объекта)',
          },
        ]}
        toForm={(r) => ({
          ...r,
          rocketdata: (r.externalIds as Record<string, string> | undefined)?.rocketdata ?? '',
        })}
        fromForm={(v, editing) => {
          const { rocketdata, ...rest } = v;
          const ext = { ...((editing?.externalIds ?? {}) as Record<string, string>) };
          if (rocketdata) ext.rocketdata = String(rocketdata);
          else delete ext.rocketdata;
          return { ...rest, externalIds: ext };
        }}
        toolbar={
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            Импорт CSV
          </Button>
        }
      />
      <Modal
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        title="Импорт объектов из CSV"
        size="xl"
      >
        <Stack>
          <Text size="sm">
            Столбцы: code; name; address; enterprise_code. Существующие объекты обновляются по коду.
            Автоматическая ежедневная синхронизация — отдельным этапом (Ф13).
          </Text>
          <Textarea autosize minRows={8} value={csv} onChange={(e) => setCsv(e.currentTarget.value)} />
          <Button onClick={() => imp.mutate(undefined)} loading={imp.isPending}>
            Импортировать
          </Button>
          {result && (
            <Alert color={result.errors.length ? 'yellow' : 'green'}>
              Создано: {result.created}, обновлено: {result.updated}
              {result.errors.map((e) => (
                <div key={e.line}>
                  Строка {e.line}: {e.message}
                </div>
              ))}
            </Alert>
          )}
        </Stack>
      </Modal>
    </>
  );
}

const BEHAVIORS = [
  { value: 'resolved', label: 'Решено (закрыть)' },
  { value: 'escalate', label: 'Передать на 2-ю линию' },
  { value: 'no_reply_needed', label: 'Не требует ответа' },
  { value: 'postponed', label: 'Отложено / перезвонить' },
  { value: 'duplicate', label: 'Дубликат' },
];
const CHANNELS = ['voice', 'webchat', 'app', 'telegram', 'email', 'review', 'api'].map((c) => ({
  value: c,
  label: c,
}));

const STRATEGIES = [
  { value: 'least_recent', label: 'Дольше всех свободен' },
  { value: 'least_load', label: 'Наименьшая загрузка' },
];

export function DictionariesPage() {
  const topics = useList('/topics');
  const queues = useList('/dict/queues');
  return (
    <>
      <Title order={3} mb="md">
        {t.nav.dictionaries}
      </Title>
      <Tabs defaultValue="dispositions" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="dispositions">Результаты обработки</Tabs.Tab>
          <Tabs.Tab value="answer-methods">Способы ответа</Tabs.Tab>
          <Tabs.Tab value="queues">Очереди</Tabs.Tab>
          <Tabs.Tab value="routing-rules">Правила маршрутизации</Tabs.Tab>
          <Tabs.Tab value="segment-priority">Приоритет сегментов</Tabs.Tab>
          <Tabs.Tab value="skills">Навыки</Tabs.Tab>
          <Tabs.Tab value="tags">Теги</Tabs.Tab>
          <Tabs.Tab value="break-reasons">Причины перерывов</Tabs.Tab>
          <Tabs.Tab value="scope-templates">Шаблоны областей</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="dispositions">
          <DictPage
            hideTitle
            kind="dispositions"
            title="Результат обработки"
            columns={[
              { key: 'code', label: 'Код' },
              { key: 'name', label: 'Название' },
              {
                key: 'behavior',
                label: 'Поведение',
                render: (r) => BEHAVIORS.find((b) => b.value === r.behavior)?.label ?? '',
              },
            ]}
            fields={[
              { key: 'code', label: 'Код', required: true },
              { key: 'name', label: 'Название', required: true },
              { key: 'behavior', label: 'Поведение', type: 'select', required: true, options: BEHAVIORS },
              { key: 'sortOrder', label: 'Порядок', type: 'number' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="answer-methods">
          <DictPage
            hideTitle
            kind="answer-methods"
            title="Способ ответа"
            columns={[
              { key: 'code', label: 'Код' },
              { key: 'name', label: 'Название' },
            ]}
            fields={[
              { key: 'code', label: 'Код', required: true },
              { key: 'name', label: 'Название', required: true },
              { key: 'sortOrder', label: 'Порядок', type: 'number' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="queues">
          <DictPage
            hideTitle
            kind="queues"
            title="Очередь"
            columns={[
              { key: 'name', label: 'Название' },
              { key: 'channels', label: 'Каналы', render: (r) => (r.channels as string[]).join(', ') },
              { key: 'priority', label: 'Приоритет' },
              {
                key: 'strategy',
                label: 'Стратегия',
                render: (r) => STRATEGIES.find((s) => s.value === r.strategy)?.label ?? String(r.strategy),
              },
            ]}
            fields={[
              { key: 'name', label: 'Название', required: true },
              { key: 'channels', label: 'Каналы', type: 'multiselect', options: CHANNELS },
              { key: 'priority', label: 'Приоритет (0–100)', type: 'number' },
              { key: 'maxWaitS', label: 'Макс. ожидание до эскалации, с', type: 'number' },
              { key: 'strategy', label: 'Стратегия распределения', type: 'select', options: STRATEGIES },
              {
                key: 'overflowQueueId',
                label: 'Резервная группа (перелив)',
                type: 'select',
                options: options((queues.data ?? []).filter((q) => q.id !== undefined)),
              },
              { key: 'overflowAfterS', label: 'Перелив в резерв через, с', type: 'number' },
              { key: 'offerTimeoutS', label: 'Таймаут принятия оператором, с', type: 'number' },
              { key: 'wrapUpS', label: 'Постобработка, с', type: 'number' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="routing-rules">
          <DictPage
            hideTitle
            kind="routing-rules"
            title="Правило маршрутизации"
            columns={[
              { key: 'name', label: 'Название' },
              { key: 'channelKind', label: 'Канал', render: (r) => String(r.channelKind ?? 'любой') },
              { key: 'matchType', label: 'Тип' },
              { key: 'pattern', label: 'Условие' },
              {
                key: 'queueId',
                label: 'Очередь',
                render: (r) => String((queues.data ?? []).find((q) => q.id === r.queueId)?.name ?? ''),
              },
            ]}
            fields={[
              { key: 'name', label: 'Название', required: true },
              {
                key: 'channelKind',
                label: 'Канал (пусто — любой)',
                type: 'select',
                options: CHANNELS.filter((c) => c.value !== 'voice'),
              },
              {
                key: 'matchType',
                label: 'Тип условия',
                type: 'select',
                required: true,
                options: [
                  { value: 'keyword', label: 'Ключевое слово (подстрока)' },
                  { value: 'regex', label: 'Регулярное выражение' },
                ],
              },
              { key: 'pattern', label: 'Слово или regex', required: true },
              {
                key: 'queueId',
                label: 'Очередь',
                type: 'select',
                required: true,
                options: options(queues.data),
              },
              { key: 'priorityBoost', label: 'Надбавка приоритета', type: 'number' },
              { key: 'isUrgent', label: 'Помечать «срочное»', type: 'switch' },
              { key: 'sortOrder', label: 'Порядок проверки', type: 'number' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="segment-priority">
          <DictPage
            hideTitle
            kind="segment-priority"
            title="Приоритет сегмента"
            columns={[
              { key: 'segment', label: 'Сегмент клиента' },
              { key: 'boost', label: 'Надбавка приоритета' },
            ]}
            fields={[
              { key: 'segment', label: 'Сегмент (как в карточке клиента)', required: true },
              { key: 'boost', label: 'Надбавка приоритета', type: 'number' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="skills">
          <DictPage
            hideTitle
            kind="skills"
            title="Навык"
            columns={[{ key: 'name', label: 'Название' }]}
            fields={[
              { key: 'name', label: 'Название', required: true },
              { key: 'topicId', label: 'Тема', type: 'select', options: options(topics.data) },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="tags">
          <DictPage
            hideTitle
            kind="tags"
            title="Тег"
            columns={[{ key: 'name', label: 'Название' }]}
            fields={[{ key: 'name', label: 'Название', required: true }]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="break-reasons">
          <DictPage
            hideTitle
            kind="break-reasons"
            title="Причина перерыва"
            columns={[{ key: 'name', label: 'Название' }]}
            fields={[{ key: 'name', label: 'Название', required: true }]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="scope-templates">
          <DictPage
            hideTitle
            kind="scope-templates"
            writePerm="admin.users"
            title="Шаблон области"
            columns={[
              { key: 'name', label: 'Название' },
              { key: 'rules', label: 'Правил', render: (r) => String((r.rules as unknown[]).length) },
            ]}
            fields={[{ key: 'name', label: 'Название', required: true }]}
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
