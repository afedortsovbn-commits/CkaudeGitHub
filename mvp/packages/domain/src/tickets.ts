import {
  CONVERSATION_EVENTS,
  makeEvent,
  newId,
  TICKET_EVENTS,
  type TicketEventData,
  type TicketStatus,
} from '@cc/contracts';
import { enqueueEvent } from '@cc/service-kit';
import type { Pool, PoolClient } from 'pg';
import { appendMessage, emitConversation, loadRef } from './conversations';
import {
  dueDate as endOfDayDate,
  type Defaults,
  type Kind,
  resolveDefaults,
  resolveResponseDays,
} from './matrix';
import {
  approvalRecipients,
  loadCard,
  queueNotifications,
  supervisorsFor,
  type NotificationKind,
} from './ticket-notify';
import { localDate } from './ticket-time';

type Db = Pool | PoolClient;

/** Ошибка бизнес-правила: API переводит её в ответ с тем же кодом состояния. */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
const bad = (m: string) => new DomainError(400, 'bad_request', m);
const notFound = (what: string) => new DomainError(404, 'not_found', `${what} не найден`);
const conflict = (code: string, m: string) => new DomainError(409, code, m);

export const TEXT_CHANNELS = ['webchat', 'app', 'telegram', 'email'];
const OPEN: TicketStatus[] = ['new', 'in_work', 'approval', 'rework'];
export const isOpen = (s: string) => (OPEN as string[]).includes(s);

/** Столбцы тикета для выборок: срок — строкой YYYY-MM-DD (тип date без сдвига часового пояса). */
export const TICKET_COLS = `t.*, to_char(t.due_date, 'YYYY-MM-DD') AS due`;

export interface TicketRow {
  id: string;
  number: string;
  conversation_id: string;
  enterprise_department_id: string;
  enterprise_id: string;
  department_id: string;
  topic_id: string;
  topic_path: string[];
  is_important: boolean;
  important_manual: boolean;
  status: TicketStatus;
  summary: string;
  due: string;
  created_by: string;
  answer_method_id: string | null;
  answer_summary: string | null;
  answered_at: Date | null;
  returns_count: number;
  approval_wait_since: Date | null;
  approval_wait_s: string;
  closed_at: Date | null;
  version: number;
}

