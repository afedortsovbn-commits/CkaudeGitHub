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

/** Узел справочника: первый уровень (тема, предприятие) и вложенные (подтема, подразделение). */
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

function indexTree(nodes: TreeNode[]): Map<string, Indexed> {
  const m = new Map<string, Indexed>();
  const walk = (list: TreeNode[], path: TreeNode[]) => {
    for (const n of list) {
      const p = [...path, n];
      m.set(n.value, { node: n, path: p, text: norm(p.map((x) => x.label).join(' ')) });
      if (n.children?.length) walk(n.children, p);
    }
  };
  walk(nodes, []);
  return m;
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
  /** Кнопка-значок вместо поля (фильтры списка): содержимое — значок. */
  target?: (open: () => void) => ReactNode;
  testId?: string;
}
type Single = Base & { multiple?: false; value: string | null; onChange(v: string | null): void };
type Multi = Base & { multiple: true; value: string[]; onChange(v: string[]): void };

/**
 * Двухуровневый (и глубже) справочник с поиском: сначала виден первый уровень, любую строку можно развернуть
 * стрелкой и увидеть вложенные; развернуть можно сразу несколько. Поиск — по словам в подписях всех уровней
 * («север клиент» найдёт «Отдел по работе с клиентами» предприятия «Север»), найденное раскрывается само.
 * Множественный выбор: отмеченная строка первого уровня включает все вложенные.
 */
export function TreePicker(props: Single | Multi) {
  const { data, size = 'xs', leafOnly, testId } = props;
  const [opened, setOpened] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const index = useMemo(() => indexTree(data), [data]);
  const selected = props.multiple ? props.value : props.value ? [props.value] : [];
  const selSet = new Set(selected);

  const open = () => {
    if (props.disabled) return;
    // Раскрыть ветки выбранных значений — текущий выбор сразу виден.
    const exp = new Set<string>();
    for (const v of selected) for (const p of index.get(v)?.path.slice(0, -1) ?? []) exp.add(p.value);
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
  /** Отмечен через родителя (множественный выбор): строку отдельно не снять. */
  const coveredByParent = (v: string) =>
    !!props.multiple && (index.get(v)?.path.slice(0, -1) ?? []).some((p) => selSet.has(p.value));

  const choose = (n: TreeNode) => {
    if (leafOnly && n.children?.length) {
      toggleExp(n.value);
      return;
    }
    if (props.multiple) {
      if (coveredByParent(n.value)) return;
      if (selSet.has(n.value)) props.onChange(props.value.filter((v) => v !== n.value));
      else {
        // Отмеченный родитель заменяет отдельно отмеченные вложенные.
        const inside = (v: string) => index.get(v)?.path.some((p) => p.value === n.value) ?? false;
        props.onChange([...props.value.filter((v) => !inside(v)), n.value]);
      }
    } else {
      props.onChange(n.value);
      setOpened(false);
    }
  };

  const words = norm(q).split(/\s+/).filter(Boolean);
  const matches = (n: TreeNode) => {
    const text = index.get(n.value)?.text ?? '';
    return words.every((w) => text.includes(w));
  };
  const hasMatchBelow = (n: TreeNode): boolean =>
    (n.children ?? []).some((c) => matches(c) || hasMatchBelow(c));

  const rows: ReactNode[] = [];
  let firstPick: TreeNode | null = null;
  const render = (list: TreeNode[], depth: number, all: boolean) => {
    for (const n of list) {
      const self = all || !words.length || matches(n);
      const below = words.length > 0 && hasMatchBelow(n);
      if (!self && !below) continue;
      const kids = n.children ?? [];
      // При поиске ветка с найденными вложенными раскрыта; совпавшая сама — раскрывается вручную.
      const isOpen = expanded.has(n.value) || (below && !expanded.has(`-${n.value}`) && !all);
      const pickable = !(leafOnly && kids.length);
      const isSel = selSet.has(n.value) || coveredByParent(n.value);
      if (pickable && !firstPick && (!words.length || matches(n))) firstPick = n;
      rows.push(
        <Group
          key={n.value}
          gap={4}
          wrap="nowrap"
          pl={depth * 22}
          pr={12}
          py={2}
          style={{
            borderRadius: 4,
            background: isSel && !props.multiple ? 'var(--mantine-color-blue-light)' : undefined,
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
                  next.delete(n.value);
                  if (below) next.add(`-${n.value}`);
                } else {
                  next.add(n.value);
                  next.delete(`-${n.value}`);
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
          {props.multiple && (
            <Checkbox
              size="xs"
              checked={isSel}
              disabled={coveredByParent(n.value)}
              onChange={() => choose(n)}
              aria-hidden
              tabIndex={-1}
            />
          )}
          <Text
            size="sm"
            role="option"
            aria-selected={isSel}
            fw={depth === 0 ? 600 : 400}
            c={pickable ? undefined : 'dimmed'}
            style={{ cursor: 'pointer', flex: 1 }}
            onClick={() => choose(n)}
          >
            {n.label}
          </Text>
          {kids.length && !isOpen ? (
            <Text size="xs" c="dimmed" style={{ cursor: 'pointer' }} onClick={() => toggleExp(n.value)}>
              {kids.length}
            </Text>
          ) : null}
        </Group>,
      );
      if (kids.length && isOpen) render(kids, depth + 1, all || (words.length > 0 && matches(n)));
    }
  };
  render(data, 0, false);

  const shown = selected
    .map(
      (v) =>
        index
          .get(v)
          ?.path.map((x) => x.label)
          .join(' › ') ?? '',
    )
    .filter(Boolean);
  const text = props.multiple
    ? shown.length > 2
      ? t.tree.selected(shown.length)
      : shown.join('; ')
    : (shown[0] ?? '');
  const clear = () => (props.multiple ? props.onChange([]) : props.onChange(null));
  const canClear = !!props.clearable && selected.length > 0 && !props.disabled;

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={props.target ? 380 : 'target'}
      shadow="md"
      trapFocus
      returnFocus
    >
      <Popover.Target>
        {props.target ? (
          <Box display="inline-block">{props.target(open)}</Box>
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
                <CloseButton size="sm" aria-label={t.tree.clear} onClick={clear} />
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
          <TextInput
            size="xs"
            placeholder={t.tree.search}
            leftSection={<IconSearch size={14} />}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && firstPick) {
                e.preventDefault();
                choose(firstPick);
              }
            }}
            data-autofocus
            data-testid={testId ? `${testId}-search` : undefined}
          />
          <ScrollArea.Autosize mah={360} type="auto">
            <Stack gap={0} role="listbox" aria-multiselectable={!!props.multiple}>
              {rows.length ? (
                rows
              ) : (
                <Text size="sm" c="dimmed" p="xs">
                  {t.tree.nothing}
                </Text>
              )}
            </Stack>
          </ScrollArea.Autosize>
          {props.multiple && selected.length > 0 && (
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {t.tree.selected(selected.length)}
              </Text>
              <Button size="compact-xs" variant="subtle" onClick={clear}>
                {t.tree.clear}
              </Button>
            </Group>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
