import type { Row } from './data';
import { t } from './i18n';

/**
 * Операторы для переадресации (Д-034): по группам «свободны / заняты / нет на линии», в подписи — статус и число
 * обращений в работе; кого нет на линии — в конце (выбрать можно: обращение ляжет ему в очередь).
 */
export function operatorGroups(list: Row[] | undefined, prefix = '', exclude?: string | null) {
  const free: { value: string; label: string }[] = [];
  const busy: { value: string; label: string }[] = [];
  const off: { value: string; label: string }[] = [];
  const s = t.workspace.opStatus;
  for (const o of list ?? []) {
    if (exclude && o.id === exclude) continue;
    const st = String(o.status ?? 'offline');
    const n = Number(o.activeNow ?? 0);
    const label = (x: string) => `${String(o.fullName)} — ${x}`;
    const item = (x: string) => ({ value: `${prefix}${String(o.id)}`, label: label(x) });
    if (st === 'offline') off.push(item(s.off));
    else if (st === 'break') off.push(item(s.break));
    else if (o.onCall) busy.push(item(s.call));
    else if (st === 'wrap_up') busy.push(item(s.wrap));
    else if (n > 0) busy.push(item(s.busy(n)));
    else free.push(item(s.free));
  }
  return [
    { group: t.workspace.opGroupFree, items: free },
    { group: t.workspace.opGroupBusy, items: busy },
    { group: t.workspace.opGroupOff, items: off },
  ].filter((g) => g.items.length);
}
