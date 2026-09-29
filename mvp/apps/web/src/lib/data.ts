import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText, get } from './api';

export interface Row {
  id: string;
  isActive?: boolean;
  [k: string]: unknown;
}

export const useList = <T = Row>(path: string, enabled = true) =>
  useQuery({ queryKey: [path], queryFn: () => get<T[]>(path), enabled });

/** Мутация с уведомлением и обновлением всех списков. */
export function useAction<A>(fn: (a: A) => Promise<unknown>, okText = 'Сохранено') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => {
      void qc.invalidateQueries();
      notifications.show({ color: 'green', message: okText });
      warnOpenTickets((res as { openTickets?: TicketRef[] } | undefined)?.openTickets);
    },
    onError: (e) =>
      notifications.show({ color: 'red', title: 'Ошибка', message: errorText(e), autoClose: 8000 }),
  });
}

export const options = (rows: Row[] | undefined, label = 'name') =>
  (rows ?? []).map((r) => ({ value: r.id, label: String(r[label] ?? r.id) }));

export interface TicketRef {
  id: string;
  number: number;
  status: string;
}

/**
 * Предупреждение администратору (M-TKT-12a): у отключённой связки подразделения, темы, предприятия или
 * подразделения есть открытые тикеты — их нужно переадресовать или переназначить.
 */
export function warnOpenTickets(list: TicketRef[] | undefined): void {
  if (!list?.length) return;
  notifications.show({
    color: 'yellow',
    title: `Есть открытые тикеты: ${list.length}`,
    message: `${list
      .slice(0, 20)
      .map((t) => `№${t.number}`)
      .join(
        ', ',
      )}${list.length > 20 ? '…' : ''} — переадресуйте их или назначьте ответственных («Контроль 2-й линии»).`,
    autoClose: false,
  });
}
