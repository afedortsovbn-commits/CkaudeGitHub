import { ActionIcon, Box, Center, Group, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconArrowLeft, IconMaximize } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

const w = t.wallboard;
type Level = 'ok' | 'warn' | 'crit';
interface Bucket {
  at: string;
  received: number;
  usual: number;
  maxWaitS: number;
  lost: number;
  flags: ('spike' | 'slow' | 'lost')[];
}
interface Data {
  level: Level;
  problems: { key: string; level: Level; text: string }[];
  operators: { online: number; free: number; busy: number; wrapUp: number; onBreak: number };
  buckets: Bucket[];
  recentProblemBuckets: number;
  now: {
    talking: number;
    ivr: number;
    queueVoice: number;
    queueText: number;
    oldestWaitS: number;
    chats: number;
  };
  today: { received: number; answered: number; abandoned: number; slPct: number | null; asaS: number | null };
  thresholds: {
    waitWarnS: number;
    waitCritS: number;
    queueWarn: number;
    queueCrit: number;
    slTargetPct: number;
  };
  at: string;
}

/** Тёмная тема экрана: крупные цифры хорошо видны издалека. */
const C = {
  bg: '#0b1220',
  card: '#131c2e',
  border: '#1f2a40',
  text: '#e6edf7',
  dim: '#8a97ad',
  ok: '#2fb36e',
  warn: '#f0a020',
  crit: '#ef4444',
};
const LEVEL_COLOR: Record<Level, string> = { ok: C.ok, warn: C.warn, crit: C.crit };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const hm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Minsk' });

