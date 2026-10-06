import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Divider,
  Group,
  Indicator,
  Popover,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBuilding,
  IconCalendar,
  IconFileSpreadsheet,
  IconFilterOff,
  IconGavel,
  IconListTree,
  IconMailForward,
  IconProgressCheck,
  IconSearch,
  IconUserCheck,
  IconUserStar,
  IconWorldWww,
} from '@tabler/icons-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useAuth } from '../lib/auth';
import { type Row, useList } from '../lib/data';
import { t } from '../lib/i18n';
import { useOrgTree, useTopicTree } from './DictPickers';
import { type TreeNode, TreePicker, treeValuesUnder } from './TreePicker';

/** Статусы обращения 2-й линии в порядке жизненного цикла. */
export const STATUS_ORDER = ['new', 'in_work', 'rework', 'approval', 'closed'] as const;
/** По умолчанию — все, кроме закрытых. */
export const OPEN_STATUSES = ['new', 'in_work', 'rework', 'approval'];
/** Поля поиска (индикаторы справа от строки поиска). */
export const SEARCH_FIELDS = ['number', 'name', 'phone', 'email', 'summary', 'fuel', 'loyalty'] as const;
const SOURCES = ['voice', 'webchat', 'app', 'telegram', 'email', 'review', 'api'] as const;
const GUILT = ['yes', 'no', 'unknown'] as const;

export interface TicketFilter {
  q: string;
  qIn: string[];
  /** Выбор в дереве «предприятие → подразделение → сотрудник» и выбранные из него сотрудники. */
  responsible: string[];
  responsibleUsers: string[];
  curator: string[];
  curatorUsers: string[];
  topics: string[];
  orgs: string[];
  statuses: string[];
  createdFrom: string;
  createdTo: string;
  overdue: boolean;
  important: boolean;
  sources: string[];
  answerMethods: string[];
  guilt: string[];
}

const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Minsk' });
const daysAgo = (n: number) => day(new Date(Date.now() - n * 86_400_000));

/** По умолчанию: открытые статусы, поступившие за последние 30 дней (включая сегодня); «я» — для 2-й линии. */
export function defaultFilter(me?: { id: string; kind?: 'responsible' | 'curator' | null }): TicketFilter {
  const mine = me?.kind ? [`u:${me.id}`] : [];
  return {
    q: '',
    qIn: [...SEARCH_FIELDS],
    responsible: me?.kind === 'responsible' ? mine : [],
    responsibleUsers: me?.kind === 'responsible' ? [me.id] : [],
    curator: me?.kind === 'curator' ? mine : [],
    curatorUsers: me?.kind === 'curator' ? [me.id] : [],
    topics: [],
    orgs: [],
    statuses: OPEN_STATUSES,
    createdFrom: daysAgo(29),
    createdTo: day(new Date()),
    overdue: false,
    important: false,
    sources: [],
    answerMethods: [],
    guilt: [],
  };
}

/** Параметры запроса списка (и выгрузки) по фильтру. */
export function filterQuery(f: TicketFilter): string {
  const p: string[] = [];
  const list = (k: string, v: string[]) => v.length && p.push(`${k}=${v.map(encodeURIComponent).join(',')}`);
  list('responsibleIds', f.responsibleUsers);
  list('curatorIds', f.curatorUsers);
  list('topicIds', f.topics);
  list('orgs', f.orgs);
  list('status', f.statuses.length ? f.statuses : [...STATUS_ORDER]);
  list('sources', f.sources);
  list('answerMethods', f.answerMethods);
  list('guilt', f.guilt);
  if (f.createdFrom) p.push(`createdFrom=${f.createdFrom}`);
  if (f.createdTo) p.push(`createdTo=${f.createdTo}`);
  if (f.overdue) p.push('overdue=true');
  if (f.important) p.push('important=true');
  if (f.q.trim()) {
    p.push(`q=${encodeURIComponent(f.q.trim())}`);
    if (f.qIn.length && f.qIn.length < SEARCH_FIELDS.length) p.push(`qIn=${f.qIn.join(',')}`);
  }
  return p.length ? `&${p.join('&')}` : '';
}

