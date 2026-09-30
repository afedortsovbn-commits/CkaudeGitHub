import {
  type CallControlCommand,
  CallControlCommandSchema,
  type CallControlReply,
  callControlSubject,
  CONVERSATION_EVENTS,
  newId,
  normalizePhone,
  sipUserOf,
  userIdOfSip,
} from '@cc/contracts';
import {
  agentLegFailed,
  callEvent,
  completeConsult,
  type ConsultTarget,
  connectAgent,
  consultConnected,
  directTransferData,
  emitCallState,
  emitConversation,
  endCall,
  endConsult,
  loadRef,
  publishedFlowForDid,
  setCallHold,
  startConsult,
  startInboundCall,
  startOutboundCall,
  transferCallExternal,
  transferCallToQueue,
  transferCallToUser,
} from '@cc/domain';
import { type FlowGraph, startFlow } from '@cc/flow-engine';
import { KvLease, type Logger } from '@cc/service-kit';
import type { KV, Msg, NatsConnection, Subscription } from 'nats';
import type { Pool, PoolClient } from 'pg';
import { type Ari, type AriChannel, type AriEvent } from './ari';
import { type IvrState, IvrRunner } from './ivr';
import type { RecordingStore } from './recordings';

export const STASIS_APP = 'cc';

export interface NodeOptions {
  name: string;
  ari: Ari;
  pool: Pool;
  nc: NatsConnection;
  leases: KV;
  instanceId: string;
  logger: Logger;
  store: RecordingStore;
  /** Адрес Kamailio для вызовов из узла: операторам (WSS) и в транк. */
  sipProxy: string;
  tickMs: number;
  outboundCallerId: string;
  /** Адрес call-control для Asterisk: аудиофайлы IVR (http://call-control:3000). */
  mediaBaseUrl: string;
  onLeadership?: (node: string, leader: boolean) => void;
}

interface CallRow {
  id: string;
  conversation_id: string;
  direction: 'in' | 'out';
  node: string;
  state: 'ivr' | 'queued' | 'dialing' | 'talking' | 'external' | 'ended';
  client_channel: string;
  agent_channel: string | null;
  agent_user_id: string | null;
  bridge_id: string | null;
  on_hold: boolean;
  to_number: string | null;
  flow_version_id: string | null;
  ivr_state: IvrState | null;
  consult_channel: string | null;
  consult_state: 'dialing' | 'talking' | null;
  consult_user_id: string | null;
  consult_target: ConsultTarget | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class CommandError extends Error {}

/**
 * Один узел Asterisk под управлением call-control (02-архитектура 6.3): активный экземпляр держит аренду
 * узла в NATS KV и подключение ARI, резервный ждёт. Состояние вызовов — в БД, поэтому новый активный после
 * переключения выполняет сверку (`reconcile`) и продолжает: разговоры держит мост Asterisk, их переключение
 * call-control не затрагивает. Все операции узла выполняются последовательно — без гонок между событиями
 * ARI, командами api и периодическим тиком.
 */
export class MediaNode {
  private readonly lease: KvLease;
  private leader = false;
  private stopped = false;
  private loop?: Promise<void>;
  private events?: { close(): void };
  private sub?: Subscription;
  private timer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();
  private ticking = false;
  /** Прослушивание супервизором: канал супервизора → snoop-канал и мост (эфемерно, не переживает переключение). */
  private readonly listens = new Map<string, { snoop: string; bridge: string | null; callId: string }>();

  private readonly ivr: IvrRunner;

  constructor(private readonly o: NodeOptions) {
    this.lease = new KvLease(o.leases, `media.${o.name}`, o.instanceId);
    this.ivr = new IvrRunner({
      node: o.name,
      ari: o.ari,
      pool: o.pool,
      nc: o.nc,
      logger: o.logger,
      store: o.store,
      sipProxy: o.sipProxy,
      outboundCallerId: o.outboundCallerId,
      mediaBaseUrl: o.mediaBaseUrl,
      stasisApp: STASIS_APP,
      tx: (fn) => this.tx(fn),
      enqueue: (fn) => void this.enqueue(fn),
      isLeader: () => this.leader,
    });
  }

  get name(): string {
    return this.o.name;
  }
  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    this.loop = this.run();
  }