export interface AttachmentRef {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

async function setting(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.query<{ v: string | null }>(
    `SELECT value #>> '{}' AS v FROM system_setting WHERE key = $1`,
    [key],
  );
  return rows[0]?.v ?? null;
}
export const systemTimezone = async (db: Db) => (await setting(db, 'system.timezone')) ?? 'Europe/Minsk';

// ------------------------------------------------------------------ загрузка и события

/** Тикет с блокировкой и проверкой версии (оптимистическая блокировка, M-TKT-03). */
export async function lockTicket(tx: PoolClient, id: string, expectedVersion?: number): Promise<TicketRow> {
  const { rows } = await tx.query<TicketRow>(
    `SELECT ${TICKET_COLS} FROM ticket t WHERE t.id = $1 FOR UPDATE`,
    [id],
  );
  const t = rows[0];
  if (!t) throw notFound('Тикет');
  if (expectedVersion !== undefined && t.version !== expectedVersion)
    throw conflict('ticket_changed', 'Тикет уже изменён другим сотрудником — обновите страницу');
  return t;
}

export async function loadTicket(db: Db, id: string): Promise<TicketRow | null> {
  const { rows } = await db.query<TicketRow>(`SELECT ${TICKET_COLS} FROM ticket t WHERE t.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function activeAssignees(
  db: Db,
  ticketId: string,
): Promise<{ user_id: string; kind: Kind; full_name: string }[]> {
  const { rows } = await db.query(
    `SELECT a.user_id, a.kind, u.full_name FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id AND u.is_active AND u.can_login
      WHERE a.ticket_id = $1 AND a.is_active ORDER BY a.kind DESC, u.full_name`,
    [ticketId],
  );
  return rows;
}

async function emitTicket(
  tx: PoolClient,
  type: string,
  t: TicketRow,
  actorId: string | null,
  notifyUserIds: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  // Измерения для отчётов по 2-й линии (Ф10): текущие назначенные, объект обращения, способ и время ответа.
  const dims = await tx.query<{
    responsible_ids: string[];
    curator_ids: string[];
    object_id: string | null;
    channel_kind: string | null;
  }>(
    `SELECT COALESCE(array_agg(a.user_id ORDER BY a.added_at) FILTER (WHERE a.kind = 'responsible'), '{}') AS responsible_ids,
            COALESCE(array_agg(a.user_id ORDER BY a.added_at) FILTER (WHERE a.kind = 'curator'), '{}') AS curator_ids,
            (SELECT c.object_id FROM conversation c WHERE c.id = $2) AS object_id,
            (SELECT c.channel_kind FROM conversation c WHERE c.id = $2) AS channel_kind
       FROM ticket_assignee a WHERE a.ticket_id = $1 AND a.is_active`,
    [t.id, t.conversation_id],
  );
  const d = dims.rows[0];
  const data: TicketEventData & Record<string, unknown> = {
    ticketId: t.id,
    number: Number(t.number),
    conversationId: t.conversation_id,
    status: t.status,
    enterpriseId: t.enterprise_id,
    departmentId: t.department_id,
    topicId: t.topic_id,
    topicPath: t.topic_path,
    isImportant: t.is_important,
    dueDate: t.due,
    createdBy: t.created_by,
    objectId: d?.object_id ?? null,
    channelKind: d?.channel_kind ?? null,
    responsibleIds: d?.responsible_ids ?? [],
    curatorIds: d?.curator_ids ?? [],
    answerMethodId: t.answer_method_id ?? null,
    answeredAt: t.answered_at ? new Date(t.answered_at).toISOString() : null,
    returnsCount: t.returns_count,
    actorId,
    notifyUserIds: [...new Set(notifyUserIds)].filter((u) => u !== actorId),
    ...extra,
  };
  await enqueueEvent(tx, makeEvent({ type, source: 'tickets', data }));
}

async function reload(tx: PoolClient, id: string): Promise<TicketRow> {
  const t = await loadTicket(tx, id);
  if (!t) throw notFound('Тикет');
  return t;
}

async function transition(
  tx: PoolClient,
  t: TicketRow,
  actorId: string | null,
  action: string,
  from: string | null,
  to: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO ticket_transition (id, ticket_id, actor_id, action, from_status, to_status, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId(), t.id, actorId, action, from, to, JSON.stringify(details)],
  );
}

async function addComment(
  tx: PoolClient,
  ticketId: string,
  authorId: string | null,
  kind: 'comment' | 'answer' | 'return' | 'redirect' | 'system',
  body: string,
  attachments: AttachmentRef[] = [],
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO ticket_comment (id, ticket_id, author_id, kind, body, attachments) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, ticketId, authorId, kind, body, JSON.stringify(attachments)],
  );
  if (attachments.length)
    await tx.query('UPDATE attachment SET ticket_id = $2 WHERE id = ANY($1) AND ticket_id IS NULL', [
      attachments.map((a) => a.id),
      ticketId,
    ]);
  return id;
}

async function operatorNote(
  tx: PoolClient,
  t: TicketRow,
  authorId: string | null,
  body: string,
): Promise<void> {
  const c = await tx.query<{ channel_kind: string }>('SELECT channel_kind FROM conversation WHERE id = $1', [
    t.conversation_id,
  ]);
  await appendMessage(tx, {
    conversationId: t.conversation_id,
    direction: 'note',
    body,
    authorUserId: authorId,
    channelKind: c.rows[0]!.channel_kind,
    meta: { auto: 'ticket' },
  });
}

// ------------------------------------------------------------------ назначенные и матрица

/** Активные сотрудники с правом работать во 2-й линии (роль «ответственный»/«куратор» и выше). */
async function assertAssignable(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.id FROM app_user u
      WHERE u.id = ANY($1) AND u.is_active AND u.can_login
        AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                     WHERE ur.user_id = u.id AND 'tickets.work' = ANY(r.permissions))`,
    [ids],
  );
  if (rows.length !== new Set(ids).size)
    throw bad('Ответственными и кураторами могут быть только активные сотрудники с ролью 2-й линии');
}

/** Подстановка ответственных и кураторов по матрице для подразделения на предприятии и темы (M-ORG-05). */
export async function matrixDefaults(
  db: Db,
  enterpriseDepartmentId: string,
  topicPath: string[],
): Promise<Defaults> {
  const { rows } = await db.query<{ topic_id: string; user_id: string; kind: Kind }>(
    `SELECT r.topic_id, r.user_id, r.kind FROM responsibility r
       JOIN app_user u ON u.id = r.user_id AND u.is_active AND u.can_login
      WHERE r.enterprise_department_id = $1 AND r.is_active AND r.topic_id = ANY($2)`,
    [enterpriseDepartmentId, topicPath],
  );
  return resolveDefaults(
    topicPath,
    rows.map((r) => ({ topicId: r.topic_id, userId: r.user_id, kind: r.kind })),
  );
}

/** Срок по умолчанию для темы: дата, конец дня по Europe/Minsk (M-ORG-03). */
export async function defaultDueDate(db: Db, topicPath: string[], now = new Date()): Promise<string> {
  const { rows } = await db.query<{ id: string; default_response_days: number | null }>(
    'SELECT id, default_response_days FROM topic WHERE id = ANY($1)',
    [topicPath],
  );
  const byId = new Map(rows.map((r) => [r.id, r.default_response_days]));
  const days = resolveResponseDays(
    topicPath.map((id) => byId.get(id) ?? null),
    Number((await setting(db, 'ticket.default_response_days')) ?? 15),
  );
  return endOfDayDate(now, days, await systemTimezone(db));
}

interface AssigneeChange {
  added: string[];
  removed: string[];
  changed: boolean;
}

/**
 * Приводит состав назначенных к желаемому: снятые остаются в истории (is_active = false), новые и вернувшиеся
 * получают назначение. Смена вида (ответственный ↔ куратор) — тоже изменение. Ответственный «сильнее» куратора.
 */
async function setAssignees(
  tx: PoolClient,
  ticketId: string,
  want: { responsibleIds: string[]; curatorIds: string[] },
  actorId: string | null,
  reason: string,
): Promise<AssigneeChange> {
  const desired = new Map<string, Kind>();
  for (const u of want.curatorIds) desired.set(u, 'curator');
  for (const u of want.responsibleIds) desired.set(u, 'responsible');
  const cur = await tx.query<{ user_id: string; kind: Kind }>(
    'SELECT user_id, kind FROM ticket_assignee WHERE ticket_id = $1 AND is_active',
    [ticketId],
  );
  const curMap = new Map(cur.rows.map((r) => [r.user_id, r.kind]));
  const added: string[] = [];
  const removed: string[] = [];
  let changed = false;
  for (const [u, kind] of desired) {
    if (curMap.get(u) === kind) continue;
    changed = true;
    if (!curMap.has(u)) added.push(u);
    await tx.query(
      `INSERT INTO ticket_assignee (ticket_id, user_id, kind, added_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (ticket_id, user_id) DO UPDATE
         SET kind = EXCLUDED.kind, is_active = true, removed_at = NULL, removed_reason = NULL,
             added_at = CASE WHEN ticket_assignee.is_active THEN ticket_assignee.added_at ELSE now() END,
             added_by = EXCLUDED.added_by`,
      [ticketId, u, kind, actorId],
    );
  }
  for (const u of curMap.keys()) {
    if (desired.has(u)) continue;
    changed = true;
    removed.push(u);
    await tx.query(
      `UPDATE ticket_assignee SET is_active = false, removed_at = now(), removed_reason = $3
        WHERE ticket_id = $1 AND user_id = $2`,
      [ticketId, u, reason],
    );
  }
  return { added, removed, changed };
}

const uniq = (a: string[]) => [...new Set(a)];

async function notifyAssigned(
  tx: PoolClient,
  t: TicketRow,
  userIds: string[],
  kind: NotificationKind,
  dedupe: string,
  extra: { comment?: string; actorName?: string } = {},
): Promise<void> {
  if (!userIds.length) return;
  await queueNotifications(tx, {
    ticketId: t.id,
    userIds,
    kind,
    dedupe,
    card: await loadCard(tx, t.id),
    extra,
    email: true,
  });
}

/** Уведомление только в интерфейсе (колокольчик, M-TKT-12) — участникам о событиях тикета. */
async function notifyUi(
  tx: PoolClient,
  t: TicketRow,
  userIds: string[],
  kind: NotificationKind,
  dedupe: string,
  actorId: string | null,
  extra: { comment?: string; actorName?: string } = {},
): Promise<void> {
  const to = uniq(userIds).filter((u) => u !== actorId);
  if (!to.length) return;
  await queueNotifications(tx, {
    ticketId: t.id,
    userIds: to,
    kind,
    dedupe,
    card: await loadCard(tx, t.id),
    extra,
    email: false,
  });
}

/** Тема (или её предок) помечена «особо важной» — отметка ставится автоматически (M-CARD-08). */
async function topicImportant(db: Db, topicPath: string[]): Promise<boolean> {
  const { rows } = await db.query<{ v: boolean }>(
    'SELECT COALESCE(bool_or(is_important), false) AS v FROM topic WHERE id = ANY($1)',
    [topicPath],
  );
  return rows[0]!.v;
}

async function actorName(db: Db, id: string | null): Promise<string> {
  if (!id) return '';
  const { rows } = await db.query<{ full_name: string }>('SELECT full_name FROM app_user WHERE id = $1', [
    id,
  ]);
  return rows[0]?.full_name ?? '';
}

// ------------------------------------------------------------------ передача на 2-ю линию

export interface CreateTicketInput {
  conversationId: string;
  actorId: string;
  enterpriseId: string;
  departmentId: string;
  topicId: string;
  summary: string;
  responsibleIds: string[];
  curatorIds: string[];
  /** YYYY-MM-DD; не задан — по умолчанию из темы или глобальный. */
  dueDate?: string;
  isImportant?: boolean;
  now?: Date;
}

/**
 * Передача обращения на 2-ю линию (M-TKT-01/02, M-CARD-05): тикет, назначенные, история, уведомления с высоким
 * приоритетом, автосообщение клиенту в текстовых каналах. Без ответственного тикет не сохраняется.
 * Вызывающий уже проверил, что оператор ведёт обращение (права и область видимости).
 */
export async function createTicket(tx: PoolClient, i: CreateTicketInput): Promise<TicketRow> {
  const now = i.now ?? new Date();
  const conv = (
    await tx.query<{
      id: string;
      status: string;
      channel_kind: string;
      fields: Record<string, unknown>;
      is_important: boolean;
      important_manual: boolean;
    }>(
      'SELECT id, status, channel_kind, fields, is_important, important_manual FROM conversation WHERE id = $1 FOR UPDATE',
      [i.conversationId],
    )
  ).rows[0];
  if (!conv) throw notFound('Обращение');
  if (conv.status === 'closed') throw bad('Обращение закрыто');
  if (conv.channel_kind === 'voice')
    throw bad(
      'Передача голосовых обращений на 2-ю линию — в фазе Ф12 (запись разговора в кабинете ответственного)',
    );
  const open = await tx.query("SELECT 1 FROM ticket WHERE conversation_id = $1 AND status <> 'closed'", [
    i.conversationId,
  ]);
  if (open.rowCount) throw conflict('ticket_exists', 'По обращению уже есть открытый тикет');

  const ed = (
    await tx.query<{ id: string }>(
      `SELECT ed.id FROM enterprise_department ed
         JOIN enterprise e ON e.id = ed.enterprise_id AND e.is_active
         JOIN department d ON d.id = ed.department_id AND d.is_active
        WHERE ed.enterprise_id = $1 AND ed.department_id = $2 AND ed.is_active`,
      [i.enterpriseId, i.departmentId],
    )
  ).rows[0];
  if (!ed) throw bad('Передать можно только в активное подразделение на активном предприятии');
  const topic = (
    await tx.query<{ path: string[] }>('SELECT path FROM topic WHERE id = $1 AND is_active', [i.topicId])
  ).rows[0];
  if (!topic) throw bad('Тема не найдена или отключена');
  const inactiveTopic = await tx.query('SELECT 1 FROM topic WHERE id = ANY($1) AND NOT is_active', [
    topic.path,
  ]);
  if (inactiveTopic.rowCount) throw bad('Тема не найдена или отключена');

  // Обязательные «при передаче» поля темы (M-CARD-04); тема и поля — из карточки обращения.
  const req = await tx.query<{ key: string; label: string }>(
    `SELECT f.key, f.label FROM field_def f WHERE f.topic_id = ANY($1) AND f.is_active AND f.required_on_escalate`,
    [topic.path],
  );
  const missing = req.rows.filter((f) => {
    const v = conv.fields?.[f.key];
    return v === undefined || v === null || v === '';
  });
  if (missing.length) throw bad(`Заполните обязательные поля: ${missing.map((f) => f.label).join(', ')}`);

  const responsibleIds = uniq(i.responsibleIds);
  const curatorIds = uniq(i.curatorIds).filter((u) => !responsibleIds.includes(u));
  if (!responsibleIds.length)
    throw bad('Укажите хотя бы одного ответственного — без него тикет не сохраняется');
  await assertAssignable(tx, [...responsibleIds, ...curatorIds]);

  const tz = await systemTimezone(tx);
  const due = i.dueDate ?? (await defaultDueDate(tx, topic.path, now));
  if (due < localDate(now, tz)) throw bad('Срок ответа не может быть в прошлом');

  // «Особо важное» (M-CARD-08, M-TKT-02): автоматически по теме тикета; вручную можно отметить тикет по любой
  // другой теме — явным флагом формы или перенесённой ручной отметкой обращения. Автоматическую не снять.
  const auto = await topicImportant(tx, topic.path);
  const manualMark = i.isImportant ?? (conv.important_manual ? conv.is_important : false);
  const important = auto || manualMark;
  const manual = !auto && manualMark;

  const id = newId();
  await tx.query(
    `INSERT INTO ticket (id, conversation_id, enterprise_department_id, enterprise_id, department_id, topic_id, topic_path,
                         is_important, important_manual, summary, due_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      i.conversationId,
      ed.id,
      i.enterpriseId,
      i.departmentId,
      i.topicId,
      topic.path,
      important,
      manual,
      i.summary,
      due,
      i.actorId,
    ],
  );
  const t = await reload(tx, id);
  await setAssignees(tx, id, { responsibleIds, curatorIds }, i.actorId, 'created');
  await transition(tx, t, i.actorId, 'created', null, 'new', { responsibleIds, curatorIds, dueDate: due });

  // Обращение ждёт 2-ю линию и не попадает в очередь 1-й; классификация фиксируется на обращении.
  const disposition = await tx.query<{ id: string }>(
    `SELECT id FROM disposition WHERE behavior = 'escalate' AND is_active ORDER BY sort_order LIMIT 1`,
  );
  await tx.query(
    `UPDATE conversation SET status = 'waiting_2nd_line', topic_id = $2, topic_path = $3, enterprise_id = $4, department_id = $5,
            is_important = $6, important_manual = $7, disposition_id = COALESCE($8, disposition_id),
            version = version + 1, updated_at = now() WHERE id = $1`,
    [
      i.conversationId,
      i.topicId,
      topic.path,
      i.enterpriseId,
      i.departmentId,
      important,
      manual,
      disposition.rows[0]?.id ?? null,
    ],
  );
  const names = await tx.query<{ e: string; d: string }>(
    `SELECT e.name AS e, d.name AS d FROM enterprise e, department d WHERE e.id = $1 AND d.id = $2`,
    [i.enterpriseId, i.departmentId],
  );
  const who = await tx.query<{ full_name: string }>('SELECT full_name FROM app_user WHERE id = ANY($1)', [
    responsibleIds,
  ]);
  await operatorNote(
    tx,
    t,
    i.actorId,
    `Передано на 2-ю линию: тикет №${t.number}, ${names.rows[0]!.e} / ${names.rows[0]!.d}; ответственные: ${who.rows.map((w) => w.full_name).join(', ')}; срок ответа до ${due}`,
  );
  // Автосообщение клиенту о передаче — только в текстовых каналах (M-TKT-01).
  const msg = ((await setting(tx, 'ticket.transfer_message')) ?? '').trim();
  if (msg && TEXT_CHANNELS.includes(conv.channel_kind)) {
    await appendMessage(tx, {
      conversationId: i.conversationId,
      direction: 'out',
      body: msg,
      channelKind: conv.channel_kind,
      meta: { auto: 'ticket' },
    });
  }
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, i.conversationId), {
    action: 'escalated',
    ticketId: id,
  });

  const all = [...responsibleIds, ...curatorIds];
  await emitTicket(tx, TICKET_EVENTS.created, t, i.actorId, all);
  await emitTicket(tx, TICKET_EVENTS.assigned, t, i.actorId, all, { added: all, removed: [] });
  await notifyAssigned(tx, t, all, 'assigned', `assigned:${id}:created`, {
    actorName: await actorName(tx, i.actorId),
  });
  return t;
}

// ------------------------------------------------------------------ переходы статуса

async function participantIds(db: Db, t: TicketRow): Promise<string[]> {
  return (await activeAssignees(db, t.id)).map((a) => a.user_id);
}

async function statusChanged(
  tx: PoolClient,
  t: TicketRow,
  actorId: string,
  action: string,
  notify: string[],
  extra: Record<string, unknown> = {},
): Promise<TicketRow> {
  const next = await reload(tx, t.id);
  await emitTicket(tx, TICKET_EVENTS.status, next, actorId, notify, {
    action,
    from: t.status,
    to: next.status,
    ...extra,
  });
  return next;
}

/** Открыть тикет: «Новый» → «В работе», «На доработке» → «В работе» (M-TKT-03). Уже «В работе» — без изменений. */
export async function openTicket(tx: PoolClient, id: string, actorId: string): Promise<TicketRow> {
  const t = await lockTicket(tx, id);
  if (t.status !== 'new' && t.status !== 'rework') return t;
  await tx.query(
    `UPDATE ticket SET status = 'in_work', version = version + 1, updated_at = now() WHERE id = $1`,
    [id],
  );
  await transition(tx, t, actorId, 'opened', t.status, 'in_work');
  const next = await statusChanged(tx, t, actorId, 'opened', [t.created_by]);
  await notifyUi(tx, next, [t.created_by], 'opened', `opened:${id}:${next.version}`, actorId, {
    actorName: await actorName(tx, actorId),
  });
  return next;
}

export interface CloseTicketInput {
  answerMethodId: string;
  answerSummary: string;
  attachments: AttachmentRef[];
  version: number;
  now?: Date;
}

/**
 * Закрытие ответственным (M-TKT-07): способ ответа, суть, документы → «На согласовании», согласующим — уведомление
 * в интерфейсе и на email. Система клиенту ничего не отправляет. Ежедневные письма прекращаются.
 */
export async function closeTicketByResponsible(
  tx: PoolClient,
  id: string,
  actorId: string,
  i: CloseTicketInput,
): Promise<TicketRow> {
  const now = i.now ?? new Date();
  const t = await lockTicket(tx, id, i.version);
  if (t.status !== 'in_work' && t.status !== 'rework')
    throw conflict('bad_status', 'Закрыть можно тикет «В работе» или «На доработке»');
  const summary = i.answerSummary.trim();
  if (!summary) throw bad('Опишите суть ответа клиенту');
  const method = await tx.query('SELECT 1 FROM answer_method WHERE id = $1 AND is_active', [
    i.answerMethodId,
  ]);
  if (!method.rowCount) throw bad('Выберите способ ответа');
  await tx.query(
    `UPDATE ticket SET status = 'approval', answer_method_id = $2, answer_summary = $3, answered_at = $4,
            approval_wait_since = $4, version = version + 1, updated_at = now() WHERE id = $1`,
    [id, i.answerMethodId, summary, now],
  );
  await addComment(tx, id, actorId, 'answer', summary, i.attachments);
  await transition(tx, t, actorId, 'answered', t.status, 'approval', {
    answerMethodId: i.answerMethodId,
    documents: i.attachments.length,
  });
  const next = await reload(tx, id);
  const rec = await approvalRecipients(tx, next, localDate(now, await systemTimezone(tx)));
  const card = await loadCard(tx, id);
  const dedupe = `approval-request:${id}:${next.version}`;
  const extra = { actorName: await actorName(tx, actorId), comment: summary };
  await queueNotifications(tx, {
    ticketId: id,
    userIds: rec.main,
    kind: 'approval_request',
    dedupe,
    card,
    extra,
    email: true,
  });
  await queueNotifications(tx, {
    ticketId: id,
    userIds: rec.uiOnly,
    kind: 'approval_request',
    dedupe,
    card,
    extra,
    email: false,
  });
  return statusChanged(tx, t, actorId, 'answered', [
    ...rec.main,
    ...rec.uiOnly,
    ...(await participantIds(tx, t)),
  ]);
}

/**
 * Принять ответ (M-TKT-08): тикет «Закрыт», обращение закрыто. «Закрыт в срок» — если последнее закрытие
 * ответственным не позже срока; ожидание согласования в просрочку ответственного не засчитывается.
 */
export async function approveTicket(
  tx: PoolClient,
  id: string,
  actorId: string,
  i: { version: number; comment?: string; now?: Date },
): Promise<TicketRow> {
  const now = i.now ?? new Date();
  const t = await lockTicket(tx, id, i.version);
  if (t.status !== 'approval') throw conflict('bad_status', 'Тикет не ожидает согласования');
  const tz = await systemTimezone(tx);
  const inTime = !!t.answered_at && localDate(t.answered_at, tz) <= t.due;
  await tx.query(
    `UPDATE ticket SET status = 'closed', closed_at = $2, closed_in_time = $3, approved_by = $4,
            approval_wait_s = approval_wait_s + GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz - COALESCE(approval_wait_since, $2::timestamptz)))::bigint),
            approval_wait_since = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
    [id, now, inTime, actorId],
  );
  if (i.comment?.trim()) await addComment(tx, id, actorId, 'comment', i.comment.trim());
  await transition(tx, t, actorId, 'approved', 'approval', 'closed', { closedInTime: inTime });
  await tx.query(
    `UPDATE conversation SET status = 'closed', closed_at = $2, closed_by = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND status <> 'closed'`,
    [t.conversation_id, now, actorId],
  );
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, t.conversation_id), {
    action: 'closed',
    disposition: 'Передать на 2-ю линию',
    dispositionKind: 'escalate',
    ticketId: id,
  });
  const next = await reload(tx, id);
  const notify = uniq([t.created_by, ...(await participantIds(tx, t))]);
  await queueNotifications(tx, {
    ticketId: id,
    userIds: notify.filter((u) => u !== actorId),
    kind: 'approved',
    dedupe: `approved:${id}:${next.version}`,
    card: await loadCard(tx, id),
    email: false,
  });
  return statusChanged(tx, t, actorId, 'approved', notify, { closedInTime: inTime });
}

