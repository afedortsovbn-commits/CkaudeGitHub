import { INTEGRATION_SUBJECT, type IntegrationReply, newId, normalizePhone } from '@cc/contracts';
import {
  agentDoneToIvr,
  agentsOnShift,
  callEvent,
  createCallbackTask,
  enqueueFromIvr,
  emitCallState,
  leaveQueueToIvr,
  saveCsat,
  transferCallExternal,
} from '@cc/domain';
import {
  type Action,
  type EngineContext,
  type FlowEvent,
  type FlowGraph,
  type FlowState,
  type Media,
  replayFlow,
  resumeFlow,
  type Schedule,
  type StepResult,
} from '@cc/flow-engine';
import type { Logger } from '@cc/service-kit';
import type { NatsConnection } from 'nats';
import type { Pool, PoolClient } from 'pg';
import type { Ari } from './ari';
import type { RecordingStore } from './recordings';

/** Состояние вызова в IVR — `call.ivr_state`, сохраняется после каждого шага (02-архитектура 6.3). */
export interface IvrState {
  flow: FlowState;
  /** Текущее действие шага. */
  action: Action;
  /** Идентификатор шага: ответы, пришедшие к уже пройденному шагу (запоздалый HTTP-ответ), игнорируются. */
  token: string;
  /** Идущее проигрывание (останавливается цифрой, ответом оператора, при переключении call-control). */
  playback?: string | null;
  /** Меню/оценка: фраза отзвучала, ждём цифру до `call.ivr_wake_at`. */
  waiting?: boolean;
  /** Голосовое сообщение: приглашение или запись. */
  vm?: 'prompt' | 'recording';
  /** Очередь: момент постановки (мс), номер периодического сообщения, звучит ли оно сейчас. */
  queuedAt?: number;
  announceN?: number;
  announcing?: boolean;
  /** Оператор уже отвечал: таймеры очереди (сообщения, долгое ожидание) больше не действуют. */
  connected?: boolean;
}

export interface IvrCall {
  id: string;
  conversation_id: string;
  state: string;
  client_channel: string;
  agent_channel: string | null;
  flow_version_id: string | null;
  ivr_state: IvrState | null;
}

export interface IvrDeps {
  node: string;
  ari: Ari;
  pool: Pool;
  nc: NatsConnection;
  logger: Logger;
  store: RecordingStore;
  sipProxy: string;
  outboundCallerId: string;
  /** Адрес, по которому Asterisk забирает аудиофайлы библиотеки у call-control (res_http_media_cache). */
  mediaBaseUrl: string;
  stasisApp: string;
  tx<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T>;
  /** Поставить операцию в последовательную очередь узла (асинхронные ответы — HTTP-узел). */
  enqueue(fn: () => Promise<void>): void;
  isLeader(): boolean;
}

const HTTP_TIMEOUT_MS = 35_000;
const CACHE_MS = 5_000;

/**
 * Исполнение сценариев IVR на узле Asterisk (M-IVR-*, 02-архитектура 4.2, 6.3). Логика шагов — в
 * flow-engine; здесь — ввод-вывод через ARI: проигрывание, DTMF, таймеры (дедлайн в БД, проверка тиком
 * активного экземпляра), очередь с сообщениями, запрос во внешнюю систему через api, голосовое сообщение,
 * перевод на номер, CSAT. Состояние после каждого шага — в `call.ivr_state`; новый активный экземпляр
 * продолжает сценарий с сохранённого шага, повторяя его с начала (`recover`).
 */
export class IvrRunner {
  private readonly graphs = new Map<string, { graph: FlowGraph; flowId: string }>();
  private schedules: { at: number; value: Record<string, Schedule> } | null = null;
  private fragments: { at: number; value: Map<string, string> } | null = null;

  constructor(private readonly d: IvrDeps) {}

  // ------------------------------------------------------------------ данные сценария

  async graph(versionId: string): Promise<{ graph: FlowGraph; flowId: string }> {
    const cached = this.graphs.get(versionId);
    if (cached) return cached;
    const { rows } = await this.d.pool.query<{ graph: FlowGraph; flow_id: string }>(
      `SELECT graph, flow_id FROM flow_version WHERE id = $1`,
      [versionId],
    );
    if (!rows[0]) throw new Error(`версия сценария ${versionId} не найдена`);
    // Версии неизменяемы — кэш без срока.
    const v = { graph: rows[0].graph, flowId: rows[0].flow_id };
    this.graphs.set(versionId, v);
    return v;
  }