  /** Корректная остановка: текущая операция завершается, аренда отдаётся — резервный подхватывает сразу. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    await this.stepDown('остановка экземпляра');
    await this.lease.release();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const held = await this.lease.refresh();
        if (held && !this.leader) await this.becomeLeader();
        else if (!held && this.leader) await this.stepDown('аренда узла потеряна');
      } catch (err) {
        this.o.logger.warn({ err: String(err), node: this.o.name }, 'ошибка аренды узла');
      }
      await sleep(this.leader ? 1000 : 500);
    }
  }

  private async becomeLeader(): Promise<void> {
    this.leader = true;
    this.o.logger.info({ node: this.o.name }, 'call-control: активный для узла');
    this.o.onLeadership?.(this.o.name, true);
    this.connect();
    this.sub = this.o.nc.subscribe(callControlSubject(this.o.name), {
      callback: (err, msg) => {
        if (!err) void this.enqueue(() => this.command(msg));
      },
    });
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.enqueue(() => this.tick()).finally(() => (this.ticking = false));
    }, this.o.tickMs);
  }

  private async stepDown(why: string): Promise<void> {
    if (!this.leader) return;
    this.leader = false;
    clearInterval(this.timer);
    this.sub?.unsubscribe();
    this.events?.close();
    this.events = undefined;
    await this.chain.catch(() => undefined);
    this.o.onLeadership?.(this.o.name, false);
    this.o.logger.info({ node: this.o.name, why }, 'call-control: узел передан резервному');
  }

  private connect(): void {
    if (!this.leader || this.stopped) return;
    this.events = this.o.ari.events(
      STASIS_APP,
      (e) => void this.enqueue(() => this.onEvent(e)),
      () => {
        this.o.logger.info({ node: this.o.name }, 'ARI подключён, сверка вызовов');
        void this.enqueue(() => this.reconcile());
      },
      (why) => {
        if (!this.leader || this.stopped) return;
        this.o.logger.warn({ node: this.o.name, why }, 'ARI отключён, переподключение');
        setTimeout(() => this.connect(), 1000);
      },
    );
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const p = this.chain.then(fn).catch((err: unknown) => {
      this.o.logger.error({ err: String(err), node: this.o.name }, 'ошибка обработки вызова');
      return undefined;
    });
    this.chain = p;
    return p;
  }

  private async tx<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.o.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async call(where: string, params: unknown[]): Promise<CallRow | undefined> {
    const { rows } = await this.o.pool.query<CallRow>(
      `SELECT * FROM call WHERE node = $1 AND state <> 'ended' AND ${where} LIMIT 1`,
      [this.o.name, ...params],
    );
    return rows[0];
  }

  // ------------------------------------------------------------------ события ARI

  private async onEvent(e: AriEvent): Promise<void> {
    if (!this.leader) return;
    if (e.type === 'StasisStart' && e.channel) await this.started(e.channel, e.args ?? []);
    // Канал, вошедший в Stasis, при отбое получает StasisEnd (после него подписка приложения снимается и
    // ChannelDestroyed не приходит); неотвеченный исходящий (в Stasis не входил) — ChannelDestroyed с причиной.
    // Мы никогда не возвращаем каналы в диалплан, поэтому StasisEnd = канал завершён.
    else if (e.type === 'StasisEnd' && e.channel) await this.gone(e.channel.id, 16);
    else if (e.type === 'ChannelDestroyed' && e.channel) await this.gone(e.channel.id, e.cause ?? 16);
    else if (e.type === 'RecordingFinished' && e.recording) {
      await this.o.store.finished(this.o.name, e.recording);
      if (e.recording.name.startsWith('vm-'))
        await this.ivr.voicemailDone(e.recording.name.slice(3), (e.recording.duration ?? 1) > 0);
    } else if (e.type === 'RecordingFailed' && e.recording) {
      await this.o.store.failed(this.o.name, e.recording.name);
      if (e.recording.name.startsWith('vm-')) await this.ivr.voicemailDone(e.recording.name.slice(3), false);
    } else if (e.type === 'PlaybackFinished' && e.playback) await this.ivr.playbackFinished(e.playback.id);
    else if (e.type === 'ChannelDtmfReceived' && e.channel && e.digit)
      await this.ivr.digit(e.channel.id, e.digit);
  }

  private async started(ch: AriChannel, args: string[]): Promise<void> {
    const [kind, a1 = '', a2 = ''] = args;
    switch (kind) {
      case 'operator':
        return this.agentAnswered(a1, ch);
      case 'outpeer':
        return this.peerAnswered(a1, ch);
      case 'external':
        return this.externalAnswered(a1, ch);
      case 'consult':
        return this.consultAnswered(a1, ch);
      case 'listen':
        return this.listenAnswered(a1, a2, ch);
      case 'snoop':
        return;
      case 'recorder':
        return this.recorderReady(a1, ch);
      case 'trunk':
      case 'webrtc':
        return this.newCall(ch, kind, a1);
      default:
        await this.o.ari.channels.hangup(ch.id);
    }
  }

  /** Новый вызов из диалплана: исходящий оператора (браузер op-…) либо входящий клиента. */
  private async newCall(ch: AriChannel, leg: string, did: string): Promise<void> {
    if (await this.call('(client_channel = $2 OR agent_channel = $2)', [ch.id])) return; // уже обработан
    const opUser = leg === 'webrtc' ? userIdOfSip(ch.caller.number) : null;
    if (opUser) return this.operatorOutbound(ch, opUser, did);
    const number = ch.caller.number?.startsWith('demo-') ? ch.caller.number.slice(5) : ch.caller.number;
    await this.o.ari.channels.answer(ch.id);
    // Сценарий IVR, опубликованный для номера (M-IVR-07): вызов запоминает версию и доигрывает её (M-IVR-06).
    const flow = await this.tx((tx) => publishedFlowForDid(tx, did));
    const step = flow
      ? startFlow(
          flow.graph as FlowGraph,
          { caller: normalizePhone(number ?? '') ?? number ?? '', did },
          await this.ivr.context(),
        )
      : null;
    const r = await this.tx((tx) =>
      startInboundCall(tx, {
        node: this.o.name,
        clientChannel: ch.id,
        callerNumber: number || null,
        callerName: ch.caller.name || null,
        did,
        ...(flow && step
          ? {
              ivr: {
                flowVersionId: flow.versionId,
                flowName: `${flow.flowName}, версия ${flow.version}`,
                state: { flow: step.state, action: step.action, token: 'start' },
              },
            }
          : {}),
      }),
    );
    if (!r) {
      this.o.logger.warn({ did }, 'нет голосового канала для номера — вызов отклонён');
      await this.o.ari.channels.hangup(ch.id, 'congestion');
      return;
    }
    if (step) {
      this.o.logger.info(
        { node: this.o.name, callId: r.callId, did, flow: flow!.flowName },
        'входящий вызов в IVR',
      );
      const c = await this.call('id = $2', [r.callId]);
      if (c) await this.ivr.perform(c, step);
      return;
    }
    await this.o.ari.channels.mohStart(ch.id);
    this.o.logger.info({ node: this.o.name, callId: r.callId, did }, 'входящий вызов в очереди');
  }

