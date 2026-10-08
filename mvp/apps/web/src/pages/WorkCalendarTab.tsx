import {
  ActionIcon,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconChevronLeft, IconChevronRight, IconRotate } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { api, get, put } from '../lib/api';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

const s = t.schedule;
type Kind = 'work' | 'short' | 'off' | 'holiday';

export interface CalendarDay {
  date: string;
  weekday: number;
  kind: Kind;
  defaultKind: Kind;
  holiday: string | null;
  note: string | null;
  overridden: boolean;
  hours: number;
}
interface Totals {
  workDays: number;
  hours: number;
  offDays: number;
}
interface YearData {
  year: number;
  days: CalendarDay[];
  months: (Totals & { month: string })[];
  total: Totals;
}

/** Вид дня: цвет ячейки и подпись. */
export const KIND_STYLE: Record<Kind, { bg: string; fg: string; color: string }> = {
  work: { bg: 'var(--mantine-color-body)', fg: 'var(--mantine-color-text)', color: 'blue' },
  short: { bg: 'var(--mantine-color-yellow-1)', fg: 'var(--mantine-color-yellow-9)', color: 'yellow' },
  off: { bg: 'var(--mantine-color-gray-2)', fg: 'var(--mantine-color-gray-7)', color: 'gray' },
  holiday: { bg: 'var(--mantine-color-red-1)', fg: 'var(--mantine-color-red-8)', color: 'red' },
};
const KINDS: Kind[] = ['work', 'short', 'off', 'holiday'];
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

/** Подпись дня для подсказки: дата, вид, праздник, комментарий. */
export function dayTitle(d: CalendarDay): string {
  return [
    new Date(`${d.date}T12:00:00Z`).toLocaleDateString('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }),
    s.cal.kind[d.kind],
    d.holiday,
    d.note,
    d.overridden ? s.cal.changed : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Производственный календарь: 12 месяцев года, цвет дня — его вид. Щелчок по дню — окно с крупными кнопками
 * «Рабочий / Сокращённый / Выходной / Праздник»; изменения сразу учитываются в норме часов и графике работы.
 */
export function WorkCalendarTab({ initialYear }: { initialYear: number }) {
  const [year, setYear] = useState(initialYear);
  const q = useQuery({
    queryKey: ['/schedule/calendar', year],
    queryFn: () => get<YearData>(`/schedule/calendar?year=${year}`),
  });
  const [edit, setEdit] = useState<CalendarDay | null>(null);
  const d = q.data;
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-start">
        <Group gap="xs">
          <ActionIcon variant="subtle" onClick={() => setYear(year - 1)} aria-label={s.cal.prevYear}>
            <IconChevronLeft size={18} />
          </ActionIcon>
          <Text fw={700} size="lg" w={60} ta="center" data-testid="calendar-year">
            {year}
          </Text>
          <ActionIcon variant="subtle" onClick={() => setYear(year + 1)} aria-label={s.cal.nextYear}>
            <IconChevronRight size={18} />
          </ActionIcon>
          {d && (
            <Text size="sm" c="dimmed" ml="sm" data-testid="calendar-total">
              {s.cal.yearTotal(d.total.workDays, d.total.hours)}
            </Text>
          )}
        </Group>
        <Group gap="md">
          {KINDS.map((k) => (
            <Group key={k} gap={6}>
              <Box
                w={16}
                h={16}
                style={{
                  background: KIND_STYLE[k].bg,
                  border: '1px solid var(--mantine-color-gray-4)',
                  borderRadius: 4,
                }}
              />
              <Text size="xs">{s.cal.kind[k]}</Text>
            </Group>
          ))}
          <Group gap={6}>
            <Box w={8} h={8} style={{ background: 'var(--mantine-color-blue-6)', borderRadius: '50%' }} />
            <Text size="xs">{s.cal.changed}</Text>
          </Group>
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        {s.cal.hint}
      </Text>
      {d && (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing="sm">
          {d.months.map((m) => (
            <MonthCard
              key={m.month}
              month={m.month}
              totals={m}
              days={d.days.filter((x) => x.date.startsWith(m.month))}
              onPick={setEdit}
            />
          ))}
        </SimpleGrid>
      )}
      <DayModal day={edit} onClose={() => setEdit(null)} />
    </Stack>
  );
}

function MonthCard({
  month,
  totals,
  days,
  onPick,
}: {
  month: string;
  totals: Totals;
  days: CalendarDay[];
  onPick(d: CalendarDay): void;
}) {
  const now = today();
  const [y, m] = month.split('-').map(Number) as [number, number];
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('ru-RU', {
    month: 'long',
    timeZone: 'UTC',
  });
  const blanks = (days[0]?.weekday ?? 1) - 1;
  return (
    <Paper withBorder p="xs" radius="md" data-testid={`calendar-month-${month}`}>
      <Group justify="space-between" mb={6}>
        <Text fw={700} tt="capitalize">
          {name}
        </Text>
        <Text size="xs" c="dimmed" data-testid="calendar-month-total">
          {s.cal.monthTotal(totals.workDays, totals.hours)}
        </Text>
      </Group>
      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
        {s.weekdays.map((w, i) => (
          <Text key={w} size="10px" ta="center" c={i >= 5 ? 'red.7' : 'dimmed'} fw={600}>
            {w}
          </Text>
        ))}
        {Array.from({ length: blanks }, (_, i) => (
          <Box key={`b${i}`} />
        ))}
        {days.map((d) => {
          const st = KIND_STYLE[d.kind];
          return (
            <Tooltip key={d.date} label={dayTitle(d)} openDelay={300} withArrow>
              <UnstyledButton
                onClick={() => onPick(d)}
                data-testid={`calendar-day-${d.date}`}
                data-kind={d.kind}
                style={{
                  position: 'relative',
                  height: 30,
                  borderRadius: 6,
                  background: st.bg,
                  color: st.fg,
                  border:
                    d.date === now
                      ? '2px solid var(--mantine-color-blue-6)'
                      : '1px solid var(--mantine-color-gray-3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  fontWeight: d.kind === 'holiday' ? 700 : 500,
                }}
              >
                {Number(d.date.slice(8))}
                {d.kind === 'short' && (
                  <span style={{ position: 'absolute', bottom: 0, right: 3, fontSize: 9, lineHeight: 1.1 }}>
                    {s.cal.shortMark}
                  </span>
                )}
                {d.overridden && (
                  <span
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: 'var(--mantine-color-blue-6)',
                    }}
                  />
                )}
              </UnstyledButton>
            </Tooltip>
          );
        })}
      </Box>
    </Paper>
  );
}

