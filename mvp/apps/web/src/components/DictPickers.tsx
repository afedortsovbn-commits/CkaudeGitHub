import { type ReactNode, useMemo } from 'react';
import { type Row, useList } from '../lib/data';
import { t } from '../lib/i18n';
import { type TreeNode, TreePicker } from './TreePicker';

/** Порядок справочника: «Порядок», затем название. */
const byOrder = (a: Row, b: Row) =>
  Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) || String(a.name).localeCompare(String(b.name), 'ru');

/** Дерево тем: тема → подтемы (и глубже). Особо важные помечены «❗». */
export function useTopicTree(): TreeNode[] {
  const topics = useList('/topics');
  return useMemo(() => {
    const list = [...(topics.data ?? [])].sort(byOrder);
    const kids = new Map<string | null, Row[]>();
    for (const r of list) {
      const p = (r.parentId as string | null) ?? null;
      kids.set(p, [...(kids.get(p) ?? []), r]);
    }
    const build = (parent: string | null): TreeNode[] =>
      (kids.get(parent) ?? []).map((r) => ({
        value: String(r.id),
        label: `${String(r.name)}${r.isImportant ? ' ❗' : ''}`,
        children: build(String(r.id)),
      }));
    return build(null);
  }, [topics.data]);
}

/** Значение «предприятие/подразделение» в дереве: «e» — предприятие, «e/d» — подразделение на предприятии. */
export const orgValue = (e?: unknown, d?: unknown): string | null =>
  e ? (d ? `${String(e)}/${String(d)}` : String(e)) : null;
export const parseOrg = (v: string | null): { enterpriseId: string | null; departmentId: string | null } => {
  if (!v) return { enterpriseId: null, departmentId: null };
  const [e, d] = v.split('/');
  return { enterpriseId: e ?? null, departmentId: d ?? null };
};

/** Дерево предприятий: предприятие → его подразделения (только связки «подразделение на предприятии»). */
export function useOrgTree(): TreeNode[] {
  const enterprises = useList('/dict/enterprises');
  const links = useList('/enterprise-departments');
  return useMemo(() => {
    const deps = new Map<string, TreeNode[]>();
    for (const l of links.data ?? []) {
      const e = String(l.enterpriseId);
      deps.set(e, [
        ...(deps.get(e) ?? []),
        { value: `${e}/${String(l.departmentId)}`, label: String(l.departmentName) },
      ]);
    }
    return [...(enterprises.data ?? [])]
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'))
      .map((e) => ({
        value: String(e.id),
        label: String(e.name),
        children: (deps.get(String(e.id)) ?? []).sort((a, b) => a.label.localeCompare(b.label, 'ru')),
      }));
  }, [enterprises.data, links.data]);
}

type Common = {
  label?: string;
  description?: string;
  placeholder?: string;
  error?: ReactNode;
  withAsterisk?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  size?: 'xs' | 'sm' | 'md';
  testId?: string;
};

/** Выбор темы или подтемы (один). */
export function TopicPicker({
  value,
  onChange,
  ...rest
}: Common & { value: string | null; onChange(v: string | null): void }) {
  const data = useTopicTree();
  return <TreePicker data={data} value={value} onChange={onChange} label={t.tree.topic} {...rest} />;
}

/**
 * Предприятие и подразделение одним полем: подразделение выбирается только внутри предприятия.
 * `requireDepartment` — само предприятие не выбирается (передача на 2-ю линию).
 */
export function OrgPicker({
  enterpriseId,
  departmentId,
  onChange,
  requireDepartment,
  ...rest
}: Common & {
  enterpriseId: string | null;
  departmentId: string | null;
  onChange(enterpriseId: string | null, departmentId: string | null): void;
  requireDepartment?: boolean;
}) {
  const data = useOrgTree();
  return (
    <TreePicker
      data={data}
      value={orgValue(enterpriseId, departmentId)}
      onChange={(v) => {
        const p = parseOrg(v);
        onChange(p.enterpriseId, p.departmentId);
      }}
      leafOnly={requireDepartment}
      label={t.tree.org}
      description={requireDepartment ? t.tree.orgHint : undefined}
      {...rest}
    />
  );
}