  private async operatorOutbound(ch: AriChannel, userId: string, number: string): Promise<void> {
    const header = await this.o.ari.channels.getVar(ch.id, 'PJSIP_HEADER(read,X-CC-Conversation)');
    const conversationId = header && /^[0-9a-f-]{36}$/i.test(header) ? header : null;
    const peer = newId();
    const r = await this.tx((tx) =>
      startOutboundCall(tx, {
        node: this.o.name,
        agentChannel: ch.id,
        peerChannel: peer,
        userId,
        number,
        conversationId,
      }),
    );
    if ('error' in r) {
      this.o.logger.warn({ number, error: r.error }, 'исходящий вызов отклонён');
      await this.o.ari.channels.hangup(ch.id, 'unallocated');
      return;
    }
    const c = await this.call('id = $2', [r.callId]);
    await this.o.ari.channels.ring(ch.id);
    try {
      await this.o.ari.channels.originate({
        endpoint: `PJSIP/trunk/sip:${c!.to_number}@${this.o.sipProxy}`,
        channelId: peer,
        app: STASIS_APP,
        appArgs: `outpeer,${r.callId}`,
        callerId: this.o.outboundCallerId,
        timeout: 60,
      });
    } catch (err) {
      this.o.logger.warn({ err: String(err) }, 'не удалось начать исходящий вызов');
      await this.tx((tx) => endCall(tx, r.callId, 'failed'));
      await this.o.ari.channels.hangup(ch.id);
    }
  }

  private async ensureBridge(c: CallRow): Promise<string> {
    if (c.bridge_id) {
      try {
        await this.o.ari.bridges.get(c.bridge_id);
        return c.bridge_id;
      } catch {
        /* мост исчез (узел перезапускался) — создаём заново */
      }
    }
    const id = c.bridge_id ?? newId();
    await this.o.ari.bridges.create(id, `call-${c.id}`);
    await this.o.pool.query(`UPDATE call SET bridge_id = $2 WHERE id = $1`, [c.id, id]);
    return id;
  }

  /**
   * Запись разговора (M-TEL-04) — одна на вызов: snoop-канал клиента в обе стороны (аналог MixMonitor) пишет
   * всё, что клиент говорит и слышит, независимо от удержаний, переводов и смены моста. Запись завершается
   * вместе с каналом клиента. Если в голосовом канале запись выключена — не пишется.
   */
  private async startRecording(c: CallRow): Promise<void> {
    const { rows } = await this.o.pool.query<{ record: boolean; exists: boolean }>(
      `SELECT COALESCE((ch.config ->> 'record')::boolean, true) AS record,
              EXISTS (SELECT 1 FROM call_recording r WHERE r.call_id = $1) AS exists
         FROM conversation cv JOIN channel ch ON ch.id = cv.channel_id WHERE cv.id = $2`,
      [c.id, c.conversation_id],
    );
    if (!rows[0]?.record || rows[0].exists) return;
    await this.o.pool.query(
      `INSERT INTO call_recording (id, call_id, conversation_id, node, name) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (node, name) DO NOTHING`,
      [newId(), c.id, c.conversation_id, this.o.name, `cc-${c.id}`],
    );
    await this.o.ari.channels.snoop(c.client_channel, {
      snoopId: newId(),
      app: STASIS_APP,
      appArgs: `recorder,${c.id}`,
    });
  }

  /** Snoop-канал записи вошёл в Stasis — начинаем запись в файл на узле. */
  private async recorderReady(callId: string, ch: AriChannel): Promise<void> {
    try {
      await this.o.ari.channels.record(ch.id, `cc-${callId}`);
    } catch (err) {
      this.o.logger.warn({ err: String(err), callId }, 'не удалось начать запись разговора');
      await this.o.store.failed(this.o.name, `cc-${callId}`);
    }
  }

  private async userName(userId: string | null): Promise<string> {
    if (!userId) return '';
    const { rows } = await this.o.pool.query<{ full_name: string }>(
      `SELECT full_name FROM app_user WHERE id = $1`,
      [userId],
    );
    return rows[0]?.full_name ?? '';
  }

  /** Оператор ответил на звонок: клиент и оператор — в мосту, музыка выключается, идёт запись. */
  private async agentAnswered(callId: string, agent: AriChannel): Promise<void> {
    const c = await this.call('id = $2', [callId]);
    if (!c || c.state !== 'dialing' || c.agent_channel !== agent.id || c.direction !== 'in') {
      await this.o.ari.channels.hangup(agent.id);
      return;
    }
    const bridge = await this.ensureBridge(c);
    await this.o.ari.bridges.add(bridge, [c.client_channel, agent.id]);
    await this.o.ari.channels.mohStop(c.client_channel);
    await this.startRecording(c);
    const name = await this.userName(c.agent_user_id);
    await this.tx((tx) => connectAgent(tx, callId, { bridgeId: bridge, userName: name }));
    await this.ivr.agentConnected(c);
  }

  /** Абонент ответил на исходящий вызов оператора. */
  private async peerAnswered(callId: string, peer: AriChannel): Promise<void> {
    const c = await this.call('id = $2', [callId]);
    if (!c || c.state !== 'dialing' || c.client_channel !== peer.id || !c.agent_channel) {
      await this.o.ari.channels.hangup(peer.id);
      return;
    }
    await this.o.ari.channels.answer(c.agent_channel);
    const bridge = await this.ensureBridge(c);
    await this.o.ari.bridges.add(bridge, [c.client_channel, c.agent_channel]);
    await this.startRecording(c);
    await this.tx((tx) =>
      connectAgent(tx, callId, { bridgeId: bridge, userName: '', message: 'Абонент ответил' }),
    );
  }

  /** Подразделение ответило на прямой перевод (M-TKT-11). */
  private async externalAnswered(callId: string, ext: AriChannel): Promise<void> {
    const c = await this.call('id = $2', [callId]);
    if (!c || c.state !== 'external' || c.agent_channel !== ext.id) {
      await this.o.ari.channels.hangup(ext.id);
      return;
    }
    const bridge = await this.ensureBridge(c);
    await this.o.ari.bridges.add(bridge, [c.client_channel, ext.id]);
    await this.o.ari.channels.mohStop(c.client_channel);
    await this.tx(async (tx) => {
      await tx.query(
        `UPDATE call SET on_hold = false, version = version + 1, updated_at = now() WHERE id = $1`,
        [callId],
      );
      await callEvent(tx, callId, 'external_connected');
      await emitCallState(tx, callId);
    });
  }

