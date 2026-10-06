import {
  ActionIcon,
  Box,
  Button,
  Checkbox,
  CloseButton,
  Group,
  Input,
  InputBase,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconSearch } from '@tabler/icons-react';
import { type ReactNode, useMemo, useState } from 'react';
import { t } from '../lib/i18n';

/** Узел справочника: первый уровень (тема, предприятие) и вложенные (подтема, подразделение, сотрудник). */
export interface TreeNode {
  value: string;
  label: string;
  children?: TreeNode[];
}

interface Indexed {
  node: TreeNode;
  path: TreeNode[];
  /** Текст для поиска: подписи всех уровней, в нижнем регистре, «ё» → «е». */
  text: string;
}

const norm = (s: string) =>
  s.toLowerCase().replace(new RegExp(String.fromCharCode(1105), 'g'), String.fromCharCode(1077));

/** Индекс по значению; одно значение может встречаться в нескольких ветках (сотрудник в нескольких отделах). */
function indexTree(nodes: TreeNode[]): Map<string, Indexed> {
  const m = new Map<string, Indexed>();
  const walk = (list: TreeNode[], path: TreeNode[]) => {
    for (const n of list) {
      const p = [...path, n];
      if (!m.has(n.value)) m.set(n.value, { node: n, path: p, text: norm(p.map((x) => x.label).join(' ')) });
      if (n.children?.length) walk(n.children, p);
    }
  };
  walk(nodes, []);
  return m;
}

/** Все значения внутри узла (с ним самим). */
export function treeValuesUnder(nodes: TreeNode[], value: string): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[], inside: boolean) => {
    for (const n of list) {
      const now = inside || n.value === value;
      if (now) out.push(n.value);
      if (n.children?.length) walk(n.children, now);
    }
  };
  walk(nodes, false);
  return [...new Set(out)];
}

/** Подпись выбранного значения с родителями: «Тема › Подтема». */
export function treeLabel(nodes: TreeNode[], value: string | null | undefined): string {
  if (!value) return '';
  const found = indexTree(nodes).get(value);
  return found ? found.path.map((x) => x.label).join(' › ') : '';
}

interface Base {
  data: TreeNode[];
  label?: ReactNode;
  description?: ReactNode;
  placeholder?: string;
  error?: ReactNode;
  withAsterisk?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  size?: 'xs' | 'sm' | 'md';
  /** Выбирать можно только последний уровень (например, подразделение, а не предприятие). */
  leafOnly?: boolean;
  /** Кнопка-значок вместо поля (фильтры списка): `opened` — окно этого фильтра открыто (кнопку выделить). */
  target?: (open: () => void, opened: boolean) => ReactNode;
  testId?: string;
}
type Single = Base & { multiple?: false; value: string | null; onChange(v: string | null): void };
type Multi = Base & {
  multiple: true;
  value: string[];
  onChange(v: string[]): void;
  /** Внизу окна — «Сбросить» и «Применить» (закрыть). Выбор при этом применяется сразу, по каждому щелчку. */
  apply?: boolean;
  /** Над поиском (например, быстрый выбор «Я»): работает с текущим (ещё не применённым) выбором. */
  header?: (ctx: { value: string[]; set(v: string[]): void }) => ReactNode;
};

/**
 * Двухуровневый (и глубже) справочник с поиском: сначала виден первый уровень, любую строку можно развернуть
 * стрелкой и увидеть вложенные; развернуть можно сразу несколько. Поиск — по словам в подписях всех уровней
 * («север клиент» найдёт «Отдел по работе с клиентами» предприятия «Север»), найденное раскрывается само.
 * Множественный выбор: отмеченная строка верхнего уровня включает все вложенные.
 */