/** Вернуть на доработку (M-TKT-08): комментарий обязателен, счётчик возвратов +1, все назначенные уведомляются. */
export async function returnTicket(
  tx: PoolClient,
  id: string,
  actorId: string,
  i: { version: number; comment: string; attachments: AttachmentRef[]; now?: Date },
): Promise<TicketRow> {
  const now = i.now ?? new Date();
  const t = await lockTicket(tx, id, i.version);
  if (t.status !== 'approval') throw conflict('bad_status', 'Тикет не ожидает согласования');
  const comment = i.comment.trim();
  if (!comment) throw bad('Укажите комментарий: что нужно доработать');
  await tx.query(
    `UPDATE ticket SET status = 'rework', returns_count = returns_count + 1,
            approval_wait_s = approval_wait_s + GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz - COALESCE(approval_wait_since, $2::timestamptz)))::bigint),
            approval_wait_since = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
    [id, now],
  );
  await addComment(tx, id, actorId, 'return', comment, i.attachments);
  await transition(tx, t, actorId, 'returned', 'approval', 'rework', { comment });
  const next = await reload(tx, id);
  const assignees = await participantIds(tx, t);
  await notifyAssigned(tx, next, assignees, 'rework', `rework:${id}:${next.version}`, {
    comment,
    actorName: await actorName(tx, actorId),
  });
  return statusChanged(tx, t, actorId, 'returned', assignees);
}

export async function commentTicket(
  tx: PoolClient,
  id: string,
  actorId: string,
  body: string,
  attachments: AttachmentRef[],
): Promise<string> {
  const t = await lockTicket(tx, id);
  const text = body.trim();
  if (!text && !attachments.length) throw bad('Пустой комментарий');
  const cid = await addComment(tx, id, actorId, 'comment', text, attachments);
  await transition(tx, t, actorId, 'commented', t.status, t.status, { commentId: cid });
  const to = uniq([t.created_by, ...(await participantIds(tx, t))]);
  await queueNotifications(tx, {
    ticketId: id,
    userIds: to.filter((u) => u !== actorId),
    kind: 'comment',
    dedupe: `comment:${cid}`,
    card: await loadCard(tx, id),
    extra: { comment: text, actorName: await actorName(tx, actorId) },
    email: false,
  });
  await emitTicket(tx, TICKET_EVENTS.comment, t, actorId, to);
  return cid;
}

// ------------------------------------------------------------------ переадресация и замена ответственных

export interface RedirectInput {
  version: number;
  comment: string;
  enterpriseId?: string;
  departmentId?: string;
  topicId?: string;
  /** Явный состав: если задан — заменяет пересчёт по матрице для этого вида. */
  responsibleIds?: string[];
  curatorIds?: string[];
}

/**
 * Переадресация ответственным или куратором (M-TKT-06): смена темы/подразделения/предприятия — ответственные
 * пересчитываются по матрице (и могут быть заданы вручную), либо просто выбор другого ответственного.
 * Срок и статус не меняются (новые назначенные открывают тикет сами), новые назначенные получают письмо.
 * Переадресация в другое предприятие не ограничивается областью видимости переадресующего (В-40).
 */
export async function redirectTicket(
  tx: PoolClient,
  id: string,
  actorId: string,
  i: RedirectInput,
): Promise<TicketRow> {
  const t = await lockTicket(tx, id, i.version);
  if (t.status === 'approval' || t.status === 'closed')
    throw conflict('bad_status', 'Переадресовать можно только тикет, который в работе');
  const comment = i.comment.trim();
  if (!comment) throw bad('Комментарий к переадресации обязателен');
  const enterpriseId = i.enterpriseId ?? t.enterprise_id;
  const departmentId = i.departmentId ?? t.department_id;
  const topicId = i.topicId ?? t.topic_id;
  const dimsChanged =
    enterpriseId !== t.enterprise_id || departmentId !== t.department_id || topicId !== t.topic_id;
  if (!dimsChanged && i.responsibleIds === undefined && i.curatorIds === undefined)
    throw bad('Укажите новую тему, подразделение, предприятие или ответственного');

  let edId = t.enterprise_department_id;
  let topicPath = t.topic_path;
  if (dimsChanged) {
    const ed = await tx.query<{ id: string }>(
      `SELECT ed.id FROM enterprise_department ed JOIN enterprise e ON e.id = ed.enterprise_id AND e.is_active
         JOIN department d ON d.id = ed.department_id AND d.is_active
        WHERE ed.enterprise_id = $1 AND ed.department_id = $2 AND ed.is_active`,
      [enterpriseId, departmentId],
    );
    if (!ed.rows[0]) throw bad('Передать можно только в активное подразделение на активном предприятии');
    edId = ed.rows[0].id;
    const tp = await tx.query<{ path: string[] }>('SELECT path FROM topic WHERE id = $1 AND is_active', [
      topicId,
    ]);
    if (!tp.rows[0]) throw bad('Тема не найдена или отключена');
    topicPath = tp.rows[0].path;
  }
  const cur = await activeAssignees(tx, id);
  const defaults = dimsChanged ? await matrixDefaults(tx, edId, topicPath) : null;
  const responsibleIds = uniq(
    i.responsibleIds ??
      (defaults ? defaults.responsibles : cur.filter((a) => a.kind === 'responsible').map((a) => a.user_id)),
  );
  const curatorIds = uniq(
    i.curatorIds ??
      (defaults ? defaults.curators : cur.filter((a) => a.kind === 'curator').map((a) => a.user_id)),
  ).filter((u) => !responsibleIds.includes(u));
  if (!responsibleIds.length)
    throw bad('По матрице ответственных не найдено — выберите ответственного вручную');
  await assertAssignable(tx, [...responsibleIds, ...curatorIds]);

  const auto = await topicImportant(tx, topicPath);
  const important = auto || (t.important_manual && t.is_important);
  await tx.query(
    `UPDATE ticket SET enterprise_department_id = $2, enterprise_id = $3, department_id = $4, topic_id = $5, topic_path = $6,
            is_important = $7, version = version + 1, updated_at = now() WHERE id = $1`,
    [id, edId, enterpriseId, departmentId, topicId, topicPath, important],
  );
  const change = await setAssignees(tx, id, { responsibleIds, curatorIds }, actorId, 'redirect');
  if (dimsChanged)
    await tx.query(
      `UPDATE conversation SET topic_id = $2, topic_path = $3, enterprise_id = $4, department_id = $5,
              is_important = CASE WHEN important_manual THEN is_important ELSE $6 END,
              version = version + 1, updated_at = now() WHERE id = $1`,
      [t.conversation_id, topicId, topicPath, enterpriseId, departmentId, auto],
    );
  await addComment(tx, id, actorId, 'redirect', comment);
  await transition(tx, t, actorId, 'redirected', t.status, t.status, {
    comment,
    from: { enterpriseId: t.enterprise_id, departmentId: t.department_id, topicId: t.topic_id },
    to: { enterpriseId, departmentId, topicId },
    added: change.added,
    removed: change.removed,
  });
  const next = await reload(tx, id);
  await notifyAssigned(tx, next, change.added, 'redirected', `assigned:${id}:${next.version}`, {
    comment,
    actorName: await actorName(tx, actorId),
  });
  const everyone = uniq([...(await participantIds(tx, next)), ...change.removed, next.created_by]);
  const name = await actorName(tx, actorId);
  await notifyUi(
    tx,
    next,
    everyone.filter((u) => !change.added.includes(u) && !change.removed.includes(u)),
    'assignees_changed',
    `redirected:${id}:${next.version}`,
    actorId,
    { comment, actorName: name },
  );
  await notifyUi(tx, next, change.removed, 'unassigned', `unassigned:${id}:${next.version}`, actorId, {
    comment,
    actorName: name,
  });
  await emitTicket(tx, TICKET_EVENTS.redirected, next, actorId, everyone, {
    added: change.added,
    removed: change.removed,
  });
  await emitTicket(tx, TICKET_EVENTS.assigned, next, actorId, change.added, {
    added: change.added,
    removed: change.removed,
  });
  return next;
}

export interface ReassignInput {
  version: number;
  responsibleIds?: string[];
  curatorIds?: string[];
  /** Новый срок ответа (YYYY-MM-DD). */
  dueDate?: string;
  isImportant?: boolean;
  comment?: string;
  now?: Date;
}

/**
 * Изменение состава назначенных, срока и отметки «особо важное» создателем тикета, супервизором или
 * администратором (M-TKT-01/02: «оператор может изменить ответственных и срок»). Всё — в истории.
 */
export async function reassignTicket(
  tx: PoolClient,
  id: string,
  actorId: string,
  i: ReassignInput,
): Promise<TicketRow> {
  const t = await lockTicket(tx, id, i.version);
  if (t.status === 'closed') throw conflict('bad_status', 'Тикет закрыт');
  const cur = await activeAssignees(tx, id);
  const responsibleIds = uniq(
    i.responsibleIds ?? cur.filter((a) => a.kind === 'responsible').map((a) => a.user_id),
  );
  const curatorIds = uniq(
    i.curatorIds ?? cur.filter((a) => a.kind === 'curator').map((a) => a.user_id),
  ).filter((u) => !responsibleIds.includes(u));
  if (!responsibleIds.length) throw bad('Нужен хотя бы один ответственный');
  await assertAssignable(tx, [...responsibleIds, ...curatorIds]);
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (i.dueDate && i.dueDate !== t.due) {
    const tz = await systemTimezone(tx);
    if (i.dueDate < localDate(i.now ?? new Date(), tz)) throw bad('Срок ответа не может быть в прошлом');
    set('due_date', i.dueDate);
  }
  if (i.isImportant !== undefined) {
    // Автоматическую отметку по теме не снять; вручную — отметить тикет по любой другой теме.
    const auto = await topicImportant(tx, t.topic_path);
    const important = auto || i.isImportant;
    if (important !== t.is_important) {
      set('is_important', important);
      set('important_manual', !auto && important);
    }
  }
  const change = await setAssignees(tx, id, { responsibleIds, curatorIds }, actorId, 'reassigned');
  if (!change.changed && !sets.length) throw bad('Нечего менять');
  await tx.query(
    `UPDATE ticket SET ${[...sets, 'version = version + 1', 'updated_at = now()'].join(', ')} WHERE id = $1`,
    vals,
  );
  const comment = i.comment?.trim();
  if (comment) await addComment(tx, id, actorId, 'comment', comment);
  await transition(tx, t, actorId, 'reassigned', t.status, t.status, {
    comment,
    added: change.added,
    removed: change.removed,
    dueDate: i.dueDate && i.dueDate !== t.due ? { from: t.due, to: i.dueDate } : undefined,
  });
  const next = await reload(tx, id);
  await notifyAssigned(tx, next, change.added, 'assigned', `assigned:${id}:${next.version}`, {
    comment,
    actorName: await actorName(tx, actorId),
  });
  const everyone = uniq([...(await participantIds(tx, next)), ...change.removed]);
  await notifyUi(tx, next, change.removed, 'unassigned', `unassigned:${id}:${next.version}`, actorId, {
    comment,
    actorName: await actorName(tx, actorId),
  });
  await emitTicket(tx, TICKET_EVENTS.assigned, next, actorId, everyone, {
    added: change.added,
    removed: change.removed,
  });
  return next;
}

// ------------------------------------------------------------------ клиент пишет в обращение с тикетом

/** Новое сообщение клиента по обращению с открытым тикетом: назначенным — уведомление в интерфейсе (M-TKT-03). */
export async function notifyClientMessage(
  tx: PoolClient,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const { rows } = await tx.query<TicketRow>(
    `SELECT ${TICKET_COLS} FROM ticket t WHERE t.conversation_id = $1 AND t.status <> 'closed'`,
    [conversationId],
  );
  const t = rows[0];
  if (!t) return;
  const to = await participantIds(tx, t);
  await queueNotifications(tx, {
    ticketId: t.id,
    userIds: to,
    kind: 'client_message',
    dedupe: `client-msg:${messageId}`,
    card: await loadCard(tx, t.id),
    email: false,
  });
  await emitTicket(tx, TICKET_EVENTS.clientMessage, t, null, to);
}

// ------------------------------------------------------------------ увольнения, матрица, отчёты

export interface DeactivationResult {
  affected: number;
  reassigned: number;
  promotedCurators: number;
  needsReassign: number;
  ticketIds: string[];
}

/**
 * Увольнение или деактивация сотрудника (M-TKT-12a): исключается из назначений открытых тикетов (и из рассылки).
 * Если у тикета не осталось активных ответственных — пересчёт по матрице; нет результата — назначаются кураторы
 * (оставшиеся или по матрице); нет и их — тикет попадает в отчёт «требуют переназначения», супервизорам уходит
 * уведомление. Заместительство деактивированного прекращается; тикеты на согласовании у уволенного создателя
 * достаются супервизорам (см. canApprove).
 */
export async function handleUserDeactivated(
  tx: PoolClient,
  userId: string,
  now = new Date(),
): Promise<DeactivationResult> {
  const res: DeactivationResult = {
    affected: 0,
    reassigned: 0,
    promotedCurators: 0,
    needsReassign: 0,
    ticketIds: [],
  };
  await tx.query(
    'UPDATE approval_substitute SET is_active = false WHERE (user_id = $1 OR substitute_id = $1) AND is_active',
    [userId],
  );
  // Исключается и из рассылки: письма, ещё не ушедшие из очереди, не отправляются.
  await tx.query(
    `UPDATE notification SET status = 'skipped', last_error = 'сотрудник деактивирован'
      WHERE user_id = $1 AND channel = 'email' AND status = 'pending'`,
    [userId],
  );
  const { rows } = await tx.query<{ id: string }>(
    `SELECT t.id FROM ticket t JOIN ticket_assignee a ON a.ticket_id = t.id AND a.user_id = $1 AND a.is_active
      WHERE t.status <> 'closed' ORDER BY t.number`,
    [userId],
  );
  for (const { id } of rows) {
    const t = await lockTicket(tx, id);
    res.affected++;
    res.ticketIds.push(id);
    await tx.query(
      `UPDATE ticket_assignee SET is_active = false, removed_at = now(), removed_reason = 'deactivated'
        WHERE ticket_id = $1 AND user_id = $2`,
      [id, userId],
    );
    // Состав назначенных изменился — открытые у других формы должны получить «тикет уже изменён».
    await tx.query('UPDATE ticket SET version = version + 1, updated_at = now() WHERE id = $1', [id]);
    const left = await activeAssignees(tx, id);
    let responsibles = left.filter((a) => a.kind === 'responsible').map((a) => a.user_id);
    const curators = left.filter((a) => a.kind === 'curator').map((a) => a.user_id);
    let how = 'kept';
    if (!responsibles.length) {
      const d = await matrixDefaults(tx, t.enterprise_department_id, t.topic_path);
      const byMatrix = d.responsibles.filter((u) => u !== userId);
      const byCurators = uniq([...curators, ...d.curators]).filter((u) => u !== userId);
      if (byMatrix.length) {
        responsibles = byMatrix;
        how = 'matrix';
        res.reassigned++;
      } else if (byCurators.length) {
        // Матрица не дала ответственных — тикет ведут кураторы (M-TKT-12a): они становятся ответственными,
        // чтобы тикет не числился в «требуют переназначения» и письма о сроках шли им.
        responsibles = byCurators;
        how = 'curators';
        res.promotedCurators++;
      }
    }
    if (how !== 'kept' && responsibles.length) {
      const change = await setAssignees(
        tx,
        id,
        { responsibleIds: responsibles, curatorIds: curators.filter((u) => !responsibles.includes(u)) },
        null,
        'deactivated',
      );
      const next = await reload(tx, id);
      await transition(tx, t, null, 'auto_reassigned', t.status, t.status, {
        userId,
        how,
        added: change.added,
      });
      await notifyAssigned(tx, next, change.added, 'assigned', `assigned:${id}:deact:${userId}`);
      await emitTicket(tx, TICKET_EVENTS.assigned, next, null, change.added, {
        added: change.added,
        removed: [userId],
      });
    } else if (!responsibles.length) {
      res.needsReassign++;
      await flagNeedsReassign(tx, t, userId);
    } else {
      await transition(tx, t, null, 'assignee_removed', t.status, t.status, { userId });
      await emitTicket(tx, TICKET_EVENTS.assigned, await reload(tx, id), null, responsibles, {
        added: [],
        removed: [userId],
      });
    }
  }
  // Согласование у уволенного создателя — супервизорам: уведомляем о тикетах, которые ждут решения.
  const orphan = await tx.query<TicketRow>(
    `SELECT ${TICKET_COLS} FROM ticket t WHERE t.status = 'approval' AND t.created_by = $1`,
    [userId],
  );
  const today = localDate(now, await systemTimezone(tx));
  for (const t of orphan.rows) {
    const rec = await approvalRecipients(tx, t, today);
    await queueNotifications(tx, {
      ticketId: t.id,
      userIds: rec.main,
      kind: 'approval_request',
      dedupe: `approval-orphan:${t.id}:${userId}`,
      card: await loadCard(tx, t.id),
      email: true,
    });
  }
  return res;
}

async function flagNeedsReassign(tx: PoolClient, t: TicketRow, byUserId: string | null): Promise<void> {
  await transition(tx, t, null, 'needs_reassign', t.status, t.status, { userId: byUserId });
  // Супервизорам, в чью область попадает тикет (администратор с полной областью — тоже).
  const sups = await supervisorsFor(tx, t);
  await queueNotifications(tx, {
    ticketId: t.id,
    userIds: sups,
    kind: 'needs_reassign',
    dedupe: `needs-reassign:${t.id}:${t.version}:${byUserId ?? 'x'}`,
    card: await loadCard(tx, t.id),
    email: true,
  });
  await emitTicket(tx, TICKET_EVENTS.needsReassign, t, null, sups);
}

/**
 * «Применить матрицу к открытым тикетам» (M-TKT-06): состав назначенных пересчитывается по текущей матрице;
 * тикеты, для которых матрица ответственных не даёт, не трогаются и возвращаются в отчёте.
 */
export async function applyMatrixToOpenTickets(
  tx: PoolClient,
  actorId: string,
): Promise<{ changed: number; unchanged: number; unresolved: string[] }> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM ticket WHERE status <> 'closed' ORDER BY number`,
  );
  const out = { changed: 0, unchanged: 0, unresolved: [] as string[] };
  for (const { id } of rows) {
    const t = await lockTicket(tx, id);
    const d = await matrixDefaults(tx, t.enterprise_department_id, t.topic_path);
    if (!d.responsibles.length) {
      out.unresolved.push(id);
      continue;
    }
    const change = await setAssignees(
      tx,
      id,
      { responsibleIds: d.responsibles, curatorIds: d.curators },
      actorId,
      'matrix',
    );
    if (!change.changed) {
      out.unchanged++;
      continue;
    }
    out.changed++;
    await tx.query('UPDATE ticket SET version = version + 1, updated_at = now() WHERE id = $1', [id]);
    await transition(tx, t, actorId, 'matrix_applied', t.status, t.status, {
      added: change.added,
      removed: change.removed,
    });
    const next = await reload(tx, id);
    await notifyAssigned(tx, next, change.added, 'assigned', `assigned:${id}:${next.version}`);
    await emitTicket(tx, TICKET_EVENTS.assigned, next, actorId, [...change.added, ...change.removed], {
      added: change.added,
      removed: change.removed,
    });
  }
  return out;
}