  private async listenAnswered(callId: string, snoopId: string, sup: AriChannel): Promise<void> {
    const l = this.listens.get(sup.id);
    const c = await this.call('id = $2', [callId]);
    if (!l || !c) {
      await this.o.ari.channels.hangup(sup.id);
      await this.o.ari.channels.hangup(snoopId);
      return;
    }
    const bridge = newId();
    await this.o.ari.bridges.create(bridge, `listen-${callId}`);
    await this.o.ari.bridges.add(bridge, [snoopId, sup.id]);
    l.bridge = bridge;
  }

  /** Канал завершился: клиент, оператор, внешний абонент или прослушивающий супервизор. */
  private async gone(channelId: string, cause: number): Promise<void> {
    const l = this.listens.get(channelId);
    if (l) {
      this.listens.delete(channelId);
      await this.o.ari.channels.hangup(l.snoop);
      if (l.bridge) await this.o.ari.bridges.destroy(l.bridge);
      return;
    }
    const c = await this.call('(client_channel = $2 OR agent_channel = $2 OR consult_channel = $2)', [
      channelId,
    ]);
    if (!c) return;
    if (c.consult_channel === channelId) {
      // Адресат консультации не ответил или положил трубку — оператор снова с клиентом.
      await this.tx((tx) =>
        endConsult(tx, c.id, c.consult_state === 'talking' ? 'hangup' : 'no_answer', null),
      );
      await this.resumeClient(c);
      return;
    }
    if (c.client_channel === channelId) {
      await this.ivr.clientGone(c);
      if (c.agent_channel) await this.o.ari.channels.hangup(c.agent_channel);
      if (c.consult_channel) await this.o.ari.channels.hangup(c.consult_channel);
      await this.dropListeners(c.id);
      if (c.bridge_id) await this.o.ari.bridges.destroy(c.bridge_id);
      const reason = c.direction === 'out' && c.state === 'dialing' ? causeReason(cause) : 'client_hangup';
      await this.tx((tx) => endCall(tx, c.id, reason));
      return;
    }
    // Канал на стороне КЦ (оператор или внешний номер подразделения).
    if (c.state === 'dialing' && c.direction === 'in') {
      const rejected = cause === 17 || cause === 21;
      const unreachable = cause === 1 || cause === 3 || cause === 20 || cause === 27;
      const note = rejected
        ? 'Оператор отклонил звонок — он возвращён в очередь'
        : unreachable
          ? 'Софтфон оператора недоступен — звонок возвращён в очередь'
          : 'Оператор не ответил на звонок — он возвращён в очередь';
      await this.tx((tx) => agentLegFailed(tx, c.id, rejected || unreachable ? 'declined' : 'timeout', note));
      return;
    }
    if (c.state === 'external' && c.on_hold && (await this.ivr.transferFailed(c.id))) return;
    if (c.state === 'external' && c.on_hold) {
      // Подразделение не ответило: звонок возвращается в очередь обращения.
      const q = await this.o.pool.query<{ queue_id: string | null }>(
        `SELECT queue_id FROM conversation WHERE id = $1`,
        [c.conversation_id],
      );
      if (q.rows[0]?.queue_id) {
        await this.tx((tx) =>
          transferCallToQueue(tx, c.id, {
            queueId: q.rows[0]!.queue_id!,
            byUserId: null,
            message: 'Подразделение не ответило — звонок возвращён в очередь',
          }),
        );
        return;
      }
    }
    if (c.consult_channel && c.state === 'talking') {
      // Оператор положил трубку во время консультации: адресат на связи — клиент соединяется с ним (как в
      // офисной АТС); адресату ещё звонят — консультация отменяется, звонок завершается как обычно.
      if (c.consult_state === 'talking') {
        await this.finishConsult(c, null);
        return;
      }
      await this.tx((tx) => endConsult(tx, c.id, 'cancel', c.agent_user_id));
      await this.o.ari.channels.hangup(c.consult_channel);
    }
    await this.dropListeners(c.id);
    // Оператор завершил разговор, а у сценария есть продолжение (автосообщение, CSAT — M-TEL-09).
    if (c.state === 'talking' && (await this.ivr.afterAgent(c))) return;
    await this.o.ari.channels.hangup(c.client_channel);
    if (c.bridge_id) await this.o.ari.bridges.destroy(c.bridge_id);
    const reason =
      c.state === 'dialing' ? 'agent_cancel' : c.state === 'external' ? 'external_hangup' : 'agent_hangup';
    await this.tx((tx) => endCall(tx, c.id, reason));
  }

  private async dropListeners(callId: string): Promise<void> {
    for (const [sup, l] of this.listens)
      if (l.callId === callId) {
        this.listens.delete(sup);
        await this.o.ari.channels.hangup(sup);
        await this.o.ari.channels.hangup(l.snoop);
        if (l.bridge) await this.o.ari.bridges.destroy(l.bridge);
      }
  }

  // ------------------------------------------------------------------ периодический тик

  private async tick(): Promise<void> {
    if (!this.leader) return;
    await this.ivr.wake();
    await this.dialOffered();
    await this.dropStaleOffers();
    await this.o.store.uploadPending(this.o.name, this.o.ari);
  }