export function TreePicker(props: Single | Multi) {
  const { data, size = 'xs', leafOnly, testId } = props;
  const multi = props.multiple === true;
  const applyMode = multi && !!(props as Multi).apply;
  const [opened, setOpened] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const index = useMemo(() => indexTree(data), [data]);
  const committed = props.multiple ? props.value : props.value ? [props.value] : [];
  const selected = committed;
  const selSet = new Set(selected);
  const setSelected = (v: string[]) => {
    if (props.multiple) props.onChange(v);
  };

  const open = () => {
    if (props.disabled) return;
    // Раскрыть ветки выбранных значений — текущий выбор сразу виден.
    const exp = new Set<string>();
    for (const v of committed) {
      const path = (index.get(v)?.path ?? []).map((x) => x.value);
      for (let k = 1; k < path.length; k++) exp.add(path.slice(0, k).join('/'));
    }
    setExpanded(exp);
    setQ('');
    setOpened(true);
  };
  const toggleExp = (v: string) => {
    const next = new Set(expanded);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setExpanded(next);
  };

  const choose = (n: TreeNode, ancestors: TreeNode[]) => {
    if (leafOnly && n.children?.length) {
      toggleExp(n.value);
      return;
    }
    if (multi) {
      // Отмечен через родителя — отдельно не снимается.
      if (ancestors.some((a) => selSet.has(a.value))) return;
      if (selSet.has(n.value)) setSelected(selected.filter((v) => v !== n.value));
      else {
        // Отмеченный родитель заменяет отдельно отмеченные вложенные.
        const inside = new Set(treeValuesUnder(data, n.value));
        setSelected([...selected.filter((v) => !inside.has(v) || v === n.value), n.value]);
      }
    } else if (!props.multiple) {
      props.onChange(n.value);
      setOpened(false);
    }
  };

  const words = norm(q).split(/\s+/).filter(Boolean);
  const matches = (n: TreeNode, path: TreeNode[]) => {
    const text = norm([...path, n].map((x) => x.label).join(' '));
    return words.every((w) => text.includes(w));
  };
  const hasMatchBelow = (n: TreeNode, path: TreeNode[]): boolean =>
    (n.children ?? []).some((c) => matches(c, [...path, n]) || hasMatchBelow(c, [...path, n]));

  const rows: ReactNode[] = [];
  let firstPick: { n: TreeNode; anc: TreeNode[] } | null = null;
  const render = (list: TreeNode[], ancestors: TreeNode[], all: boolean) => {
    const depth = ancestors.length;
    for (const n of list) {
      const key = [...ancestors.map((a) => a.value), n.value].join('/');
      const self = all || !words.length || matches(n, ancestors);
      const below = words.length > 0 && hasMatchBelow(n, ancestors);
      if (!self && !below) continue;
      const kids = n.children ?? [];
      // При поиске ветка с найденными вложенными раскрыта; совпавшая сама — раскрывается вручную.
      const isOpen = expanded.has(key) || (below && !expanded.has(`-${key}`) && !all);
      const pickable = !(leafOnly && kids.length);
      const covered = multi && ancestors.some((a) => selSet.has(a.value));
      const isSel = selSet.has(n.value) || covered;
      if (pickable && !firstPick && (!words.length || matches(n, ancestors)))
        firstPick = { n, anc: ancestors };
      rows.push(
        <Group
          key={key}
          gap={4}
          wrap="nowrap"
          pl={depth * 22}
          pr={12}
          py={2}
          style={{
            borderRadius: 4,
            background: isSel && !multi ? 'var(--mantine-color-blue-light)' : undefined,
          }}
        >
          {kids.length ? (
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label={isOpen ? t.tree.collapse : t.tree.expand}
              onClick={() => {
                const next = new Set(expanded);
                if (isOpen) {
                  next.delete(key);
                  if (below) next.add(`-${key}`);
                } else {
                  next.add(key);
                  next.delete(`-${key}`);
                }
                setExpanded(next);
              }}
              data-testid={testId ? `${testId}-toggle` : undefined}
            >
              {isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ActionIcon>
          ) : (
            <Box w={22} />
          )}
          {multi && (
            <Checkbox
              size="xs"
              checked={isSel}
              disabled={covered}
              onChange={() => choose(n, ancestors)}
              aria-hidden
              tabIndex={-1}
            />
          )}
          <Text
            size="sm"
            role="option"
            aria-selected={isSel}
            fw={kids.length ? 600 : 400}
            c={pickable ? undefined : 'dimmed'}
            style={{ cursor: 'pointer', flex: 1 }}
            onClick={() => choose(n, ancestors)}
          >
            {n.label}
          </Text>
          {kids.length && !isOpen ? (
            <Text size="xs" c="dimmed" style={{ cursor: 'pointer' }} onClick={() => toggleExp(key)}>
              {kids.length}
            </Text>
          ) : null}
        </Group>,
      );
      if (kids.length && isOpen)
        render(kids, [...ancestors, n], all || (words.length > 0 && matches(n, ancestors)));
    }
  };
  render(data, [], false);

  const shown = committed
    .map(
      (v) =>
        index
          .get(v)
          ?.path.map((x) => x.label)
          .join(' › ') ?? '',
    )
    .filter(Boolean);
  const text = multi
    ? shown.length > 2
      ? t.tree.selected(shown.length)
      : shown.join('; ')
    : (shown[0] ?? '');
  const clearAll = () => (props.multiple ? props.onChange([]) : props.onChange(null));
  const canClear = !!props.clearable && committed.length > 0 && !props.disabled;
  const header = props.multiple ? props.header : undefined;

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={props.target ? 400 : 'target'}
      shadow="md"
      trapFocus
      returnFocus
    >
      <Popover.Target>
        {props.target ? (
          <Box display="inline-block">{props.target(open, opened)}</Box>
        ) : (
          <InputBase
            component="button"
            type="button"
            pointer
            size={size}
            label={props.label}
            description={props.description}
            error={props.error}
            withAsterisk={props.withAsterisk}
            disabled={props.disabled}
            onClick={() => (opened ? setOpened(false) : open())}
            rightSection={
              canClear ? (
                <CloseButton size="sm" aria-label={t.tree.clear} onClick={clearAll} />
              ) : (
                <IconChevronDown size={14} />
              )
            }
            rightSectionPointerEvents={canClear ? 'all' : 'none'}
            data-testid={testId}
            title={text}
            styles={{ input: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}
          >
            {text || <Input.Placeholder>{props.placeholder ?? ''}</Input.Placeholder>}
          </InputBase>
        )}
      </Popover.Target>
      <Popover.Dropdown p="xs" miw={340}>
        <Stack gap={6}>
          {header?.({ value: selected, set: setSelected })}
          <TextInput
            size="xs"
            placeholder={t.tree.search}
            leftSection={<IconSearch size={14} />}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && firstPick) {
                e.preventDefault();
                choose(firstPick.n, firstPick.anc);
              }
            }}
            data-autofocus
            data-testid={testId ? `${testId}-search` : undefined}
          />
          <ScrollArea.Autosize mah={360} type="auto">
            <Stack gap={0} role="listbox" aria-multiselectable={multi}>
              {rows.length ? (
                rows
              ) : (
                <Text size="sm" c="dimmed" p="xs">
                  {t.tree.nothing}
                </Text>
              )}
            </Stack>
          </ScrollArea.Autosize>
          {multi && (applyMode || selected.length > 0) && (
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {selected.length ? t.tree.selected(selected.length) : ''}
              </Text>
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setSelected([])}
                  data-testid={testId ? `${testId}-reset` : undefined}
                >
                  {t.tree.clear}
                </Button>
                {applyMode && (
                  <Button
                    size="compact-xs"
                    onClick={() => setOpened(false)}
                    data-testid={testId ? `${testId}-apply` : undefined}
                  >
                    {t.tree.apply}
                  </Button>
                )}
              </Group>
            </Group>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
