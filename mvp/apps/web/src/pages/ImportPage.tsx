import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  FileButton,
  Group,
  Modal,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCopy,
  IconDownload,
  IconFileSpreadsheet,
  IconUpload,
} from '@tabler/icons-react';
import { useState } from 'react';
import { authBlobUrl, errorText, post, upload } from '../lib/api';
import { useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

interface Summary {
  fileName: string;
  headerRow: number;
  rows: number;
  create: number;
  update: number;
  same: number;
  duplicate: number;
  error: number;
  changes: { column: string; count: number }[];
  errors: { reason: string; count: number }[];
  sameIds: string[];
  duplicateIds: string[];
  unknownColumns: string[];
  missingRequired: string[];
}
interface Problem {
  row: number;
  action: 'error' | 'duplicate' | 'same';
  id: string | null;
  dupOfRow: number | null;
  errors: { column: string; message: string }[];
}
interface Check {
  id: string;
  summary: Summary;
  problems: Problem[];
}
interface Applied {
  created: number;
  updated: number;
  skipped: number;
}

const tt = t.dataImport;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Minsk' });
const monthAgo = () =>
  new Date(Date.now() - 30 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Minsk' });

/** Скачать файл с авторизацией под своим именем. */
async function download(path: string, name: string, ok: string) {
  try {
    const url = await authBlobUrl(path);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notifications.show({ color: 'green', message: ok });
  } catch (e) {
    notifications.show({ color: 'red', title: t.error, message: errorText(e), autoClose: 8000 });
  }
}

function Stat({
  label,
  n,
  color,
  hint,
  testId,
}: {
  label: string;
  n: number;
  color: string;
  hint?: string;
  testId: string;
}) {
  return (
    <Tooltip label={hint} disabled={!hint} multiline w={280}>
      <Paper withBorder p="sm" data-testid={testId}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Text fw={700} size="xl" c={n ? color : 'dimmed'}>
          {n}
        </Text>
      </Paper>
    </Tooltip>
  );
}

function CopyIds({ ids }: { ids: string[] }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="compact-xs"
      variant="subtle"
      leftSection={<IconCopy size={14} />}
      onClick={() =>
        void navigator.clipboard.writeText(ids.join('\n')).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1300);
          },
          (e) => notifications.show({ color: 'red', title: t.error, message: String(e) }),
        )
      }
    >
      {done ? tt.copied : tt.copyIds}
    </Button>
  );
}