/** Изменение дня: крупные кнопки вида дня (сохраняются сразу), комментарий, «как по закону». */
function DayModal({ day, onClose }: { day: CalendarDay | null; onClose(): void }) {
  const [note, setNote] = useState('');
  useEffect(() => setNote(day?.note ?? ''), [day]);
  const save = useAction((b: { kind: Kind; note: string }) =>
    put(`/schedule/calendar/${day!.date}`, { kind: b.kind, note: b.note.trim() || null }),
  );
  const reset = useAction(() => api('DELETE', `/schedule/calendar/${day!.date}`), s.cal.resetDone);
  if (!day) return null;
  const pick = (kind: Kind) => save.mutate({ kind, note }, { onSuccess: onClose });
  return (
    <Modal
      opened={!!day}
      onClose={onClose}
      title={dayTitle({ ...day, overridden: false, note: null })}
      size="md"
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed" data-testid="calendar-default">
          {s.cal.byLaw(s.cal.kind[day.defaultKind]!)}
          {day.holiday ? ` — ${day.holiday}` : ''}
        </Text>
        <TextInput
          label={s.cal.note}
          placeholder={s.cal.notePlaceholder}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          data-testid="calendar-note"
        />
        <Text size="sm" fw={600}>
          {s.cal.pick}
        </Text>
        <SimpleGrid cols={2} spacing="xs">
          {KINDS.map((k) => (
            <Button
              key={k}
              h={56}
              color={KIND_STYLE[k].color}
              variant={day.kind === k ? 'filled' : 'light'}
              onClick={() => pick(k)}
              loading={save.isPending && save.variables?.kind === k}
              data-testid={`calendar-set-${k}`}
            >
              <Stack gap={0} align="center">
                <Text size="sm" fw={700} inherit>
                  {s.cal.kind[k]}
                </Text>
                <Text size="xs" inherit opacity={0.8}>
                  {s.cal.kindHours[k]}
                </Text>
              </Stack>
            </Button>
          ))}
        </SimpleGrid>
        <Group justify="space-between">
          {day.overridden ? (
            <Button
              variant="subtle"
              leftSection={<IconRotate size={16} />}
              onClick={() => reset.mutate(undefined, { onSuccess: onClose })}
              loading={reset.isPending}
              data-testid="calendar-reset"
            >
              {s.cal.reset}
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="default"
            onClick={() => pick(day.kind)}
            disabled={note.trim() === (day.note ?? '')}
            data-testid="calendar-save-note"
          >
            {s.cal.saveNote}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