  async context(): Promise<EngineContext> {
    if (!this.schedules || Date.now() - this.schedules.at > CACHE_MS) {
      const { rows } = await this.d.pool.query<{
        id: string;
        timezone: string;
        week: Schedule['week'];
        holidays: string[];
      }>(`SELECT id, timezone, week, holidays::text[] AS holidays FROM schedule WHERE is_active`);
      this.schedules = {
        at: Date.now(),
        value: Object.fromEntries(
          rows.map((r) => [r.id, { timezone: r.timezone, week: r.week, holidays: r.holidays }]),
        ),
      };
    }
    return { now: new Date(), schedules: this.schedules.value };
  }

  private async fragmentIds(): Promise<Map<string, string>> {
    if (!this.fragments || Date.now() - this.fragments.at > CACHE_MS) {
      const { rows } = await this.d.pool.query<{ fragment_key: string; id: string }>(
        `SELECT fragment_key, id FROM audio_file WHERE kind = 'fragment' AND is_active`,
      );
      this.fragments = { at: Date.now(), value: new Map(rows.map((r) => [r.fragment_key, r.id])) };
    }
    return this.fragments.value;
  }

  private async mediaUris(c: IvrCall, media: Media[]): Promise<string[]> {
    const ids: string[] = [];
    for (const m of media) {
      if (m.kind === 'audio') ids.push(m.id);
      else if (m.kind === 'fragment') {
        const id = (await this.fragmentIds()).get(m.key);
        if (id) ids.push(id);
        else this.d.logger.warn({ key: m.key }, 'нет фрагмента числа в аудиобиблиотеке');
      } else {
        // Действующие объявления о сбоях (M-IVR-04) — на момент проигрывания.
        const flowId = c.flow_version_id ? (await this.graph(c.flow_version_id)).flowId : null;
        const { rows } = await this.d.pool.query<{ audio_id: string }>(
          `SELECT a.audio_id FROM announcement a JOIN audio_file f ON f.id = a.audio_id AND f.is_active
            WHERE a.is_active AND (a.starts_at IS NULL OR a.starts_at <= now()) AND (a.ends_at IS NULL OR a.ends_at > now())
              AND (cardinality(a.flow_ids) = 0 OR $1::uuid = ANY (a.flow_ids))
            ORDER BY a.sort_order, a.created_at`,
          [flowId],
        );
        ids.push(...rows.map((r) => r.audio_id));
      }
    }
    return ids.map((id) => `sound:${this.d.mediaBaseUrl}/media/${id}.wav`);
  }

  private async load(callId: string): Promise<IvrCall | undefined> {
    const { rows } = await this.d.pool.query<IvrCall>(
      `SELECT id, conversation_id, state, client_channel, agent_channel, flow_version_id, ivr_state
         FROM call WHERE id = $1 AND node = $2 AND state <> 'ended'`,
      [callId, this.d.node],
    );
    return rows[0];
  }

  private async save(callId: string, st: IvrState, wakeAt: Date | null = null): Promise<void> {
    await this.d.pool.query(
      `UPDATE call SET ivr_state = $2, ivr_wake_at = $3, updated_at = now() WHERE id = $1`,
      [callId, JSON.stringify(st), wakeAt],
    );
  }

  // ------------------------------------------------------------------ шаги

