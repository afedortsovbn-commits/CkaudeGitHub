import {
  Badge,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, patch } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

export function SettingsPage() {
  const s = useQuery({ queryKey: ['/settings'], queryFn: () => get<Record<string, unknown>>('/settings') });
  const [v, setV] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (s.data) setV(s.data);
  }, [s.data]);
  // Только изменённые значения: в system_setting есть и служебные ключи (например, отметка дня рассылки),
  // которые сервер не принимает на запись.
  const save = useAction(() =>
    patch(
      '/settings',
      Object.fromEntries(
        Object.entries(v).filter(([k, x]) => JSON.stringify(x) !== JSON.stringify(s.data?.[k])),
      ),
    ),
  );
  const thresholds = (v['supervisor.thresholds'] ?? {}) as Record<string, number>;
  return (
    <Stack maw={520}>
      <NumberInput
        label={t.settingsPage.srokOtveta2Y}
        description={t.settingsPage.deystvuetEsliUTemy}
        min={1}
        max={365}
        value={Number(v['ticket.default_response_days'] ?? 15)}
        onChange={(x) => setV({ ...v, 'ticket.default_response_days': Number(x) })}
      />
      <TextInput
        label={t.settingsPage.vremyaEzhednevnoyRassylkiPo}
        description={t.settingsPage.pismaOstalosNDney}
        value={String(v['ticket.daily_notification_time'] ?? '08:00')}
        onChange={(e) => setV({ ...v, 'ticket.daily_notification_time': e.currentTarget.value })}
      />
      <NumberInput
        label={t.settingsPage.nadbavkaPrioritetaPriEskalatsii}
        description={t.settingsPage.pribavlyaetsyaKPrioritetuObrashcheni}
        min={0}
        max={100000}
        value={Number(v['routing.escalation_boost'] ?? 1000)}
        onChange={(x) => setV({ ...v, 'routing.escalation_boost': Number(x) })}
      />
      <NumberInput
        label={t.settingsPage.chatVoVkladkePostobrabotka}
        description={t.settingsPage.poslednimNapisalOperatorKlient}
        min={10}
        max={86400}
        value={Number(v['operator.wrapup_chat_idle_s'] ?? 300)}
        onChange={(x) => setV({ ...v, 'operator.wrapup_chat_idle_s': Number(x) })}
        data-testid="setting-wrapup-idle"
      />
      <Select
        label={t.settingsPage.ktoSoglasuetZakrytieTiketa}
        data={[
          { value: 'creator', label: t.settingsPage.sozdatelTiketaEgoZamestitel },
          { value: 'supervisor', label: t.settingsPage.tolkoSupervizor },
        ]}
        value={String(v['ticket.approval_mode'] ?? 'creator')}
        onChange={(x) => setV({ ...v, 'ticket.approval_mode': x })}
      />
      <TextInput
        label={t.settingsPage.avtosoobshchenieKlientuPriPeredache}
        description={t.settingsPage.ukhoditVTekstovykhKanalakh}
        value={String(v['ticket.transfer_message'] ?? '')}
        onChange={(e) => setV({ ...v, 'ticket.transfer_message': e.currentTarget.value })}
      />
      <Title order={5} mt="md">
        {t.settingsPage.routingTitle}
      </Title>
      <Text size="xs" c="dimmed">
        {t.settingsPage.routingHint}
      </Text>
      {(() => {
        const policy = {
          text: 'auto',
          voice: 'auto',
          email: 'auto',
          idleScope: 'combined',
          sticky: false,
          stickyDays: 30,
          ...((v['routing.policy'] as Record<string, unknown> | undefined) ?? {}),
        } as { text: string; email: string; idleScope: string; sticky: boolean; stickyDays: number };
        const setPolicy = (patch: Record<string, unknown>) =>
          setV({ ...v, 'routing.policy': { ...policy, ...patch } });
        const modes = [
          { value: 'auto', label: t.settingsPage.routingAuto },
          { value: 'pull', label: t.settingsPage.routingPull },
        ];
        return (
          <>
            <Select
              label={t.settingsPage.routingText}
              data={modes}
              value={policy.text}
              onChange={(x) => x && setPolicy({ text: x })}
              data-testid="routing-text"
            />
            <Select
              label={t.settingsPage.routingEmail}
              data={modes}
              value={policy.email}
              onChange={(x) => x && setPolicy({ email: x })}
              data-testid="routing-email"
            />
            <Text size="sm" c="dimmed">
              {t.settingsPage.routingVoice}
            </Text>
            <Select
              label={t.settingsPage.routingIdle}
              data={[
                { value: 'combined', label: t.settingsPage.routingIdleCombined },
                { value: 'split', label: t.settingsPage.routingIdleSplit },
              ]}
              value={policy.idleScope}
              onChange={(x) => x && setPolicy({ idleScope: x })}
              data-testid="routing-idle"
            />
            <Switch
              label={t.settingsPage.routingSticky}
              description={t.settingsPage.routingStickyHint}
              checked={policy.sticky}
              onChange={(e) => setPolicy({ sticky: e.currentTarget.checked })}
              data-testid="routing-sticky"
            />
            {policy.sticky && (
              <NumberInput
                label={t.settingsPage.routingStickyDays}
                min={1}
                max={365}
                value={policy.stickyDays}
                onChange={(x) => setPolicy({ stickyDays: Number(x) || 30 })}
                data-testid="routing-sticky-days"
              />
            )}
          </>
        );
      })()}
      <Title order={5} mt="md">
        {t.settingsPage.bezopasnostIPersonalnyeDannye}
      </Title>
      <Switch
        label={t.settingsPage.vkhodSKodom2fa}
        description={t.settingsPage.sotrudnikiSAdministrativnymiPravami}
        checked={Boolean(v['security.admin_2fa_required'] ?? false)}
        onChange={(e) => setV({ ...v, 'security.admin_2fa_required': e.currentTarget.checked })}
        data-testid="setting-admin-2fa"
      />
      <NumberInput
        label={t.settingsPage.srokKhraneniyaZapiseyRazgovorov}
        description={t.settingsPage.zapisiStarsheSrokaUdalyayutsya}
        min={1}
        max={3650}
        value={Number(v['recording.retention_days'] ?? 1825)}
        onChange={(x) => setV({ ...v, 'recording.retention_days': Number(x) })}
        data-testid="setting-recording-retention"
      />
      <Group grow>
        <NumberInput
          label={t.resources.warnPct}
          description={t.resources.pctHint}
          min={50}
          max={99}
          value={Number(v['resource.warn_pct'] ?? 80)}
          onChange={(x) => setV({ ...v, 'resource.warn_pct': Number(x) })}
          data-testid="setting-resource-warn"
        />
        <NumberInput
          label={t.resources.critPct}
          description={t.resources.pctHint}
          min={50}
          max={99}
          value={Number(v['resource.crit_pct'] ?? 90)}
          onChange={(x) => setV({ ...v, 'resource.crit_pct': Number(x) })}
          data-testid="setting-resource-crit"
        />
      </Group>
      <Title order={5} mt="md">
        {t.settingsPage.panelSupervizoraIOtchety}
      </Title>
      {(
        [
          ['waitWarnS', t.settingsPage.ozhidanieVOcherediVnimanie, 60],
          ['waitCritS', t.settingsPage.ozhidanieVOcherediKritichno, 180],
          ['queueWarn', t.settingsPage.ozhidayushchikhVOcherediVnimanie, 5],
          ['queueCrit', t.settingsPage.ozhidayushchikhVOcherediKritichno, 15],
          ['breakWarnS', t.settingsPage.podsvechivatPereryvOperatoraDolshe, 900],
          ['slTargetPct', t.settingsPage.tselSlZaSegodnya, 80],
        ] as const
      ).map(([k, label, def]) => (
        <NumberInput
          key={k}
          label={label}
          min={1}
          value={Number(thresholds[k] ?? def)}
          onChange={(x) => setV({ ...v, 'supervisor.thresholds': { ...thresholds, [k]: Number(x) } })}
          data-testid={`setting-${k}`}
        />
      ))}
      {(
        [
          ['report.sl_voice_s', t.settingsPage.slOtvetNaZvonok, 20],
          ['report.sl_text_s', t.settingsPage.slOtvetVTekstovom, 60],
          ['report.short_abandon_s', t.settingsPage.korotkiySbrosNeSchitaetsya, 5],
          ['report.first_response_s', t.settingsPage.pervyyOtvetVChate, 120],
        ] as const
      ).map(([k, label, def]) => (
        <NumberInput
          key={k}
          label={label}
          min={0}
          value={Number(v[k] ?? def)}
          onChange={(x) => setV({ ...v, [k]: Number(x) })}
        />
      ))}
      <SlRules v={v} setV={setV} />
      <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>
        {t.save}
      </Button>
      <ReleasePanel />
    </Stack>
  );
}