/** Сотрудники, выбранные в дереве (отмеченное предприятие или подразделение — все его сотрудники). */
function usersOf(tree: TreeNode[], values: string[]): string[] {
  const out = new Set<string>();
  for (const v of values)
    for (const x of v.startsWith('u:') ? [v] : treeValuesUnder(tree, v))
      if (x.startsWith('u:')) out.add(x.slice(2));
  return [...out];
}

/** Дерево «предприятие → подразделение → сотрудник» по матрице ответственности. */
function useAssigneeTree(kind: 'responsible' | 'curator'): TreeNode[] {
  const list = useList(`/tickets/assignee-tree?kind=${kind}`);
  return useMemo(() => {
    const ents = new Map<string, TreeNode>();
    const deps = new Map<string, TreeNode>();
    const loose: TreeNode[] = [];
    for (const r of list.data ?? []) {
      const person = { value: `u:${String(r.userId)}`, label: String(r.fullName) };
      if (!r.enterpriseId) {
        loose.push(person);
        continue;
      }
      const e = String(r.enterpriseId);
      if (!ents.has(e)) ents.set(e, { value: `e:${e}`, label: String(r.enterpriseName), children: [] });
      const d = String(r.edId);
      if (!deps.has(d)) {
        const node = { value: `d:${d}`, label: String(r.departmentName), children: [] as TreeNode[] };
        deps.set(d, node);
        ents.get(e)!.children!.push(node);
      }
      deps.get(d)!.children!.push(person);
    }
    const out = [...ents.values()];
    if (loose.length) out.push({ value: 'e:none', label: t.tickets.fltNoMatrix, children: loose });
    return out;
  }, [list.data]);
}

/** Кнопка-значок фильтра: красная точка — фильтр применён; открытый фильтр — выделенная кнопка. */
function FilterButton({
  label,
  active,
  opened,
  onClick,
  children,
  color,
  testId,
}: {
  label: string;
  active: boolean;
  opened?: boolean;
  onClick?(): void;
  children: ReactNode;
  color?: string;
  testId: string;
}) {
  return (
    <Tooltip label={label} withArrow disabled={opened}>
      <Indicator color="red" size={9} offset={3} disabled={!active} withBorder>
        <ActionIcon
          variant={opened ? 'filled' : active ? 'light' : 'default'}
          color={color}
          size="lg"
          aria-label={label}
          onClick={onClick}
          data-testid={testId}
          data-active={active || undefined}
          data-opened={opened || undefined}
          style={opened ? { boxShadow: '0 0 0 3px var(--mantine-color-blue-3)' } : undefined}
        >
          {children}
        </ActionIcon>
      </Indicator>
    </Tooltip>
  );
}

