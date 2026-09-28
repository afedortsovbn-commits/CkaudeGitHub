/**
 * Тонкий клиент Asterisk REST Interface (ARI): REST через fetch и поток событий приложения Stasis по
 * WebSocket (встроенный в Node 22). Своя реализация вместо ari-client: нужен десяток методов, а
 * переподключение и сверку после переключения ведёт сам call-control (02-архитектура 6.3).
 */
export interface AriChannel {
  id: string;
  name: string;
  state: string;
  caller: { name: string; number: string };
  connected: { name: string; number: string };
  dialplan: { context: string; exten: string; priority: number; app_name?: string; app_data?: string };
  creationtime: string;
}

export interface AriBridge {
  id: string;
  channels: string[];
}

export interface AriEvent {
  type: string;
  application?: string;
  channel?: AriChannel;
  args?: string[];
  cause?: number;
  cause_txt?: string;
  recording?: { name: string; state: string; duration?: number; target_uri?: string };
  bridge?: AriBridge;
}

export class AriError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class Ari {
  private readonly auth: string;

  constructor(
    readonly baseUrl: string, // http://asterisk-1:8088/ari
    private readonly user: string,
    private readonly password: string,
  ) {
    this.auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }

  async req<T = unknown>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.baseUrl}${path}${qs.size ? `?${qs}` : ''}`;
    const r = await fetch(url, {
      method,
      headers: { authorization: this.auth, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new AriError(r.status, `ARI ${method} ${path}: ${r.status} ${await r.text()}`);
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Как req, но 404 (канал/мост уже исчез) — не ошибка: команды идемпотентны при повторе и сверке. */
  async quiet(method: string, path: string, query: Query = {}, body?: unknown): Promise<void> {
    try {
      await this.req(method, path, query, body);
    } catch (e) {
      if (!(e instanceof AriError) || (e.status !== 404 && e.status !== 409 && e.status !== 422)) throw e;
    }
  }

  channels = {
    list: () => this.req<AriChannel[]>('GET', '/channels'),
    get: (id: string) => this.req<AriChannel>('GET', `/channels/${id}`),
    answer: (id: string) => this.quiet('POST', `/channels/${id}/answer`),
    ring: (id: string) => this.quiet('POST', `/channels/${id}/ring`),
    hangup: (id: string, reason = 'normal') => this.quiet('DELETE', `/channels/${id}`, { reason }),
    mohStart: (id: string, mohClass = 'default') => this.quiet('POST', `/channels/${id}/moh`, { mohClass }),
    mohStop: (id: string) => this.quiet('DELETE', `/channels/${id}/moh`),
    getVar: async (id: string, variable: string) => {
      try {
        return (await this.req<{ value: string }>('GET', `/channels/${id}/variable`, { variable })).value;
      } catch {
        return null;
      }
    },
    originate: (o: {
      endpoint: string;
      channelId: string;
      app: string;
      appArgs: string;
      callerId?: string;
      timeout?: number;
      variables?: Record<string, string>;
    }) =>
      this.req<AriChannel>(
        'POST',
        `/channels/${o.channelId}`,
        { endpoint: o.endpoint, app: o.app, appArgs: o.appArgs, callerId: o.callerId, timeout: o.timeout },
        { variables: o.variables ?? {} },
      ),
    record: (id: string, name: string) =>
      this.req('POST', `/channels/${id}/record`, {
        name,
        format: 'wav',
        ifExists: 'overwrite',
        beep: false,
        terminateOn: 'none',
      }),
    snoop: (id: string, o: { snoopId: string; app: string; appArgs: string }) =>
      this.req<AriChannel>('POST', `/channels/${id}/snoop`, {
        spy: 'both',
        whisper: 'none',
        app: o.app,
        appArgs: o.appArgs,
        snoopId: o.snoopId,
      }),
  };

  bridges = {
    get: (id: string) => this.req<AriBridge>('GET', `/bridges/${id}`),
    create: (id: string, name: string) =>
      this.req<AriBridge>('POST', `/bridges/${id}`, { type: 'mixing', name }),
    add: (id: string, channels: string[]) =>
      this.quiet('POST', `/bridges/${id}/addChannel`, { channel: channels.join(',') }),
    remove: (id: string, channels: string[]) =>
      this.quiet('POST', `/bridges/${id}/removeChannel`, { channel: channels.join(',') }),
    destroy: (id: string) => this.quiet('DELETE', `/bridges/${id}`),
    record: (id: string, name: string) =>
      this.req('POST', `/bridges/${id}/record`, {
        name,
        format: 'wav',
        ifExists: 'overwrite',
        beep: false,
        terminateOn: 'none',
      }),
  };

  recordings = {
    storedFile: async (name: string): Promise<Buffer> => {
      const r = await fetch(`${this.baseUrl}/recordings/stored/${encodeURIComponent(name)}/file`, {
        headers: { authorization: this.auth },
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new AriError(r.status, `ARI запись ${name}: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    deleteStored: (name: string) => this.quiet('DELETE', `/recordings/stored/${encodeURIComponent(name)}`),
  };

  /** Поток событий приложения; onClose — при любом разрыве (переподключение решает вызывающий). */
  events(app: string, onEvent: (e: AriEvent) => void, onOpen: () => void, onClose: (why: string) => void) {
    const ws = new WebSocket(
      `${this.baseUrl.replace(/^http/, 'ws')}/events?app=${encodeURIComponent(app)}&subscribeAll=false&api_key=${encodeURIComponent(`${this.user}:${this.password}`)}`,
    );
    let closed = false;
    const close = (why: string) => {
      if (closed) return;
      closed = true;
      onClose(why);
    };
    ws.onopen = () => onOpen();
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as AriEvent);
      } catch {
        /* некорректное событие пропускаем */
      }
    };
    ws.onerror = () => close('ошибка WebSocket ARI');
    ws.onclose = (e) => close(`WebSocket ARI закрыт (${e.code})`);
    return {
      close: () => {
        closed = true;
        ws.close();
      },
    };
  }
}