function Tile({
  label,
  value,
  level = 'ok',
  sub,
  testId,
}: {
  label: string;
  value: string | number;
  level?: Level;
  sub?: string;
  testId?: string;
}) {
  return (
    <Box
      data-testid={testId}
      data-level={level}
      style={{
        background: C.card,
        border: `2px solid ${level === 'ok' ? C.border : LEVEL_COLOR[level]}`,
        borderRadius: 16,
        padding: '1.2vh 1.2vw',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <Text style={{ color: C.dim, fontSize: 'clamp(13px, min(1.5vw, 2.6vh), 30px)', lineHeight: 1.1 }}>
        {label}
      </Text>
      {/* Пояснение — справа от цифры (не под ней): плитка не растёт в высоту. */}
      <Box style={{ display: 'flex', alignItems: 'flex-end', gap: '1vw', minWidth: 0 }}>
        <Text
          style={{
            color: level === 'ok' ? C.text : LEVEL_COLOR[level],
            fontSize: 'clamp(28px, min(6vw, 8.5vh), 140px)',
            fontWeight: 800,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
            flex: 'none',
          }}
        >
          {value}
        </Text>
        {sub && (
          <Text
            style={{
              color: C.dim,
              fontSize: 'clamp(11px, min(1.1vw, 2vh), 22px)',
              lineHeight: 1.2,
              paddingBottom: '0.6vh',
            }}
          >
            {sub}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function Section({ title, children, cols }: { title: string; children: React.ReactNode; cols: number }) {
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: '0.8vh', minHeight: 0 }}>
      <Text style={{ color: C.dim, fontSize: 'clamp(14px, 1.3vw, 26px)', fontWeight: 700, letterSpacing: 1 }}>
        {title.toUpperCase()}
      </Text>
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: '1vw',
          flex: 1,
          minHeight: 0,
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

/** Шкала последних 2 часов: столбик — поступило за 10 минут, риска — обычно; цвет — проблемы отрезка. */
function Timeline({ buckets }: { buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.received, b.usual)));
  return (
    <Box
      style={{ display: 'flex', alignItems: 'flex-end', gap: '0.6vw', height: '100%' }}
      data-testid="wb-timeline"
    >
      {buckets.map((b) => {
        const lvl: Level =
          b.flags.length >= 2 || b.flags.includes('lost') ? 'crit' : b.flags.length ? 'warn' : 'ok';
        const tip = [
          `${hm(b.at)} — ${w.received.toLowerCase()} ${b.received}, ${w.usual} ${b.usual}`,
          ...b.flags.map((f) =>
            f === 'spike' ? w.legendSpike : f === 'slow' ? w.legendSlow : `${w.legendLost}: ${b.lost}`,
          ),
        ].join(' · ');
        return (
          <Tooltip key={b.at} label={tip}>
            <Box
              style={{
                flex: 1,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
              }}
            >
              <Box style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                <Box
                  style={{
                    width: '100%',
                    height: `${Math.max(3, (b.received / max) * 100)}%`,
                    background: lvl === 'ok' ? '#2b6cb0' : LEVEL_COLOR[lvl],
                    borderRadius: 6,
                  }}
                />
                {b.usual > 0 && (
                  <Box
                    style={{
                      position: 'absolute',
                      left: '-8%',
                      right: '-8%',
                      bottom: `${(b.usual / max) * 100}%`,
                      borderTop: `3px dashed ${C.dim}`,
                    }}
                  />
                )}
              </Box>
              <Text ta="center" style={{ color: C.dim, fontSize: 'clamp(10px, 0.9vw, 18px)', marginTop: 4 }}>
                {hm(b.at)}
              </Text>
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

/**
 * Экран мониторинга на отдельный монитор: сверху — общее состояние и проблемы, затем «Сейчас», «Операторы»,
 * «Сегодня» и шкала последних 2 часов. Обновление каждые 5 с; потеря связи — красная полоса.
 */
export function WallboardPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useQuery({
    queryKey: ['/supervisor/wallboard'],
    queryFn: () => get<Data>('/supervisor/wallboard'),
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
    retry: false,
    enabled: can('supervisor.monitor'),
  });
  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  if (!can('supervisor.monitor'))
    return (
      <Center h="100vh" bg={C.bg}>
        <Text c={C.text}>{w.noAccess}</Text>
      </Center>
    );
  const d = q.data;
  const stale = !!d && clock.getTime() - Date.parse(d.at) > 30_000;
  const lost = q.isError || stale;
  const th = d?.thresholds;
  const queued = d ? d.now.queueVoice + d.now.queueText : 0;
  const qLevel: Level = !th ? 'ok' : queued >= th.queueCrit ? 'crit' : queued >= th.queueWarn ? 'warn' : 'ok';
  const waitLevel: Level =
    !th || !d
      ? 'ok'
      : d.now.oldestWaitS >= th.waitCritS
        ? 'crit'
        : d.now.oldestWaitS >= th.waitWarnS
          ? 'warn'
          : 'ok';
  const level: Level = lost ? 'crit' : (d?.level ?? 'ok');
  return (
    <Box
      data-testid="wallboard"
      data-level={level}
      style={{
        background: C.bg,
        color: C.text,
        height: '100vh',
        padding: '1.5vh 1.5vw',
        display: 'grid',
        gridTemplateRows: 'auto auto 1fr 1fr 1fr 0.9fr',
        gap: '1.4vh',
        overflow: 'hidden',
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <Tooltip label={w.back}>
            <ActionIcon variant="subtle" color="gray" onClick={() => nav('/supervisor')} aria-label={w.back}>
              <IconArrowLeft size={20} />
            </ActionIcon>
          </Tooltip>
          <Text style={{ fontSize: 'clamp(16px, 1.6vw, 32px)', fontWeight: 700 }}>{w.title}</Text>
        </Group>
        <Group gap="md" wrap="nowrap">
          {d && (
            <Text style={{ color: C.dim, fontSize: 'clamp(12px, 1vw, 20px)' }}>{w.updated(hm(d.at))}</Text>
          )}
          <Text
            style={{
              fontSize: 'clamp(22px, 2.6vw, 56px)',
              fontWeight: 800,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {clock.toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Europe/Minsk',
            })}
          </Text>
          <Tooltip label={w.fullscreen}>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}
              aria-label={w.fullscreen}
            >
              <IconMaximize size={20} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {/* Общее состояние: зелёная полоса — всё в норме; жёлтая/красная — что именно не так. */}
      <Box
        data-testid="wb-status"
        style={{
          background: LEVEL_COLOR[level],
          color: level === 'warn' ? '#1a1300' : '#fff',
          borderRadius: 16,
          padding: '1.2vh 1.5vw',
          display: 'flex',
          alignItems: 'center',
          gap: '2vw',
          flexWrap: 'wrap',
        }}
      >
        <Text style={{ fontSize: 'clamp(24px, 3vw, 64px)', fontWeight: 900 }}>
          {lost ? w.crit : w[level]}
        </Text>
        <Box style={{ flex: 1, minWidth: 0 }}>
          {lost && <Text style={{ fontSize: 'clamp(16px, 1.7vw, 36px)', fontWeight: 700 }}>{w.offline}</Text>}
          {(d?.problems ?? []).slice(0, lost ? 2 : 3).map((p) => (
            <Text
              key={p.key}
              data-testid={`wb-problem-${p.key}`}
              style={{ fontSize: 'clamp(16px, 1.7vw, 36px)', fontWeight: 700, lineHeight: 1.25 }}
            >
              • {p.text}
            </Text>
          ))}
          {!lost && d && !d.problems.length && (
            <Text style={{ fontSize: 'clamp(16px, 1.5vw, 30px)', fontWeight: 600 }}>
              {d.recentProblemBuckets ? w.recent(d.recentProblemBuckets) : w.recentNone}
            </Text>
          )}
        </Box>
      </Box>

      {d && (
        <>
          <Section title={w.now} cols={4}>
            <Tile label={w.queueVoice} value={d.now.queueVoice} level={qLevel} testId="wb-queue-voice" />
            <Tile label={w.queueText} value={d.now.queueText} level={qLevel} testId="wb-queue-text" />
            <Tile
              label={w.longestWait}
              value={queued ? mmss(d.now.oldestWaitS) : w.dash}
              level={waitLevel}
              testId="wb-wait"
            />
            <Tile
              label={w.talking}
              value={d.now.talking}
              sub={`${w.chats}: ${d.now.chats} · ${w.ivr}: ${d.now.ivr}`}
              testId="wb-talking"
            />
          </Section>
          <Section title={w.operators} cols={4}>
            <Tile
              label={w.free}
              value={d.operators.free}
              level={queued > 0 && d.operators.free === 0 ? 'crit' : 'ok'}
              sub={w.online(d.operators.online)}
              testId="wb-free"
            />
            <Tile label={w.busy} value={d.operators.busy} testId="wb-busy" />
            <Tile label={w.onBreak} value={d.operators.onBreak} testId="wb-break" />
            <Tile label={w.wrapUp} value={d.operators.wrapUp} testId="wb-wrapup" />
          </Section>
          <Section title={w.today} cols={5}>
            <Tile label={w.received} value={d.today.received} testId="wb-received" />
            <Tile label={w.answered} value={d.today.answered} testId="wb-answered" />
            <Tile
              label={w.lost}
              value={d.today.abandoned}
              level={d.today.abandoned ? 'warn' : 'ok'}
              testId="wb-lost"
            />
            <Tile
              label={w.sl}
              value={d.today.slPct === null ? w.dash : `${Math.round(d.today.slPct)}%`}
              level={d.today.slPct !== null && d.today.slPct < d.thresholds.slTargetPct ? 'warn' : 'ok'}
              sub={w.slTarget(d.thresholds.slTargetPct)}
              testId="wb-sl"
            />
            <Tile
              label={w.asa}
              value={d.today.asaS === null ? w.dash : `${Math.round(d.today.asaS)} ${w.sec}`}
              testId="wb-asa"
            />
          </Section>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: '0.8vh', minHeight: 0 }}>
            <Group justify="space-between">
              <Text
                style={{
                  color: C.dim,
                  fontSize: 'clamp(14px, 1.3vw, 26px)',
                  fontWeight: 700,
                  letterSpacing: 1,
                }}
              >
                {w.last2h.toUpperCase()}
              </Text>
              <Group gap="lg">
                {[
                  [C.warn, w.legendSpike],
                  [C.warn, w.legendSlow],
                  [C.crit, w.legendLost],
                ].map(([c, l]) => (
                  <Group key={l} gap={6}>
                    <Box w={14} h={14} style={{ background: c, borderRadius: 3 }} />
                    <Text style={{ color: C.dim, fontSize: 'clamp(11px, 1vw, 20px)' }}>{l}</Text>
                  </Group>
                ))}
                <Group gap={6}>
                  <Box w={22} style={{ borderTop: `3px dashed ${C.dim}` }} />
                  <Text style={{ color: C.dim, fontSize: 'clamp(11px, 1vw, 20px)' }}>{w.usual}</Text>
                </Group>
              </Group>
            </Group>
            <Box style={{ flex: 1, minHeight: 0 }}>
              <Timeline buckets={d.buckets} />
            </Box>
          </Box>
        </>
      )}
    </Box>
  );
}
