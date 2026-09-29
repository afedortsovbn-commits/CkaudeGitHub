import { z } from 'zod';

/** Статусы тикета 2-й линии (M-TKT-03). «Просрочен» — вычисляемый признак, а не статус. */
export const TICKET_STATUSES = ['new', 'in_work', 'approval', 'rework', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
/** Тикет ещё требует работы ответственного (по нему идёт рассылка сроков). */
export const TICKET_WORK_STATUSES: readonly TicketStatus[] = ['new', 'in_work', 'rework'];

export const TICKET_EVENTS = {
  created: 'ticket.created',
  /** Состав назначенных изменился (назначение, переадресация, замена, увольнение). */
  assigned: 'ticket.assigned',
  /** Смена статуса: открыт, закрыт ответственным, принят, возвращён (payload — TicketEventData + from/to). */
  status: 'ticket.status_changed',
  redirected: 'ticket.redirected',
  comment: 'ticket.commented',
  /** Клиент написал в обращение с открытым тикетом. */
  clientMessage: 'ticket.client_message',
  /** Требует переназначения: не осталось ни ответственных, ни кураторов (M-TKT-12a). */
  needsReassign: 'ticket.needs_reassign',
} as const;

/**
 * Данные события тикета. Измерения (предприятие, подразделение, тема, важность) — на момент события:
 * отчёты строятся по журналу без соединений (02-архитектура, 5.1). `notifyUserIds` — кому показать
 * уведомление в интерфейсе (realtime рассылает только им).
 */
export const TicketEventDataSchema = z
  .object({
    ticketId: z.string().uuid(),
    number: z.number(),
    conversationId: z.string().uuid(),
    status: z.enum(TICKET_STATUSES),
    enterpriseId: z.string().uuid().nullable(),
    departmentId: z.string().uuid().nullable(),
    topicId: z.string().uuid().nullable(),
    topicPath: z.array(z.string().uuid()),
    isImportant: z.boolean(),
    dueDate: z.string(),
    createdBy: z.string().uuid(),
    actorId: z.string().uuid().nullable().optional(),
    notifyUserIds: z.array(z.string().uuid()).default([]),
  })
  .passthrough();
export type TicketEventData = z.infer<typeof TicketEventDataSchema>;
