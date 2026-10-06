import {
  ActionIcon,
  Button,
  Checkbox,
  Divider,
  Group,
  Indicator,
  MultiSelect,
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
  IconFilterOff,
  IconListTree,
  IconProgressCheck,
  IconSearch,
  IconUserCheck,
  IconUserStar,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useList } from '../lib/data';
import { t } from '../lib/i18n';
import { useOrgTree, useTopicTree } from './DictPickers';
import { TreePicker } from './TreePicker';

/** Статусы обращения 2-й линии в порядке жизненного цикла. */
export const STATUS_ORDER = ['new', 'in_work', 'rework', 'approval', 'closed'] as const;
/** По умолчанию — все, кроме закрытых. */
export const OPEN_STATUSES = ['new', 'in_work', 'rework', 'approval'];

export interface TicketFilter {
  q: string;
  responsible: string[];
  curator: string[];
  topics: string[];
  orgs: string[];
  statuses: string[];
  dueFrom: string;
  dueTo: string;
  createdFrom: string;
  createdTo: string;
  overdue: boolean;
  important: boolean;
}

export const DEFAULT_FILTER: TicketFilter = {
  q: '',
  responsible: [],
  curator: [],
  topics: [],
  orgs: [],
  statuses: OPEN_STATUSES,
  dueFrom: '',
  dueTo: '',
  createdFrom: '',
  createdTo: '',
  overdue: false,
  important: false,
};

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Параметры запроса списка по фильтру. */
export function filterQuery(f: TicketFilter): string {
  const p: string[] = [];
  const list = (k: string, v: string[]) => v.length && p.push(`${k}=${v.map(encodeURIComponent).join(',')}`);
  list('responsibleIds', f.responsible);
  list('curatorIds', f.curator);
  list('topicIds', f.topics);
  list('orgs', f.orgs);
  list('status', f.statuses.length ? f.statuses : [...STATUS_ORDER]);
  for (const k of ['dueFrom', 'dueTo', 'createdFrom', 'createdTo'] as const) if (f[k]) p.push(`${k}=${f[k]}`);
  if (f.overdue) p.push('overdue=true');
  if (f.important) p.push('important=true');
  if (f.q.trim()) p.push(`q=${encodeURIComponent(f.q.trim())}`);
  return p.length ? `&${p.join('&')}` : '';
}

/** Значок фильтра: красная точка — фильтр применён. */
function FilterIcon({
  label,
  active,
  onClick,
  children,
  color,
  testId,
}: {
  label: string;
  active: boolean;
  onClick?(): void;
  children: ReactNode;
  color?: string;
  testId: string;
}) {
  return (
    <Tooltip label={label} withArrow>
      <Indicator color="red" size={9} offset={3} disabled={!active} withBorder>
        <ActionIcon
          variant={active ? 'light' : 'default'}
          color={color}
          size="lg"
          aria-label={label}
          onClick={onClick}
          data-testid={testId}
          data-active={active || undefined}
        >
          {children}
        </ActionIcon>
      </Indicator>
    </Tooltip>
  );
}