/** Выпадающий фильтр с черновиком: «Сбросить» очищает, «Применить» применяет и закрывает. */
function DraftFilter<T>({
  label,
  icon,
  active,
  value,
  empty,
  onApply,
  testId,
  width = 280,
  children,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  value: T;
  empty: T;
  onApply(v: T): void;
  testId: string;
  width?: number;
  children(draft: T, set: (v: T) => void): ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState<T>(value);
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" shadow="md" width={width}>
      <Popover.Target>
        <span>
          <FilterButton
            label={label}
            active={active}
            opened={opened}
            testId={testId}
            onClick={() => {
              if (!opened) setDraft(value);
              setOpened(!opened);
            }}
          >
            {icon}
          </FilterButton>
        </span>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={600}>
            {label}
          </Text>
          {children(draft, setDraft)}
          <Group justify="flex-end" gap="xs">
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setDraft(empty)}
              data-testid={`${testId}-reset`}
            >
              {t.tree.clear}
            </Button>
            <Button
              size="compact-xs"
              onClick={() => {
                onApply(draft);
                setOpened(false);
              }}
              data-testid={`${testId}-apply`}
            >
              {t.tree.apply}
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function Checks({
  options,
  value,
  onChange,
  testId,
}: {
  options: { value: string; label: string }[];
  value: string[];
  onChange(v: string[]): void;
  testId: string;
}) {
  return (
    <Checkbox.Group value={value} onChange={onChange}>
      <Stack gap={6}>
        {options.map((o) => (
          <Checkbox key={o.value} value={o.value} label={o.label} data-testid={`${testId}-${o.value}`} />
        ))}
      </Stack>
    </Checkbox.Group>
  );
}

/** Сотрудники (ответственный/куратор): «Я» сверху, ниже — предприятие → подразделение → ФИО с поиском. */
function PeopleFilter({
  kind,
  value,
  onApply,
}: {
  kind: 'responsible' | 'curator';
  value: string[];
  onApply(values: string[], users: string[]): void;
}) {
  const { me } = useAuth();
  const tree = useAssigneeTree(kind);
  const label = kind === 'responsible' ? t.tickets.fltResponsible : t.tickets.fltCurator;
  const testId = `flt-${kind}`;
  return (
    <TreePicker
      multiple
      apply
      data={tree}
      value={value}
      onChange={(v) => onApply(v, usersOf(tree, v))}
      testId={`${testId}-tree`}
      header={({ value: draft, set }) => {
        // «Я» активно, если среди выбранных есть я (в том числе через предприятие или подразделение).
        const meOn = !!me && usersOf(tree, draft).includes(me.id);
        return (
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              {label}
            </Text>
            <Button
              size="compact-xs"
              variant={meOn ? 'filled' : 'light'}
              onClick={() =>
                me && set(meOn ? draft.filter((v) => v !== `u:${me.id}`) : [...draft, `u:${me.id}`])
              }
              data-testid={`${testId}-me`}
            >
              {t.tickets.fltMe}
            </Button>
          </Group>
        );
      }}
      target={(open, opened) => (
        <FilterButton label={label} active={value.length > 0} opened={opened} onClick={open} testId={testId}>
          {kind === 'responsible' ? <IconUserCheck size={20} /> : <IconUserStar size={20} />}
        </FilterButton>
      )}
    />
  );
}

/**
 * Поиск с индикаторами полей и фильтры значками: ответственный и куратор (предприятие → подразделение → ФИО),
 * тема, предприятие/подразделение, статус, источник, способ ответа, вина работника, дата поступления (с быстрым
 * выбором и просроченными), особо важные; выгрузка в Excel. Красная точка — фильтр применён.
 */
export function TicketFilters({
  value: f,
  onChange,
  onReset,
  onExport,
  exporting,
}: {
  value: TicketFilter;
  onChange(f: TicketFilter): void;
  onReset(): void;
  onExport?(): void;
  exporting?: boolean;
}) {
  const set = (patch: Partial<TicketFilter>) => onChange({ ...f, ...patch });
  const topicTree = useTopicTree();
  const orgTree = useOrgTree();
  const methods = useList('/dict/answer-methods');
  const STATUS: Record<string, string> = {
    new: t.tickets.novyy,
    in_work: t.tickets.vRabote,
    rework: t.tickets.naDorabotke,
    approval: t.tickets.naSoglasovanii,
    closed: t.tickets.zakryt,
  };
  const SOURCE: Record<string, string> = {
    voice: t.workspace.zvonok,
    webchat: t.workspace.sayt,
    app: t.workspace.prilozhenie,
    telegram: 'Telegram',
    email: 'E-mail',
    review: t.reviews.channel,
    api: t.workspace.vneshnyayaSistema,
  };
  const dateActive = !!(f.createdFrom || f.createdTo || f.overdue);
  const qIn = new Set(f.qIn);
  return (
    <Stack gap={6} data-testid="ticket-filters">
      <Group gap={6} wrap="nowrap" align="center">
        <TextInput
          size="xs"
          style={{ flex: 1, minWidth: 140 }}
          placeholder={t.tickets.fltSearch}
          leftSection={<IconSearch size={14} />}
          value={f.q}
          onChange={(e) => set({ q: e.currentTarget.value })}
          data-testid="flt-q"
        />
        {/* Индикаторы полей поиска: по умолчанию все включены, щелчок — выключить/включить. */}
        <Group gap={3} wrap="wrap" maw={300} data-testid="flt-q-fields">
          {SEARCH_FIELDS.map((k) => (
            <Tooltip key={k} label={t.tickets.qFieldHint[k]} withArrow>
              <Badge
                size="sm"
                variant={qIn.has(k) ? 'filled' : 'outline'}
                color={qIn.has(k) ? 'blue' : 'gray'}
                style={{ cursor: 'pointer', textTransform: 'none' }}
                onClick={() => {
                  const next = qIn.has(k) ? f.qIn.filter((x) => x !== k) : [...f.qIn, k];
                  set({ qIn: next.length ? next : [...SEARCH_FIELDS] });
                }}
                data-testid={`flt-q-${k}`}
                data-on={qIn.has(k) || undefined}
              >
                {t.tickets.qField[k]}
              </Badge>
            </Tooltip>
          ))}
        </Group>
      </Group>
      <Group gap={8}>
        <PeopleFilter
          kind="responsible"
          value={f.responsible}
          onApply={(v, users) => set({ responsible: v, responsibleUsers: users })}
        />
        <PeopleFilter
          kind="curator"
          value={f.curator}
          onApply={(v, users) => set({ curator: v, curatorUsers: users })}
        />
        <TreePicker
          multiple
          apply
          data={topicTree}
          value={f.topics}
          onChange={(v) => set({ topics: v })}
          testId="flt-topic-tree"
          target={(open, opened) => (
            <FilterButton
              label={t.tickets.fltTopic}
              active={f.topics.length > 0}
              opened={opened}
              onClick={open}
              testId="flt-topic"
            >
              <IconListTree size={20} />
            </FilterButton>
          )}
        />
        <TreePicker
          multiple
          apply
          data={orgTree}
          value={f.orgs}
          onChange={(v) => set({ orgs: v })}
          testId="flt-org-tree"
          target={(open, opened) => (
            <FilterButton
              label={t.tickets.fltOrg}
              active={f.orgs.length > 0}
              opened={opened}
              onClick={open}
              testId="flt-org"
            >
              <IconBuilding size={20} />
            </FilterButton>
          )}
        />
        <DraftFilter
          label={t.tickets.fltStatus}
          icon={<IconProgressCheck size={20} />}
          // Не все статусы — фильтр применён (по умолчанию закрытые не показываются).
          active={f.statuses.length < STATUS_ORDER.length}
          value={f.statuses}
          empty={[...STATUS_ORDER] as string[]}
          onApply={(v) => set({ statuses: v.length ? v : [...STATUS_ORDER] })}
          testId="flt-status"
          width={240}
        >
          {(draft, setDraft) => (
            <>
              <Checks
                options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS[s]! }))}
                value={draft}
                onChange={setDraft}
                testId="flt-status"
              />
              <Button size="compact-xs" variant="subtle" onClick={() => setDraft(OPEN_STATUSES)}>
                {t.tickets.fltOpenOnly}
              </Button>
            </>
          )}
        </DraftFilter>
        <DraftFilter
          label={t.tickets.fltSource}
          icon={<IconWorldWww size={20} />}
          active={f.sources.length > 0}
          value={f.sources}
          empty={[] as string[]}
          onApply={(v) => set({ sources: v })}
          testId="flt-source"
          width={240}
        >
          {(draft, setDraft) => (
            <Checks
              options={SOURCES.map((s) => ({ value: s, label: SOURCE[s]! }))}
              value={draft}
              onChange={setDraft}
              testId="flt-source"
            />
          )}
        </DraftFilter>
        <DraftFilter
          label={t.tickets.fltMethod}
          icon={<IconMailForward size={20} />}
          active={f.answerMethods.length > 0}
          value={f.answerMethods}
          empty={[] as string[]}
          onApply={(v) => set({ answerMethods: v })}
          testId="flt-method"
          width={260}
        >
          {(draft, setDraft) => (
            <Checks
              options={(methods.data ?? []).map((m: Row) => ({ value: m.id, label: String(m.name) }))}
              value={draft}
              onChange={setDraft}
              testId="flt-method"
            />
          )}
        </DraftFilter>
        <DraftFilter
          label={t.tickets.fltGuilt}
          icon={<IconGavel size={20} />}
          active={f.guilt.length > 0}
          value={f.guilt}
          empty={[] as string[]}
          onApply={(v) => set({ guilt: v })}
          testId="flt-guilt"
          width={220}
        >
          {(draft, setDraft) => (
            <Checks
              options={GUILT.map((g) => ({ value: g, label: t.tickets.guiltOpt[g]! }))}
              value={draft}
              onChange={setDraft}
              testId="flt-guilt"
            />
          )}
        </DraftFilter>
        <DraftFilter
          label={t.tickets.fltDates}
          icon={<IconCalendar size={20} />}
          active={dateActive}
          value={{ from: f.createdFrom, to: f.createdTo, overdue: f.overdue }}
          empty={{ from: '', to: '', overdue: false }}
          onApply={(v) => set({ createdFrom: v.from, createdTo: v.to, overdue: v.overdue })}
          testId="flt-date"
          width={310}
        >
          {(draft, setDraft) => (
            <>
              <Group gap={4}>
                {(
                  [
                    ['today', t.tickets.fltToday, 0],
                    ['week', t.tickets.fltWeek, 6],
                    ['month', t.tickets.flt30, 29],
                  ] as const
                ).map(([k, lbl, n]) => (
                  <Button
                    key={k}
                    size="compact-xs"
                    variant={draft.from === daysAgo(n) && draft.to === day(new Date()) ? 'filled' : 'light'}
                    onClick={() => setDraft({ ...draft, from: daysAgo(n), to: day(new Date()) })}
                    data-testid={`flt-date-${k}`}
                  >
                    {lbl}
                  </Button>
                ))}
              </Group>
              <Divider label={t.tickets.fltReceived} labelPosition="left" />
              <Group grow gap="xs">
                <TextInput
                  size="xs"
                  type="date"
                  label={t.tickets.s}
                  value={draft.from}
                  onChange={(e) => setDraft({ ...draft, from: e.currentTarget.value })}
                  data-testid="flt-created-from"
                />
                <TextInput
                  size="xs"
                  type="date"
                  label={t.tickets.po}
                  value={draft.to}
                  onChange={(e) => setDraft({ ...draft, to: e.currentTarget.value })}
                  data-testid="flt-created-to"
                />
              </Group>
              <Switch
                color="red"
                label={t.tickets.fltOverdue}
                checked={draft.overdue}
                onChange={(e) => setDraft({ ...draft, overdue: e.currentTarget.checked })}
                data-testid="flt-overdue"
              />
              <Text size="xs" c="dimmed">
                {t.tickets.fltOverdueHint}
              </Text>
            </>
          )}
        </DraftFilter>
        <FilterButton
          label={f.important ? t.tickets.fltImportantOn : t.tickets.fltImportantOff}
          active={f.important}
          color="red"
          onClick={() => set({ important: !f.important })}
          testId="flt-important"
        >
          <IconAlertTriangle size={20} />
        </FilterButton>
        <Tooltip label={t.tickets.fltReset} withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label={t.tickets.fltReset}
            onClick={onReset}
            data-testid="flt-reset"
          >
            <IconFilterOff size={20} />
          </ActionIcon>
        </Tooltip>
        {onExport && (
          <Tooltip label={t.tickets.exportXlsx} withArrow>
            <ActionIcon
              variant="light"
              color="green"
              size="lg"
              aria-label={t.tickets.exportXlsx}
              onClick={onExport}
              loading={exporting}
              data-testid="ticket-export"
            >
              <IconFileSpreadsheet size={20} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Stack>
  );
}
