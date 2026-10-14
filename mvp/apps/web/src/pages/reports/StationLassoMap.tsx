import 'leaflet/dist/leaflet.css';
import {
  Button,
  Checkbox,
  Chip,
  Group,
  Modal,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconHandMove, IconLasso } from '@tabler/icons-react';
import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Station, useStations } from '../../components/AzsMap';
import { t } from '../../lib/i18n';

const canon = (s: string) =>
  s
    .toLowerCase()
    .replace(new RegExp(String.fromCharCode(0x451), 'g'), String.fromCharCode(0x435))
    .replace(/\s+/g, ' ');

/** Точка внутри многоугольника (луч вправо; для области на карте страны широты/долготы — как плоскость). */
function inside(lat: number, lon: number, poly: L.LatLng[]): boolean {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.lat > lat !== b.lat > lat && lon < ((b.lng - a.lng) * (lat - a.lat)) / (b.lat - a.lat) + a.lng)
      ins = !ins;
  }
  return ins;
}

export const stationLabel = (s: Station) => `${s.title}${s.address ? `, ${s.address}` : ''}`;

/**
 * Д-041. Выбор АЗС/ЭЗС для фильтра отчёта: обвести область на карте (каждое обведение добавляет станции к
 * выбору), щелчок по значку — выбрать или снять, слева — список с поиском и галочками.
 */