/** Выбор сотрудников: сверху быстрый выбор «Я», ниже — несколько сотрудников с поиском. */
function PeopleFilter({
  kind,
  value,
  onChange,
  people,
}: {
  kind: 'responsible' | 'curator';
  value: string[];
  onChange(v: string[]): void;
  people: { value: string; label: string }[];
}) {
  const me = value.includes('me');
  const label = kind === 'responsible' ? t.tickets.fltResponsible : t.tickets.fltCurator;
  return (
    <Popover position="bottom-start" shadow="md" width={320} trapFocus>
      <Popover.Target>
        <span>
          <FilterIcon label={label} active={value.length > 0} testId={`flt-${kind}`}>
            {kind === 'responsible' ? <IconUserCheck size={20} /> : <IconUserStar size={20} />}
          </FilterIcon>
        </span>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={600}>
            {label}
          </Text>
          <Button
            size="xs"
            variant={me ? 'filled' : 'light'}
            onClick={() => onChange(me ? value.filter((v) => v !== 'me') : [...value, 'me'])}
            data-testid={`flt-${kind}-me`}
          >
            {t.tickets.fltMe}
          </Button>
          <MultiSelect
            size="xs"
            placeholder={t.tickets.fltPeople}
            data={people}
            value={value.filter((v) => v !== 'me')}
            onChange={(v) => onChange(me ? ['me', ...v] : v)}
            searchable
            clearable
            comboboxProps={{ withinPortal: false }}
            data-testid={`flt-${kind}-people`}
          />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * Фильтры списка обращений 2-й линии значками: ответственный и куратор, тема, предприятие/подразделение,
 * статус, даты (с просроченными), особо важные. Красная точка у значка — фильтр применён.
 */
export function TicketFilters({
  value: f,
  onChange,
}: {
  value: TicketFilter;
  onChange(f: TicketFilter): void;
}) {
  const set = (patch: Partial<TicketFilter>) => onChange({ ...f, ...patch });
  const peopleList = useList('/tickets/assignable');
  const people = (peopleList.data ?? []).map((p) => ({ value: p.id, label: String(p.fullName) }));
  const topicTree = useTopicTree();
  const orgTree = useOrgTree();
  const statusChanged = !sameSet(f.statuses, OPEN_STATUSES);
  const dateActive = !!(f.dueFrom || f.dueTo || f.createdFrom || f.createdTo || f.overdue);
  const any =
    !!f.q ||
    f.responsible.length > 0 ||
    f.curator.length > 0 ||
    f.topics.length > 0 ||
    f.orgs.length > 0 ||
    statusChanged ||
    dateActive ||
    f.important;
  const STATUS: Record<string, string> = {
    new: t.tickets.novyy,
    in_work: t.tickets.vRabote,
    rework: t.tickets.naDorabotke,
    approval: t.tickets.naSoglasovanii,
    closed: t.tickets.zakryt,
  };
  return (
    <Stack gap={6} data-testid="ticket-filters">
      <TextInput
        size="xs"
        placeholder={t.tickets.fltSearch}
        leftSection={<IconSearch size={14} />}
        value={f.q}
        onChange={(e) => set({ q: e.currentTarget.value })}
        data-testid="flt-q"
      />
      <Group gap={8}>
        <PeopleFilter
          kind="responsible"
          value={f.responsible}
          onChange={(v) => set({ responsible: v })}
          people={people}
        />
        <PeopleFilter
          kind="curator"
          value={f.curator}
          onChange={(v) => set({ curator: v })}
          people={people}
        />
        <TreePicker
          multiple
          data={topicTree}
          value={f.topics}
          onChange={(v) => set({ topics: v })}
          testId="flt-topic-tree"
          target={(open) => (
            <FilterIcon
              label={t.tickets.fltTopic}
              active={f.topics.length > 0}
              onClick={open}
              testId="flt-topic"
            >
              <IconListTree size={20} />
            </FilterIcon>
          )}
        />
        <TreePicker
          multiple
          data={orgTree}
          value={f.orgs}
          onChange={(v) => set({ orgs: v })}
          testId="flt-org-tree"
          target={(open) => (
            <FilterIcon label={t.tickets.fltOrg} active={f.orgs.length > 0} onClick={open} testId="flt-org">
              <IconBuilding size={20} />
            </FilterIcon>
          )}
        />
        <Popover position="bottom-start" shadow="md" width={240}>
          <Popover.Target>
            <span>
              <FilterIcon label={t.tickets.fltStatus} active={statusChanged} testId="flt-status">
                <IconProgressCheck size={20} />
              </FilterIcon>
            </span>
          </Popover.Target>
          <Popover.Dropdown>
            <Checkbox.Group value={f.statuses} onChange={(v) => set({ statuses: v })}>
              <Stack gap={6}>
                {STATUS_ORDER.map((s) => (
                  <Checkbox key={s} value={s} label={STATUS[s]} data-testid={`flt-status-${s}`} />
                ))}
              </Stack>
            </Checkbox.Group>
            <Button
              size="compact-xs"
              variant="subtle"
              mt="xs"
              onClick={() => set({ statuses: OPEN_STATUSES })}
            >
              {t.tickets.fltOpenOnly}
            </Button>
          </Popover.Dropdown>
        </Popover>
        <Popover position="bottom-start" shadow="md" width={300}>
          <Popover.Target>
            <span>
              <FilterIcon label={t.tickets.fltDates} active={dateActive} testId="flt-date">
                <IconCalendar size={20} />
              </FilterIcon>
            </span>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap={6}>
              <Switch
                color="red"
                label={t.tickets.fltOverdue}
                checked={f.overdue}
                onChange={(e) => set({ overdue: e.currentTarget.checked })}
                data-testid="flt-overdue"
              />
              <Divider label={t.tickets.fltDue} labelPosition="left" />
              <Group grow gap="xs">
                <TextInput
                  size="xs"
                  type="date"
                  label={t.tickets.s}
                  value={f.dueFrom}
                  onChange={(e) => set({ dueFrom: e.currentTarget.value })}
                  data-testid="flt-due-from"
                />
                <TextInput
                  size="xs"
                  type="date"
                  label={t.tickets.po}
                  value={f.dueTo}
                  onChange={(e) => set({ dueTo: e.currentTarget.value })}
                  data-testid="flt-due-to"
                />
              </Group>
              <Divider label={t.tickets.fltCreated} labelPosition="left" />
              <Group grow gap="xs">
                <TextInput
                  size="xs"
                  type="date"
                  label={t.tickets.s}
                  value={f.createdFrom}
                  onChange={(e) => set({ createdFrom: e.currentTarget.value })}
                  data-testid="flt-created-from"
                />
                <TextInput
                  size="xs"
                  type="date"
                  label={t.tickets.po}
                  value={f.createdTo}
                  onChange={(e) => set({ createdTo: e.currentTarget.value })}
                  data-testid="flt-created-to"
                />
              </Group>
            </Stack>
          </Popover.Dropdown>
        </Popover>
        <FilterIcon
          label={f.important ? t.tickets.fltImportantOn : t.tickets.fltImportantOff}
          active={f.important}
          color="red"
          onClick={() => set({ important: !f.important })}
          testId="flt-important"
        >
          <IconAlertTriangle size={20} />
        </FilterIcon>
        {any && (
          <Tooltip label={t.tickets.fltReset} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              aria-label={t.tickets.fltReset}
              onClick={() => onChange(DEFAULT_FILTER)}
              data-testid="flt-reset"
            >
              <IconFilterOff size={20} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Stack>
  );
}
