import JsSIP from 'jssip';
import type { RTCSession } from 'jssip/lib/RTCSession';
import type { RTCSessionEvent, UA } from 'jssip/lib/UA';
import { useSyncExternalStore } from 'react';
import { get } from './api';
import { applySink, audioDevices, toneUrl } from './audio-devices';
import { connectHeadset, type HeadsetAction, type HidHeadset, onHeadsetDisconnect } from './headset';
import { onRealtime } from './realtime';
import { t } from './i18n';

/**
 * Софтфон оператора (M-OP-05, 02-архитектура 8.1): JsSIP регистрируется в Kamailio по WSS (в обход Traefik)
 * короткоживущими учётными данными от api; ICE-серверы запрашиваются перед каждым вызовом. Удержание и
 * перевод выполняет сервер (call-control) — клиент при удержании слышит музыку, запись разговора непрерывна.
 */

export type RegState = 'off' | 'connecting' | 'registered' | 'error';

export interface CallView {
  direction: 'incoming' | 'outgoing';
  state: 'ringing' | 'connecting' | 'active' | 'ended';
  remote: string;
  remoteName: string;
  conversationId: string | null;
  /** Идентификатор вызова в КЦ (для удержания и перевода). */
  callId: string | null;
  /** Входящий — прослушивание разговора супервизором. */
  listen: boolean;
  startedAt: number | null;
  muted: boolean;
  onHold: boolean;
  endReason?: string;
  /** Качество связи по статистике WebRTC (раз в 2 с). */
  quality: QualitySample | null;
  /** Медиа прервалось (смена сети) — идёт восстановление (ICE restart). */
  reconnecting: boolean;
  /** Консультация, которую ведёт этот оператор (клиент на удержании), — Ф12b. */
  consult: { state: 'dialing' | 'talking'; label: string } | null;
  /** Входящий — консультация коллеги: звонок станет своим, когда коллега соединит клиента. */
  consultOf: boolean;
}

export interface SoftphoneState {
  reg: RegState;
  error: string | null;
  call: CallView | null;
  /** Подключённая гарнитура с кнопками (WebHID). */
  headset: string | null;
}

export interface QualitySample {
  level: 'good' | 'fair' | 'poor';
  rttMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
}

/** Оценка качества разговора по задержке, джиттеру и потерям (пороги — рекомендации ITU-T G.114/G.107). */
export function qualityLevel(s: Omit<QualitySample, 'level'>): QualitySample['level'] {
  const rtt = s.rttMs ?? 0;
  const jitter = s.jitterMs ?? 0;
  const loss = s.lossPct ?? 0;
  if (loss > 5 || rtt > 400 || jitter > 60) return 'poor';
  if (loss > 1 || rtt > 250 || jitter > 30) return 'fair';
  return 'good';
}

interface SoftphoneConfig {
  wsUri: string;
  sipUri: string;
  authorizationUser: string;
  password: string;
  displayName: string;
  domain: string;
  expiresAt: string;
  iceServers: RTCIceServer[];
}

interface CallStateEvent {
  callId: string;
  conversationId: string;
  state: 'queued' | 'dialing' | 'talking' | 'external' | 'ended';
  onHold: boolean;
  agentUserId: string | null;
  consult?: { state: 'dialing' | 'talking'; label: string; userId: string | null } | null;
}

/** Ограничения микрофона по умолчанию (демо-страница); софтфон берёт выбранное устройство и обработку. */
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

