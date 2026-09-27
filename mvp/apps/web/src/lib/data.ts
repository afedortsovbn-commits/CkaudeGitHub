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
    onSuccess: () => {
      void qc.invalidateQueries();
      notifications.show({ color: 'green', message: okText });
    },
    onError: (e) =>
      notifications.show({ color: 'red', title: 'Ошибка', message: errorText(e), autoClose: 8000 }),
  });
}

export const options = (rows: Row[] | undefined, label = 'name') =>
  (rows ?? []).map((r) => ({ value: r.id, label: String(r[label] ?? r.id) }));
