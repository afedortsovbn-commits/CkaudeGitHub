import JsSIP from 'jssip';
import type { RTCSession } from 'jssip/lib/RTCSession';
import type { RTCSessionEvent, UA } from 'jssip/lib/UA';
import { useSyncExternalStore } from 'react';
import { get } from './api';
import { onRealtime } from './realtime';

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
}

export interface SoftphoneState {
  reg: RegState;
  error: string | null;
  call: CallView | null;
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
}

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
  private ring: { ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null = null;
  private renew: ReturnType<typeof setTimeout> | null = null;
  private stopRealtime: (() => void) | null = null;
  private state: SoftphoneState = { reg: 'off', error: null, call: null };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<SoftphoneState>) {
    this.state = { ...this.state, ...patch };
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
      this.set({ reg: 'error', error: `Регистрация не удалась: ${e.cause ?? ''}` }),
    );
    ua.on('newRTCSession', (e: RTCSessionEvent) => this.onSession(e));
    ua.start();
    this.ua = ua;
    // Учётные данные короткоживущие — пересоздаём регистрацию заранее, но не во время разговора.
    const ms = Math.max(60_000, new Date(cfg.expiresAt).getTime() - Date.now() - 10 * 60_000);
    this.renew = setTimeout(() => this.renewWhenIdle(), ms);
    this.stopRealtime = onRealtime((ev) => {
      if (ev.type !== 'event' || ev.event !== 'conversation.call' || !ev.data) return;
      const d = ev.data as unknown as CallStateEvent;
      if (d.agentUserId !== this.userId && this.state.call?.callId !== d.callId) return;
      if (!this.state.call || this.state.call.state === 'ended') return;
      if (this.state.call.callId && this.state.call.callId !== d.callId) return;
      this.setCall({ callId: d.callId, conversationId: d.conversationId, onHold: d.onHold });
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
    this.stopRealtime?.();
    this.stopRealtime = null;
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
        startedAt: null,
        muted: false,
        onHold: false,
      },
    });
    this.pendingConversation = null;
    session.on('peerconnection', (ev: { peerconnection: RTCPeerConnection }) => {
      ev.peerconnection.addEventListener('track', (t) => {
        if (!this.audio) return;
        this.audio.srcObject = t.streams[0] ?? new MediaStream([t.track]);
        void this.audio.play().catch(() => undefined);
      });
    });
    if (!incoming) {
      session.connection?.addEventListener('track', (t: RTCTrackEvent) => {
        if (!this.audio) return;
        this.audio.srcObject = t.streams[0] ?? new MediaStream([t.track]);
        void this.audio.play().catch(() => undefined);
      });
    }
    session.on('accepted', () => {
      this.stopRinging();
      this.setCall({ state: 'active', startedAt: Date.now() });
    });
    const done = (ev: { cause?: string }) => {
      this.stopRinging();
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

  private startRinging() {
    try {
      const ctx = new AudioContext();
      const beep = () => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 480;
        g.gain.value = 0.08;
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.8);
      };
      beep();
      this.ring = { ctx, timer: setInterval(beep, 3000) };
    } catch {
      /* без звука вызова — индикация в интерфейсе остаётся */
    }
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification('Входящий звонок', {
        body: this.state.call?.remoteName || this.state.call?.remote || '',
      });
  }

  private stopRinging() {
    if (!this.ring) return;
    clearInterval(this.ring.timer);
    void this.ring.ctx.close();
    this.ring = null;
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
      mediaConstraints: { audio: AUDIO_CONSTRAINTS, video: false },
      pcConfig: { iceServers: await this.iceServers() },
    });
  }

  decline(): void {
    this.session?.terminate({ status_code: 603, reason_phrase: 'Decline' });
  }

  hangup(): void {
    this.session?.terminate();
  }

  toggleMute(): void {
    const s = this.session;
    if (!s) return;
    if (this.state.call?.muted) s.unmute({ audio: true });
    else s.mute({ audio: true });
    this.setCall({ muted: !this.state.call?.muted });
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
      mediaConstraints: { audio: AUDIO_CONSTRAINTS, video: false },
      pcConfig: { iceServers: await this.iceServers() },
      extraHeaders: conversationId ? [`X-CC-Conversation: ${conversationId}`] : [],
    });
  }
}

export const softphone = new Softphone();

export function useSoftphone(): SoftphoneState {
  return useSyncExternalStore(softphone.subscribe, softphone.getSnapshot);
}