  /** router предложил голосовое обращение оператору — звоним в его софтфон (02-архитектура 4.2). */
  private async dialOffered(): Promise<void> {
    const { rows } = await this.o.pool.query<{
      id: string;
      conversation_id: string;
      assignee_id: string;
      timeout_s: number;
      caller: string | null;
      number: string | null;
    }>(
      `SELECT c.id, c.conversation_id, cv.assignee_id, COALESCE(q.offer_timeout_s, 20) AS timeout_s,
              ct.display_name AS caller, c.from_number AS number
         FROM call c JOIN conversation cv ON cv.id = c.conversation_id
         JOIN contact ct ON ct.id = cv.contact_id LEFT JOIN queue q ON q.id = cv.queue_id
        WHERE c.node = $1 AND c.state = 'queued' AND cv.status = 'offered' AND cv.assignee_id IS NOT NULL
        LIMIT 20`,
      [this.o.name],
    );
    for (const r of rows) {
      const agentChannel = newId();
      const ok = await this.tx(async (tx) => {
        const u = await tx.query(
          `UPDATE call SET state = 'dialing', agent_channel = $2, agent_user_id = $3, version = version + 1, updated_at = now()
            WHERE id = $1 AND state = 'queued' RETURNING id`,
          [r.id, agentChannel, r.assignee_id],
        );
        if (!u.rowCount) return false;
        await callEvent(tx, r.id, 'offered', r.assignee_id);
        await emitCallState(tx, r.id);
        return true;
      });
      if (!ok) continue;
      const name = (r.caller ?? '').replace(/["<>]/g, '');
      try {
        await this.o.ari.channels.originate({
          endpoint: `PJSIP/webrtc/sip:${sipUserOf(r.assignee_id)}@${this.o.sipProxy}`,
          channelId: agentChannel,
          app: STASIS_APP,
          appArgs: `operator,${r.id}`,
          callerId: `"${name || r.number || 'Клиент'}" <${r.number ?? 'anonymous'}>`,
          timeout: r.timeout_s,
          variables: {
            'PJSIP_HEADER(add,X-CC-Conversation)': r.conversation_id,
            'PJSIP_HEADER(add,X-CC-Call)': r.id,
          },
        });
      } catch (err) {
        this.o.logger.warn({ err: String(err), callId: r.id }, 'не удалось вызвать софтфон оператора');
        await this.tx((tx) =>
          agentLegFailed(
            tx,
            r.id,
            'declined',
            'Не удалось вызвать софтфон оператора — звонок возвращён в очередь',
          ),
        );
      }
    }
  }

  /** Предложение закрыто router (таймаут принятия) или обращение забрали — отбой звонка оператору. */
  private async dropStaleOffers(): Promise<void> {
    const { rows } = await this.o.pool.query<{ id: string; agent_channel: string }>(
      `SELECT c.id, c.agent_channel FROM call c JOIN conversation cv ON cv.id = c.conversation_id
        WHERE c.node = $1 AND c.state = 'dialing' AND c.direction = 'in'
          AND NOT (cv.status = 'offered' AND cv.assignee_id = c.agent_user_id)`,
      [this.o.name],
    );
    for (const r of rows) {
      const done = await this.tx(async (tx) => {
        const u = await tx.query(
          `UPDATE call SET state = 'queued', agent_channel = NULL, agent_user_id = NULL, version = version + 1, updated_at = now()
            WHERE id = $1 AND state = 'dialing' AND agent_channel = $2 RETURNING id`,
          [r.id, r.agent_channel],
        );
        if (!u.rowCount) return false;
        await callEvent(tx, r.id, 'agent_no_answer');
        await emitCallState(tx, r.id);
        return true;
      });
      if (done) await this.o.ari.channels.hangup(r.agent_channel);
    }
  }

  // ------------------------------------------------------------------ сверка после переключения

  /**
   * Сверка состояния вызовов узла с Asterisk (02-архитектура 6.3): события ARI, пришедшие за время
   * переключения, потеряны — восстанавливаем по фактическим каналам. Завершившиеся вызовы закрываются,
   * отвеченные за время разрыва — соединяются, новые вызовы в Stasis без записи в БД — обрабатываются.
   */
  private async reconcile(): Promise<void> {
    if (!this.leader) return;
    const channels = await this.o.ari.channels.list();
    const byId = new Map(channels.map((c) => [c.id, c]));
    const { rows: calls } = await this.o.pool.query<CallRow>(
      `SELECT * FROM call WHERE node = $1 AND state <> 'ended'`,
      [this.o.name],
    );
    const known = new Set<string>();
    for (const c of calls) {
      known.add(c.client_channel);
      if (c.agent_channel) known.add(c.agent_channel);
      if (c.consult_channel) known.add(c.consult_channel);
      const agent = c.agent_channel ? byId.get(c.agent_channel) : undefined;
      if (!byId.has(c.client_channel)) {
        await this.gone(c.client_channel, 16);
        continue;
      }
      if (c.state === 'ivr') {
        await this.ivr.recover(c);
      } else if (c.state === 'queued') {
        if (c.ivr_state) await this.ivr.recover(c);
        await this.o.ari.channels.mohStart(c.client_channel);
      } else if (c.state === 'dialing') {
        const peer = byId.get(c.client_channel);
        if (!agent) await this.gone(c.agent_channel ?? '', 19);
        else if (c.direction === 'in' && agent.state === 'Up') await this.agentAnswered(c.id, agent);
        else if (c.direction === 'out' && peer?.state === 'Up') await this.peerAnswered(c.id, peer);
      } else if (c.state === 'talking') {
        if (!agent) await this.gone(c.agent_channel ?? '', 16);
        else {
          const bridge = await this.ensureBridge(c);
          if (c.on_hold) {
            await this.o.ari.bridges.add(bridge, [agent.id]);
            await this.o.ari.channels.mohStart(c.client_channel);
          } else await this.o.ari.bridges.add(bridge, [c.client_channel, agent.id]);
          // Консультация: адресат — в мосту с оператором; завершилась или ответили за время переключения.
          if (c.consult_channel) {
            const cc = byId.get(c.consult_channel);
            if (!cc) await this.gone(c.consult_channel, 16);
            else if (c.consult_state === 'talking') await this.o.ari.bridges.add(bridge, [cc.id]);
            else if (cc.state === 'Up') await this.consultAnswered(c.id, cc);
          }
        }
      } else if (c.state === 'external') {
        if (!agent) await this.gone(c.agent_channel ?? '', 16);
        else if (agent.state === 'Up' && c.on_hold) await this.externalAnswered(c.id, agent);
      }
    }
    for (const ch of channels) {
      if (known.has(ch.id) || this.listens.has(ch.id)) continue;
      const app = ch.dialplan?.app_name;
      const data = ch.dialplan?.app_data ?? '';
      if (app !== 'Stasis' || !data.startsWith(`${STASIS_APP},`)) continue;
      const args = data.split(',').slice(1);
      if (args[0] === 'trunk' || args[0] === 'webrtc') await this.newCall(ch, args[0], args[1] ?? '');
      else if (args[0] !== 'snoop' && args[0] !== 'recorder') await this.o.ari.channels.hangup(ch.id);
    }
  }

  // ------------------------------------------------------------------ команды api

  private async command(msg: Msg): Promise<void> {
    let reply: CallControlReply;
    try {
      const cmd = CallControlCommandSchema.parse(msg.json());
      await this.execute(cmd);
      reply = { ok: true };
    } catch (err) {
      reply = { ok: false, error: err instanceof CommandError ? err.message : `ошибка: ${String(err)}` };
      if (!(err instanceof CommandError))
        this.o.logger.error({ err: String(err) }, 'ошибка команды call-control');
    }
    msg.respond(JSON.stringify(reply));
  }

  private async execute(cmd: CallControlCommand): Promise<void> {
    const c = await this.call('id = $2', [cmd.callId]);
    if (!c) throw new CommandError('Звонок уже завершён');
    if (cmd.op === 'listen') return this.listen(c, cmd.userId);
    if (c.agent_user_id !== cmd.userId) throw new CommandError('Звонок ведёт другой оператор');
    if (c.state !== 'talking' || !c.agent_channel) throw new CommandError('Звонок ещё не соединён');
    const bridge = await this.ensureBridge(c);
    switch (cmd.op) {
      case 'hold':
        if (c.on_hold) return;
        await this.o.ari.bridges.remove(bridge, [c.client_channel]);
        await this.o.ari.channels.mohStart(c.client_channel);
        await this.tx((tx) => setCallHold(tx, c.id, true, cmd.userId));
        return;
      case 'unhold':
        if (!c.on_hold) return;
        if (c.consult_channel)
          throw new CommandError('Идёт консультация — вернитесь к клиенту или соедините его');
        await this.o.ari.channels.mohStop(c.client_channel);
        await this.o.ari.bridges.add(bridge, [c.client_channel]);
        await this.tx((tx) => setCallHold(tx, c.id, false, cmd.userId));
        return;
      case 'hangup':
        await this.o.ari.channels.hangup(c.agent_channel);
        return;
      case 'transfer':
        if (c.consult_channel)
          throw new CommandError('Идёт консультация — соедините клиента или вернитесь к нему');
        return this.transfer(c, bridge, cmd);
      case 'consult':
        return this.consult(c, bridge, cmd);
      case 'consult_complete':
        if (!c.consult_channel) throw new CommandError('Консультация не идёт');
        if (c.consult_state !== 'talking') throw new CommandError('Адресат ещё не ответил');
        return this.finishConsult(c, cmd.userId);
      case 'consult_cancel':
        if (!c.consult_channel) throw new CommandError('Консультация не идёт');
        await this.tx((tx) => endConsult(tx, c.id, 'cancel', cmd.userId));
        await this.o.ari.channels.hangup(c.consult_channel);
        await this.resumeClient(c);
        return;
    }
  }

  /** Клиент снова в разговоре с оператором (конец консультации без перевода). */
  private async resumeClient(c: CallRow): Promise<void> {
    if (c.state !== 'talking' || !c.agent_channel) return;
    const bridge = await this.ensureBridge(c);
    await this.o.ari.channels.mohStop(c.client_channel);
    await this.o.ari.bridges.add(bridge, [c.client_channel]);
  }

  /**
   * Консультация (M-OP-05, M-TKT-11): клиент на удержании, оператору звонит адресат — оператор (софтфон),
   * свободный оператор очереди или подразделения, внешний номер подразделения. Оператор и адресат говорят в мосту
   * вызова; клиент вне моста слушает музыку, запись разговора продолжается.
   */
  private async consult(c: CallRow, bridge: string, cmd: Extract<CallControlCommand, { op: 'consult' }>) {
    if (c.consult_channel) throw new CommandError('Консультация уже идёт');
    const target = await this.consultTarget(c, cmd.userId, cmd.target);
    const by = await this.userName(cmd.userId);
    const channel = newId();
    if (!c.on_hold) {
      await this.o.ari.bridges.remove(bridge, [c.client_channel]);
      await this.o.ari.channels.mohStart(c.client_channel);
    }
    await this.tx((tx) => startConsult(tx, c.id, { channel, byUserId: cmd.userId, byName: by, target }));
    try {
      if (target.userId)
        await this.o.ari.channels.originate({
          endpoint: `PJSIP/webrtc/sip:${sipUserOf(target.userId)}@${this.o.sipProxy}`,
          channelId: channel,
          app: STASIS_APP,
          appArgs: `consult,${c.id}`,
          callerId: `"Консультация: ${by.replace(/["<>]/g, '')}" <consult>`,
          timeout: 30,
          variables: {
            'PJSIP_HEADER(add,X-CC-Consult)': c.id,
            'PJSIP_HEADER(add,X-CC-Call)': c.id,
            'PJSIP_HEADER(add,X-CC-Conversation)': c.conversation_id,
          },
        });
      else
        await this.o.ari.channels.originate({
          endpoint: `PJSIP/trunk/sip:${target.number}@${this.o.sipProxy}`,
          channelId: channel,
          app: STASIS_APP,
          appArgs: `consult,${c.id}`,
          callerId: this.o.outboundCallerId,
          timeout: 40,
        });
    } catch (err) {
      this.o.logger.warn({ err: String(err), callId: c.id }, 'не удалось позвонить адресату консультации');
      await this.tx((tx) => endConsult(tx, c.id, 'failed', cmd.userId));
      await this.resumeClient(c);
      throw new CommandError('Не удалось позвонить адресату консультации');
    }
  }

  /** Адресат консультации: оператор, свободный оператор очереди/подразделения или внешний номер подразделения. */
  private async consultTarget(
    c: CallRow,
    byUserId: string,
    t: Extract<CallControlCommand, { op: 'consult' }>['target'],
  ): Promise<ConsultTarget> {
    const operator = async (userId: string) => {
      if (userId === byUserId) throw new CommandError('Нельзя консультироваться с самим собой');
      const u = await this.o.pool.query<{ full_name: string }>(
        `SELECT u.full_name FROM app_user u WHERE u.id = $1 AND u.is_active AND u.can_login
           AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                        WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))`,
        [userId],
      );
      if (!u.rows[0]) throw new CommandError('Оператор не найден');
      return u.rows[0].full_name;
    };
    /** Свободный оператор очереди: «Готов», без звонка; дольше всех без обращений — первым. */
    const freeInQueue = async (queueId: string) => {
      const { rows } = await this.o.pool.query<{ id: string; full_name: string }>(
        `SELECT u.id, u.full_name FROM agent_status s JOIN app_user u ON u.id = s.user_id
          WHERE s.status = 'ready' AND u.id <> $2 AND u.is_active
            AND EXISTS (SELECT 1 FROM user_queue uq WHERE uq.user_id = u.id AND uq.queue_id = $1)
            AND NOT EXISTS (SELECT 1 FROM conversation v WHERE v.assignee_id = u.id AND v.channel_kind = 'voice'
                             AND v.status IN ('active', 'offered'))
            AND NOT EXISTS (SELECT 1 FROM call k WHERE k.consult_user_id = u.id AND k.state <> 'ended')
          ORDER BY s.last_assigned_at NULLS FIRST LIMIT 1`,
        [queueId, byUserId],
      );
      if (!rows[0])
        throw new CommandError(
          'Нет свободного оператора для консультации — переведите звонок без консультации',
        );
      return rows[0];
    };
    if (t.kind === 'user') return { label: `оператор ${await operator(t.userId)}`, userId: t.userId };
    if (t.kind === 'queue') {
      const q = await this.o.pool.query<{ name: string }>(
        `SELECT name FROM queue WHERE id = $1 AND is_active`,
        [t.queueId],
      );
      if (!q.rows[0]) throw new CommandError('Очередь не найдена');
      const u = await freeInQueue(t.queueId);
      return { label: `оператор ${u.full_name} (очередь «${q.rows[0].name}»)`, userId: u.id };
    }
    const { rows } = await this.o.pool.query<{
      transfer_number: string | null;
      transfer_queue_id: string | null;
      enterprise: string;
      department: string;
    }>(
      `SELECT ed.transfer_number, ed.transfer_queue_id, e.name AS enterprise, d.name AS department
         FROM enterprise_department ed JOIN enterprise e ON e.id = ed.enterprise_id JOIN department d ON d.id = ed.department_id
        WHERE ed.enterprise_id = $1 AND ed.department_id = $2 AND ed.is_active`,
      [t.enterpriseId, t.departmentId],
    );
    const ed = rows[0];
    if (!ed) throw new CommandError('Подразделение не найдено на этом предприятии');
    const where = `подразделение «${ed.department}» (предприятие «${ed.enterprise}»)`;
    const data = { enterpriseId: t.enterpriseId, departmentId: t.departmentId, direct: true };
    await this.o.pool.query(
      `UPDATE conversation SET enterprise_id = COALESCE(enterprise_id, $2), department_id = COALESCE(department_id, $3) WHERE id = $1`,
      [c.conversation_id, t.enterpriseId, t.departmentId],
    );
    if (ed.transfer_queue_id) {
      const u = await freeInQueue(ed.transfer_queue_id);
      return { label: `${where}, оператор ${u.full_name}`, userId: u.id, data };
    }
    const number = ed.transfer_number ? normalizePhone(ed.transfer_number) : null;
    if (!number) throw new CommandError('У подразделения не задан номер или очередь для перевода');
    return { label: `${where}, номер ${number}`, number, data };
  }

  /** Адресат консультации ответил: он в мосту с оператором, клиент по-прежнему на удержании. */
  private async consultAnswered(callId: string, ch: AriChannel): Promise<void> {
    const c = await this.call('id = $2', [callId]);
    if (!c || c.consult_channel !== ch.id || c.state !== 'talking') {
      await this.o.ari.channels.hangup(ch.id);
      return;
    }
    const bridge = await this.ensureBridge(c);
    await this.o.ari.bridges.add(bridge, [ch.id]);
    await this.tx((tx) => consultConnected(tx, callId));
  }

  /**
   * «Соединить»: клиент — в мосту с адресатом консультации, консультировавший оператор отключается. byUserId=null —
   * оператор сам положил трубку во время консультации (его канал уже завершён).
   */
  private async finishConsult(c: CallRow, byUserId: string | null): Promise<void> {
    const by = byUserId ?? c.agent_user_id;
    const name = await this.userName(by);
    const done = await this.tx((tx) => completeConsult(tx, c.id, { byUserId: by!, byName: name }));
    if (!done) return;
    const bridge = await this.ensureBridge(c);
    if (byUserId && c.agent_channel) {
      await this.o.ari.bridges.remove(bridge, [c.agent_channel]).catch(() => undefined);
      await this.o.ari.channels.hangup(c.agent_channel);
    }
    await this.o.ari.channels.mohStop(c.client_channel);
    await this.o.ari.bridges.add(bridge, [c.client_channel]);
  }

  private async transfer(c: CallRow, bridge: string, cmd: Extract<CallControlCommand, { op: 'transfer' }>) {
    const agent = c.agent_channel!;
    const by = await this.userName(cmd.userId);
    const note = cmd.comment ? `: ${cmd.comment}` : '';
    const t = cmd.target;
    const detach = async () => {
      await this.o.ari.bridges.remove(bridge, [c.client_channel, agent]);
      await this.o.ari.channels.mohStart(c.client_channel);
      await this.o.ari.channels.hangup(agent);
    };
    if (t.kind === 'user') {
      if (t.userId === cmd.userId) throw new CommandError('Нельзя перевести звонок самому себе');
      const u = await this.o.pool.query<{ full_name: string }>(
        `SELECT u.full_name FROM app_user u WHERE u.id = $1 AND u.is_active AND u.can_login
           AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                        WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))`,
        [t.userId],
      );
      if (!u.rows[0]) throw new CommandError('Оператор не найден');
      await this.tx((tx) =>
        transferCallToUser(tx, c.id, {
          toUserId: t.userId,
          byUserId: cmd.userId,
          message: `${by} перевёл звонок оператору ${u.rows[0]!.full_name}${note}`,
        }),
      );
      return detach();
    }
    if (t.kind === 'queue') {
      const q = await this.o.pool.query<{ name: string }>(
        `SELECT name FROM queue WHERE id = $1 AND is_active`,
        [t.queueId],
      );
      if (!q.rows[0]) throw new CommandError('Очередь не найдена');
      await this.tx((tx) =>
        transferCallToQueue(tx, c.id, {
          queueId: t.queueId,
          byUserId: cmd.userId,
          message: `${by} перевёл звонок в очередь «${q.rows[0]!.name}»${note}`,
        }),
      );
      return detach();
    }
    // Прямой перевод на подразделение предприятия (M-TKT-11): его очередь или внешний номер.
    const { rows } = await this.o.pool.query<{
      transfer_number: string | null;
      transfer_queue_id: string | null;
      enterprise: string;
      department: string;
    }>(
      `SELECT ed.transfer_number, ed.transfer_queue_id, e.name AS enterprise, d.name AS department
         FROM enterprise_department ed JOIN enterprise e ON e.id = ed.enterprise_id JOIN department d ON d.id = ed.department_id
        WHERE ed.enterprise_id = $1 AND ed.department_id = $2 AND ed.is_active`,
      [t.enterpriseId, t.departmentId],
    );
    const ed = rows[0];
    if (!ed) throw new CommandError('Подразделение не найдено на этом предприятии');
    const where = `подразделение «${ed.department}» (предприятие «${ed.enterprise}»)`;
    const data = { enterpriseId: t.enterpriseId, departmentId: t.departmentId, direct: true };
    await this.o.pool.query(
      `UPDATE conversation SET enterprise_id = COALESCE(enterprise_id, $2), department_id = COALESCE(department_id, $3) WHERE id = $1`,
      [c.conversation_id, t.enterpriseId, t.departmentId],
    );
    if (ed.transfer_queue_id) {
      await this.tx((tx) =>
        transferCallToQueue(tx, c.id, {
          queueId: ed.transfer_queue_id!,
          byUserId: cmd.userId,
          message: `${by} перевёл звонок в ${where}${note}`,
          data,
        }),
      );
      return detach();
    }
    const number = ed.transfer_number ? normalizePhone(ed.transfer_number) : null;
    if (!number) throw new CommandError('У подразделения не задан номер или очередь для перевода');
    const ext = newId();
    await this.tx(async (tx) => {
      await transferCallExternal(tx, c.id, {
        extChannel: ext,
        number,
        byUserId: cmd.userId,
        message: `${by} перевёл звонок в ${where}, номер ${number}${note}`,
        data,
      });
      await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.conversation_id), {
        action: 'transferred',
        byUserId: cmd.userId,
        ...directTransferData(data, 'external'),
      });
    });
    await detach();
    try {
      await this.o.ari.channels.originate({
        endpoint: `PJSIP/trunk/sip:${number}@${this.o.sipProxy}`,
        channelId: ext,
        app: STASIS_APP,
        appArgs: `external,${c.id}`,
        callerId: this.o.outboundCallerId,
        timeout: 40,
      });
    } catch (err) {
      this.o.logger.warn({ err: String(err) }, 'перевод на внешний номер не удался');
      await this.gone(ext, 34);
    }
  }