class Softphone {
  private ua: UA | null = null;
  private session: RTCSession | null = null;
  private cfg: SoftphoneConfig | null = null;
  private userId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly audio: HTMLAudioElement | null = typeof Audio !== 'undefined' ? new Audio() : null;
  private ringer: HTMLAudioElement | null = null;
  private renew: ReturnType<typeof setTimeout> | null = null;
  private stopRealtime: (() => void) | null = null;
  private onPageHide: (() => void) | null = null;
  private stopDevices: (() => void) | null = null;
  private stats: ReturnType<typeof setInterval> | null = null;
  private lastLoss: { lost: number; recv: number } | null = null;
  private iceTimer: ReturnType<typeof setTimeout> | null = null;
  private micId: string | null = null;
  private speakerId: string | null = null;
  private headset: HidHeadset | null = null;
  private visibilityHooked = false;
  private state: SoftphoneState = { reg: 'off', error: null, call: null, headset: null };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<SoftphoneState>) {
    this.state = { ...this.state, ...patch };
    this.syncHeadset();
    this.listeners.forEach((l) => l());
  }
  private setCall(patch: Partial<CallView>) {
    if (this.state.call) this.set({ call: { ...this.state.call, ...patch } });
  }

  /** Запуск после входа сотрудника; повторный вызов безопасен. */
  async start(userId: string): Promise<void> {
    if (this.ua && this.userId === userId) return;
    this.stop();
    this.userId = userId;
    this.set({ reg: 'connecting', error: null });
    audioDevices.start();
    this.stopDevices = audioDevices.subscribe(() => void this.devicesChanged());
    this.hookVisibility();
    void this.attachHeadset(false);
    try {
      this.cfg = await get<SoftphoneConfig>('/telephony/softphone');
    } catch (e) {
      this.set({ reg: 'error', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const cfg = this.cfg;
    const ua = new JsSIP.UA({
      sockets: [new JsSIP.WebSocketInterface(cfg.wsUri)],
      uri: cfg.sipUri,
      authorization_user: cfg.authorizationUser,
      password: cfg.password,
      display_name: cfg.displayName,
      register: true,
      register_expires: 300,
      session_timers: false,
      connection_recovery_min_interval: 2,
      connection_recovery_max_interval: 10,
      user_agent: 'cc-softphone',
    });
    ua.on('connecting', () => this.set({ reg: 'connecting' }));
    ua.on('disconnected', () => this.set({ reg: 'connecting' }));
    ua.on('registered', () => this.set({ reg: 'registered', error: null }));
    ua.on('unregistered', () => this.state.reg !== 'error' && this.set({ reg: 'connecting' }));
    ua.on('registrationFailed', (e: { cause?: string }) =>
      this.set({ reg: 'error', error: t.softphoneLib.registratsiyaNeUdalas(e.cause ?? '') }),
    );
    ua.on('newRTCSession', (e: RTCSessionEvent) => this.onSession(e));
    ua.start();
    this.ua = ua;
    // Закрытие или перезагрузка страницы — снимаем свою регистрацию, чтобы у оператора не копились «мёртвые»
    // контакты (живут до register_expires): звонок рассылается на ограниченное число регистраций.
    this.onPageHide = () => {
      try {
        ua.unregister();
      } catch {
        /* соединение уже закрыто — регистрация истечёт сама */
      }
    };
    window.addEventListener('pagehide', this.onPageHide);
    // Учётные данные короткоживущие — пересоздаём регистрацию заранее, но не во время разговора.
    const ms = Math.max(60_000, new Date(cfg.expiresAt).getTime() - Date.now() - 10 * 60_000);
    this.renew = setTimeout(() => this.renewWhenIdle(), ms);
    this.stopRealtime = onRealtime((ev) => {
      if (ev.type !== 'event' || ev.event !== 'conversation.call' || !ev.data) return;
      const d = ev.data as unknown as CallStateEvent;
      if (d.agentUserId !== this.userId && this.state.call?.callId !== d.callId) return;
      if (!this.state.call || this.state.call.state === 'ended') return;
      if (this.state.call.callId && this.state.call.callId !== d.callId) return;
      // Адресат консультации: звонок станет своим, когда коллега соединит клиента (ведущий — этот оператор).
      if (this.state.call.consultOf) {
        if (d.agentUserId === this.userId) this.setCall({ consultOf: false, onHold: d.onHold });
        return;
      }
      this.setCall({
        callId: d.callId,
        conversationId: d.conversationId,
        onHold: d.onHold,
        consult: d.consult ? { state: d.consult.state, label: d.consult.label } : null,
      });
    });
  }

  private renewWhenIdle() {
    if (this.session) {
      this.renew = setTimeout(() => this.renewWhenIdle(), 30_000);
      return;
    }
    const id = this.userId;
    this.stop();
    if (id) void this.start(id);
  }

  stop(): void {
    if (this.renew) clearTimeout(this.renew);
    if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
    this.onPageHide = null;
    this.stopRealtime?.();
    this.stopRealtime = null;
    this.stopDevices?.();
    this.stopDevices = null;
    this.stopMonitoring();
    this.stopRinging();
    this.session?.terminate();
    this.session = null;
    this.ua?.stop();
    this.ua = null;
    this.set({ reg: 'off', call: null });
  }

  private onSession(e: RTCSessionEvent) {
    const session = e.session;
    const incoming = e.originator === 'remote';
    if (this.session && this.session !== session) {
      if (incoming) session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
      return;
    }
    this.session = session;
    const header = (name: string) => (incoming ? (e.request.getHeader(name) ?? null) : null);
    const remote = session.remote_identity;
    this.set({
      call: {
        direction: incoming ? 'incoming' : 'outgoing',
        state: incoming ? 'ringing' : 'connecting',
        remote: remote?.uri?.user ?? '',
        remoteName: remote?.display_name ?? '',
        conversationId: header('X-CC-Conversation') ?? this.pendingConversation,
        callId: header('X-CC-Call'),
        listen: !!header('X-CC-Listen'),
        consult: null,
        consultOf: !!header('X-CC-Consult'),
        startedAt: null,
        muted: false,
        onHold: false,
        quality: null,
        reconnecting: false,
      },
    });
    this.pendingConversation = null;
    session.on('peerconnection', (ev: { peerconnection: RTCPeerConnection }) =>
      this.watchPc(ev.peerconnection),
    );
    if (!incoming && session.connection) this.watchPc(session.connection);
    session.on('accepted', () => {
      this.stopRinging();
      this.micId = audioDevices.getSnapshot().effective.mic?.id ?? null;
      this.setCall({ state: 'active', startedAt: Date.now() });
      this.startMonitoring(session);
    });
    const done = (ev: { cause?: string }) => {
      this.stopRinging();
      this.stopMonitoring();
      if (this.session === session) this.session = null;
      this.setCall({ state: 'ended', endReason: ev?.cause });
      setTimeout(() => {
        if (!this.session && this.state.call?.state === 'ended') this.set({ call: null });
      }, 2500);
    };
    session.on('ended', done);
    session.on('failed', done);
    if (incoming) {
      if (this.state.call?.listen) void this.answer();
      else this.startRinging();
    }
  }

  private pendingConversation: string | null = null;

  /** Звонок — на отдельном устройстве (например, динамик компьютера, пока гарнитура на столе). */
  private startRinging() {
    if (typeof Audio !== 'undefined') {
      this.ringer ??= new Audio(toneUrl('ring'));
      this.ringer.loop = true;
      this.ringer.currentTime = 0;
      void applySink(this.ringer, audioDevices.sinkId('ringer')).then(() =>
        this.ringer?.play().catch(() => undefined),
      );
    }
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification(t.softphoneLib.vkhodyashchiyZvonok, {
        body: this.state.call?.remoteName || this.state.call?.remote || '',
      });
  }

  private stopRinging() {
    this.ringer?.pause();
  }

  /** Звук собеседника — на выбранный динамик разговора; при обрыве медиа — восстановление (ICE restart). */
  private watchPc(pc: RTCPeerConnection) {
    pc.addEventListener('track', (t) => {
      if (!this.audio) return;
      this.audio.srcObject = t.streams[0] ?? new MediaStream([t.track]);
      this.speakerId = audioDevices.sinkId('speaker');
      void applySink(this.audio, this.speakerId).then(() => this.audio?.play().catch(() => undefined));
    });
    pc.addEventListener('iceconnectionstatechange', () => {
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') {
        if (this.iceTimer) clearTimeout(this.iceTimer);
        this.iceTimer = null;
        if (this.state.call?.reconnecting) this.setCall({ reconnecting: false });
        return;
      }
      if (
        (st === 'disconnected' || st === 'failed') &&
        !this.iceTimer &&
        this.state.call?.state === 'active'
      ) {
        this.setCall({ reconnecting: true });
        // Смена сети оператора: пробуем восстановить медиа без разрыва звонка (best effort, 02-архитектура 8.1).
        this.iceTimer = setTimeout(() => {
          this.iceTimer = null;
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
          try {
            this.session?.renegotiate({ rtcOfferConstraints: { iceRestart: true } });
          } catch {
            /* повторная попытка — при следующем изменении состояния */
          }
        }, 3000);
      }
    });
  }

  private startMonitoring(session: RTCSession) {
    this.stopMonitoring();
    this.stats = setInterval(() => void this.sample(session), 2000);
  }

  private stopMonitoring() {
    if (this.stats) clearInterval(this.stats);
    this.stats = null;
    this.lastLoss = null;
    if (this.iceTimer) clearTimeout(this.iceTimer);
    this.iceTimer = null;
  }

  private async sample(session: RTCSession) {
    const pc = session.connection;
    if (!pc || this.session !== session) return;
    let rtt: number | null = null;
    let jitter: number | null = null;
    let lost = 0;
    let recv = 0;
    (await pc.getStats()).forEach((r: Record<string, unknown>) => {
      if (
        r.type === 'candidate-pair' &&
        r.state === 'succeeded' &&
        typeof r.currentRoundTripTime === 'number'
      )
        rtt = r.currentRoundTripTime * 1000;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        jitter = typeof r.jitter === 'number' ? r.jitter * 1000 : null;
        lost = Number(r.packetsLost ?? 0);
        recv = Number(r.packetsReceived ?? 0);
      }
    });
    const prev = this.lastLoss;
    this.lastLoss = { lost, recv };
    const dLost = prev ? lost - prev.lost : 0;
    const dRecv = prev ? recv - prev.recv : 0;
    const lossPct = prev && dLost + dRecv > 0 ? (100 * Math.max(0, dLost)) / (dLost + dRecv) : null;
    const q = { rttMs: rtt, jitterMs: jitter, lossPct };
    this.setCall({ quality: { ...q, level: qualityLevel(q) } });
  }

  /** Сменилось устройство (выбор оператора или горячее подключение/отключение гарнитуры). */
  private async devicesChanged() {
    const eff = audioDevices.getSnapshot().effective;
    const pc = this.session?.connection;
    if (this.audio && this.speakerId !== null && eff.speaker && eff.speaker.id !== this.speakerId) {
      this.speakerId = eff.speaker.id;
      await applySink(this.audio, eff.speaker.id);
    }
    if (this.ringer && !this.ringer.paused) await applySink(this.ringer, audioDevices.sinkId('ringer'));
    if (!pc || this.state.call?.state !== 'active' || !eff.mic || eff.mic.id === this.micId) return;
    // Горячая замена микрофона без разрыва звонка: новый трек в тот же отправитель (replaceTrack).
    const sender = pc.getSenders().find((x) => x.track?.kind === 'audio');
    if (!sender) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioDevices.micConstraints() });
      const track = stream.getAudioTracks()[0]!;
      track.enabled = !this.state.call?.muted;
      const old = sender.track;
      await sender.replaceTrack(track);
      old?.stop();
      this.micId = eff.mic.id;
    } catch {
      /* устройство недоступно — остаётся прежний трек */
    }
  }

  /** Возврат во вкладку (Chrome мог «заморозить» фоновую): проверяем регистрацию и восстанавливаем. */
  private hookVisibility() {
    if (this.visibilityHooked || typeof document === 'undefined') return;
    this.visibilityHooked = true;
    const check = () => {
      if (document.visibilityState !== 'visible' || !this.ua) return;
      if (this.ua.isConnected() && !this.ua.isRegistered()) this.ua.register();
    };
    document.addEventListener('visibilitychange', check);
    document.addEventListener('resume', check);
  }

  // ------------------------------------------------------------------ гарнитура (WebHID)

  /** Подключить гарнитуру с кнопками: request=true — по действию пользователя (выбор устройства). */
  async attachHeadset(request: boolean): Promise<boolean> {
    const h = await connectHeadset((a) => this.headsetAction(a), request).catch(() => null);
    if (!h) return false;
    await this.headset?.close();
    this.headset = h;
    onHeadsetDisconnect(() => {
      this.headset = null;
      this.set({ headset: null });
    });
    this.set({ headset: h.name });
    return true;
  }

  private headsetAction(a: HeadsetAction) {
    const c = this.state.call;
    if (a === 'answer' && c?.state === 'ringing' && c.direction === 'incoming') void this.answer();
    else if (a === 'hangup' && c && c.state !== 'ended') {
      if (c.state === 'ringing' && c.direction === 'incoming') this.decline();
      else this.hangup();
    } else if (a === 'mute' && c?.state === 'active') this.toggleMute();
  }

  private syncHeadset() {
    const c = this.state.call;
    this.headset?.setState({
      ring: c?.state === 'ringing' && c.direction === 'incoming',
      offHook: !!c && (c.state === 'active' || c.state === 'connecting'),
      mute: !!c?.muted,
    });
  }

  private async iceServers(): Promise<RTCIceServer[]> {
    try {
      return (await get<{ iceServers: RTCIceServer[] }>('/telephony/ice')).iceServers;
    } catch {
      return this.cfg?.iceServers ?? [];
    }
  }

  async answer(): Promise<void> {
    const s = this.session;
    if (!s || this.state.call?.state !== 'ringing') return;
    this.stopRinging();
    this.setCall({ state: 'connecting' });
    s.answer({
      mediaConstraints: { audio: audioDevices.micConstraints(), video: false },
      pcConfig: { iceServers: await this.iceServers() },
    });
  }

  decline(): void {
    this.session?.terminate({ status_code: 603, reason_phrase: 'Decline' });
  }

  hangup(): void {
    this.session?.terminate();
  }

  /** Микрофон — через текущий трек отправителя: после горячей замены устройства трек уже другой. */
  toggleMute(): void {
    const pc = this.session?.connection;
    if (!pc) return;
    const muted = !this.state.call?.muted;
    for (const sender of pc.getSenders()) if (sender.track?.kind === 'audio') sender.track.enabled = !muted;
    this.setCall({ muted });
  }

  dtmf(tone: string): void {
    this.session?.sendDTMF(tone, { transportType: JsSIP.C.DTMF_TRANSPORT.RFC2833 });
  }

  /** Исходящий вызов (M-TEL-06); из карточки — с привязкой к обращению. */
  async call(number: string, conversationId?: string | null): Promise<void> {
    if (!this.ua || !this.cfg || this.session) return;
    const target = number.replace(/[^\d+*#]/g, '');
    if (!target) return;
    this.pendingConversation = conversationId ?? null;
    this.ua.call(`sip:${target}@${this.cfg.domain}`, {
      mediaConstraints: { audio: audioDevices.micConstraints(), video: false },
      pcConfig: { iceServers: await this.iceServers() },
      extraHeaders: conversationId ? [`X-CC-Conversation: ${conversationId}`] : [],
    });
  }
}

export const softphone = new Softphone();

export function useSoftphone(): SoftphoneState {
  return useSyncExternalStore(softphone.subscribe, softphone.getSnapshot);
}
