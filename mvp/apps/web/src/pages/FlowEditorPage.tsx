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
  PanOnScrollMode,
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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, errorText, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { options, type Row, useAction, useList } from '../lib/data';
import { AudioPreview } from './IvrAdminPages';
import { t } from '../lib/i18n';

/** Пределы масштаба схемы. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;

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
    t.flowEditor.stsenariySozdan,
  );
  const toggle = useAction((r: Row) => post(`/flows/${r.id}/${r.isActive ? 'deactivate' : 'activate'}`));
  return (
    <>
      <Group justify="space-between" mb="md">
        <span />
        {can(text ? 'bots.manage' : 'ivr.manage') && (
          <Button onClick={() => setOpen(true)} data-testid="flow-new">
            {t.flowEditor.novyyStsenariy}
          </Button>
        )}
      </Group>
      <Table striped highlightOnHover data-testid="flow-list">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.flowEditor.nazvanie}</Table.Th>
            <Table.Th>{text ? t.flowEditor.kanaly : t.flowEditor.nomeraDid}</Table.Th>
            <Table.Th>{t.flowEditor.opublikovana}</Table.Th>
            <Table.Th>{t.flowEditor.status}</Table.Th>
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
                      .join(', ') || t.flowEditor.naznachaetsyaVKanalakh
                  : ((f.dids as string[]) ?? []).join(', ') || '—'}
              </Table.Td>
              <Table.Td>
                {f.publishedVersion ? (
                  t.flowEditor.versiya(String(f.publishedVersion))
                ) : (
                  <Badge color="gray">{t.flowEditor.neOpublikovan}</Badge>
                )}{' '}
                {f.hasUnpublished && f.publishedVersion ? (
                  <Badge color="orange">{t.flowEditor.estIzmeneniya}</Badge>
                ) : null}
              </Table.Td>
              <Table.Td>
                <Badge color={f.isActive ? 'green' : 'gray'}>
                  {f.isActive ? t.flowEditor.aktiven : t.flowEditor.otklyuchen}
                </Badge>
              </Table.Td>
              <Table.Td>
                {can(text ? 'bots.manage' : 'ivr.manage') && (
                  <Button
                    size="xs"
                    variant="subtle"
                    color={f.isActive ? 'red' : 'green'}
                    onClick={() => toggle.mutate(f)}
                  >
                    {f.isActive ? t.deactivate : t.activate}
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        title={text ? t.flowEditor.novyyBot : t.flowEditor.novyyStsenariyIvr}
      >
        <Stack>
          <TextInput
            label={t.flowEditor.nazvanie}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-testid="flow-name"
          />
          {!text && (
            <TagsInput
              label={t.flowEditor.nomeraDidNaKotorye}
              description={t.flowEditor.mozhnoNaznachitPozzheNomer}
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
            {t.create}
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
  String(refs.audio.find((a) => a.id === id)?.name ?? t.flowEditor.faylUdalen);

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
            {data.name || t.flowEditor.nachalo}
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
      return String(refs.queues.find((q) => q.id === p.queueId)?.name ?? t.flowEditor.ocheredKanala);
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
      return p.mode === 'callback' ? t.flowEditor.zakazPerezvona : t.flowEditor.golosovoeSoobshchenie;
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
        description={description ?? t.flowEditor.faylyZvuchatVPoryadke}
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
  const nodeType = node.data.type;
  return (
    <Stack gap="xs">
      {nodeType !== 'start' && (
        <TextInput
          label={t.flowEditor.podpisUzla}
          value={node.data.name ?? ''}
          onChange={(e) => onChange({ name: e.currentTarget.value })}
          data-testid="param-name"
        />
      )}
      {(nodeType === 'play' || (nodeType === 'hangup' && kind === 'voice')) &&
        audioMulti('audio', nodeType === 'hangup' ? t.flowEditor.proshchalnayaFraza : t.flowEditor.frazy)}
      {kind === 'text' && <TextNodeParams t={nodeType} p={p} refs={refs} set={set} />}
      {nodeType === 'announcements' && (
        <Text size="xs" c="dimmed">
          {t.flowEditor.zvuchatDeystvuyushchieObyavleniyaIz}
        </Text>
      )}
      {nodeType === 'menu' && (
        <>
          {audioMulti('audio', t.flowEditor.frazaMenyu)}
          <MultiSelect
            label={t.flowEditor.punktyTsifry}
            data={MENU_DIGITS}
            value={(p.digits as string[]) ?? []}
            onChange={(v) => set('digits', v)}
            data-testid="param-digits"
          />
          <Select
            label={t.flowEditor.tsifraVernutsyaVPredydushchee}
            data={MENU_DIGITS}
            value={(p.backDigit as string) || null}
            onChange={(v) => set('backDigit', v ?? undefined)}
            clearable
          />
          {num('timeoutSec', t.flowEditor.ozhidanieVvodaS, 1, 60)}
          {num('retries', t.flowEditor.povtorovPriOshibkeIli, 0, 10)}
          {audioMulti('invalidAudio', t.flowEditor.frazaPriNevernomVvode, ' ')}
        </>
      )}
      {nodeType === 'schedule' && (
        <Select
          label={t.flowEditor.raspisanie}
          data={options(refs.schedules)}
          value={(p.scheduleId as string) || null}
          onChange={(v) => set('scheduleId', v ?? '')}
        />
      )}
      {nodeType === 'condition' && (
        <>
          <TextInput
            label={t.flowEditor.peremennaya}
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
          />
          <Select
            label={t.flowEditor.uslovie}
            data={[
              { value: 'eq', label: t.flowEditor.ravno },
              { value: 'ne', label: t.flowEditor.neRavno },
              { value: 'gt', label: t.flowEditor.bolshe },
              { value: 'ge', label: t.flowEditor.bolsheIliRavno },
              { value: 'lt', label: t.flowEditor.menshe },
              { value: 'le', label: t.flowEditor.mensheIliRavno },
              { value: 'contains', label: t.flowEditor.soderzhit },
              { value: 'empty', label: t.flowEditor.pusto },
              { value: 'notEmpty', label: t.flowEditor.nePusto },
            ]}
            value={String(p.op ?? 'eq')}
            onChange={(v) => set('op', v)}
          />
          {!['empty', 'notEmpty'].includes(String(p.op)) && (
            <TextInput
              label={t.flowEditor.znachenie}
              value={String(p.value ?? '')}
              onChange={(e) => set('value', e.currentTarget.value)}
            />
          )}
        </>
      )}
      {nodeType === 'setVariable' && (
        <>
          <TextInput
            label={t.flowEditor.peremennaya}
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
          />
          <TextInput
            label={t.flowEditor.znacheniePeremennaya}
            value={String(p.value ?? '')}
            onChange={(e) => set('value', e.currentTarget.value)}
          />
        </>
      )}
      {nodeType === 'queue' && (
        <>
          <Select
            label={t.flowEditor.ochered}
            data={options(refs.queues)}
            value={(p.queueId as string) || null}
            onChange={(v) => set('queueId', v ?? '')}
            data-testid="param-queue"
          />
          <Select
            label={t.flowEditor.temaNavyk}
            data={refs.topics.map((x) => ({ value: x.id, label: String(x.pathName ?? x.name) }))}
            value={(p.topicId as string) || null}
            onChange={(v) => set('topicId', v)}
            clearable
            searchable
          />
          {num('priority', t.flowEditor.nadbavkaPrioriteta, 0, 10000)}
          {audioMulti(
            'announceAudio',
            t.flowEditor.soobshchenieVOcheredi,
            t.flowEditor.zvuchitPeriodicheskiVmestoMuzyki,
          )}
          {num('announceEverySec', t.flowEditor.periodichnostSoobshcheniyaS, 10, 600)}
          {audioMulti('busyAudio', t.flowEditor.busyAudio, t.flowEditor.busyAudioHint)}
          {num('maxWaitSec', t.flowEditor.maksimalnoeOzhidanieSVykhod, 10, 7200)}
          <Switch
            label={t.flowEditor.proveryatOperatorovNaSmene}
            checked={!!p.checkAgents}
            onChange={(e) => set('checkAgents', e.currentTarget.checked)}
          />
          <Text size="xs" c="dimmed">
            {t.flowEditor.vykhodPosleRazgovoraProdolzhenie}
          </Text>
        </>
      )}
      {nodeType === 'voicemail' && (
        <>
          <Select
            label={t.flowEditor.rezhim}
            data={[
              { value: 'voicemail', label: t.flowEditor.golosovoeSoobshchenie2 },
              { value: 'callback', label: t.flowEditor.tolkoZakazPerezvona },
            ]}
            value={String(p.mode ?? 'voicemail')}
            onChange={(v) => set('mode', v)}
          />
          {audioMulti('audio', t.flowEditor.priglashenie)}
          {p.mode !== 'callback' && num('maxSec', t.flowEditor.dlitelnostSoobshcheniyaDoS, 5, 600)}
          <Select
            label={t.flowEditor.ocheredZadachiPerezvonit}
            data={options(refs.queues)}
            value={(p.queueId as string) || null}
            onChange={(v) => set('queueId', v ?? '')}
          />
        </>
      )}
      {nodeType === 'http' && <HttpParamsEditor p={p} refs={refs} set={set} kind={kind} />}
      {nodeType === 'sayNumber' && (
        <>
          <TextInput
            label={t.flowEditor.peremennayaSChislom}
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
          />
          {audioMulti('before', t.flowEditor.frazaPeredChislom, ' ')}
          <Select
            label={t.flowEditor.rodEdinitsy}
            data={[
              { value: 'm', label: t.flowEditor.muzhskoyOdinBonus },
              { value: 'f', label: t.flowEditor.zhenskiyOdnaKopeyka },
            ]}
            value={String(p.gender ?? 'm')}
            onChange={(v) => set('gender', v)}
          />
          {(['one', 'few', 'many'] as const).map((k) =>
            audioOne(
              (p.unit as Record<string, string> | undefined)?.[k],
              {
                one: t.flowEditor.edinitsa1Bonus,
                few: t.flowEditor.edinitsa2Bonusa,
                many: t.flowEditor.edinitsa5Bonusov,
              }[k],
              (v) => set('unit', { ...((p.unit as object) ?? {}), [k]: v }),
            ),
          )}
          {audioMulti('after', t.flowEditor.frazaPosleChisla, ' ')}
          <Text size="xs" c="dimmed">
            {t.flowEditor.tsifrySobirayutsyaIzFragmentov}
            {NUMBER_FRAGMENTS.length}
            {t.flowEditor.sht}
          </Text>
        </>
      )}
      {nodeType === 'transfer' && (
        <TextInput
          label={t.flowEditor.nomer}
          value={String(p.number ?? '')}
          onChange={(e) => set('number', e.currentTarget.value)}
          placeholder="+375 17 000-00-00"
        />
      )}
      {nodeType === 'csat' && (
        <>
          {audioMulti('audio', t.flowEditor.voprosOtseniteOt1)}
          {num('timeoutSec', t.flowEditor.ozhidanieOtvetaS, 1, 60)}
          {num('retries', t.flowEditor.povtorov, 0, 5)}
          {audioMulti('thanksAudio', t.flowEditor.blagodarnost, ' ')}
        </>
      )}
    </Stack>
  );
}

/** Свойства текстовых узлов бота (Ф7): сообщение, кнопки, сбор поля, перевод на оператора, завершение. */
function TextNodeParams({
  t: nodeType,
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
      description={description ?? t.flowEditor.mozhnoVstavlyatPeremennyeName}
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
  // Ф14: ожидание ответа клиента — пусто или 0 означает «ждать без ограничения» (выхода «нет ответа» нет).
  const wait = (
    <>
      <NumberInput
        label={t.flowEditor.zhdatOtvetaS}
        description={t.flowEditor.zhdatOtvetaOpisanie}
        min={0}
        max={86400}
        value={Number(p.waitSec ?? 0) || ''}
        onChange={(v) => set('waitSec', v === '' || !Number(v) ? undefined : Number(v))}
        data-testid="param-waitSec"
      />
      {Number(p.waitSec ?? 0) > 0 && (
        <>
          {num('reminders', t.flowEditor.napomnitRaz, 0, 5)}
          {textArea('remindText', t.flowEditor.tekstNapominaniya, t.flowEditor.tekstNapominaniyaOpisanie)}
        </>
      )}
    </>
  );
  const buttons = (p.buttons as { id: string; label: string }[] | undefined) ?? [];
  switch (nodeType) {
    case 'message':
      return textArea('text', t.flowEditor.tekstSoobshcheniya);
    case 'hangup':
      return textArea(
        'text',
        t.flowEditor.proshchalnoeSoobshchenieNeobyazateln,
        t.flowEditor.dialogZakryvaetsyaPosleNego,
      );
    case 'buttons':
      return (
        <>
          {textArea('text', t.flowEditor.vopros)}
          <Text size="sm" fw={500}>
            {t.flowEditor.knopki}
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
                {
                  id: `b${Math.random().toString(36).slice(2, 7)}`,
                  label: t.flowEditor.variant(buttons.length + 1),
                },
              ])
            }
            data-testid="param-button-add"
          >
            {t.flowEditor.knopka}
          </Button>
          <TextInput
            label={t.flowEditor.sokhranitVyborVPeremennuyu}
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
          />
          {textArea('retryText', t.flowEditor.esliOtvetNeSovpal, ' ')}
          {num('retries', t.flowEditor.povtorovVoprosaZatemVykhod, 0, 10)}
          {(
            [
              ['backLabel', t.flowEditor.navBack, t.flowEditor.navBackDefault],
              ['homeLabel', t.flowEditor.navHome, t.flowEditor.navHomeDefault],
            ] as const
          ).map(([key, label, def]) => (
            <Group key={key} gap="xs" wrap="nowrap" align="center">
              <Switch
                label={label}
                checked={!!p[key]}
                onChange={(e) => set(key, e.currentTarget.checked ? def : '')}
                data-testid={`param-${key}-on`}
              />
              {!!p[key] && (
                <TextInput
                  size="xs"
                  style={{ flex: 1 }}
                  value={String(p[key] ?? '')}
                  onChange={(e) => set(key, e.currentTarget.value)}
                  data-testid={`param-${key}`}
                />
              )}
            </Group>
          ))}
          <Text size="xs" c="dimmed">
            {t.flowEditor.navHint}
          </Text>
          {wait}
        </>
      );
    case 'ask':
      return (
        <>
          {textArea('text', t.flowEditor.vopros)}
          <TextInput
            label={t.flowEditor.peremennayaDlyaOtveta}
            value={String(p.variable ?? '')}
            onChange={(e) => set('variable', e.currentTarget.value)}
            data-testid="param-variable"
          />
          <Select
            label={t.flowEditor.formatOtveta}
            data={[
              { value: 'text', label: t.flowEditor.lyuboyTekst },
              { value: 'phone', label: t.flowEditor.telefon },
              { value: 'email', label: 'Email' },
              { value: 'number', label: t.flowEditor.chislo },
            ]}
            value={String(p.validation ?? 'text')}
            onChange={(v) => set('validation', v ?? 'text')}
          />
          <Select
            label={t.flowEditor.sokhranitVKartochkuKlienta}
            data={[
              { value: 'phone', label: t.flowEditor.telefonIUznavatKlienta },
              { value: 'email', label: t.flowEditor.emailIUznavatKlienta },
              { value: 'name', label: t.flowEditor.imya },
            ]}
            value={(p.saveTo as string) || null}
            onChange={(v) => set('saveTo', v)}
            clearable
          />
          {textArea('retryText', t.flowEditor.esliFormatNePodoshel, ' ')}
          {num('retries', t.flowEditor.povtorovZatemVykhodNe, 0, 10)}
          {wait}
        </>
      );
    case 'handoff':
      return (
        <>
          {textArea('text', t.flowEditor.soobshchenieKlientuPriPerevode)}
          <Select
            label={t.flowEditor.ochered}
            description={t.flowEditor.pustoOcheredKanalaPo}
            data={options(refs.queues)}
            value={(p.queueId as string) || null}
            onChange={(v) => set('queueId', v ?? '')}
            clearable
            data-testid="param-queue"
          />
          <Select
            label={t.flowEditor.temaNavyk}
            data={refs.topics.map((x) => ({ value: x.id, label: String(x.pathName ?? x.name) }))}
            value={(p.topicId as string) || null}
            onChange={(v) => set('topicId', v)}
            clearable
            searchable
          />
          {num('priority', t.flowEditor.nadbavkaPrioriteta, 0, 10000)}
          <Text size="xs" c="dimmed">
            {t.flowEditor.operatorUviditVsyuPerepisku}
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
        label={t.flowEditor.integratsionnayaOperatsiya}
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
              ? t.flowEditor.shablonPhoneTelefonKlienta
              : t.flowEditor.shablonCallerNomerZvonyashchego
          }
          value={input[i.name] ?? ''}
          onChange={(e) => set('input', { ...input, [i.name]: e.currentTarget.value })}
        />
      ))}
      {outputs.length > 0 && (
        <Text size="xs" c="dimmed">
          {t.flowEditor.rezultatVPeremennykh}
          {outputs.map((o) => `${o.name} (${o.label || o.name})`).join(', ')}
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
              : t.flowEditor.obyavleniyaOSboyakh,
        )
        .join(' ');
    switch (a.type) {
      case 'play':
        return t.flowEditor.zvuchit(media(a.media));
      case 'collect':
        return t.flowEditor.zvuchitZhdemTsifruS(media(a.media), a.digits.join(', '), a.timeoutSec);
      case 'http':
        return t.flowEditor.zaprosVoVneshnyuyuSistemu(JSON.stringify(a.input));
      case 'queue':
        return t.flowEditor.klientVOcheredi(String(refs.queues.find((q) => q.id === a.queueId)?.name ?? ''));
      case 'voicemail':
        return a.mode === 'voicemail'
          ? t.flowEditor.zvuchitZapisSoobshcheniya(media(a.media))
          : t.flowEditor.zakazObratnogoZvonka;
      case 'transfer':
        return t.flowEditor.perevodNaNomer(a.number);
      case 'hangup':
        return a.media.length ? t.flowEditor.zvuchitOtboy(media(a.media)) : t.flowEditor.otboy;
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
      if (e.type === 'csat') lines.push({ kind: 'system', text: t.flowEditor.otsenkaSokhranena(e.score) });
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
        r.ok ? t.flowEditor.otvet(JSON.stringify(r.outputs)) : t.flowEditor.oshibka(r.error),
      );
    } catch (e) {
      await send({ type: 'http', ok: false, outputs: {} }, t.flowEditor.oshibka(errorText(e)));
    } finally {
      setBusy(false);
    }
  };
  const a = step?.action;
  return (
    <Drawer opened onClose={onClose} title={t.flowEditor.testovyyProgon} position="right" size="lg">
      <Stack>
        <Group align="end">
          <TextInput
            label={t.flowEditor.nomerZvonyashchegoCaller}
            value={caller}
            onChange={(e) => setCaller(e.currentTarget.value)}
          />
          <Button
            onClick={() => {
              setLog([{ kind: 'system', text: t.flowEditor.zvonokSNomera(caller) }]);
              apply(startFlow(graph, { caller, did: t.flowEditor.test }, ctx()));
            }}
            data-testid="test-start"
          >
            {step ? t.flowEditor.nachatZanovo : t.flowEditor.nachat}
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
                {a.type === 'play' ? t.flowEditor.frazaProzvuchala : t.flowEditor.soobshchenieZapisano}
              </Button>
            )}
            {a.type === 'voicemail' && a.mode === 'callback' && (
              <Button onClick={() => void send({ type: 'done' })}>{t.flowEditor.dalee}</Button>
            )}
            {a.type === 'collect' && (
              <Stack gap="xs">
                <SimpleGrid cols={6} spacing={4}>
                  {MENU_DIGITS.map((d) => (
                    <Button
                      key={d}
                      variant={a.digits.includes(d) ? 'filled' : 'default'}
                      onClick={() => void send({ type: 'digit', digit: d }, t.flowEditor.nazhato(d))}
                      data-testid={`test-digit-${d}`}
                    >
                      {d}
                    </Button>
                  ))}
                </SimpleGrid>
                <Button
                  variant="light"
                  onClick={() => void send({ type: 'timeout' }, t.flowEditor.tishinaTaymaut)}
                >
                  {t.flowEditor.tishina}
                </Button>
              </Stack>
            )}
            {a.type === 'http' && (
              <Group>
                <Button onClick={() => void runHttp(a)} loading={busy} data-testid="test-http">
                  {t.flowEditor.vypolnitZapros}
                </Button>
                <Button
                  variant="light"
                  color="red"
                  onClick={() =>
                    void send({ type: 'http', ok: false, outputs: {} }, t.flowEditor.oshibkaImitatsiya)
                  }
                >
                  {t.flowEditor.imitirovatOshibku}
                </Button>
              </Group>
            )}
            {a.type === 'queue' && (
              <Group>
                <Button
                  onClick={() =>
                    void send({ type: 'queue', result: 'after' }, t.flowEditor.operatorOtvetilIZavershil)
                  }
                  data-testid="test-after"
                >
                  {t.flowEditor.razgovorSOperatoromZavershen}
                </Button>
                <Button
                  variant="light"
                  onClick={() =>
                    void send({ type: 'queue', result: 'timeout' }, t.flowEditor.dolgoeOzhidanie)
                  }
                >
                  {t.flowEditor.dolgoeOzhidanie}
                </Button>
                <Button
                  variant="light"
                  onClick={() => void send({ type: 'queue', result: 'noAgents' }, t.flowEditor.netOperatorov)}
                >
                  {t.flowEditor.netOperatorov}
                </Button>
              </Group>
            )}
            {a.type === 'transfer' && (
              <Button onClick={() => void send({ type: 'transfer', ok: false }, t.flowEditor.nomerNeOtvetil)}>
                {t.flowEditor.nomerNeOtvetil}
              </Button>
            )}
          </Card>
        )}
        {step && (
          <Text size="xs" c="dimmed">
            {t.flowEditor.peremennye}
            {JSON.stringify(step.state.vars)}
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
  const [name, setName] = useState(t.flowEditor.anna);
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
          out.push({ from: 'system', text: t.flowEditor.vKartochkuKlienta(e.field, e.value) });
      const a = r.action;
      if (a.type === 'say') {
        out.push({ from: 'bot', text: a.text });
        r = resumeFlow(graph, r.state, { type: 'done' }, ctx());
        continue;
      }
      if (a.type === 'prompt') out.push({ from: 'bot', text: a.text, buttons: a.buttons });
      else if (a.type === 'http')
        out.push({ from: 'system', text: t.flowEditor.zaprosVoVneshnyuyuSistemu(JSON.stringify(a.input)) });
      else if (a.type === 'handoff') {
        if (a.text) out.push({ from: 'bot', text: a.text });
        const q = a.queueId
          ? String(refs.queues.find((x) => x.id === a.queueId)?.name ?? '')
          : t.flowEditor.ocheredKanala;
        out.push({
          from: 'system',
          text: t.flowEditor.perevodNaOperatoraPeremennye(q, JSON.stringify(r.state.vars)),
        });
      } else if (a.type === 'hangup') {
        if (a.text) out.push({ from: 'bot', text: a.text });
        out.push({ from: 'system', text: t.flowEditor.botZakrylDialog });
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
  /** Клиент молчит (Ф14): срок ожидания шага истёк — напоминание или выход «нет ответа». */
  const silence = () => {
    if (!step) return;
    drive(resumeFlow(graph, step.state, { type: 'timeout' }, ctx()), [
      {
        from: 'system',
        text: t.flowEditor.klientMolchitS(step.action.type === 'prompt' ? step.action.waitSec : 0),
      },
    ]);
  };
  const runHttp = async (a: Extract<Action, { type: 'http' }>, fail = false) => {
    if (!step) return;
    setBusy(true);
    let ev: FlowEvent = { type: 'http', ok: false, outputs: {} };
    let note = t.flowEditor.oshibkaImitatsiya;
    if (!fail)
      try {
        const r = await post<{ ok: boolean; outputs: Record<string, string>; error?: string }>(
          `/integrations/${a.operationId}/test`,
          { input: a.input },
        );
        ev = { type: 'http', ok: r.ok, outputs: r.outputs };
        note = r.ok ? t.flowEditor.otvet(JSON.stringify(r.outputs)) : t.flowEditor.oshibka(r.error);
      } catch (e) {
        note = t.flowEditor.oshibka(errorText(e));
      }
    setBusy(false);
    drive(resumeFlow(graph, step.state, ev, ctx()), [{ from: 'system', text: note }]);
  };
  const a = step?.action;
  return (
    <Drawer opened onClose={onClose} title={t.flowEditor.testovyyProgonBota} position="right" size="lg">
      <Stack>
        <Group align="end">
          <TextInput
            label={t.flowEditor.imyaKlientaName}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button
            onClick={() => {
              setLines([]);
              drive(startFlow(graph, { name, 'client.name': name, channel: 'webchat' }, ctx()), [
                { from: 'system', text: t.flowEditor.klientNapisalVChat },
              ]);
            }}
            data-testid="test-start"
          >
            {step ? t.flowEditor.nachatZanovo : t.flowEditor.nachat}
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
              placeholder={t.flowEditor.otvetKlienta}
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && answer(input)}
              data-testid="test-input"
            />
            <Button onClick={() => answer(input)} data-testid="test-send">
              {t.flowEditor.otpravit}
            </Button>
            {!!a.waitSec && (
              <Button variant="light" color="gray" onClick={silence} data-testid="test-silence">
                {t.flowEditor.klientMolchit}
              </Button>
            )}
          </Group>
        )}
        {a?.type === 'http' && (
          <Group>
            <Button onClick={() => void runHttp(a)} loading={busy} data-testid="test-http">
              {t.flowEditor.vypolnitZapros}
            </Button>
            <Button variant="light" color="red" onClick={() => void runHttp(a, true)}>
              {t.flowEditor.imitirovatOshibku}
            </Button>
          </Group>
        )}
        {step && (
          <Text size="xs" c="dimmed">
            {t.flowEditor.peremennye}
            {JSON.stringify(step.state.vars)}
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
  const canvasRef = useRef<HTMLDivElement>(null);
  // Щипок на тачпаде приходит как колесо с Ctrl; у React Flow на Windows он в 10 раз медленнее, чем на Mac, —
  // масштабируем сами, относительно точки под пальцами. Обычное колесо мыши с Ctrl — так же.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const { x, y, zoom } = rf.getViewport();
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * Math.exp(-step * 0.01)));
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const k = next / zoom;
      void rf.setViewport({ x: px - (px - x) * k, y: py - (py - y) * k, zoom: next });
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, [rf]);
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
  // Голосовой сценарий правит «Сценарии IVR», бот — «Боты».
  const writable = can(flow.kind === 'text' ? 'bots.manage' : 'ivr.manage');

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
  const saveAction = useAction(save, t.flowEditor.chernovikSokhranen);
  const check = useAction(async () => {
    await save();
    setServerIssues(await post(`/flows/${flow.id}/validate`));
  }, t.flowEditor.proverkaVypolnena);
  const publish = useMutationWithDetails(async () => {
    await save();
    const r = await post<{ version: number; warnings: unknown[] }>(`/flows/${flow.id}/publish`, {
      comment: comment || undefined,
    });
    setComment('');
    setServerIssues(null);
    notifications.show({
      color: 'green',
      message: t.flowEditor.opublikovanaVersiyaNovyeIdut(
        r.version,
        flow.kind === 'text' ? t.flowEditor.dialogi : t.flowEditor.zvonki,
      ),
    });
    void qc.invalidateQueries({ queryKey: [`/flows/${flow.id}`] });
  }, setServerIssues);

  const sel = shown.find((n) => n.id === selected);
  const kindNodes = (Object.keys(NODE_SPECS) as NodeType[]).filter(
    (nodeType) => nodeType !== 'start' && NODE_SPECS[nodeType].kinds.includes(flow.kind),
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
              placeholder={t.flowEditor.nomeraDid}
              w={220}
              readOnly={!writable}
              data-testid="flow-dids"
            />
          )}
          <Badge variant="light" data-testid="flow-published">
            {flow.publishedVersion
              ? t.flowEditor.opublikovanaVersiya(flow.publishedVersion)
              : t.flowEditor.neOpublikovan}
          </Badge>
          {dirty && <Badge color="orange">{t.flowEditor.neSokhraneno}</Badge>}
        </Group>
        <Group gap="xs">
          <Button variant="default" onClick={() => setTesting(true)} data-testid="flow-test">
            {t.flowEditor.testovyyProgon}
          </Button>
          <Button variant="default" onClick={() => setVersions(true)}>
            {t.flowEditor.versii}
          </Button>
          {writable && (
            <>
              <Button
                variant="light"
                onClick={() => saveAction.mutate(undefined)}
                loading={saveAction.isPending}
                data-testid="flow-save"
              >
                {t.flowEditor.sokhranitChernovik}
              </Button>
              <Button
                variant="light"
                color="teal"
                onClick={() => check.mutate(undefined)}
                loading={check.isPending}
              >
                {t.flowEditor.proverit}
              </Button>
              <TextInput
                placeholder={t.flowEditor.kommentariyKVersii}
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
                {t.flowEditor.opublikovat}
              </Button>
            </>
          )}
        </Group>
      </Group>
      <Group align="stretch" gap="xs" style={{ flex: 1, minHeight: 0 }} wrap="nowrap">
        {writable && (
          <Stack gap={4} w={150} style={{ flexShrink: 0 }} data-testid="palette">
            <Text size="xs" c="dimmed">
              {t.flowEditor.dobavitUzel}
            </Text>
            {kindNodes.map((nodeType) => (
              <Button
                key={nodeType}
                size="compact-xs"
                variant="light"
                color="gray"
                onClick={() => add(nodeType)}
                title={NODE_SPECS[nodeType].description}
                data-testid={`palette-${nodeType}`}
                styles={{ inner: { justifyContent: 'flex-start' } }}
              >
                {NODE_SPECS[nodeType].label}
              </Button>
            ))}
            <Text size="10px" c="dimmed" mt="xs">
              {t.flowEditor.svyazPeretashchitTochkuVykhoda}
            </Text>
          </Stack>
        )}
        <Box
          ref={canvasRef}
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
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            // Тачпад ноутбука: два пальца — перемещение схемы (как прокрутка), щипок — масштаб (обработчик выше).
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            zoomOnScroll={false}
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
                {t.flowEditor.vyberiteUzelChtobyIzmenit}
              </Text>
            )}
            <Title order={6} mt="md">
              {t.flowEditor.proverka}
            </Title>
            {local.errors.length === 0 && local.warnings.length === 0 && (
              <Text size="xs" c="green" data-testid="flow-valid">
                {t.flowEditor.oshibokNet}
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
                  {t.flowEditor.proverkaNaServereSsylki}
                </Text>
                {serverIssues.errors.length + serverIssues.warnings.length === 0 && (
                  <Text size="xs" c="green">
                    {t.flowEditor.zamechaniyNet}
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
            title: t.flowEditor.neOpublikovano,
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
    t.flowEditor.opublikovanaVybrannayaVersiya,
  );
  return (
    <Modal opened onClose={onClose} title={t.flowEditor.versiiStsenariya} size="lg">
      <Text size="sm" c="dimmed" mb="sm">
        {t.flowEditor.publikatsiyaAtomarnaNovyeZvonki}
      </Text>
      <Table striped data-testid="flow-versions">
        <Table.Tbody>
          {flow.versions.map((v) => (
            <Table.Tr key={v.id}>
              <Table.Td>
                {t.flowEditor.versiya2}
                {v.version}{' '}
                {v.id === flow.publishedVersionId && (
                  <Badge color="green">{t.flowEditor.opublikovana2}</Badge>
                )}
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
                    {t.flowEditor.vChernovik}
                  </Button>
                  {can(flow.kind === 'text' ? 'bots.manage' : 'ivr.manage') &&
                    v.id !== flow.publishedVersionId && (
                      <Button
                        size="xs"
                        variant="light"
                        color="orange"
                        onClick={() => rollback.mutate(v.id, { onSuccess: onClose })}
                        data-testid={`rollback-${v.version}`}
                      >
                        {t.flowEditor.otkatitNaNee}
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
  if (!flow.data) return <Text c="dimmed">{t.flowEditor.zagruzka}</Text>;
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
