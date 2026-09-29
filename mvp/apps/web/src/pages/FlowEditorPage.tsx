import '@xyflow/react/dist/style.css';
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Drawer,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import {
  type Action,
  exitsOf,
  type FlowEvent,
  type FlowGraph,
  type FlowKind,
  type FlowNode,
  type Media,
  MENU_DIGITS,
  NODE_SPECS,
  NUMBER_FRAGMENTS,
  type NodeType,
  resumeFlow,
  type Schedule,
  startFlow,
  type StepResult,
  validateGraph,
} from '@cc/flow-engine';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, errorText, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { options, type Row, useAction, useList } from '../lib/data';
import { AudioPreview } from './IvrAdminPages';

// ------------------------------------------------------------------ список сценариев

export function FlowListPage({ kind = 'voice' }: { kind?: FlowKind }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const text = kind === 'text';
  const base = text ? '/bots' : '/ivr';
  const list = useList(`/flows?kind=${kind}`);
  const channels = useList('/dict/channels', text);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [dids, setDids] = useState<string[]>([]);
  const create = useAction(
    () => post<Row>('/flows', { name, kind, dids: text ? [] : dids }).then((f) => nav(`${base}/${f.id}`)),
    'Сценарий создан',
  );
  const toggle = useAction((r: Row) => post(`/flows/${r.id}/${r.isActive ? 'deactivate' : 'activate'}`));
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>{text ? 'Боты текстовых каналов' : 'Сценарии IVR'}</Title>
        {can('admin.directories') && (
          <Button onClick={() => setOpen(true)} data-testid="flow-new">
            Новый сценарий
          </Button>
        )}
      </Group>
      <Table striped highlightOnHover data-testid="flow-list">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Название</Table.Th>
            <Table.Th>{text ? 'Каналы' : 'Номера (DID)'}</Table.Th>
            <Table.Th>Опубликована</Table.Th>
            <Table.Th>Статус</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((f) => (
            <Table.Tr key={f.id}>
              <Table.Td>
                <Link to={`${base}/${f.id}`}>{String(f.name)}</Link>
              </Table.Td>
              <Table.Td>
                {text
                  ? (channels.data ?? [])
                      .filter((c) => c.botFlowId === f.id)
                      .map((c) => String(c.name))
                      .join(', ') || '— (назначается в «Каналах»)'
                  : ((f.dids as string[]) ?? []).join(', ') || '—'}
              </Table.Td>
              <Table.Td>
                {f.publishedVersion ? (
                  `версия ${String(f.publishedVersion)}`
                ) : (
                  <Badge color="gray">не опубликован</Badge>
                )}{' '}
                {f.hasUnpublished && f.publishedVersion ? <Badge color="orange">есть изменения</Badge> : null}
              </Table.Td>
              <Table.Td>
                <Badge color={f.isActive ? 'green' : 'gray'}>{f.isActive ? 'Активен' : 'Отключён'}</Badge>
              </Table.Td>
              <Table.Td>
                {can('admin.directories') && (
                  <Button
                    size="xs"
                    variant="subtle"
                    color={f.isActive ? 'red' : 'green'}
                    onClick={() => toggle.mutate(f)}
                  >
                    {f.isActive ? 'Отключить' : 'Включить'}
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={open} onClose={() => setOpen(false)} title={text ? 'Новый бот' : 'Новый сценарий IVR'}>
        <Stack>
          <TextInput
            label="Название"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-testid="flow-name"
          />
          {!text && (
            <TagsInput
              label="Номера (DID), на которые отвечает сценарий"
              description="Можно назначить позже; номер должен быть у голосового канала"
              value={dids}
              onChange={setDids}
            />
          )}
          <Button
            disabled={!name.trim()}
            onClick={() => create.mutate(undefined)}
            loading={create.isPending}
            data-testid="flow-create"
          >
            Создать
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ справочники для свойств и прогона

interface Refs {
  audio: Row[];
  queues: Row[];
  topics: Row[];
  schedules: Row[];
  operations: Row[];
}

function useRefs(): Refs {
  const audio = useList('/ivr/audio');
  const queues = useList('/dict/queues');
  const topics = useList('/topics');
  const schedules = useList('/dict/schedules');
  const operations = useList('/dict/integrations');
  // Один объект на набор данных — иначе эффекты, зависящие от справочников, срабатывали бы на каждой отрисовке.
  return useMemo(
    () => ({
      audio: audio.data ?? [],
      queues: queues.data ?? [],
      topics: topics.data ?? [],
      schedules: schedules.data ?? [],
      operations: operations.data ?? [],
    }),
    [audio.data, queues.data, topics.data, schedules.data, operations.data],
  );
}

const audioName = (refs: Refs, id: string) =>
  String(refs.audio.find((a) => a.id === id)?.name ?? '(файл удалён)');

// ------------------------------------------------------------------ узел на холсте

type NodeData = {
  type: NodeType;
  name?: string;
  params: Record<string, unknown>;
  issues?: string[];
  summary?: string;
};
type CcNode = Node<NodeData, 'cc'>;

const COLORS: Partial<Record<NodeType, string>> = {
  start: '#2f9e44',
  menu: '#1971c2',
  queue: '#e8590c',
  http: '#7048e8',
  hangup: '#868e96',
  csat: '#f08c00',
  voicemail: '#c2255c',
  schedule: '#0c8599',
  condition: '#0c8599',
  buttons: '#1971c2',
  ask: '#5f3dc4',
  handoff: '#e8590c',
};

const NodeView = memo(function NodeView({ data, selected }: NodeProps<CcNode>) {
  const spec = NODE_SPECS[data.type];
  const exits = exitsOf({ id: '', type: data.type, params: data.params });
  const color = COLORS[data.type] ?? '#495057';
  return (
    <Box
      data-testid={`node-${data.type}`}
      style={{
        width: Math.max(200, exits.length * 56),
        background: 'var(--mantine-color-body)',
        border: `2px solid ${data.issues?.length ? '#e03131' : selected ? '#228be6' : color}`,
        borderRadius: 8,
        fontSize: 12,
        boxShadow: selected ? '0 0 0 3px rgba(34,139,230,.25)' : undefined,
      }}
    >
      {data.type !== 'start' && <Handle type="target" position={Position.Top} />}
      <Box style={{ background: color, color: 'white', padding: '2px 8px', borderRadius: '5px 5px 0 0' }}>
        {spec.label}
      </Box>
      <Box p={6} pb={exits.length ? 18 : 6}>
        {(data.name || data.type === 'start') && (
          <Text size="xs" fw={600} truncate>
            {data.name || 'Начало'}
          </Text>
        )}
        {data.summary && (
          <Text size="10px" c="dimmed" lineClamp={2}>
            {data.summary}
          </Text>
        )}
      </Box>
      {exits.map((x, i) => {
        const left = `${((i + 0.5) / exits.length) * 100}%`;
        return (
          <Box key={x.id}>
            <Text
              size="9px"
              c="dimmed"
              style={{
                position: 'absolute',
                bottom: 4,
                left,
                transform: 'translateX(-50%)',
                whiteSpace: 'nowrap',
              }}
            >
              {x.label}
            </Text>
            <Handle
              type="source"
              id={x.id}
              position={Position.Bottom}
              style={{ left, background: color }}
              data-testid={`exit-${x.id}`}
            />
          </Box>
        );
      })}
    </Box>
  );
});
const nodeTypes = { cc: NodeView };

function summary(n: { type: NodeType; params: Record<string, unknown> }, refs: Refs): string {
  const p = n.params;
  const names = (ids: unknown) => ((ids as string[]) ?? []).map((id) => audioName(refs, id)).join(', ');
  switch (n.type) {
    case 'hangup':
      return p.text ? String(p.text) : names(p.audio);
    case 'play':
      return names(p.audio);
    case 'message':
    case 'ask':
      return String(p.text ?? '');
    case 'buttons':
      return String(p.text ?? '');
    case 'handoff':
      return String(refs.queues.find((q) => q.id === p.queueId)?.name ?? 'очередь канала');
    case 'menu':
      return `${names(p.audio)} · ${((p.digits as string[]) ?? []).join(' ')}`;
    case 'queue':
      return String(refs.queues.find((q) => q.id === p.queueId)?.name ?? '');
    case 'http':
      return String(refs.operations.find((o) => o.id === p.operationId)?.name ?? '');
    case 'schedule':
      return String(refs.schedules.find((s) => s.id === p.scheduleId)?.name ?? '');
    case 'condition':
      return `${String(p.variable ?? '')} ${String(p.op ?? '')} ${String(p.value ?? '')}`;
    case 'setVariable':
      return `${String(p.variable ?? '')} = ${String(p.value ?? '')}`;
    case 'sayNumber':
      return `{{${String(p.variable ?? '')}}}`;
    case 'transfer':
      return String(p.number ?? '');
    case 'voicemail':
      return p.mode === 'callback' ? 'заказ перезвона' : 'голосовое сообщение';
    default:
      return '';
  }
}

// ------------------------------------------------------------------ свойства узла

function NodeParams({
  node,
  refs,
  kind,
  onChange,
}: {
  node: CcNode;
  refs: Refs;
  kind: FlowKind;
  onChange(patch: Partial<NodeData>): void;
}) {
  const p = node.data.params;
  const set = (k: string, v: unknown) => onChange({ params: { ...p, [k]: v } });
  const prompts = refs.audio
    .filter((a) => a.kind === 'prompt')
    .map((a) => ({ value: a.id, label: String(a.name) }));
  const audioMulti = (key: string, label: string, description?: string) => (
    <Stack gap={2}>
      <MultiSelect
        label={label}
        description={description ?? 'Файлы звучат в порядке выбора'}
        data={prompts}
        value={(p[key] as string[]) ?? []}
        onChange={(v) => set(key, v)}
        searchable
        data-testid={`param-${key}`}
      />
      <Group gap={4}>
        {((p[key] as string[]) ?? []).map((id) => (
          <AudioPreview key={id} id={id} />
        ))}
      </Group>
    </Stack>
  );
  const audioOne = (value: string | undefined, label: string, onSet: (v: string | undefined) => void) => (
    <Select
      label={label}
      data={prompts}
      value={value ?? null}
      onChange={(v) => onSet(v ?? undefined)}
      clearable
      searchable
    />
  );
  const num = (key: string, label: string, min: number, max: number) => (
    <NumberInput
      label={label}
      min={min}
      max={max}
      value={Number(p[key] ?? '') || ''}
      onChange={(v) => set(key, v === '' ? undefined : Number(v))}
    />
  );
  const t = node.data.type;
  return (
    <Stack gap="xs">
      {t !== 'start' && (
        <TextInput
          label="Подпись узла"
          value={node.data.name ?? ''}
          onChange={(e) => onChange({ name: e.currentTarget.value })}
          data-testid="param-name"
        />
      )}
      {(t === 'play' || (t === 'hangup' && kind === 'voice')) &&
        audioMulti('audio', t === 'hangup' ? 'Прощальная фраза' : 'Фразы')}
      {kind === 'text' && <TextNodeParams t={t} p={p} refs={refs} set={set} />}
      {t === 'announcements' && (
        <Text size="xs" c="dimmed">
          Звучат действующие объявления из раздела «Объявления о сбоях». Если их нет — сценарий сразу идёт
          дальше.
        </Text>
      )}
      {t === 'menu' && (
        <>
          {audioMulti('audio', 'Фраза меню')}
          <MultiSelect
            label="Пункты (цифры)"
            data={MENU_DIGITS}
            value={(p.digits as string[]) ?? []}
            onChange={(v) => set('digits', v)}
            data-testid="param-digits"
          />
          <Select
            label="Цифра «вернуться в предыдущее меню»"
            data={MENU_DIGITS}
            value={(p.backDigit as string) || null}
            onChange={(v) => set('backDigit', v ?? undefined)}
            clearable
          />
          {num('timeoutSec', 'Ожидание ввода, с', 1, 60)}
          {num('retries', 'Повторов при ошибке или тишине', 0, 10)}
          {audioMulti('invalidAudio', 'Фраза при неверном вводе', ' ')}
        </>
      )}
      {t === 'schedule' && (
        <Select
          label="Расписание"
          data={options(refs.schedules)}
          value={(p.scheduleId as string) || null}
          onChange={(v) => set('scheduleId', v ?? '')}
        />
      )}
      {t === 'condition' && (
        <>
          <TextInput
            label="Переменная"
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
          />
          <Select
            label="Условие"
            data={[
              { value: 'eq', label: 'равно' },
              { value: 'ne', label: 'не равно' },
              { value: 'gt', label: 'больше' },
              { value: 'ge', label: 'больше или равно' },
              { value: 'lt', label: 'меньше' },
              { value: 'le', label: 'меньше или равно' },
              { value: 'contains', label: 'содержит' },
              { value: 'empty', label: 'пусто' },
              { value: 'notEmpty', label: 'не пусто' },
            ]}
            value={String(p.op ?? 'eq')}
            onChange={(v) => set('op', v)}
          />
          {!['empty', 'notEmpty'].includes(String(p.op)) && (
            <TextInput
              label="Значение"
              value={String(p.value ?? '')}
              onChange={(e) => set('value', e.currentTarget.value)}
            />
          )}
        </>
      )}
      {t === 'setVariable' && (
        <>
          <TextInput
            label="Переменная"
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
          />
          <TextInput
            label="Значение ({{переменная}})"
            value={String(p.value ?? '')}
            onChange={(e) => set('value', e.currentTarget.value)}
          />
        </>
      )}
      {t === 'queue' && (
        <>
          <Select
            label="Очередь"
            data={options(refs.queues)}
            value={(p.queueId as string) || null}
            onChange={(v) => set('queueId', v ?? '')}
            data-testid="param-queue"
          />
          <Select
            label="Тема (навык)"
            data={refs.topics.map((x) => ({ value: x.id, label: String(x.pathName ?? x.name) }))}
            value={(p.topicId as string) || null}
            onChange={(v) => set('topicId', v)}
            clearable
            searchable
          />
          {num('priority', 'Надбавка приоритета', 0, 10000)}
          {audioMulti('announceAudio', 'Сообщение в очереди', 'Звучит периодически вместо музыки')}
          {num('announceEverySec', 'Периодичность сообщения, с', 10, 600)}
          {num('maxWaitSec', 'Максимальное ожидание, с (выход «долгое ожидание»)', 10, 7200)}
          <Switch
            label="Проверять операторов на смене (выход «нет операторов»)"
            checked={!!p.checkAgents}
            onChange={(e) => set('checkAgents', e.currentTarget.checked)}
          />
          <Text size="xs" c="dimmed">
            Выход «после разговора» — продолжение, когда оператор завершил разговор (автосообщение, оценка).
          </Text>
        </>
      )}
      {t === 'voicemail' && (
        <>
          <Select
            label="Режим"
            data={[
              { value: 'voicemail', label: 'Голосовое сообщение' },
              { value: 'callback', label: 'Только заказ перезвона' },
            ]}
            value={String(p.mode ?? 'voicemail')}
            onChange={(v) => set('mode', v)}
          />
          {audioMulti('audio', 'Приглашение')}
          {p.mode !== 'callback' && num('maxSec', 'Длительность сообщения до, с', 5, 600)}
          <Select
            label="Очередь задачи «перезвонить»"
            data={options(refs.queues)}
            value={(p.queueId as string) || null}
            onChange={(v) => set('queueId', v ?? '')}
          />
        </>
      )}
      {t === 'http' && <HttpParamsEditor p={p} refs={refs} set={set} kind={kind} />}
      {t === 'sayNumber' && (
        <>
          <TextInput
            label="Переменная с числом"
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
          />
          {audioMulti('before', 'Фраза перед числом', ' ')}
          <Select
            label="Род единицы"
            data={[
              { value: 'm', label: 'мужской (один бонус)' },
              { value: 'f', label: 'женский (одна копейка)' },
            ]}
            value={String(p.gender ?? 'm')}
            onChange={(v) => set('gender', v)}
          />
          {(['one', 'few', 'many'] as const).map((k) =>
            audioOne(
              (p.unit as Record<string, string> | undefined)?.[k],
              { one: 'Единица: 1 (бонус)', few: 'Единица: 2 (бонуса)', many: 'Единица: 5 (бонусов)' }[k],
              (v) => set('unit', { ...((p.unit as object) ?? {}), [k]: v }),
            ),
          )}
          {audioMulti('after', 'Фраза после числа', ' ')}
          <Text size="xs" c="dimmed">
            Цифры собираются из фрагментов аудиобиблиотеки ({NUMBER_FRAGMENTS.length} шт.).
          </Text>
        </>
      )}
      {t === 'transfer' && (
        <TextInput
          label="Номер"
          value={String(p.number ?? '')}
          onChange={(e) => set('number', e.currentTarget.value)}
          placeholder="+375 17 000-00-00"
        />
      )}
      {t === 'csat' && (
        <>
          {audioMulti('audio', 'Вопрос («оцените от 1 до 5»)')}
          {num('timeoutSec', 'Ожидание ответа, с', 1, 60)}
          {num('retries', 'Повторов', 0, 5)}
          {audioMulti('thanksAudio', 'Благодарность', ' ')}
        </>
      )}
    </Stack>
  );
}

/** Свойства текстовых узлов бота (Ф7): сообщение, кнопки, сбор поля, перевод на оператора, завершение. */
function TextNodeParams({
  t,
  p,
  refs,
  set,
}: {
  t: NodeType;
  p: Record<string, unknown>;
  refs: Refs;
  set(k: string, v: unknown): void;
}) {
  const textArea = (key: string, label: string, description?: string) => (
    <Textarea
      label={label}
      description={description ?? 'Можно вставлять переменные: {{name}}, {{phone}}, {{переменная}}'}
      autosize
      minRows={2}
      value={String(p[key] ?? '')}
      onChange={(e) => set(key, e.currentTarget.value)}
      data-testid={`param-${key}`}
    />
  );
  const num = (key: string, label: string, min: number, max: number) => (
    <NumberInput
      label={label}
      min={min}
      max={max}
      value={Number(p[key] ?? 0)}
      onChange={(v) => set(key, v === '' ? 0 : Number(v))}
    />
  );
  const buttons = (p.buttons as { id: string; label: string }[] | undefined) ?? [];
  switch (t) {
    case 'message':
      return textArea('text', 'Текст сообщения');
    case 'hangup':
      return textArea('text', 'Прощальное сообщение (необязательно)', 'Диалог закрывается после него');
    case 'buttons':
      return (
        <>
          {textArea('text', 'Вопрос')}
          <Text size="sm" fw={500}>
            Кнопки
          </Text>
          {buttons.map((b, i) => (
            <Group key={b.id} gap={4} wrap="nowrap">
              <TextInput
                style={{ flex: 1 }}
                value={b.label}
                onChange={(e) =>
                  set(
                    'buttons',
                    buttons.map((x, j) => (j === i ? { ...x, label: e.currentTarget.value } : x)),
                  )
                }
                data-testid={`param-button-${i}`}
              />
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() =>
                  set(
                    'buttons',
                    buttons.filter((_, j) => j !== i),
                  )
                }
              >
                ✕
              </Button>
            </Group>
          ))}
          <Button
            size="compact-xs"
            variant="light"
            disabled={buttons.length >= 10}
            onClick={() =>
              set('buttons', [
                ...buttons,
                { id: `b${Math.random().toString(36).slice(2, 7)}`, label: `Вариант ${buttons.length + 1}` },
              ])
            }
            data-testid="param-button-add"
          >
            + кнопка
          </Button>
          <TextInput
            label="Сохранить выбор в переменную"
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
          />
          {textArea('retryText', 'Если ответ не совпал с кнопкой', ' ')}
          {num('retries', 'Повторов вопроса (затем выход «другое»)', 0, 10)}
        </>
      );
    case 'ask':
      return (
        <>
          {textArea('text', 'Вопрос')}
          <TextInput
            label="Переменная для ответа"
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
            data-testid="param-variable"
          />
          <Select
            label="Формат ответа"
            data={[
              { value: 'text', label: 'Любой текст' },
              { value: 'phone', label: 'Телефон' },
              { value: 'email', label: 'Email' },
              { value: 'number', label: 'Число' },
            ]}
            value={String(p.validation ?? 'text')}
            onChange={(v) => set('validation', v ?? 'text')}
          />
          <Select
            label="Сохранить в карточку клиента"
            data={[
              { value: 'phone', label: 'Телефон (и узнавать клиента по нему)' },
              { value: 'email', label: 'Email (и узнавать клиента по нему)' },
              { value: 'name', label: 'Имя' },
            ]}
            value={(p.saveTo as string) || null}
            onChange={(v) => set('saveTo', v)}
            clearable
          />
          {textArea('retryText', 'Если формат не подошёл', ' ')}
          {num('retries', 'Повторов (затем выход «не получено»)', 0, 10)}
        </>
      );
    case 'handoff':
      return (
        <>
          {textArea('text', 'Сообщение клиенту при переводе')}
          <Select
            label="Очередь"
            description="Пусто — очередь канала по умолчанию"
            data={options(refs.queues)}
            value={(p.queueId as string) || null}
            onChange={(v) => set('queueId', v ?? '')}
            clearable
            data-testid="param-queue"
          />
          <Select
            label="Тема (навык)"
            data={refs.topics.map((x) => ({ value: x.id, label: String(x.pathName ?? x.name) }))}
            value={(p.topicId as string) || null}
            onChange={(v) => set('topicId', v)}
            clearable
            searchable
          />
          {num('priority', 'Надбавка приоритета', 0, 10000)}
          <Text size="xs" c="dimmed">
            Оператор увидит всю переписку с ботом и заметку с собранными данными.
          </Text>
        </>
      );
    default:
      return null;
  }
}

function HttpParamsEditor({
  p,
  refs,
  set,
  kind,
}: {
  p: Record<string, unknown>;
  refs: Refs;
  set(k: string, v: unknown): void;
  kind: FlowKind;
}) {
  // Номер клиента: в IVR — АОН ({{caller}}), в боте — телефон из карточки или собранный ботом ({{phone}}).
  const phoneVar = kind === 'text' ? '{{phone}}' : '{{caller}}';
  const op = refs.operations.find((o) => o.id === p.operationId);
  const inputs = (op?.inputs as { name: string; label: string }[]) ?? [];
  const outputs = (op?.outputs as { name: string; label: string }[]) ?? [];
  const input = (p.input as Record<string, string>) ?? {};
  return (
    <>
      <Select
        label="Интеграционная операция"
        data={options(refs.operations)}
        value={(p.operationId as string) || null}
        onChange={(v) => {
          const next = refs.operations.find((o) => o.id === v);
          const defaults = Object.fromEntries(
            ((next?.inputs as { name: string }[]) ?? []).map((i) => [
              i.name,
              i.name === 'phone' ? phoneVar : '',
            ]),
          );
          set('operationId', v ?? '');
          if (v) set('input', defaults);
        }}
        data-testid="param-operation"
      />
      {inputs.map((i) => (
        <TextInput
          key={i.name}
          label={`${i.label || i.name} (${i.name})`}
          description={
            kind === 'text'
              ? 'Шаблон: {{phone}} — телефон клиента, {{переменная}} — например, ответ «Сбора поля»'
              : 'Шаблон: {{caller}} — номер звонящего, {{переменная}}'
          }
          value={input[i.name] ?? ''}
          onChange={(e) => set('input', { ...input, [i.name]: e.currentTarget.value })}
        />
      ))}
      {outputs.length > 0 && (
        <Text size="xs" c="dimmed">
          Результат — в переменных: {outputs.map((o) => `${o.name} (${o.label || o.name})`).join(', ')}
        </Text>
      )}
    </>
  );
}

// ------------------------------------------------------------------ тестовый прогон

interface LogLine {
  kind: 'node' | 'say' | 'input' | 'system';
  text: string;
}

/** Прогон сценария в браузере тем же исполнителем, что и в call-control; HTTP-узлы — настоящим запросом через api. */
function TestRun({ graph, refs, onClose }: { graph: FlowGraph; refs: Refs; onClose(): void }) {
  const [caller, setCaller] = useState('+375291234567');
  const [step, setStep] = useState<StepResult | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const schedules = useMemo<Record<string, Schedule>>(
    () =>
      Object.fromEntries(
        refs.schedules.map((s) => [
          s.id,
          {
            timezone: String(s.timezone),
            week: s.week as Schedule['week'],
            holidays: (s.holidays as string[]) ?? [],
          },
        ]),
      ),
    [refs.schedules],
  );
  const ctx = () => ({ now: new Date(), schedules });
  const nodeName = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? n.name || NODE_SPECS[n.type].label : id;
  };
  const describe = (a: Action): string => {
    const media = (m: Media[]) =>
      m
        .map((x) =>
          x.kind === 'audio'
            ? `«${audioName(refs, x.id)}»`
            : x.kind === 'fragment'
              ? (NUMBER_FRAGMENTS.find((f) => f.key === x.key)?.label ?? x.key)
              : '[объявления о сбоях]',
        )
        .join(' ');
    switch (a.type) {
      case 'play':
        return `Звучит: ${media(a.media)}`;
      case 'collect':
        return `Звучит: ${media(a.media)} — ждём цифру (${a.digits.join(', ')}), ${a.timeoutSec} с`;
      case 'http':
        return `Запрос во внешнюю систему: ${JSON.stringify(a.input)}`;
      case 'queue':
        return `Клиент в очереди «${String(refs.queues.find((q) => q.id === a.queueId)?.name ?? '')}»`;
      case 'voicemail':
        return a.mode === 'voicemail'
          ? `Звучит: ${media(a.media)} — запись сообщения`
          : 'Заказ обратного звонка';
      case 'transfer':
        return `Перевод на номер ${a.number}`;
      case 'hangup':
        return a.media.length ? `Звучит: ${media(a.media)} — отбой` : 'Отбой';
      default:
        return a.type;
    }
  };
  const apply = (r: StepResult | null, input?: string) => {
    if (!r) return;
    const lines: LogLine[] = [];
    if (input) lines.push({ kind: 'input', text: input });
    for (const p of r.path) if (!p.exit) lines.push({ kind: 'node', text: `→ ${nodeName(p.nodeId)}` });
    for (const e of r.effects)
      if (e.type === 'csat') lines.push({ kind: 'system', text: `Оценка сохранена: ${e.score}` });
    lines.push({ kind: r.action.type === 'hangup' ? 'system' : 'say', text: describe(r.action) });
    setLog((l) => [...l, ...lines]);
    setStep(r);
  };
  const send = async (event: FlowEvent, input?: string) => {
    if (!step) return;
    apply(resumeFlow(graph, step.state, event, ctx()), input);
  };
  const runHttp = async (a: Extract<Action, { type: 'http' }>) => {
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; outputs: Record<string, string>; error?: string }>(
        `/integrations/${a.operationId}/test`,
        { input: a.input },
      );
      await send(
        { type: 'http', ok: r.ok, outputs: r.outputs },
        r.ok ? `Ответ: ${JSON.stringify(r.outputs)}` : `Ошибка: ${r.error}`,
      );
    } catch (e) {
      await send({ type: 'http', ok: false, outputs: {} }, `Ошибка: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const a = step?.action;
  return (
    <Drawer opened onClose={onClose} title="Тестовый прогон" position="right" size="lg">
      <Stack>
        <Group align="end">
          <TextInput
            label="Номер звонящего ({{caller}})"
            value={caller}
            onChange={(e) => setCaller(e.currentTarget.value)}
          />
          <Button
            onClick={() => {
              setLog([{ kind: 'system', text: `Звонок с номера ${caller}` }]);
              apply(startFlow(graph, { caller, did: 'тест' }, ctx()));
            }}
            data-testid="test-start"
          >
            {step ? 'Начать заново' : 'Начать'}
          </Button>
        </Group>
        <ScrollArea h={360} type="auto">
          <Stack gap={2} data-testid="test-log">
            {log.map((l, i) => (
              <Text
                key={i}
                size="sm"
                c={
                  l.kind === 'node'
                    ? 'dimmed'
                    : l.kind === 'input'
                      ? 'blue'
                      : l.kind === 'system'
                        ? 'orange'
                        : undefined
                }
              >
                {l.text}
              </Text>
            ))}
          </Stack>
        </ScrollArea>
        {a && a.type !== 'hangup' && (
          <Card withBorder>
            {(a.type === 'play' || (a.type === 'voicemail' && a.mode === 'voicemail')) && (
              <Button onClick={() => void send({ type: 'done' })} data-testid="test-done">
                {a.type === 'play' ? 'Фраза прозвучала' : 'Сообщение записано'}
              </Button>
            )}
            {a.type === 'voicemail' && a.mode === 'callback' && (
              <Button onClick={() => void send({ type: 'done' })}>Далее</Button>
            )}
            {a.type === 'collect' && (
              <Stack gap="xs">
                <SimpleGrid cols={6} spacing={4}>
                  {MENU_DIGITS.map((d) => (
                    <Button
                      key={d}
                      variant={a.digits.includes(d) ? 'filled' : 'default'}
                      onClick={() => void send({ type: 'digit', digit: d }, `Нажато: ${d}`)}
                      data-testid={`test-digit-${d}`}
                    >
                      {d}
                    </Button>
                  ))}
                </SimpleGrid>
                <Button variant="light" onClick={() => void send({ type: 'timeout' }, 'Тишина (таймаут)')}>
                  Тишина
                </Button>
              </Stack>
            )}
            {a.type === 'http' && (
              <Group>
                <Button onClick={() => void runHttp(a)} loading={busy} data-testid="test-http">
                  Выполнить запрос
                </Button>
                <Button
                  variant="light"
                  color="red"
                  onClick={() => void send({ type: 'http', ok: false, outputs: {} }, 'Ошибка (имитация)')}
                >
                  Имитировать ошибку
                </Button>
              </Group>
            )}
            {a.type === 'queue' && (
              <Group>
                <Button
                  onClick={() =>
                    void send({ type: 'queue', result: 'after' }, 'Оператор ответил и завершил разговор')
                  }
                  data-testid="test-after"
                >
                  Разговор с оператором завершён
                </Button>
                <Button
                  variant="light"
                  onClick={() => void send({ type: 'queue', result: 'timeout' }, 'Долгое ожидание')}
                >
                  Долгое ожидание
                </Button>
                <Button
                  variant="light"
                  onClick={() => void send({ type: 'queue', result: 'noAgents' }, 'Нет операторов')}
                >
                  Нет операторов
                </Button>
              </Group>
            )}
            {a.type === 'transfer' && (
              <Button onClick={() => void send({ type: 'transfer', ok: false }, 'Номер не ответил')}>
                Номер не ответил
              </Button>
            )}
          </Card>
        )}
        {step && (
          <Text size="xs" c="dimmed">
            Переменные: {JSON.stringify(step.state.vars)}
          </Text>
        )}
      </Stack>
    </Drawer>
  );
}

interface ChatLine {
  from: 'bot' | 'client' | 'system';
  text: string;
  buttons?: { id: string; label: string }[];
}

/**
 * Тестовый прогон бота (Ф7) в виде чата — тем же исполнителем flow-engine, что и worker. Сообщения бота
 * идут подряд до вопроса; запрос во внешнюю систему — настоящий, через api.
 */
function ChatTestRun({ graph, refs, onClose }: { graph: FlowGraph; refs: Refs; onClose(): void }) {
  const [name, setName] = useState('Анна');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [step, setStep] = useState<StepResult | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const schedules = useMemo<Record<string, Schedule>>(
    () =>
      Object.fromEntries(
        refs.schedules.map((x) => [
          x.id,
          {
            timezone: String(x.timezone),
            week: x.week as Schedule['week'],
            holidays: (x.holidays as string[]) ?? [],
          },
        ]),
      ),
    [refs.schedules],
  );
  const ctx = () => ({ now: new Date(), schedules });
  /** Выполнить действия бота до ожидания ввода клиента / внешней системы / конца сценария. */
  const drive = (first: StepResult | null, out: ChatLine[]) => {
    let r = first;
    for (let i = 0; r && i < 100; i++) {
      for (const e of r.effects)
        if (e.type === 'contact')
          out.push({ from: 'system', text: `В карточку клиента: ${e.field} = ${e.value}` });
      const a = r.action;
      if (a.type === 'say') {
        out.push({ from: 'bot', text: a.text });
        r = resumeFlow(graph, r.state, { type: 'done' }, ctx());
        continue;
      }
      if (a.type === 'prompt') out.push({ from: 'bot', text: a.text, buttons: a.buttons });
      else if (a.type === 'http')
        out.push({ from: 'system', text: `Запрос во внешнюю систему: ${JSON.stringify(a.input)}` });
      else if (a.type === 'handoff') {
        if (a.text) out.push({ from: 'bot', text: a.text });
        const q = a.queueId
          ? String(refs.queues.find((x) => x.id === a.queueId)?.name ?? '')
          : 'очередь канала';
        out.push({
          from: 'system',
          text: `Перевод на оператора: ${q}. Переменные: ${JSON.stringify(r.state.vars)}`,
        });
      } else if (a.type === 'hangup') {
        if (a.text) out.push({ from: 'bot', text: a.text });
        out.push({ from: 'system', text: 'Бот закрыл диалог' });
      }
      break;
    }
    setLines((l) => [...l, ...out]);
    setStep(r);
  };
  const answer = (text: string) => {
    if (!step || !text.trim()) return;
    setInput('');
    const r = resumeFlow(graph, step.state, { type: 'text', text }, ctx());
    drive(r, [{ from: 'client', text }]);
  };
  const runHttp = async (a: Extract<Action, { type: 'http' }>, fail = false) => {
    if (!step) return;
    setBusy(true);
    let ev: FlowEvent = { type: 'http', ok: false, outputs: {} };
    let note = 'Ошибка (имитация)';
    if (!fail)
      try {
        const r = await post<{ ok: boolean; outputs: Record<string, string>; error?: string }>(
          `/integrations/${a.operationId}/test`,
          { input: a.input },
        );
        ev = { type: 'http', ok: r.ok, outputs: r.outputs };
        note = r.ok ? `Ответ: ${JSON.stringify(r.outputs)}` : `Ошибка: ${r.error}`;
      } catch (e) {
        note = `Ошибка: ${errorText(e)}`;
      }
    setBusy(false);
    drive(resumeFlow(graph, step.state, ev, ctx()), [{ from: 'system', text: note }]);
  };
  const a = step?.action;
  return (
    <Drawer opened onClose={onClose} title="Тестовый прогон бота" position="right" size="lg">
      <Stack>
        <Group align="end">
          <TextInput
            label="Имя клиента ({{name}})"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button
            onClick={() => {
              setLines([]);
              drive(startFlow(graph, { name, 'client.name': name, channel: 'webchat' }, ctx()), [
                { from: 'system', text: 'Клиент написал в чат' },
              ]);
            }}
            data-testid="test-start"
          >
            {step ? 'Начать заново' : 'Начать'}
          </Button>
        </Group>
        <ScrollArea h={380} type="auto">
          <Stack gap={6} data-testid="test-log">
            {lines.map((l, i) => (
              <Box
                key={i}
                style={{
                  alignSelf: l.from === 'client' ? 'flex-end' : l.from === 'bot' ? 'flex-start' : 'center',
                  maxWidth: '85%',
                }}
              >
                <Text
                  size="sm"
                  c={l.from === 'system' ? 'orange' : undefined}
                  p={l.from === 'system' ? 0 : 6}
                  style={{
                    whiteSpace: 'pre-wrap',
                    borderRadius: 8,
                    background:
                      l.from === 'client'
                        ? 'var(--mantine-color-blue-1)'
                        : l.from === 'bot'
                          ? 'var(--mantine-color-gray-1)'
                          : undefined,
                  }}
                >
                  {l.text}
                </Text>
                {l.buttons && l.buttons.length > 0 && i === lines.length - 1 && (
                  <Group gap={4} mt={4}>
                    {l.buttons.map((b) => (
                      <Button key={b.id} size="compact-xs" variant="light" onClick={() => answer(b.label)}>
                        {b.label}
                      </Button>
                    ))}
                  </Group>
                )}
              </Box>
            ))}
          </Stack>
        </ScrollArea>
        {a?.type === 'prompt' && (
          <Group gap="xs">
            <TextInput
              style={{ flex: 1 }}
              placeholder="Ответ клиента…"
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && answer(input)}
              data-testid="test-input"
            />
            <Button onClick={() => answer(input)} data-testid="test-send">
              Отправить
            </Button>
          </Group>
        )}
        {a?.type === 'http' && (
          <Group>
            <Button onClick={() => void runHttp(a)} loading={busy} data-testid="test-http">
              Выполнить запрос
            </Button>
            <Button variant="light" color="red" onClick={() => void runHttp(a, true)}>
              Имитировать ошибку
            </Button>
          </Group>
        )}
        {step && (
          <Text size="xs" c="dimmed">
            Переменные: {JSON.stringify(step.state.vars)}
          </Text>
        )}
      </Stack>
    </Drawer>
  );
}

// ------------------------------------------------------------------ редактор

interface FlowRow extends Row {
  name: string;
  kind: FlowKind;
  dids: string[];
  draft: FlowGraph;
  publishedVersionId: string | null;
  publishedVersion: number | null;
  versions: {
    id: string;
    version: number;
    comment: string | null;
    createdAt: string;
    createdByName: string | null;
  }[];
}

function toRf(g: FlowGraph, refs: Refs): { nodes: CcNode[]; edges: Edge[] } {
  return {
    nodes: g.nodes.map((n, i) => ({
      id: n.id,
      type: 'cc',
      position: n.position ?? { x: 40 + (i % 4) * 260, y: 40 + Math.floor(i / 4) * 160 },
      deletable: n.type !== 'start',
      data: { type: n.type, name: n.name, params: n.params ?? {}, summary: summary(n, refs) },
    })),
    edges: g.edges.map((e) => edgeOf(e.id, e.source, e.exit, e.target)),
  };
}
const edgeOf = (id: string, source: string, exit: string, target: string): Edge => ({
  id,
  source,
  sourceHandle: exit,
  target,
  markerEnd: { type: MarkerType.ArrowClosed },
});

function fromRf(kind: FlowKind, nodes: CcNode[], edges: Edge[]): FlowGraph {
  return {
    version: 1,
    kind,
    nodes: nodes.map(
      (n): FlowNode => ({
        id: n.id,
        type: n.data.type,
        ...(n.data.name ? { name: n.data.name } : {}),
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        params: n.data.params,
      }),
    ),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      exit: e.sourceHandle ?? 'next',
      target: e.target,
    })),
  };
}

function Editor({ flow }: { flow: FlowRow }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const refs = useRefs();
  const rf = useReactFlow();
  const initial = useMemo(() => toRf(flow.draft, refs), [flow.draft, refs]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CcNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(flow.name);
  const [dids, setDids] = useState<string[]>(flow.dids ?? []);
  const [serverIssues, setServerIssues] = useState<{
    errors: { message: string; nodeId?: string }[];
    warnings: { message: string; nodeId?: string }[];
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [versions, setVersions] = useState(false);
  const [comment, setComment] = useState('');
  const [dirty, setDirty] = useState(false);
  const writable = can('admin.directories');

  // Справочники подгружаются позже графа — обновляем подписи узлов.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, summary: summary(n.data, refs) } })));
  }, [refs, setNodes]);

  const graph = useMemo(() => fromRf(flow.kind, nodes, edges), [flow.kind, nodes, edges]);
  const local = useMemo(() => validateGraph(graph, flow.kind), [graph, flow.kind]);
  const issuesByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of local.errors) if (e.nodeId) m.set(e.nodeId, [...(m.get(e.nodeId) ?? []), e.message]);
    return m;
  }, [local]);
  const shown = useMemo(
    () =>
      nodes.map((n) =>
        issuesByNode.get(n.id) || n.data.issues
          ? { ...n, data: { ...n.data, issues: issuesByNode.get(n.id) } }
          : n,
      ),
    [nodes, issuesByNode],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      const exit = c.sourceHandle ?? 'next';
      setEdges((es) => [
        ...es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? 'next') === exit)),
        edgeOf(`${c.source}-${exit}-${c.target}`, c.source, exit, c.target),
      ]);
      setDirty(true);
    },
    [setEdges],
  );

  const add = (type: NodeType) => {
    const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    const params = structuredClone(NODE_SPECS[type].defaults);
    // Новый узел — под выбранным (обычно сценарий строится сверху вниз), иначе под самым нижним.
    const anchor =
      nodes.find((n) => n.id === selected) ?? [...nodes].sort((a, b) => b.position.y - a.position.y)[0];
    const position = anchor
      ? { x: anchor.position.x, y: anchor.position.y + (anchor.measured?.height ?? 80) + 70 }
      : { x: 40, y: 40 };
    while (
      nodes.some((n) => Math.abs(n.position.x - position.x) < 60 && Math.abs(n.position.y - position.y) < 60)
    )
      position.x += 240;
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      {
        id,
        type: 'cc',
        position,
        selected: true,
        data: { type, params, summary: summary({ type, params }, refs) },
      },
    ]);
    setSelected(id);
    setDirty(true);
    void rf.setCenter(position.x + 110, position.y + 40, { zoom: rf.getZoom(), duration: 200 });
  };

  const updateNode = (id: string, patchData: Partial<NodeData>) => {
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n;
        const data = { ...n.data, ...patchData };
        return { ...n, data: { ...data, summary: summary(data, refs) } };
      }),
    );
    // У меню убраны цифры — удаляем связи от исчезнувших выходов.
    if (patchData.params?.digits)
      setEdges((es) =>
        es.filter(
          (e) =>
            e.source !== id ||
            !e.sourceHandle?.startsWith('digit:') ||
            (patchData.params!.digits as string[]).includes(e.sourceHandle.slice(6)),
        ),
      );
    // У кнопок бота убрана кнопка — удаляем связь от её выхода.
    if (patchData.params?.buttons) {
      const ids = (patchData.params.buttons as { id: string }[]).map((b) => `btn:${b.id}`);
      setEdges((es) =>
        es.filter(
          (e) => e.source !== id || !e.sourceHandle?.startsWith('btn:') || ids.includes(e.sourceHandle),
        ),
      );
    }
    setDirty(true);
  };

  const save = async () => {
    await patch(`/flows/${flow.id}`, { name, dids, draft: graph });
    setDirty(false);
    void qc.invalidateQueries({ queryKey: ['/flows'] });
  };
  const saveAction = useAction(save, 'Черновик сохранён');
  const check = useAction(async () => {
    await save();
    setServerIssues(await post(`/flows/${flow.id}/validate`));
  }, 'Проверка выполнена');
  const publish = useMutationWithDetails(async () => {
    await save();
    const r = await post<{ version: number; warnings: unknown[] }>(`/flows/${flow.id}/publish`, {
      comment: comment || undefined,
    });
    setComment('');
    setServerIssues(null);
    notifications.show({
      color: 'green',
      message: `Опубликована версия ${r.version} — новые ${flow.kind === 'text' ? 'диалоги' : 'звонки'} идут по ней`,
    });
    void qc.invalidateQueries({ queryKey: [`/flows/${flow.id}`] });
  }, setServerIssues);

  const sel = shown.find((n) => n.id === selected);
  const kindNodes = (Object.keys(NODE_SPECS) as NodeType[]).filter(
    (t) => t !== 'start' && NODE_SPECS[t].kinds.includes(flow.kind),
  );

  return (
    <Stack gap="xs" h="calc(100vh - 100px)">
      <Group justify="space-between" gap="xs">
        <Group gap="xs">
          <TextInput
            value={name}
            onChange={(e) => (setName(e.currentTarget.value), setDirty(true))}
            w={260}
            readOnly={!writable}
          />
          {flow.kind === 'voice' && (
            <TagsInput
              value={dids}
              onChange={(v) => (setDids(v), setDirty(true))}
              placeholder="Номера (DID)"
              w={220}
              readOnly={!writable}
              data-testid="flow-dids"
            />
          )}
          <Badge variant="light" data-testid="flow-published">
            {flow.publishedVersion ? `опубликована версия ${flow.publishedVersion}` : 'не опубликован'}
          </Badge>
          {dirty && <Badge color="orange">не сохранено</Badge>}
        </Group>
        <Group gap="xs">
          <Button variant="default" onClick={() => setTesting(true)} data-testid="flow-test">
            Тестовый прогон
          </Button>
          <Button variant="default" onClick={() => setVersions(true)}>
            Версии
          </Button>
          {writable && (
            <>
              <Button
                variant="light"
                onClick={() => saveAction.mutate(undefined)}
                loading={saveAction.isPending}
                data-testid="flow-save"
              >
                Сохранить черновик
              </Button>
              <Button
                variant="light"
                color="teal"
                onClick={() => check.mutate(undefined)}
                loading={check.isPending}
              >
                Проверить
              </Button>
              <TextInput
                placeholder="Комментарий к версии"
                value={comment}
                onChange={(e) => setComment(e.currentTarget.value)}
                w={180}
              />
              <Button
                color="green"
                onClick={() => publish.run()}
                loading={publish.pending}
                data-testid="flow-publish"
              >
                Опубликовать
              </Button>
            </>
          )}
        </Group>
      </Group>
      <Group align="stretch" gap="xs" style={{ flex: 1, minHeight: 0 }} wrap="nowrap">
        {writable && (
          <Stack gap={4} w={150} style={{ flexShrink: 0 }} data-testid="palette">
            <Text size="xs" c="dimmed">
              Добавить узел
            </Text>
            {kindNodes.map((t) => (
              <Button
                key={t}
                size="compact-xs"
                variant="light"
                color="gray"
                onClick={() => add(t)}
                title={NODE_SPECS[t].description}
                data-testid={`palette-${t}`}
                styles={{ inner: { justifyContent: 'flex-start' } }}
              >
                {NODE_SPECS[t].label}
              </Button>
            ))}
            <Text size="10px" c="dimmed" mt="xs">
              Связь — перетащить точку выхода узла на другой узел. Удалить узел или связь — выделить и нажать
              Delete.
            </Text>
          </Stack>
        )}
        <Box
          style={{ flex: 1, border: '1px solid var(--mantine-color-gray-3)', borderRadius: 8 }}
          data-testid="flow-canvas"
        >
          <ReactFlow
            nodes={shown}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(c) => {
              onNodesChange(c);
              if (c.some((x) => x.type !== 'select' && x.type !== 'dimensions')) setDirty(true);
            }}
            onEdgesChange={(c) => {
              onEdgesChange(c);
              if (c.some((x) => x.type === 'remove')) setDirty(true);
            }}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            nodesDraggable={writable}
            nodesConnectable={writable}
            deleteKeyCode={writable ? ['Delete', 'Backspace'] : null}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            minZoom={0.2}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </Box>
        <ScrollArea w={290} type="auto" style={{ flexShrink: 0 }}>
          <Stack gap="xs" pr="xs">
            {sel ? (
              <>
                <Title order={6}>{NODE_SPECS[sel.data.type].label}</Title>
                <Text size="xs" c="dimmed">
                  {NODE_SPECS[sel.data.type].description}
                </Text>
                {sel.data.issues?.map((m) => (
                  <Alert key={m} color="red" p={6}>
                    <Text size="xs">{m}</Text>
                  </Alert>
                ))}
                <NodeParams
                  node={sel}
                  refs={refs}
                  kind={flow.kind}
                  onChange={(pd) => updateNode(sel.id, pd)}
                />
              </>
            ) : (
              <Text size="sm" c="dimmed">
                Выберите узел, чтобы изменить его свойства.
              </Text>
            )}
            <Title order={6} mt="md">
              Проверка
            </Title>
            {local.errors.length === 0 && local.warnings.length === 0 && (
              <Text size="xs" c="green" data-testid="flow-valid">
                Ошибок нет
              </Text>
            )}
            {[
              ...local.errors.map((e) => ({ ...e, err: true })),
              ...local.warnings.map((e) => ({ ...e, err: false })),
            ].map((e, i) => (
              <Text
                key={i}
                size="xs"
                c={e.err ? 'red' : 'orange'}
                style={{ cursor: e.nodeId ? 'pointer' : undefined }}
                onClick={() => e.nodeId && setSelected(e.nodeId)}
              >
                {e.err ? '✖' : '⚠'} {e.message}
              </Text>
            ))}
            {serverIssues && (
              <>
                <Text size="xs" fw={600}>
                  Проверка на сервере (ссылки на файлы, очереди, операции)
                </Text>
                {serverIssues.errors.length + serverIssues.warnings.length === 0 && (
                  <Text size="xs" c="green">
                    Замечаний нет
                  </Text>
                )}
                {[
                  ...serverIssues.errors.map((e) => ({ ...e, err: true })),
                  ...serverIssues.warnings.map((e) => ({ ...e, err: false })),
                ].map((e, i) => (
                  <Text key={i} size="xs" c={e.err ? 'red' : 'orange'}>
                    {e.err ? '✖' : '⚠'} {e.message}
                  </Text>
                ))}
              </>
            )}
          </Stack>
        </ScrollArea>
      </Group>
      {testing &&
        (flow.kind === 'text' ? (
          <ChatTestRun graph={graph} refs={refs} onClose={() => setTesting(false)} />
        ) : (
          <TestRun graph={graph} refs={refs} onClose={() => setTesting(false)} />
        ))}
      {versions && (
        <Versions
          flow={flow}
          onLoad={(g) => {
            const r = toRf(g, refs);
            setNodes(r.nodes);
            setEdges(r.edges);
            setDirty(true);
            setVersions(false);
          }}
          onClose={() => setVersions(false)}
        />
      )}
    </Stack>
  );
}

/** Мутация, ошибки публикации которой (ошибки графа в details) показываются в панели проверки. */
function useMutationWithDetails(
  fn: () => Promise<void>,
  onDetails: (d: { errors: { message: string }[]; warnings: { message: string }[] }) => void,
) {
  const [pending, setPending] = useState(false);
  return {
    pending,
    run: () => {
      setPending(true);
      fn()
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.details && typeof e.details === 'object' && 'errors' in e.details)
            onDetails(e.details as never);
          notifications.show({
            color: 'red',
            title: 'Не опубликовано',
            message: e instanceof ApiError ? e.message : errorText(e),
          });
        })
        .finally(() => setPending(false));
    },
  };
}

function Versions({ flow, onLoad, onClose }: { flow: FlowRow; onLoad(g: FlowGraph): void; onClose(): void }) {
  const { can } = useAuth();
  const rollback = useAction(
    (versionId: string) => post(`/flows/${flow.id}/rollback`, { versionId }),
    'Опубликована выбранная версия',
  );
  return (
    <Modal opened onClose={onClose} title="Версии сценария" size="lg">
      <Text size="sm" c="dimmed" mb="sm">
        Публикация атомарна: новые звонки идут по опубликованной версии, начавшиеся — доигрывают свою.
      </Text>
      <Table striped data-testid="flow-versions">
        <Table.Tbody>
          {flow.versions.map((v) => (
            <Table.Tr key={v.id}>
              <Table.Td>
                версия {v.version}{' '}
                {v.id === flow.publishedVersionId && <Badge color="green">опубликована</Badge>}
              </Table.Td>
              <Table.Td>{new Date(v.createdAt).toLocaleString('ru-RU')}</Table.Td>
              <Table.Td>{v.createdByName ?? ''}</Table.Td>
              <Table.Td>{v.comment ?? ''}</Table.Td>
              <Table.Td>
                <Group gap={4} justify="flex-end">
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() =>
                      void get<{ graph: FlowGraph }>(`/flows/${flow.id}/versions/${v.id}`).then((r) =>
                        onLoad(r.graph),
                      )
                    }
                  >
                    В черновик
                  </Button>
                  {can('admin.directories') && v.id !== flow.publishedVersionId && (
                    <Button
                      size="xs"
                      variant="light"
                      color="orange"
                      onClick={() => rollback.mutate(v.id, { onSuccess: onClose })}
                      data-testid={`rollback-${v.version}`}
                    >
                      Откатить на неё
                    </Button>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Modal>
  );
}

export function FlowEditorPage() {
  const { id } = useParams();
  const flow = useQuery({ queryKey: [`/flows/${id}`], queryFn: () => get<FlowRow>(`/flows/${id}`) });
  if (!flow.data) return <Text c="dimmed">Загрузка…</Text>;
  return (
    <ReactFlowProvider>
      {/* key — после публикации/отката граф перечитывается с сервера */}
      <Editor
        key={`${flow.data.id}:${flow.data.publishedVersionId}:${flow.data.versions.length}`}
        flow={flow.data}
      />
    </ReactFlowProvider>
  );
}
