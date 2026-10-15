import { type RefObject, useEffect } from 'react';

/**
 * Д-078: выбранная карточка списка, частично ушедшая за край прокрутки, плавно прокручивается в видимую область.
 * Ждёт, пока закончится «приподнимание» карточки и перестройка колонок, — иначе размеры ещё старые.
 */
export function useRevealSelected(box: RefObject<HTMLElement | null>, selected: string | null) {
  useEffect(() => {
    if (!selected) return;
    const timer = setTimeout(() => {
      const el = box.current?.querySelector<HTMLElement>('[data-selected]');
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 420);
    return () => clearTimeout(timer);
  }, [box, selected]);
}