/**
 * Открытые тикеты по подразделению на предприятии, теме (с подтемами), предприятию или подразделению — для
 * предупреждения администратору при деактивации (M-TKT-12a).
 */
export async function openTicketsAffectedBy(
  db: Db,
  by: { enterpriseDepartmentIds?: string[]; topicId?: string; enterpriseId?: string; departmentId?: string },
): Promise<{ id: string; number: number; status: string }[]> {
  const { rows } = await db.query(
    `SELECT t.id, t.number, t.status FROM ticket t
      WHERE t.status <> 'closed'
        AND (($1::uuid[] IS NOT NULL AND t.enterprise_department_id = ANY($1))
          OR ($2::uuid IS NOT NULL AND $2 = ANY(t.topic_path))
          OR ($3::uuid IS NOT NULL AND t.enterprise_id = $3)
          OR ($4::uuid IS NOT NULL AND t.department_id = $4))
      ORDER BY t.number LIMIT 200`,
    [
      by.enterpriseDepartmentIds ?? null,
      by.topicId ?? null,
      by.enterpriseId ?? null,
      by.departmentId ?? null,
    ],
  );
  return rows.map((r) => ({ id: r.id, number: Number(r.number), status: r.status }));
}

/** Тикеты без активного ответственного — отчёт «требуют переназначения» (M-TKT-12a). */
export async function ticketsNeedingReassignment(db: Db): Promise<TicketRow[]> {
  const { rows } = await db.query<TicketRow>(
    `SELECT ${TICKET_COLS} FROM ticket t
      WHERE t.status <> 'closed'
        AND NOT EXISTS (SELECT 1 FROM ticket_assignee a JOIN app_user u ON u.id = a.user_id AND u.is_active AND u.can_login
                         WHERE a.ticket_id = t.id AND a.is_active AND a.kind = 'responsible')
      ORDER BY t.number`,
  );
  return rows;
}