  /** Выполнить результат шага: эффекты (оценка), сохранение состояния, журнал пути, действие. */
  async perform(c: IvrCall, r: StepResult, log = true): Promise<void> {
    const st: IvrState = {
      flow: r.state,
      action: r.action,
      token: newId(),
      connected: c.ivr_state?.connected,
    };
    await this.d.tx(async (tx) => {
      for (const e of r.effects) if (e.type === 'csat') await saveCsat(tx, c.id, e.score);
      await tx.query(
        `UPDATE call SET ivr_state = $2, ivr_wake_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
        [c.id, JSON.stringify(st)],
      );
      if (log)
        for (const p of r.path)
          await callEvent(tx, c.id, 'ivr', null, {
            node: p.nodeId,
            type: p.type,
            ...(p.name ? { name: p.name } : {}),
            ...(p.exit ? { exit: p.exit } : {}),
          });
    });
    await this.execute({ ...c, ivr_state: st }, st);
  }

  private async resume(c: IvrCall, st: IvrState, event: FlowEvent): Promise<void> {
    if (!c.flow_version_id) return;
    const { graph } = await this.graph(c.flow_version_id);
    const r = resumeFlow(graph, st.flow, event, await this.context());
    if (r) await this.perform({ ...c, ivr_state: st }, r);
  }

  private async play(
    c: IvrCall,
    st: IvrState,
    media: Media[],
    extra: Partial<IvrState> = {},
  ): Promise<boolean> {
    const uris = await this.mediaUris(c, media);
    if (!uris.length) return false;
    const playback = `${st.token}.${newId().slice(-8)}`;
    await this.save(c.id, { ...st, ...extra, playback });
    await this.d.ari.channels.mohStop(c.client_channel);
    await this.d.ari.channels.play(c.client_channel, playback, uris);
    return true;
  }

  private async execute(c: IvrCall, st: IvrState): Promise<void> {
    const a = st.action;
    const ch = c.client_channel;
    switch (a.type) {
      case 'play':
        if (!(await this.play(c, st, a.media))) await this.resume(c, st, { type: 'done' });
        return;
      case 'collect':
        if (!(await this.play(c, st, a.media))) await this.startWaiting(c, st);
        return;
      case 'hangup':
        if (!(await this.play(c, st, a.media))) await this.d.ari.channels.hangup(ch);
        return;
      case 'http': {
        const token = st.token;
        const req = {
          operationId: a.operationId,
          input: a.input,
          source: 'ivr',
          callId: c.id,
          conversationId: c.conversation_id,
        };
        void this.d.nc
          .request(INTEGRATION_SUBJECT, JSON.stringify(req), { timeout: HTTP_TIMEOUT_MS })
          .then((m) => m.json<IntegrationReply>())
          .catch(
            (err: unknown): IntegrationReply => ({
              ok: false,
              outputs: {},
              error: `api недоступен: ${String(err)}`,
              durationMs: 0,
            }),
          )
          .then((reply) => this.d.enqueue(() => this.httpDone(c.id, token, reply)));
        return;
      }
      case 'queue': {
        if (a.checkAgents && (await agentsOnShift(this.d.pool, a.queueId)) === 0)
          return this.resume(c, st, { type: 'queue', result: 'noAgents' });
        const ok = await this.d.tx((tx) =>
          enqueueFromIvr(tx, c.id, { queueId: a.queueId, topicId: a.topicId, priority: a.priority }),
        );
        if (!ok) {
          this.d.logger.warn({ callId: c.id, queueId: a.queueId }, 'IVR: очередь недоступна');
          return this.resume(c, st, { type: 'queue', result: 'noAgents' });
        }
        const next = { ...st, queuedAt: Date.now(), announceN: 0 };
        await this.save(c.id, next, this.nextQueueWake(next));
        await this.d.ari.channels.mohStart(ch);
        return;
      }
      case 'voicemail':
        if (!(await this.play(c, st, a.media, { vm: 'prompt' })))
          await this.startVoicemail(c, { ...st, vm: 'prompt' });
        return;
      case 'transfer': {
        const number = normalizePhone(a.number) ?? a.number;
        const ext = newId();
        await this.d.tx((tx) =>
          transferCallExternal(tx, c.id, {
            extChannel: ext,
            number,
            byUserId: null,
            message: `IVR: перевод на номер ${number}`,
            data: { from: 'ivr' },
          }),
        );
        await this.d.ari.channels.mohStart(ch);
        try {
          await this.d.ari.channels.originate({
            endpoint: `PJSIP/trunk/sip:${number}@${this.d.sipProxy}`,
            channelId: ext,
            app: this.d.stasisApp,
            appArgs: `external,${c.id}`,
            callerId: this.d.outboundCallerId,
            timeout: 40,
          });
        } catch (err) {
          this.d.logger.warn({ err: String(err) }, 'IVR: перевод на номер не удался');
          await this.transferFailed(c.id);
        }
        return;
      }
    }
  }

  private async startWaiting(c: IvrCall, st: IvrState): Promise<void> {
    if (st.action.type !== 'collect') return;
    await this.save(
      c.id,
      { ...st, playback: null, waiting: true },
      new Date(Date.now() + st.action.timeoutSec * 1000),
    );
  }

  private async startVoicemail(c: IvrCall, st: IvrState): Promise<void> {
    if (st.action.type !== 'voicemail') return;
    const a = st.action;
    if (a.mode === 'callback') {
      await this.d.tx((tx) =>
        createCallbackTask(tx, c.id, { queueId: a.queueId, mode: 'callback', withRecording: false }),
      );
      return this.resume(c, st, { type: 'done' });
    }
    const name = `vm-${c.id}`;
    await this.d.pool.query(
      `INSERT INTO call_recording (id, call_id, conversation_id, node, name, kind) VALUES ($1, $2, $3, $4, $5, 'voicemail')
       ON CONFLICT (node, name) DO NOTHING`,
      [newId(), c.id, c.conversation_id, this.d.node, name],
    );
    await this.save(c.id, { ...st, vm: 'recording', playback: null });
    try {
      await this.d.ari.channels.recordMessage(c.client_channel, name, a.maxSec);
    } catch (err) {
      this.d.logger.warn({ err: String(err), callId: c.id }, 'IVR: не удалось начать запись сообщения');
      await this.d.store.failed(this.d.node, name);
      await this.voicemailDone(c.id, false);
    }
  }

  private nextQueueWake(st: IvrState): Date | null {
    if (st.action.type !== 'queue' || st.connected) return null;
    const a = st.action;
    const t: number[] = [];
    if (a.announceEverySec && a.announceAudio.length)
      t.push((st.queuedAt ?? Date.now()) + a.announceEverySec * 1000 * ((st.announceN ?? 0) + 1));
    if (a.maxWaitSec) t.push((st.queuedAt ?? Date.now()) + a.maxWaitSec * 1000);
    return t.length ? new Date(Math.min(...t)) : null;
  }

  // ------------------------------------------------------------------ события

  /** Проигрывание закончилось (или остановлено) — следующий шаг. */
  async playbackFinished(playbackId: string): Promise<void> {
    const { rows } = await this.d.pool.query<IvrCall>(
      `SELECT id, conversation_id, state, client_channel, agent_channel, flow_version_id, ivr_state FROM call
        WHERE node = $1 AND state IN ('ivr', 'queued') AND ivr_state ->> 'playback' = $2`,
      [this.d.node, playbackId],
    );
    const c = rows[0];
    const st = c?.ivr_state;
    if (!c || !st) return;
    if (c.state === 'queued') {
      // Периодическое сообщение в очереди отзвучало — снова музыка.
      await this.save(c.id, { ...st, playback: null, announcing: false }, this.nextQueueWake(st));
      await this.d.ari.channels.mohStart(c.client_channel);
      return;
    }
    const a = st.action;
    if (a.type === 'play') return this.resume(c, st, { type: 'done' });
    if (a.type === 'collect') return this.startWaiting(c, st);
    if (a.type === 'hangup') return this.d.ari.channels.hangup(c.client_channel);
    if (a.type === 'voicemail' && st.vm === 'prompt') return this.startVoicemail(c, st);
  }

  /** Цифра DTMF от клиента: ответ в меню или оценка; фраза прерывается. */
  async digit(channelId: string, digit: string): Promise<void> {
    const { rows } = await this.d.pool.query<IvrCall>(
      `SELECT id, conversation_id, state, client_channel, agent_channel, flow_version_id, ivr_state FROM call
        WHERE node = $1 AND state = 'ivr' AND client_channel = $2`,
      [this.d.node, channelId],
    );
    const c = rows[0];
    const st = c?.ivr_state;
    if (!c || !st || st.action.type !== 'collect') return;
    if (st.playback) await this.d.ari.playbacks.stop(st.playback);
    await this.d.tx((tx) => callEvent(tx, c.id, 'ivr_dtmf', null, { digit }));
    await this.resume(c, st, { type: 'digit', digit });
  }

  private async httpDone(callId: string, token: string, reply: IntegrationReply): Promise<void> {
    if (!this.d.isLeader()) return;
    const c = await this.load(callId);
    const st = c?.ivr_state;
    if (!c || !st || c.state !== 'ivr' || st.token !== token) return; // шаг уже пройден или повторён
    await this.d.tx((tx) =>
      callEvent(tx, c.id, 'ivr_http', null, {
        ok: reply.ok,
        ...(reply.error ? { error: reply.error } : {}),
        durationMs: reply.durationMs,
      }),
    );
    await this.resume(c, st, { type: 'http', ok: reply.ok, outputs: reply.outputs ?? {} });
  }

  /** Голосовое сообщение записано (или клиент прервал запись) — задача «перезвонить», дальше по сценарию. */
  async voicemailDone(callId: string, recorded: boolean): Promise<void> {
    const c = await this.load(callId);
    const st = c?.ivr_state;
    if (!c || !st || c.state !== 'ivr' || st.action.type !== 'voicemail' || st.vm !== 'recording') return;
    const a = st.action;
    await this.d.tx((tx) =>
      createCallbackTask(tx, c.id, { queueId: a.queueId, mode: 'voicemail', withRecording: recorded }),
    );
    await this.resume(c, st, { type: 'done' });
  }

  /** Тик: истёк таймаут ввода, пора периодическому сообщению или вышло максимальное ожидание в очереди. */
  async wake(): Promise<void> {
    const { rows } = await this.d.pool.query<IvrCall>(
      `SELECT id, conversation_id, state, client_channel, agent_channel, flow_version_id, ivr_state FROM call
        WHERE node = $1 AND state <> 'ended' AND ivr_wake_at <= now() ORDER BY ivr_wake_at LIMIT 20`,
      [this.d.node],
    );
    for (const c of rows) {
      const st = c.ivr_state;
      if (!st) {
        await this.d.pool.query(`UPDATE call SET ivr_wake_at = NULL WHERE id = $1`, [c.id]);
        continue;
      }
      if (c.state === 'ivr' && st.action.type === 'collect' && st.waiting) {
        await this.resume(c, st, { type: 'timeout' });
      } else if (c.state === 'queued' && st.action.type === 'queue' && !st.connected) {
        await this.queueTimers(c, st);
      } else if (c.state === 'dialing') {
        // Оператору звонят: таймеры очереди ждут исхода (ответ — таймеры снимаются, неответ — продолжаются).
        await this.d.pool.query(`UPDATE call SET ivr_wake_at = now() + interval '2 seconds' WHERE id = $1`, [
          c.id,
        ]);
      } else {
        await this.d.pool.query(`UPDATE call SET ivr_wake_at = NULL WHERE id = $1`, [c.id]);
      }
    }
  }

  private async queueTimers(c: IvrCall, st: IvrState): Promise<void> {
    if (st.action.type !== 'queue') return;
    const a = st.action;
    const now = Date.now();
    if (a.maxWaitSec && now >= (st.queuedAt ?? now) + a.maxWaitSec * 1000) {
      const left = await this.d.tx((tx) => leaveQueueToIvr(tx, c.id, 'timeout'));
      if (left) {
        if (st.playback) await this.d.ari.playbacks.stop(st.playback);
        await this.d.ari.channels.mohStop(c.client_channel);
        return this.resume(
          { ...c, state: 'ivr' },
          { ...st, playback: null },
          { type: 'queue', result: 'timeout' },
        );
      }
      // Обращение как раз предлагается оператору — проверим ещё раз чуть позже.
      await this.save(c.id, st, new Date(now + 3000));
      return;
    }
    const n = (st.announceN ?? 0) + 1;
    const due = a.announceEverySec && (st.queuedAt ?? now) + a.announceEverySec * 1000 * n <= now;
    if (due && !st.announcing) {
      const next = { ...st, announceN: n, announcing: true };
      const played = await this.play(
        c,
        next,
        a.announceAudio.map((id) => ({ kind: 'audio', id })),
        {
          announcing: true,
        },
      );
      const after = played ? { ...next } : { ...next, announcing: false };
      await this.d.pool.query(`UPDATE call SET ivr_wake_at = $2 WHERE id = $1`, [
        c.id,
        this.nextQueueWake(after),
      ]);
      return;
    }
    await this.save(c.id, st, this.nextQueueWake({ ...st, announceN: due ? n : st.announceN }));
  }

  /** Оператор ответил: сообщение в очереди прерывается, таймеры очереди больше не действуют. */
  async agentConnected(c: IvrCall): Promise<void> {
    const st = c.ivr_state;
    if (!st) return;
    if (st.playback) await this.d.ari.playbacks.stop(st.playback);
    await this.save(c.id, { ...st, playback: null, announcing: false, connected: true }, null);
  }

  /**
   * Оператор завершил разговор. true — у сценария есть продолжение «после разговора» (автосообщение,
   * CSAT), клиент остаётся на линии; false — звонок завершается как обычно.
   */
  async afterAgent(c: IvrCall & { bridge_id: string | null }): Promise<boolean> {
    const st = c.ivr_state;
    if (!st || !c.flow_version_id || st.action.type !== 'queue') return false;
    const { graph } = await this.graph(c.flow_version_id);
    const r = resumeFlow(graph, st.flow, { type: 'queue', result: 'after' }, await this.context());
    if (!r || (r.action.type === 'hangup' && !r.action.media.length)) return false;
    if (c.bridge_id) await this.d.ari.bridges.destroy(c.bridge_id);
    await this.d.ari.channels.mohStop(c.client_channel);
    const moved = await this.d.tx((tx) => agentDoneToIvr(tx, c.id));
    if (!moved) return false;
    await this.perform({ ...c, state: 'ivr' }, r);
    return true;
  }

  /** Перевод на номер из IVR не состоялся — дальше по выходу «не удалось». */
  async transferFailed(callId: string): Promise<boolean> {
    const c = await this.load(callId);
    const st = c?.ivr_state;
    if (!c || !st || c.state !== 'external' || st.action.type !== 'transfer') return false;
    await this.d.tx(async (tx) => {
      await tx.query(
        `UPDATE call SET state = 'ivr', agent_channel = NULL, on_hold = false, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [c.id],
      );
      await callEvent(tx, c.id, 'transfer_failed');
      await emitCallState(tx, c.id);
    });
    await this.d.ari.channels.mohStop(c.client_channel);
    await this.resume({ ...c, state: 'ivr' }, st, { type: 'transfer', ok: false });
    return true;
  }

