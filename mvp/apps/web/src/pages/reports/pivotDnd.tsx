import {
  createContext,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { Zone } from './pivotModel';

/**
 * Д-041. Перетаскивание полей и показателей между каталогом и зонами конструктора. Указатель (мышь и палец):
 * перенос начинается после сдвига на 4 px (иначе это щелчок); на телефоне каталог тянется только за ручку —
 * прокрутка списка не страдает. Положение чипов в зонах снимается один раз в начале переноса (как в эталоне
 * «Шашлыков»), поэтому полоска места вставки не дёргается; чип-«призрак» едет за указателем.
 */
export interface DragItem {
  kind: 'dim' | 'measure';
  id: string;
  label: string;
  from?: { zone: Zone; index: number };
}
export type DropTarget = Zone | 'catalog';
interface Bar {
  left: number;
  top: number;
  height: number;
}
interface DragState {
  item: DragItem;
  x: number;
  y: number;
  over: DropTarget | null;
  accepted: boolean;
  index: number;
  bar: Bar | null;
}
interface ZoneReg {
  el: HTMLElement;
  accepts(item: DragItem): boolean;
}
interface Ctx {
  state: DragState | null;
  start(e: ReactPointerEvent<HTMLElement>, item: DragItem, onClick?: () => void): void;
  register(target: DropTarget, reg: ZoneReg | null): void;
}
const DndCtx = createContext<Ctx | null>(null);

export function useDnd(): Ctx {
  const c = useContext(DndCtx);
  if (!c) throw new Error('PivotDnd: no provider');
  return c;
}

/** Регистрация зоны приёма: ref-колбэк для контейнера чипов. */
export function useDropZone(target: DropTarget, accepts: (item: DragItem) => boolean) {
  const { register, state } = useDnd();
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  const ref = useCallback(
    (el: HTMLElement | null) => register(target, el ? { el, accepts: (i) => acceptsRef.current(i) } : null),
    [register, target],
  );
  const active = state?.over === target ? state : null;
  return { ref, active, dragging: state };
}

const THRESHOLD = 4;

export function PivotDnd({
  onDrop,
  children,
}: {
  onDrop(item: DragItem, target: DropTarget | null, index: number): void;
  children: ReactNode;
}) {
  const zones = useRef(new Map<DropTarget, ZoneReg>());
  const [state, setState] = useState<DragState | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const register = useCallback((target: DropTarget, reg: ZoneReg | null) => {
    if (reg) zones.current.set(target, reg);
    else zones.current.delete(target);
  }, []);

  const start = useCallback((e: ReactPointerEvent<HTMLElement>, item: DragItem, onClick?: () => void) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // На сенсорном экране тянуть можно только за ручку — иначе это прокрутка.
    if (e.pointerType === 'touch' && !(e.target as HTMLElement).closest('[data-drag-handle]')) return;
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const pointerId = e.pointerId;
    const dragKey = item.from ? `${item.from.zone}:${item.from.index}` : null;
    let begun = false;
    let snap: { target: DropTarget; rect: DOMRect; chips: DOMRect[]; reg: ZoneReg }[] = [];
    let raf = 0;
    let last: DragState | null = null;

    const snapshot = () =>
      [...zones.current.entries()].map(([target, reg]) => ({
        target,
        reg,
        rect: reg.el.getBoundingClientRect(),
        chips: [...reg.el.querySelectorAll<HTMLElement>('[data-pivot-chip]')]
          .filter((c) => c.dataset.pivotChip !== dragKey)
          .map((c) => c.getBoundingClientRect()),
      }));

    const compute = (x: number, y: number): DragState => {
      const z = snap.find(
        (s) => x >= s.rect.left && x <= s.rect.right && y >= s.rect.top && y <= s.rect.bottom,
      );
      if (!z) return { item, x, y, over: null, accepted: false, index: -1, bar: null };
      const accepted = z.reg.accepts(item);
      let index = z.chips.length;
      let bar: Bar | null = null;
      for (let i = 0; i < z.chips.length; i++) {
        const r = z.chips[i]!;
        if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) {
          index = i;
          bar = { left: r.left - 4, top: r.top, height: r.height };
          break;
        }
      }
      if (!bar) {
        const lastChip = z.chips[z.chips.length - 1];
        bar = lastChip
          ? { left: lastChip.right + 3, top: lastChip.top, height: lastChip.height }
          : { left: z.rect.left + 8, top: z.rect.top + 8, height: Math.min(28, z.rect.height - 16) };
      }
      return { item, x, y, over: z.target, accepted, index, bar };
    };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!begun) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
        begun = true;
        snap = snapshot();
        document.body.style.userSelect = 'none';
      }
      ev.preventDefault();
      last = compute(ev.clientX, ev.clientY);
      cancelAnimationFrame(raf);
      const s = last;
      raf = requestAnimationFrame(() => setState(s));
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      cancelAnimationFrame(raf);
      document.body.style.userSelect = '';
      setState(null);
      if (!begun) {
        if (commit) onClick?.();
        return;
      }
      if (commit && last) {
        if (last.over && !last.accepted) return;
        dropRef.current(item, last.over, last.index);
      }
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(true);
    };
    const cancel = () => finish(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish(false);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  }, []);

  const ctx = useMemo(() => ({ state, start, register }), [state, start, register]);
  return (
    <DndCtx.Provider value={ctx}>
      {children}
      {state &&
        createPortal(
          <>
            <div
              className={`pivot-ghost pivot-ghost-${state.item.kind}${state.over && !state.accepted ? ' pivot-ghost-bad' : ''}`}
              style={{ left: state.x + 10, top: state.y + 8 }}
            >
              {state.item.label}
            </div>
            {state.bar && state.accepted && state.over !== 'catalog' && (
              <div
                className="pivot-insert-bar"
                style={{ left: state.bar.left, top: state.bar.top, height: state.bar.height }}
              />
            )}
          </>,
          document.body,
        )}
    </DndCtx.Provider>
  );
}

/** Отключить выделение текста и прокрутку страницы, пока идёт перенос (на телефоне). */
export function useNoScrollWhileDragging(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}