  /** Прослушивание супервизором (M-TEL-10): snoop-канал клиента → софтфон супервизора. */
  private async listen(c: CallRow, userId: string): Promise<void> {
    if (c.state !== 'talking') throw new CommandError('Разговор ещё не начался');
    const snoop = newId();
    const sup = newId();
    this.listens.set(sup, { snoop, bridge: null, callId: c.id });
    try {
      await this.o.ari.channels.snoop(c.client_channel, {
        snoopId: snoop,
        app: STASIS_APP,
        appArgs: `snoop,${c.id}`,
      });
      await this.o.ari.channels.originate({
        endpoint: `PJSIP/webrtc/sip:${sipUserOf(userId)}@${this.o.sipProxy}`,
        channelId: sup,
        app: STASIS_APP,
        appArgs: `listen,${c.id},${snoop}`,
        callerId: '"Прослушивание разговора" <listen>',
        timeout: 30,
        variables: {
          'PJSIP_HEADER(add,X-CC-Listen)': c.id,
          'PJSIP_HEADER(add,X-CC-Conversation)': c.conversation_id,
        },
      });
    } catch (err) {
      this.listens.delete(sup);
      await this.o.ari.channels.hangup(snoop);
      throw new CommandError(`Не удалось начать прослушивание: ${String(err)}`);
    }
    await this.tx((tx) => callEvent(tx, c.id, 'listen', userId));
  }
}

/** Причина завершения исходящего вызова по коду Q.850 от транка. */
function causeReason(cause: number): string {
  if (cause === 17) return 'busy';
  if (cause === 18 || cause === 19) return 'no_answer';
  if (cause === 16) return 'client_hangup';
  return 'failed';
}
