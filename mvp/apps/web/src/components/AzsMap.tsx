import 'leaflet/dist/leaflet.css';
import { Anchor, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Row, useList } from '../lib/data';
import { t } from '../lib/i18n';

/** Официальные карты — для сверки (выбор в карточке — по нашей карте, там щелчок сразу выбирает станцию). */
export const SITE_MAP: Record<StationKind, string> = {
  azs: 'https://azs.belorusneft.by/web-azs/ru/azs-map?country=BY',
  ezs: 'https://malankabn.by/',
};

/** Вид объекта: АЗС или электрозарядная станция (ЭЗС, сеть «Маланка»). */
export type StationKind = 'azs' | 'ezs';

export interface Station {
  obj: Row;
  kind: StationKind;
  /** Номер АЗС (у ЭЗС номера нет). */
  num: string;
  /** Как показывать оператору: «АЗС №12» или название ЭЗС. */
  title: string;
  address: string;
  enterprise: string;
  lat: number | null;
  lon: number | null;
}

const canon = (s: string) =>
  s
    .toLowerCase()
    .replace(new RegExp(String.fromCharCode(0x451), 'g'), String.fromCharCode(0x435))
    .replace(/\s+/g, ' ');

/** Номер АЗС объекта: из данных справочника (azsnum), иначе — цифры из названия. */
export const stationNum = (o: Row): string => {
  const ext = (o.externalIds as Record<string, string> | undefined) ?? {};
  return String(ext.azsnum ?? /\d+/.exec(String(o.name))?.[0] ?? '');
};

/** Станции справочника объектов (АЗС и ЭЗС) с номером, адресом, предприятием-владельцем и координатами. */
export function useStations(enabled = true): { stations: Station[]; loading: boolean } {
  const objects = useList('/dict/objects?limit=2000', enabled);
  const enterprises = useList('/dict/enterprises', enabled);
  const stations = useMemo(() => {
    const ent = new Map((enterprises.data ?? []).map((e) => [String(e.id), String(e.name)]));
    return (objects.data ?? []).map((o) => {
      const ext = (o.externalIds as Record<string, string> | undefined) ?? {};
      const lat = Number(ext.lat);
      const lon = Number(ext.lon);
      const kind: StationKind = o.kind === 'ezs' ? 'ezs' : 'azs';
      const num = kind === 'azs' ? stationNum(o) : '';
      return {
        obj: o,
        kind,
        num,
        title: kind === 'azs' ? t.azsMap.station(num) : String(o.name),
        address: String(o.address ?? ''),
        enterprise: ent.get(String(o.enterpriseId)) ?? '',
        lat: ext.lat && Number.isFinite(lat) ? lat : null,
        lon: ext.lon && Number.isFinite(lon) ? lon : null,
      };
    });
  }, [objects.data, enterprises.data]);
  return { stations, loading: objects.isLoading };
}

/** Подпись значка: номер, адрес, предприятие — текстом (без HTML из справочника). */
function tip(s: Station, current: boolean): HTMLElement {
  const div = document.createElement('div');
  for (const [text, bold] of [
    [s.title, true],
    [s.address, false],
    [s.enterprise, false],
    ...(current ? [[t.azsMap.current, false] as const] : []),
  ] as const) {
    if (!text) continue;
    const line = document.createElement('div');
    line.textContent = String(text);
    if (bold) line.style.fontWeight = '700';
    div.appendChild(line);
  }
  return div;
}

/** Выбор АЗС на карте: щелчок по значку сразу выбирает АЗС и закрывает окно. */
export function AzsMapModal({
  opened,
  onClose,
  onPick,
  currentId,
  kind,
}: {
  opened: boolean;
  onClose(): void;
  onPick(s: Station): void;
  currentId: string | null;
  kind: StationKind;
}) {
  const { stations: all, loading } = useStations(opened);
  const stations = useMemo(() => all.filter((s) => s.kind === kind), [all, kind]);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [ready, setReady] = useState(0);
  const pick = useRef(onPick);
  pick.current = onPick;
  const onMap = useMemo(() => stations.filter((s) => s.lat !== null && s.lon !== null), [stations]);
  const shown = useMemo(() => {
    const words = canon(q).split(' ').filter(Boolean);
    if (!words.length) return onMap;
    return onMap.filter((s) => {
      const hay = canon(`${s.num} ${s.kind === 'ezs' ? s.title : ''} ${s.address} ${s.enterprise}`);
      return words.every((w) => (/^\d+$/.test(w) ? s.num === w || hay.includes(w) : hay.includes(w)));
    });
  }, [onMap, q]);

  // Карта создаётся, когда окно открыто и контейнер уже на странице; удаляется при закрытии.
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
        // Окно открывается с анимацией — пересчитать размер, когда она закончится.
        timers.push(setTimeout(() => m?.invalidateSize(), 300));
      }, 50),
    );
    return () => {
      timers.forEach(clearTimeout);
      m?.remove();
      map.current = null;
      layer.current = null;
      setQ('');
    };
  }, [opened]);

  useEffect(() => {
    const m = map.current;
    const lg = layer.current;
    if (!m || !lg) return;
    lg.clearLayers();
    let cur: Station | undefined;
    for (const s of shown) {
      const isCur = String(s.obj.id) === currentId;
      if (isCur) cur = s;
      L.circleMarker([s.lat!, s.lon!], {
        radius: isCur ? 10 : 7,
        color: isCur ? '#c92a2a' : kind === 'ezs' ? '#2b8a3e' : '#1864ab',
        fillColor: isCur ? '#fa5252' : kind === 'ezs' ? '#51cf66' : '#339af0',
        weight: 2,
        fillOpacity: 0.85,
      })
        .bindTooltip(tip(s, isCur), { direction: 'top', offset: [0, -6] })
        .on('click', () => pick.current(s))
        .addTo(lg);
    }
    if (q && shown.length)
      m.fitBounds(L.latLngBounds(shown.map((s) => [s.lat!, s.lon!] as [number, number])), {
        maxZoom: 14,
        padding: [30, 30],
      });
    else if (!q && cur) m.setView([cur.lat!, cur.lon!], 13);
  }, [shown, ready, currentId, q, kind]);

  return (
    <Modal opened={opened} onClose={onClose} title={t.azsMap.title[kind]} size="80%" data-testid="azs-map">
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            size="xs"
            placeholder={t.azsMap.search[kind]}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            data-testid="azs-map-search"
            data-autofocus
          />
          <Text size="xs" c="dimmed">
            {t.azsMap.found(shown.length)}
          </Text>
          <Anchor size="xs" href={SITE_MAP[kind]} target="_blank" rel="noreferrer">
            {t.azsMap.site[kind]}
          </Anchor>
        </Group>
        {/* Немного совпадений — их можно выбрать и списком. */}
        {q && shown.length > 0 && shown.length <= 6 && (
          <Group gap={4}>
            {shown.map((s) => (
              <Button
                key={String(s.obj.id)}
                size="compact-xs"
                variant="light"
                onClick={() => onPick(s)}
                data-testid="azs-map-result"
              >
                {s.title}
                {s.address ? `, ${s.address}` : ''}
              </Button>
            ))}
          </Group>
        )}
        {!onMap.length && !loading && (
          <Text size="sm" c="dimmed">
            {t.azsMap.empty[kind]}
          </Text>
        )}
        <div ref={box} style={{ height: '65vh', borderRadius: 8, overflow: 'hidden' }} />
      </Stack>
    </Modal>
  );
}
