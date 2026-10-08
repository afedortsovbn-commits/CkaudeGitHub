import { useSyncExternalStore } from 'react';

/**
 * Режим обработки обращения: оператор взял обращение в работу — список обращений скрыт, меню свёрнуто до значков,
 * всё место — текущему обращению. Включает рабочее место, учитывает шапка с меню (Layout).
 */
let focus = false;
const subs = new Set<() => void>();

export function setFocusMode(v: boolean): void {
  if (focus === v) return;
  focus = v;
  subs.forEach((f) => f());
}

export function useFocusMode(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => focus,
  );
}