/** Загрузка обращений из Excel (Д-064): шаблон → проверка с итогом → загрузка; журнал загрузок. */
export function ImportPage() {
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(today());
  const [check, setCheck] = useState<Check | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [onlyNew, setOnlyNew] = useState(false);
  const history = useList('/import/batches');
  const doCheck = useAction(async (f: File) => {
    setApplied(null);
    const r = await upload<Check>(`/import/conversations/check${onlyNew ? '?onlyNew=true' : ''}`, f);
    setCheck(r);
    return r;
  }, tt.checkedOk);
  const apply = useAction(async () => {
    const r = await post<Applied>(`/import/batches/${check!.id}/apply`);
    setApplied(r);
    setConfirm(false);
    return r;
  }, tt.appliedOk);
  const s = check?.summary;
  const todo = s ? s.create + s.update : 0;
  return (
    <Stack maw={1200} data-testid="import-page">
      <Title order={3}>{tt.title}</Title>
      <Text c="dimmed" size="sm">
        {tt.intro}
      </Text>

      <Paper withBorder p="md">
        <Text fw={700} mb={4}>
          {tt.step1}
        </Text>
        <Text size="sm" c="dimmed" mb="sm">
          {tt.step1Text}
        </Text>
        <Group align="flex-end" gap="lg">
          <Button
            leftSection={<IconDownload size={16} />}
            variant="light"
            onClick={() => void download('/import/conversations/template', tt.templateFile, tt.templateOk)}
            data-testid="import-template"
          >
            {tt.template}
          </Button>
          <Group align="flex-end" gap="xs">
            <Text size="sm" fw={500} pb={6}>
              {tt.exportTitle}
            </Text>
            <Group gap={6} align="center">
              <Text size="sm">{tt.from}</Text>
              <TextInput
                type="date"
                size="xs"
                value={from}
                onChange={(e) => setFrom(e.currentTarget.value)}
              />
              <Text size="sm">{tt.to}</Text>
              <TextInput type="date" size="xs" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
            </Group>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconFileSpreadsheet size={16} />}
              onClick={() =>
                void download(
                  `/import/conversations/export?from=${from}&to=${to}`,
                  tt.exportFile(from, to),
                  tt.exportOk,
                )
              }
              data-testid="import-export"
            >
              {tt.exportBtn}
            </Button>
          </Group>
        </Group>
      </Paper>

      <Paper withBorder p="md">
        <Text fw={700} mb="sm">
          {tt.step2}
        </Text>
        <Group gap="lg">
          <FileButton onChange={(f) => f && doCheck.mutate(f)} accept=".xlsx">
            {(props) => (
              <Button
                {...props}
                leftSection={<IconUpload size={16} />}
                loading={doCheck.isPending}
                data-testid="import-pick"
              >
                {tt.pick}
              </Button>
            )}
          </FileButton>
          <Checkbox
            label={tt.onlyNew}
            checked={onlyNew}
            onChange={(e) => setOnlyNew(e.currentTarget.checked)}
            data-testid="import-only-new"
          />
        </Group>
        {s && check && (
          <Stack mt="md" gap="sm" data-testid="import-result">
            <Text size="sm">{tt.file(s.fileName, s.rows, s.headerRow)}</Text>
            {s.missingRequired.length > 0 && (
              <Alert color="red" icon={<IconAlertTriangle size={18} />}>
                {tt.missingRequired(s.missingRequired.join(', '))}
              </Alert>
            )}
            {s.unknownColumns.length > 0 && (
              <Alert color="yellow" icon={<IconAlertTriangle size={18} />}>
                {tt.unknownColumns(s.unknownColumns.join(', '))}
              </Alert>
            )}
            <SimpleGrid cols={{ base: 2, sm: 5 }}>
              <Stat label={tt.create} n={s.create} color="green" testId="import-create" />
              <Stat label={tt.update} n={s.update} color="yellow.8" testId="import-update" />
              <Stat label={tt.same} n={s.same} color="gray" hint={tt.sameHint} testId="import-same" />
              <Stat
                label={tt.duplicate}
                n={s.duplicate}
                color="orange"
                hint={tt.duplicateHint}
                testId="import-duplicate"
              />
              <Stat label={tt.error} n={s.error} color="red" hint={tt.errorHint} testId="import-error" />
            </SimpleGrid>
            <Group justify="space-between">
              <Tooltip label={tt.markedHint} multiline w={300}>
                <Button
                  variant="default"
                  leftSection={<IconFileSpreadsheet size={16} />}
                  onClick={() =>
                    void download(
                      `/import/batches/${check.id}/file`,
                      tt.markedFileName(s.fileName),
                      tt.exportOk,
                    )
                  }
                  data-testid="import-marked"
                >
                  {tt.markedFile}
                </Button>
              </Tooltip>
              {applied ? (
                <Badge size="lg" color="green" data-testid="import-applied">
                  {tt.applied(applied.created, applied.updated)}
                </Badge>
              ) : (
                <Button
                  color="green"
                  leftSection={<IconUpload size={16} />}
                  onClick={() =>
                    todo ? setConfirm(true) : notifications.show({ color: 'yellow', message: tt.nothing })
                  }
                  data-testid="import-apply"
                >
                  {tt.apply(todo)}
                </Button>
              )}
            </Group>
            {(s.sameIds.length > 0 || s.duplicateIds.length > 0) && (
              <Group gap="xs">
                <Text size="sm">{tt.sameIds(s.sameIds.length + s.duplicateIds.length)}</Text>
                <CopyIds ids={[...s.sameIds, ...s.duplicateIds]} />
              </Group>
            )}
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              {s.changes.length > 0 && (
                <div>
                  <Text fw={600} size="sm" mb={4}>
                    {tt.changesTitle}
                  </Text>
                  <Table withTableBorder data-testid="import-changes">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{tt.colField}</Table.Th>
                        <Table.Th w={90}>{tt.colCount}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {s.changes.map((c) => (
                        <Table.Tr key={c.column}>
                          <Table.Td>{c.column}</Table.Td>
                          <Table.Td>{c.count}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
              {s.errors.length > 0 && (
                <div>
                  <Text fw={600} size="sm" mb={4}>
                    {tt.errorsTitle}
                  </Text>
                  <Table withTableBorder data-testid="import-errors">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{tt.colWhat}</Table.Th>
                        <Table.Th w={90}>{tt.colCount}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {s.errors.slice(0, 50).map((c) => (
                        <Table.Tr key={c.reason}>
                          <Table.Td>{c.reason}</Table.Td>
                          <Table.Td>{c.count}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </SimpleGrid>
            {check.problems.length > 0 && (
              <div>
                <Text fw={600} size="sm" mb={4}>
                  {tt.problemsTitle}
                </Text>
                <ScrollArea.Autosize mah={360} type="auto">
                  <Table withTableBorder striped stickyHeader data-testid="import-problems">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w={80}>{tt.colRow}</Table.Th>
                        <Table.Th>{tt.colWhat}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {check.problems.map((p) => (
                        <Table.Tr key={p.row}>
                          <Table.Td>{p.row}</Table.Td>
                          <Table.Td>
                            {p.action === 'error' ? (
                              p.errors.map((e, i) => (
                                <Text key={i} size="sm" c="red">
                                  {e.column ? <b>{e.column}: </b> : null}
                                  {e.message}
                                </Text>
                              ))
                            ) : (
                              <Text size="sm" c="orange">
                                {p.action === 'same' && p.id ? tt.sameAs(p.id) : null}
                                {p.action === 'duplicate' && p.dupOfRow ? tt.dupOf(p.dupOfRow) : null}
                                {p.action === 'duplicate' && p.id ? (
                                  <>
                                    {tt.dupOfId('')}
                                    <Code>{p.id}</Code>
                                  </>
                                ) : null}
                              </Text>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea.Autosize>
              </div>
            )}
          </Stack>
        )}
      </Paper>

      <Modal opened={confirm} onClose={() => setConfirm(false)} title={tt.applyTitle}>
        {s && <Text size="sm">{tt.applyText(s.create, s.update, s.error + s.duplicate + s.same)}</Text>}
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirm(false)}>
            {t.cancel}
          </Button>
          <Button
            color="green"
            loading={apply.isPending}
            onClick={() => apply.mutate(undefined)}
            data-testid="import-confirm"
          >
            {tt.apply(todo)}
          </Button>
        </Group>
      </Modal>

      <Paper withBorder p="md">
        <Text fw={700} mb="sm">
          {tt.history}
        </Text>
        <Table withTableBorder data-testid="import-history">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={170}>{tt.colDate}</Table.Th>
              <Table.Th>{tt.colFile}</Table.Th>
              <Table.Th>{tt.colWho}</Table.Th>
              <Table.Th>{tt.colResult}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(history.data ?? []).map((b) => {
              const sm = b.summary as Summary;
              const r = b.result as Applied | null;
              return (
                <Table.Tr key={b.id}>
                  <Table.Td>{new Date(String(b.createdAt)).toLocaleString('ru-RU')}</Table.Td>
                  <Table.Td>{String(b.fileName)}</Table.Td>
                  <Table.Td>{String(b.createdByName ?? '')}</Table.Td>
                  <Table.Td>
                    {r ? (
                      <Text size="sm">{tt.resultLine(r.created, r.updated, r.skipped)}</Text>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {tt.notApplied} · {tt.checkLine(sm.rows, sm.error)}
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  );
}
