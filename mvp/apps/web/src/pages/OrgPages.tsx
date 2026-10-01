import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  MultiSelect,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { DictPage } from '../components/DictPage';
import { get, post, put, patch } from '../lib/api';
import { type Row, type TicketRef, options, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

export function EnterprisesPage() {
  return (
    <DictPage
      kind="enterprises"
      title={t.nav.enterprises}
      columns={[
        { key: 'code', label: t.org.kod },
        { key: 'name', label: t.org.nazvanie },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: t.org.telefon },
      ]}
      fields={[
        { key: 'code', label: t.org.kod, required: true },
        { key: 'name', label: t.org.nazvanie, required: true },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: t.org.telefon },
      ]}
    />
  );
}

/** Подразделение → в каких предприятиях (мультивыбор) + атрибуты связки. */
function DepartmentEnterprises({ dep, onClose }: { dep: Row; onClose(): void }) {
  const enterprises = useList('/dict/enterprises');
  const links = useList(`/enterprise-departments?departmentId=${dep.id}`);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (links.data) setSelected(links.data.map((l) => String(l.enterpriseId)));
  }, [links.data]);
  // Отключаемые связки: перед сохранением узнаём их открытые тикеты, чтобы предупредить (M-TKT-12a).
  const save = useAction(async () => {
    const removed = (links.data ?? []).filter((l) => !selected.includes(String(l.enterpriseId)));
    const affected = (
      await Promise.all(
        removed.map((l) => get<TicketRef[]>(`/tickets-impact?enterpriseDepartmentId=${l.id}`)),
      )
    ).flat();
    await put(`/departments/${dep.id}/enterprises`, { enterpriseIds: selected });
    return { openTickets: affected };
  });
  const saveLink = useAction((l: { id: string; transferNumber: string; email: string }) =>
    patch(`/enterprise-departments/${l.id}`, {
      transferNumber: l.transferNumber || null,
      email: l.email || null,
    }),
  );
  return (
    <Modal opened onClose={onClose} title={t.org.predpriyatiya(String(dep.name))} size="xl">
      <Stack>
        <Group align="end">
          <MultiSelect
            style={{ flex: 1 }}
            label={t.org.predpriyatiyaVKotorykhEst}
            data={options(enterprises.data)}
            value={selected}
            onChange={setSelected}
            searchable
            data-testid="dep-enterprises"
          />
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>
            {t.save}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          {t.org.nomerIliOcheredDlya}
        </Text>
        <Table>
          <Table.Tbody>
            {(links.data ?? []).map((l) => (
              <LinkRow key={l.id} link={l} onSave={(v) => saveLink.mutate({ id: l.id, ...v })} />
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </Modal>
  );
}

function LinkRow({
  link,
  onSave,
}: {
  link: Row;
  onSave(v: { transferNumber: string; email: string }): void;
}) {
  const [num, setNum] = useState(String(link.transferNumber ?? ''));
  const [email, setEmail] = useState(String(link.email ?? ''));
  return (
    <Table.Tr>
      <Table.Td>{String(link.enterpriseName)}</Table.Td>
      <Table.Td>
        <TextInput
          size="xs"
          placeholder={t.org.nomerDlyaPerevoda}
          value={num}
          onChange={(e) => setNum(e.currentTarget.value)}
        />
      </Table.Td>
      <Table.Td>
        <TextInput
          size="xs"
          placeholder={t.org.emailPodrazdeleniya}
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      </Table.Td>
      <Table.Td>
        <Button size="xs" variant="light" onClick={() => onSave({ transferNumber: num, email })}>
          {t.save}
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

export function DepartmentsPage() {
  const [dep, setDep] = useState<Row | null>(null);
  const links = useList('/enterprise-departments');
  const byDep = new Map<string, string[]>();
  for (const l of links.data ?? [])
    byDep.set(String(l.departmentId), [
      ...(byDep.get(String(l.departmentId)) ?? []),
      String(l.enterpriseName),
    ]);
  return (
    <>
      <DictPage
        kind="departments"
        title={t.nav.departments}
        columns={[
          { key: 'code', label: t.org.kod },
          { key: 'name', label: t.org.nazvanie },
          {
            key: 'enterprises',
            label: t.nav.enterprises,
            render: (r) => (
              <Group gap={4}>
                {(byDep.get(r.id) ?? []).map((n) => (
                  <Badge key={n} variant="outline">
                    {n}
                  </Badge>
                ))}
              </Group>
            ),
          },
        ]}
        fields={[
          { key: 'code', label: t.org.kod, required: true },
          { key: 'name', label: t.org.nazvanie, required: true },
        ]}
        rowActions={(r) => (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setDep(r)}
            data-testid={`dep-links-${String(r.code)}`}
          >
            {t.nav.enterprises}
          </Button>
        )}
      />
      {dep && <DepartmentEnterprises dep={dep} onClose={() => setDep(null)} />}
    </>
  );
}

export function ObjectsPage() {
  const enterprises = useList('/dict/enterprises?active=all');
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState('code;name;address;enterprise_code\n');
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    errors: { line: number; message: string }[];
  } | null>(null);
  const imp = useAction(async () => setResult(await post('/objects/import', { csv })), t.org.importVypolnen);
  const entName = new Map((enterprises.data ?? []).map((e) => [e.id, String(e.name)]));
  return (
    <>
      <DictPage
        kind="objects"
        title={t.nav.objects}
        columns={[
          { key: 'code', label: t.org.kod },
          { key: 'name', label: t.org.nazvanie },
          { key: 'address', label: t.org.adres },
          {
            key: 'enterpriseId',
            label: t.org.predpriyatie,
            render: (r) => entName.get(String(r.enterpriseId)) ?? '',
          },
          {
            key: 'source',
            label: t.org.istochnik,
            render: (r) => t.reviews.sources[String(r.source)] ?? String(r.source ?? ''),
          },
          {
            key: 'objguid',
            label: t.reviews.objectGuid,
            render: (r) => String((r.externalIds as Record<string, string> | undefined)?.objguid ?? ''),
          },
        ]}
        fields={[
          {
            key: 'enterpriseId',
            label: t.org.predpriyatie,
            type: 'select',
            required: true,
            options: options(enterprises.data),
          },
          { key: 'code', label: t.org.kod, required: true },
          { key: 'name', label: t.org.nazvanie, required: true },
          { key: 'address', label: t.org.adres },
          { key: 'objguid', label: t.reviews.objectGuid, description: t.reviews.objectGuidHint },
        ]}
        toForm={(r) => ({
          ...r,
          objguid: (r.externalIds as Record<string, string> | undefined)?.objguid ?? '',
        })}
        fromForm={(v, editing) => {
          const { objguid, ...rest } = v;
          const ext = { ...((editing?.externalIds ?? {}) as Record<string, string>) };
          if (objguid) ext.objguid = String(objguid).trim();
          else delete ext.objguid;
          return { ...rest, externalIds: ext };
        }}
        toolbar={
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            {t.org.importCsv}
          </Button>
        }
      />
      <Modal
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        title={t.org.importObektovIzCsv}
        size="xl"
      >
        <Stack>
          <Text size="sm">{t.org.stolbtsyCodeNameAddress}</Text>
          <Textarea autosize minRows={8} value={csv} onChange={(e) => setCsv(e.currentTarget.value)} />
          <Button onClick={() => imp.mutate(undefined)} loading={imp.isPending}>
            {t.org.importirovat}
          </Button>
          {result && (
            <Alert color={result.errors.length ? 'yellow' : 'green'}>
              {t.org.sozdano}
              {result.created}
              {t.org.obnovleno}
              {result.updated}
              {result.errors.map((e) => (
                <div key={e.line}>
                  {t.org.stroka}
                  {e.line}: {e.message}
                </div>
              ))}
            </Alert>
          )}
        </Stack>
      </Modal>
    </>
  );
}

const BEHAVIORS = [
  { value: 'resolved', label: t.org.reshenoZakryt },
  { value: 'escalate', label: t.org.peredatNa2Yu },
  { value: 'no_reply_needed', label: t.org.neTrebuetOtveta },
  { value: 'postponed', label: t.org.otlozhenoPerezvonit },
  { value: 'duplicate', label: t.org.dublikat },
];
const CHANNELS = ['voice', 'webchat', 'app', 'telegram', 'email', 'review', 'api'].map((c) => ({
  value: c,
  label: c,
}));

const STRATEGIES = [
  { value: 'least_recent', label: t.org.dolsheVsekhSvoboden },
  { value: 'least_load', label: t.org.naimenshayaZagruzka },
];

export function DictionariesPage() {
  const topics = useList('/topics');
  const queues = useList('/dict/queues');
  return (
    <>
      <Title order={3} mb="md">
        {t.nav.dictionaries}
      </Title>
      <Tabs defaultValue="dispositions" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="dispositions">{t.org.rezultatyObrabotki}</Tabs.Tab>
          <Tabs.Tab value="answer-methods">{t.org.sposobyOtveta}</Tabs.Tab>
          <Tabs.Tab value="queues">{t.org.ocheredi}</Tabs.Tab>
          <Tabs.Tab value="routing-rules">{t.org.pravilaMarshrutizatsii}</Tabs.Tab>
          <Tabs.Tab value="segment-priority">{t.org.prioritetSegmentov}</Tabs.Tab>
          <Tabs.Tab value="skills">{t.org.navyki}</Tabs.Tab>
          <Tabs.Tab value="tags">{t.org.tegi}</Tabs.Tab>
          <Tabs.Tab value="break-reasons">{t.org.prichinyPereryvov}</Tabs.Tab>
          <Tabs.Tab value="scope-templates">{t.org.shablonyOblastey}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="dispositions">
          <DictPage
            hideTitle
            kind="dispositions"
            title={t.org.rezultatObrabotki}
            columns={[
              { key: 'code', label: t.org.kod },
              { key: 'name', label: t.org.nazvanie },
              {
                key: 'behavior',
                label: t.org.povedenie,
                render: (r) => BEHAVIORS.find((b) => b.value === r.behavior)?.label ?? '',
              },
            ]}
            fields={[
              { key: 'code', label: t.org.kod, required: true },
              { key: 'name', label: t.org.nazvanie, required: true },
              { key: 'behavior', label: t.org.povedenie, type: 'select', required: true, options: BEHAVIORS },
              { key: 'sortOrder', label: t.org.poryadok, type: 'number' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="answer-methods">
          <DictPage
            hideTitle
            kind="answer-methods"
            title={t.org.sposobOtveta}
            columns={[
              { key: 'code', label: t.org.kod },
              { key: 'name', label: t.org.nazvanie },
            ]}
            fields={[
              { key: 'code', label: t.org.kod, required: true },
              { key: 'name', label: t.org.nazvanie, required: true },
              { key: 'sortOrder', label: t.org.poryadok, type: 'number' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="queues">
          <DictPage
            hideTitle
            kind="queues"
            title={t.org.ochered}
            columns={[
              { key: 'name', label: t.org.nazvanie },
              { key: 'channels', label: t.org.kanaly, render: (r) => (r.channels as string[]).join(', ') },
              { key: 'priority', label: t.org.prioritet },
              {
                key: 'strategy',
                label: t.org.strategiya,
                render: (r) => STRATEGIES.find((s) => s.value === r.strategy)?.label ?? String(r.strategy),
              },
            ]}
            fields={[
              { key: 'name', label: t.org.nazvanie, required: true },
              { key: 'channels', label: t.org.kanaly, type: 'multiselect', options: CHANNELS },
              { key: 'priority', label: t.org.prioritet0100, type: 'number' },
              { key: 'maxWaitS', label: t.org.maksOzhidanieDoEskalatsii, type: 'number' },
              { key: 'strategy', label: t.org.strategiyaRaspredeleniya, type: 'select', options: STRATEGIES },
              {
                key: 'overflowQueueId',
                label: t.org.rezervnayaGruppaPereliv,
                type: 'select',
                options: options((queues.data ?? []).filter((q) => q.id !== undefined)),
              },
              { key: 'overflowAfterS', label: t.org.perelivVRezervCherez, type: 'number' },
              { key: 'offerTimeoutS', label: t.org.taymautPrinyatiyaOperatoromS, type: 'number' },
              { key: 'wrapUpS', label: t.org.postobrabotkaS, type: 'number' },
              { key: 'requireTag', label: t.org.obyazatelnyyTegPriZakrytii, type: 'switch' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="routing-rules">
          <DictPage
            hideTitle
            kind="routing-rules"
            title={t.org.praviloMarshrutizatsii}
            columns={[
              { key: 'name', label: t.org.nazvanie },
              {
                key: 'channelKind',
                label: t.org.kanal,
                render: (r) => String(r.channelKind ?? t.org.lyuboy),
              },
              { key: 'matchType', label: t.org.tip },
              { key: 'pattern', label: t.org.uslovie },
              {
                key: 'queueId',
                label: t.org.ochered,
                render: (r) => String((queues.data ?? []).find((q) => q.id === r.queueId)?.name ?? ''),
              },
            ]}
            fields={[
              { key: 'name', label: t.org.nazvanie, required: true },
              {
                key: 'channelKind',
                label: t.org.kanalPustoLyuboy,
                type: 'select',
                options: CHANNELS.filter((c) => c.value !== 'voice'),
              },
              {
                key: 'matchType',
                label: t.org.tipUsloviya,
                type: 'select',
                required: true,
                options: [
                  { value: 'keyword', label: t.org.klyuchevoeSlovoPodstroka },
                  { value: 'regex', label: t.org.regulyarnoeVyrazhenie },
                ],
              },
              { key: 'pattern', label: t.org.slovoIliRegex, required: true },
              {
                key: 'queueId',
                label: t.org.ochered,
                type: 'select',
                required: true,
                options: options(queues.data),
              },
              { key: 'priorityBoost', label: t.org.nadbavkaPrioriteta, type: 'number' },
              { key: 'isUrgent', label: t.org.pomechatSrochnoe, type: 'switch' },
              { key: 'sortOrder', label: t.org.poryadokProverki, type: 'number' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="segment-priority">
          <DictPage
            hideTitle
            kind="segment-priority"
            title={t.org.prioritetSegmenta}
            columns={[
              { key: 'segment', label: t.org.segmentKlienta },
              { key: 'boost', label: t.org.nadbavkaPrioriteta },
            ]}
            fields={[
              { key: 'segment', label: t.org.segmentKakVKartochke, required: true },
              { key: 'boost', label: t.org.nadbavkaPrioriteta, type: 'number' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="skills">
          <DictPage
            hideTitle
            kind="skills"
            title={t.org.navyk}
            columns={[{ key: 'name', label: t.org.nazvanie }]}
            fields={[
              { key: 'name', label: t.org.nazvanie, required: true },
              { key: 'topicId', label: t.org.tema, type: 'select', options: options(topics.data) },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="tags">
          <DictPage
            hideTitle
            kind="tags"
            title={t.org.teg}
            columns={[{ key: 'name', label: t.org.nazvanie }]}
            fields={[{ key: 'name', label: t.org.nazvanie, required: true }]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="break-reasons">
          <DictPage
            hideTitle
            kind="break-reasons"
            title={t.org.prichinaPereryva}
            columns={[{ key: 'name', label: t.org.nazvanie }]}
            fields={[{ key: 'name', label: t.org.nazvanie, required: true }]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="scope-templates">
          <DictPage
            hideTitle
            kind="scope-templates"
            writePerm="admin.users"
            title={t.org.shablonOblasti}
            columns={[
              { key: 'name', label: t.org.nazvanie },
              { key: 'rules', label: t.org.pravil, render: (r) => String((r.rules as unknown[]).length) },
            ]}
            fields={[{ key: 'name', label: t.org.nazvanie, required: true }]}
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