export function StationLassoMap({
  opened,
  value,
  onClose,
  onApply,
}: {
  opened: boolean;
  value: string[];
  onClose(): void;
  onApply(ids: string[], labels: string[]): void;
}) {
  const { stations } = useStations(opened);
  const [sel, setSel] = useState<Set<string>>(new Set(value));
  const [kinds, setKinds] = useState<string[]>(['azs', 'ezs']);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'lasso' | 'pan'>('lasso');
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [ready, setReady] = useState(0);
  const selRef = useRef(sel);
  selRef.current = sel;

  useEffect(() => {
    if (opened) setSel(new Set(value));
  }, [opened, value]);

  const sorted = useMemo(
    () =>
      [...stations].sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          (Number(a.num) || 1e9) - (Number(b.num) || 1e9) ||
          a.title.localeCompare(b.title, 'ru', { numeric: true }),
      ),
    [stations],
  );
  const shown = useMemo(() => {
    const words = canon(q).split(' ').filter(Boolean);
    return sorted.filter((s) => {
      if (!kinds.includes(s.kind)) return false;
      if (!words.length) return true;
      const hay = canon(`${s.num} ${s.title} ${s.address} ${s.enterprise}`);
      return words.every((w) => (/^\d+$/.test(w) ? s.num === w || hay.includes(w) : hay.includes(w)));
    });
  }, [sorted, kinds, q]);
  const onMap = useMemo(() => shown.filter((s) => s.lat !== null && s.lon !== null), [shown]);
  const shownRef = useRef(onMap);
  shownRef.current = onMap;

  useEffect(() => {
    if (!opened) return;
    let m: L.Map | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        if (!box.current) return;
        m = L.map(box.current, { preferCanvas: true }).setView([53.7, 27.95], 7);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution: t.azsMap.attribution,
        }).addTo(m);
        layer.current = L.layerGroup().addTo(m);
        map.current = m;
        setReady((r) => r + 1);
        timers.push(setTimeout(() => m?.invalidateSize(), 300));
      }, 50),
    );
    return () => {
      timers.forEach(clearTimeout);
      m?.remove();
      map.current = null;
      layer.current = null;
    };
  }, [opened]);

  // Значки станций: выбранные — красные.
  useEffect(() => {
    const lg = layer.current;
    if (!lg) return;
    lg.clearLayers();
    for (const s of onMap) {
      const id = String(s.obj.id);
      const on = sel.has(id);
      L.circleMarker([s.lat!, s.lon!], {
        radius: on ? 7 : 5,
        color: on ? '#c92a2a' : s.kind === 'ezs' ? '#2b8a3e' : '#1864ab',
        fillColor: on ? '#fa5252' : s.kind === 'ezs' ? '#51cf66' : '#339af0',
        weight: on ? 2 : 1,
        fillOpacity: 0.85,
      })
        .bindTooltip(stationLabel(s), { direction: 'top', offset: [0, -4] })
        .on('click', () =>
          setSel((x) => {
            const n = new Set(x);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
          }),
        )
        .addTo(lg);
    }
  }, [onMap, sel, ready]);

  // Обведение: пока режим «обвести», карта не двигается, указатель рисует контур.
  useEffect(() => {
    const m = map.current;
    const el = box.current;
    if (!m || !el) return;
    if (mode === 'pan') {
      m.dragging.enable();
      return;
    }
    m.dragging.disable();
    let pts: L.LatLng[] = [];
    let line: L.Polyline | null = null;
    let drawing = false;
    const at = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return m.containerPointToLatLng(L.point(e.clientX - r.left, e.clientY - r.top));
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if ((e.target as HTMLElement).closest('.leaflet-control')) return;
      e.preventDefault();
      e.stopPropagation();
      drawing = true;
      pts = [at(e)];
      line = L.polyline(pts, { color: '#c92a2a', weight: 2, dashArray: '6 4' }).addTo(m);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* старые браузеры */
      }
    };
    const move = (e: PointerEvent) => {
      if (!drawing) return;
      e.preventDefault();
      pts.push(at(e));
      line?.setLatLngs(pts);
    };
    const up = () => {
      if (!drawing) return;
      drawing = false;
      const poly = pts;
      if (line) {
        const l = line;
        l.setLatLngs([...poly, poly[0]!]);
        setTimeout(() => l.remove(), 500);
      }
      if (poly.length < 3) return;
      const hit = shownRef.current.filter((s) => inside(s.lat!, s.lon!, poly)).map((s) => String(s.obj.id));
      if (hit.length) setSel((x) => new Set([...x, ...hit]));
    };
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', move, true);
    el.addEventListener('pointerup', up, true);
    el.addEventListener('pointercancel', up, true);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('pointermove', move, true);
      el.removeEventListener('pointerup', up, true);
      el.removeEventListener('pointercancel', up, true);
      m.dragging.enable();
    };
  }, [mode, ready]);

  const byId = useMemo(() => new Map(stations.map((s) => [String(s.obj.id), s])), [stations]);
  const toggle = (id: string) =>
    setSel((x) => {
      const n = new Set(x);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const noCoords = shown.length - onMap.length;
  const listed = shown.slice(0, 500);

  return (
    <Modal opened={opened} onClose={onClose} title={t.pivot.mapTitle} size="90%" data-testid="pivot-map">
      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="sm">
        <Stack gap={6}>
          <TextInput
            size="xs"
            placeholder={t.pivot.mapSearch}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            data-testid="pivot-map-search"
          />
          <Group gap={6}>
            <Chip.Group multiple value={kinds} onChange={setKinds}>
              <Chip size="xs" value="azs">
                {t.pivot.mapAzs}
              </Chip>
              <Chip size="xs" value="ezs">
                {t.pivot.mapEzs}
              </Chip>
            </Chip.Group>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setSel((x) => new Set([...x, ...shown.map((s) => String(s.obj.id))]))}
            >
              {t.pivot.selectFound}
            </Button>
          </Group>
          <ScrollArea className="pivot-map-list" type="auto">
            <Stack gap={2}>
              {listed.map((s) => (
                <Checkbox
                  key={String(s.obj.id)}
                  size="xs"
                  checked={sel.has(String(s.obj.id))}
                  onChange={() => toggle(String(s.obj.id))}
                  label={stationLabel(s)}
                />
              ))}
            </Stack>
          </ScrollArea>
          {noCoords > 0 && (
            <Text size="xs" c="dimmed">
              {t.pivot.mapNoCoords(noCoords)}
            </Text>
          )}
        </Stack>
        <Stack gap={6} style={{ gridColumn: 'span 2' }}>
          <Group justify="space-between">
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={(v) => setMode(v as 'lasso' | 'pan')}
              data={[
                {
                  value: 'lasso',
                  label: (
                    <Group gap={4} wrap="nowrap">
                      <IconLasso size={14} />
                      {t.pivot.mapLasso}
                    </Group>
                  ),
                },
                {
                  value: 'pan',
                  label: (
                    <Group gap={4} wrap="nowrap">
                      <IconHandMove size={14} />
                      {t.pivot.mapPan}
                    </Group>
                  ),
                },
              ]}
              data-testid="pivot-map-mode"
            />
            <Text size="xs" c="dimmed">
              {mode === 'lasso' ? t.pivot.mapLassoHint : ''}
            </Text>
          </Group>
          <div
            ref={box}
            className={`pivot-map${mode === 'lasso' ? ' pivot-map-lasso' : ''}`}
            style={{ touchAction: mode === 'lasso' ? 'none' : undefined }}
            data-testid="pivot-map-canvas"
          />
        </Stack>
      </SimpleGrid>
      <Group justify="space-between" mt="sm">
        <Text size="sm" fw={600} data-testid="pivot-map-count">
          {t.pivot.mapSelected(sel.size)}
        </Text>
        <Group gap="xs">
          <Button variant="default" onClick={() => setSel(new Set())}>
            {t.pivot.mapClear}
          </Button>
          <Button
            onClick={() => {
              const ids = [...sel];
              onApply(
                ids,
                ids.map((id) => {
                  const s = byId.get(id);
                  return s ? stationLabel(s) : id;
                }),
              );
            }}
            data-testid="pivot-map-apply"
          >
            {t.pivot.mapApply}
          </Button>
        </Group>
      </Group>
    </Modal>
  );
}
