import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useRef } from 'react';

const GAP_PX = 6;

export interface HandleProps {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  style: CSSProperties;
  'data-drag-handle': true;
}

/**
 * Список с перетаскиванием за ручку (порядок пунктов меню и вкладок в интерфейсе роли). Перенос логики
 * attachBuyerHandleDrag из «Шашлыков» (эталон владельца): перетаскивается только за маленькую ручку
 * (touch-action: none — прокрутка списка на телефоне не страдает); соседи и их середины снимаются один раз
 * при нажатии; пока палец движется, соседи плавно сдвигаются, освобождая место; новый порядок применяется
 * сразу при отпускании (родитель сохраняет его вместе с ролью).
 */
export function SortableList<T>({
  items,
  keyOf,
  onReorder,
  renderRow,
  testId,
}: {
  items: T[];
  keyOf(item: T): string;
  onReorder(next: T[]): void;
  renderRow(item: T, handle: HandleProps, index: number): ReactNode;
  testId?: string;
}) {
  const rowsRef = useRef(new Map<string, HTMLDivElement>());

  const start = (e: ReactPointerEvent<HTMLElement>, key: string) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const row = rowsRef.current.get(key);
    if (!row) return;
    const order = items.map(keyOf);
    const originIndex = order.indexOf(key);
    // Снимок соседей — один раз: DOM-порядок до отпускания не меняется.
    const siblings = order.filter((k) => k !== key).map((k) => rowsRef.current.get(k)!);
    const mids = siblings.map((s) => {
      const r = s.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const rect = row.getBoundingClientRect();
    const shiftAmount = rect.height + GAP_PX;
    const startY = e.clientY;
    let dropIndex = originIndex;
    const handle = e.currentTarget;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* старые браузеры */
    }
    row.dataset.dragging = '1';
    row.style.zIndex = '2';
    row.style.position = 'relative';
    siblings.forEach((s) => (s.style.transition = 'transform 0.15s ease'));
    if (navigator.vibrate) navigator.vibrate(12);

    const dropAt = (y: number) => {
      // Позиция вставки — по середине самой карточки, а не по пальцу: пересечение «на половину карточки».
      const center = rect.top + rect.height / 2 + (y - startY);
      let idx = mids.length;
      for (let i = 0; i < mids.length; i++) {
        if (center < mids[i]!) {
          idx = i;
          break;
        }
      }
      return idx;
    };
    const onMove = (ev: PointerEvent) => {
      ev.preventDefault();
      row.style.transform = `translateY(${ev.clientY - startY}px)`;
      dropIndex = dropAt(ev.clientY);
      siblings.forEach((s, i) => {
        let shift = 0;
        if (dropIndex <= i && i < originIndex) shift = shiftAmount;
        else if (originIndex <= i && i < dropIndex) shift = -shiftAmount;
        s.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const end = (commit: boolean) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      siblings.forEach((s) => {
        s.style.transform = '';
        s.style.transition = '';
      });
      row.style.transform = '';
      row.style.zIndex = '';
      row.style.position = '';
      delete row.dataset.dragging;
      if (commit && dropIndex !== originIndex) {
        const rest = items.filter((x) => keyOf(x) !== key);
        rest.splice(dropIndex, 0, items[originIndex]!);
        onReorder(rest);
      }
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  return (
    <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', gap: GAP_PX }}>
      {items.map((item, i) => {
        const key = keyOf(item);
        return (
          <div
            key={key}
            ref={(el) => {
              if (el) rowsRef.current.set(key, el);
              else rowsRef.current.delete(key);
            }}
            data-sort-key={key}
          >
            {renderRow(
              item,
              {
                onPointerDown: (e) => start(e, key),
                style: { touchAction: 'none', cursor: 'grab' },
                'data-drag-handle': true,
              },
              i,
            )}
          </div>
        );
      })}
    </div>
  );
}
