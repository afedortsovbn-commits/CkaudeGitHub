import { z } from 'zod';

/**
 * Нормализация телефонного номера к E.164 (M-TEL-06): «+375 (29) 123-45-67», «80291234567», «291234567» →
 * «+375291234567». Короткие внутренние номера (до 6 цифр — DID, добавочные) возвращаются как есть.
 * Возвращает null, если номер не распознан.
 */
export function normalizePhone(raw: string, countryCode = '375'): string | null {
  const s = raw.trim();
  if (!s) return null;
  const plus = s.startsWith('+') || s.startsWith('00');
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.slice(2);
  if (!digits) return null;
  if (plus) return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length <= 6) return digits;
  // Беларусь: междугородний префикс «8 0» + код (80 29 …), 9 цифр без префикса, 12 — с кодом страны.
  if (countryCode === '375') {
    if (digits.length === 11 && digits.startsWith('80')) return `+375${digits.slice(2)}`;
    if (digits.length === 9) return `+375${digits}`;
    if (digits.length === 12 && digits.startsWith('375')) return `+${digits}`;
  }
  if (digits.startsWith(countryCode) && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** Экземпляр голосового канала: входящие номера (DID) → очередь канала. */
export const VoiceChannelConfigSchema = z
  .object({
    /** Номера, на которые звонят клиенты (как их передаёт транк, в т.ч. короткие для демо и SIPp). */
    dids: z.array(z.string().trim().min(1).max(32)).min(1),
    /** Записывать разговоры (M-TEL-04). */
    record: z.boolean().default(true),
  })
  .passthrough();
export type VoiceChannelConfig = z.infer<typeof VoiceChannelConfigSchema>;

/** ivr — клиент в сценарии IVR (до очереди, после разговора — оценка, голосовое сообщение), Ф6. */
export const CALL_STATES = ['ivr', 'queued', 'dialing', 'talking', 'external', 'ended'] as const;
export type CallState = (typeof CALL_STATES)[number];

/** Состояние вызова в событии обращения `conversation.call` (для рабочего места и панели супервизора). */
export interface CallStateEvent {
  callId: string;
  state: CallState;
  direction: 'in' | 'out';
  onHold: boolean;
  agentUserId: string | null;
  endReason?: string | null;
  /** Идёт консультация (Ф12b): оператор говорит с адресатом, клиент на удержании. */
  consult?: CallConsultState | null;
  /**
   * Супервизор подключён к разговору (Ф14, M-TEL-10): прослушивание (оператор не видит), суфлирование (слышит только
   * оператор) или вмешательство (слышат оба).
   */
  supervisor?: { userId: string; mode: SupervisorMode } | null;
}

/** Режим подключения супервизора к разговору (Ф14). */
export const SUPERVISOR_MODES = ['listen', 'whisper', 'barge'] as const;
export type SupervisorMode = (typeof SUPERVISOR_MODES)[number];

/** Консультация оператора перед переводом (M-OP-05, M-TKT-11). */
export interface CallConsultState {
  /** dialing — адресату звонят, talking — оператор говорит с адресатом. */
  state: 'dialing' | 'talking';
  /** Кому: ФИО оператора или подразделение и номер. */
  label: string;
  /** Адресат-оператор (для внешнего номера — null). */
  userId: string | null;
}

/** SIP-пользователь оператора в Kamailio: op-<id сотрудника>. */
export const sipUserOf = (userId: string) => `op-${userId}`;
export const userIdOfSip = (sipUser: string): string | null =>
  /^op-([0-9a-f-]{36})$/i.exec(sipUser)?.[1] ?? null;

/**
 * Команда call-control от api (NATS request/reply на `cc.callctl.<узел>`; отвечает только активный
 * экземпляр узла). Ответ — CallControlReply.
 */
/** Адресат перевода или консультации: оператор, очередь, подразделение предприятия (очередь или внешний номер). */
export const CallTransferTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().uuid() }),
  z.object({ kind: z.literal('queue'), queueId: z.string().uuid() }),
  z.object({
    kind: z.literal('department'),
    enterpriseId: z.string().uuid(),
    departmentId: z.string().uuid(),
  }),
]);

export const CallControlCommandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('hold'), callId: z.string().uuid(), userId: z.string().uuid() }),
  z.object({ op: z.literal('unhold'), callId: z.string().uuid(), userId: z.string().uuid() }),
  z.object({ op: z.literal('hangup'), callId: z.string().uuid(), userId: z.string().uuid() }),
  z.object({
    op: z.literal('transfer'),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('user'), userId: z.string().uuid() }),
      z.object({ kind: z.literal('queue'), queueId: z.string().uuid() }),
      z.object({
        kind: z.literal('department'),
        enterpriseId: z.string().uuid(),
        departmentId: z.string().uuid(),
      }),
    ]),
    comment: z.string().max(1000).optional(),
  }),
  // Прослушивание (Ф5a); mode (Ф14) — сразу в режиме суфлирования или вмешательства.
  z.object({
    op: z.literal('listen'),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    mode: z.enum(SUPERVISOR_MODES).optional(),
  }),
  // Ф14: смена режима подключённого супервизора без переподключения; перехват звонка супервизором.
  z.object({
    op: z.literal('supervise'),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    mode: z.enum(SUPERVISOR_MODES),
  }),
  z.object({ op: z.literal('takeover'), callId: z.string().uuid(), userId: z.string().uuid() }),
  // Консультативный перевод (Ф12b): консультация с адресатом → соединить клиента с ним или вернуться к клиенту.
  z.object({
    op: z.literal('consult'),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    target: CallTransferTargetSchema,
  }),
  z.object({ op: z.literal('consult_complete'), callId: z.string().uuid(), userId: z.string().uuid() }),
  z.object({ op: z.literal('consult_cancel'), callId: z.string().uuid(), userId: z.string().uuid() }),
]);
export type CallControlCommand = z.infer<typeof CallControlCommandSchema>;
export interface CallControlReply {
  ok: boolean;
  error?: string;
}
export const callControlSubject = (node: string) => `cc.callctl.${node}`;

/** Настройки софтфона оператора: SIP-учётные данные (короткоживущие) и адрес WSS Kamailio. */
export interface SoftphoneConfig {
  wsUri: string;
  sipUri: string;
  authorizationUser: string;
  password: string;
  displayName: string;
  domain: string;
  expiresAt: string;
}