  /** Клиент положил трубку во время записи сообщения — сообщение сохраняется, задача создаётся. */
  async clientGone(c: IvrCall): Promise<void> {
    const st = c.ivr_state;
    if (c.state !== 'ivr' || st?.action.type !== 'voicemail' || st.vm !== 'recording') return;
    const a = st.action;
    await this.d.pool.query(
      `UPDATE call_recording SET status = 'pending_upload' WHERE node = $1 AND name = $2 AND status = 'recording'`,
      [this.d.node, `vm-${c.id}`],
    );
    await this.d.tx((tx) =>
      createCallbackTask(tx, c.id, { queueId: a.queueId, mode: 'voicemail', withRecording: true }),
    );
  }

  /**
   * После переключения call-control (сверка): события за время разрыва потеряны — текущий шаг
   * повторяется с начала (фраза переигрывается, ожидание цифры — заново). Критерий — пауза ≤ 3 с.
   */
  async recover(c: IvrCall): Promise<void> {
    const st = c.ivr_state;
    if (!st || !c.flow_version_id) return;
    if (st.playback) await this.d.ari.playbacks.stop(st.playback);
    // Для журнала вызова и проверки паузы при переключении (DoD Ф6: штатное ≤ 3 с, аварийное ≤ 8 с).
    await this.d.tx((tx) => callEvent(tx, c.id, 'ivr_resumed', null, { node: st.flow.node, state: c.state }));
    if (c.state === 'queued') {
      await this.save(c.id, { ...st, playback: null, announcing: false }, this.nextQueueWake(st));
      return; // музыку включает общая сверка
    }
    if (st.action.type === 'voicemail' && st.vm === 'recording') {
      // Запись на узле шла без нас — останавливаем и сохраняем то, что успел сказать клиент.
      await this.d.ari.recordings.stopLive(`vm-${c.id}`);
      await this.d.store.finished(this.d.node, { name: `vm-${c.id}` });
      return this.voicemailDone(c.id, true);
    }
    const { graph } = await this.graph(c.flow_version_id);
    const r = replayFlow(graph, st.flow, await this.context());
    this.d.logger.info({ callId: c.id, node: st.flow.node }, 'IVR: сценарий продолжен после переключения');
    await this.perform(c, r, false);
  }
}
