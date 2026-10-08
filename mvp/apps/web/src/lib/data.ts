import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorText, get } from './api';
import { t } from './i18n';

export interface Row {
  id: string;
  isActive?: boolean;
  [k: string]: unknown;
}

export const useList = <T = Row>(path: string, enabled = true) =>
  useQuery({ queryKey: [path], queryFn: () => get<T[]>(path), enabled });

/** Мутация с уведомлением и обновлением всех списков. */
export function useAction<A>(fn: (a: A) => Promise<unknown>, okText = t.saved) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => {
      // Перечитать данные на экране; редко меняющиеся справочники (meta.static) — нет: они обновляются сами по
      // истечении staleTime, иначе каждое сохранение поля карточки заново скачивало бы, например, все станции.
      void qc.invalidateQueries({ predicate: (q) => !q.meta?.static });
      notifications.show({ color: 'green', message: okText });
      warnOpenTickets((res as { openTickets?: TicketRef[] } | undefined)?.openTickets);
    },
    onError: (e) =>
      notifications.show({ color: 'red', title: t.error, message: errorText(e), autoClose: 8000 }),
  });
}

/**
 * Обязательные поля по кнопке (во всех формах): звёздочки — красные (`withAsterisk`), после нажатия пустые
 * поля подсвечиваются красным, а сообщение перечисляет, что заполнить. Кнопка не блокируется молча.
 */
export function useRequired() {
  const [tried, setTried] = useState(false);
  return {
    tried,
    reset: () => setTried(false),
    /** true — всё заполнено; иначе подсветка и сообщение со списком. */
    check(missing: string[]): boolean {
      setTried(true);
      if (!missing.length) return true;
      notifications.show({
        color: 'red',
        title: t.dataLib.fillRequired,
        message: missing.join(', '),
        autoClose: 8000,
      });
      return false;
    },
    error: (bad: boolean) => (tried && bad ? t.dataLib.required : undefined),
  };
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
    title: t.dataLib.estOtkrytyeTikety(list.length),
    message: t.dataLib.pereadresuyteIkhIliNaznachte(
      list
        .slice(0, 20)
        .map((t) => `№${t.number}`)
        .join(', '),
      list.length > 20 ? '…' : '',
    ),
    autoClose: false,
  });
}
