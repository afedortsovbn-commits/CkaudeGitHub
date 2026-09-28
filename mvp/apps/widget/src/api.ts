export interface WidgetConfig {
  name: string;
  greeting: string;
  consentText: string;
  consentVersion: string;
  maxFileMb: number;
}
export interface Msg {
  id: string;
  seq?: number;
  direction: 'in' | 'out' | 'system';
  body: string;
  attachments: { id: string; filename: string; contentType: string; size: number }[];
  sentAt: string;
  authorName?: string | null;
  pending?: boolean;
  failed?: boolean;
  clientMessageId?: string;
  externalId?: string | null;
}

export class ChatApi {
  token: string | null = null;
  constructor(
    public base: string,
    public key: string,
  ) {}

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    raw?: { data: Blob; filename: string },
  ): Promise<T> {
    const r = await fetch(`${this.base}/api/v1/client${path}`, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(raw
          ? {
              'content-type': raw.data.type || 'application/octet-stream',
              'x-filename': encodeURIComponent(raw.filename),
            }
          : body
            ? { 'content-type': 'application/json' }
            : {}),
      },
      body: raw ? raw.data : body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (!r.ok) throw Object.assign(new Error(data.message || 'Ошибка'), { status: r.status });
    return data as T;
  }

  config = () => this.req<WidgetConfig>('GET', `/config?publicKey=${encodeURIComponent(this.key)}`);
  session = (b: Record<string, unknown>) =>
    this.req<{ token: string; contactId: string }>('POST', '/session', { publicKey: this.key, ...b });
  messages = (after?: string) =>
    this.req<Msg[]>('GET', `/messages${after ? `?after=${encodeURIComponent(after)}` : ''}`);
  send = (clientMessageId: string, body: string, attachmentIds: string[]) =>
    this.req('POST', '/messages', { clientMessageId, body, attachmentIds });
  upload = (file: File) =>
    this.req<Msg['attachments'][number]>('POST', '/attachments', undefined, {
      data: file,
      filename: file.name,
    });
  fileUrl = (id: string) =>
    `${this.base}/api/v1/client/attachments/${id}?t=${encodeURIComponent(this.token ?? '')}`;
  wsUrl = () => `${this.base.replace(/^http/, 'ws')}/ws?client=${encodeURIComponent(this.token ?? '')}`;
}

export const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null): void {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* хранилище недоступно (приватный режим) — сессия живёт до перезагрузки */
    }
  },
};