type QueueSl = Record<string, { voiceS?: number | null; textS?: number | null }>;

/**
 * Правила расчёта SL (В-51): учёт коротких сбросов и возвратов в IVR/бот в знаменателе, перевод — новое
 * поступление, порог ответа по очереди (пусто — общий). Действуют в отчёте SL и на панели супервизора.
 */
function SlRules({ v, setV }: { v: Record<string, unknown>; setV(x: Record<string, unknown>): void }) {
  const queues = useList('/dict/queues');
  const per = (v['report.sl_queue_thresholds'] ?? {}) as QueueSl;
  const setQueue = (id: string, k: 'voiceS' | 'textS', x: number | string) => {
    const cur = { ...(per[id] ?? {}), [k]: x === '' ? null : Number(x) };
    const next: QueueSl = { ...per, [id]: cur };
    if (cur.voiceS == null && cur.textS == null) delete next[id];
    setV({ ...v, 'report.sl_queue_thresholds': next });
  };
  const flag = (k: string, label: string, description: string, def: boolean) => (
    <Switch
      label={label}
      description={description}
      checked={Boolean(v[k] ?? def)}
      onChange={(e) => setV({ ...v, [k]: e.currentTarget.checked })}
      data-testid={`setting-${k}`}
    />
  );
  return (
    <>
      {flag(
        'report.sl_count_short_abandons',
        t.settingsPage.slUchityvatKorotkieSbrosy,
        t.settingsPage.vyklyuchenoSbrosyBystreePoroga,
        false,
      )}
      {flag(
        'report.sl_count_ivr_returns',
        t.settingsPage.slUchityvatVozvratyIz,
        t.settingsPage.vklyuchenoTakoyEpizodSchitaetsya,
        false,
      )}
      {flag(
        'report.sl_transfer_new_arrival',
        t.settingsPage.slPostanovkaVOchered,
        t.settingsPage.vyklyuchenoVRaschetVkhodit,
        true,
      )}
      <Table data-testid="sl-queue-thresholds">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.settingsPage.porogSlPoOcheredi}</Table.Th>
            <Table.Th>{t.settingsPage.golosS}</Table.Th>
            <Table.Th>{t.settingsPage.tekstS}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(queues.data ?? []).map((q) => (
            <Table.Tr key={q.id}>
              <Table.Td>{String(q.name)}</Table.Td>
              {(['voiceS', 'textS'] as const).map((k) => (
                <Table.Td key={k}>
                  <NumberInput
                    size="xs"
                    min={1}
                    placeholder={t.settingsPage.obshchiy}
                    value={per[q.id]?.[k] ?? ''}
                    onChange={(x) => setQueue(q.id, k, x)}
                    aria-label={`${String(q.name)}: ${k === 'voiceS' ? t.settingsPage.golos : t.settingsPage.tekst}`}
                  />
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}

const RELEASE_STATUS: Record<string, [string, string]> = {
  started: [t.settingsPage.idet, 'blue'],
  succeeded: [t.settingsPage.uspeshno, 'green'],
  failed: [t.settingsPage.oshibka, 'red'],
  rolled_back: [t.settingsPage.otkat, 'orange'],
};

/**
 * Обновления без простоя (Ф11): фиче-флаги (новая функциональность включается после обновления всех
 * экземпляров) и журнал выпусков ops/release.sh. Изменения действуют без перезапуска.
 */
function ReleasePanel() {
  const flags = useList('/admin/feature-flags');
  const releases = useList('/admin/releases');
  const toggle = useAction((b: { key: string; enabled: boolean }) =>
    patch(`/admin/feature-flags/${encodeURIComponent(b.key)}`, { enabled: b.enabled }),
  );
  return (
    <>
      <Title order={4} mt="md">
        {t.release.flags}
      </Title>
      {(flags.data ?? []).map((f) => (
        <Switch
          key={String(f.key)}
          data-testid={`flag-${String(f.key)}`}
          label={String(f.key)}
          description={f.description ? String(f.description) : undefined}
          checked={Boolean(f.enabled)}
          onChange={(e) => toggle.mutate({ key: String(f.key), enabled: e.currentTarget.checked })}
        />
      ))}
      <Title order={4} mt="md">
        {t.release.log}
      </Title>
      <Table data-testid="release-log">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.release.tag}</Table.Th>
            <Table.Th>{t.release.started}</Table.Th>
            <Table.Th>{t.release.duration}</Table.Th>
            <Table.Th>{t.release.status}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(releases.data ?? []).map((r) => {
            const [label, color] = RELEASE_STATUS[String(r.status)] ?? [String(r.status), 'gray'];
            const ms = r.finishedAt
              ? new Date(String(r.finishedAt)).getTime() - new Date(String(r.startedAt)).getTime()
              : null;
            return (
              <Table.Tr key={String(r.id)}>
                <Table.Td>
                  {r.prevTag ? `${String(r.prevTag)} → ` : ''}
                  {String(r.tag)}
                </Table.Td>
                <Table.Td>
                  {new Date(String(r.startedAt)).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}
                </Table.Td>
                <Table.Td>{ms === null ? '—' : t.settingsPage.s(Math.round(ms / 1000))}</Table.Td>
                <Table.Td>
                  <Badge color={color} variant="light">
                    {label}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </>
  );
}

export function AuditPage() {
  const [entity, setEntity] = useState('');
  const list = useList<Row>(`/audit?limit=200${entity ? `&entity=${entity}` : ''}`);
  return (
    <>
      <TextInput
        mb="md"
        maw={300}
        placeholder={t.settingsPage.obektNaprimerTopicApp}
        value={entity}
        onChange={(e) => setEntity(e.currentTarget.value)}
      />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.settingsPage.kogda}</Table.Th>
            <Table.Th>{t.settingsPage.kto}</Table.Th>
            <Table.Th>{t.settingsPage.deystvie}</Table.Th>
            <Table.Th>{t.settingsPage.obekt}</Table.Th>
            <Table.Th>{t.settingsPage.byloStalo}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td>{new Date(String(a.at)).toLocaleString('ru-RU')}</Table.Td>
              <Table.Td>{String(a.actorName ?? '')}</Table.Td>
              <Table.Td>{String(a.action)}</Table.Td>
              <Table.Td>
                {String(a.entity)} {a.entityId ? String(a.entityId).slice(0, 8) : ''}
              </Table.Td>
              <Table.Td style={{ fontSize: 11, maxWidth: 500, wordBreak: 'break-all' }}>
                {a.before ? JSON.stringify(a.before).slice(0, 200) : '—'} →{' '}
                {a.after ? JSON.stringify(a.after).slice(0, 200) : '—'}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
