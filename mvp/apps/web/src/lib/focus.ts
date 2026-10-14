import { useEffect, useSyncExternalStore } from 'react';

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

/**
 * Страницы, которым нужно всё место (1-я линия, обучение, конструктор отчётов): пока страница открыта, меню свёрнуто
 * до значков так же, как в режиме обработки (кнопка в меню временно раскрывает его; выбор сотрудника не меняется).
 */
let pages = 0;
const pageSubs = new Set<() => void>();

export function useCompactMenu(on = true): void {
  useEffect(() => {
    if (!on) return;
    pages += 1;
    pageSubs.forEach((f) => f());
    return () => {
      pages -= 1;
      pageSubs.forEach((f) => f());
    };
  }, [on]);
}

export function usePageCompact(): boolean {
  return useSyncExternalStore(
    (f) => {
      pageSubs.add(f);
      return () => void pageSubs.delete(f);
    },
    () => pages > 0,
  );
}
