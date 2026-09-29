/**
 * Клиент API: access-токен в памяти, refresh — в httpOnly cookie (недоступен скриптам).
 * При 401 один раз пытаемся обновить сессию и повторить запрос.
 */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function onSessionLost(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setAccessToken(t: string | null): void {
  accessToken = t;
}

export const getAccessToken = (): string | null => accessToken;

/** Загрузка файла сырым телом (вложения). */
export async function upload<T>(path: string, file: File): Promise<T> {
  const doIt = () =>
    fetch(`/api/v1${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: file,
    });
  let r = await doIt();
  if (r.status === 401 && (await refreshSession())) r = await doIt();
  const data = await r.json();
  if (!r.ok) throw new ApiError(r.status, String(data.error), String(data.message), data.details);
  return data as T;
}

/** Открыть вложение (скачивание с авторизацией через Bearer). */
export async function openAttachment(id: string): Promise<void> {
  const r = await fetch(`/api/v1/attachments/${id}`, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  if (!r.ok) throw new ApiError(r.status, 'download', 'Файл недоступен');
  const url = URL.createObjectURL(await r.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Файл, требующий авторизации (запись разговора, аудио IVR), как blob-URL для <audio>. */
export async function authBlobUrl(path: string): Promise<string> {
  const doIt = () =>
    fetch(`/api/v1${path}`, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
  let r = await doIt();
  if (r.status === 401 && (await refreshSession())) r = await doIt();
  if (!r.ok) throw new ApiError(r.status, 'file', 'Файл недоступен');
  return URL.createObjectURL(await r.blob());
}

/** Аудио записи разговора как blob-URL для <audio> (авторизация через Bearer). */
export const recordingUrl = (id: string) => authBlobUrl(`/recordings/${id}`);

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) return false;
      accessToken = ((await r.json()) as { accessToken: string }).accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  retry = true,
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refreshSession()) return api<T>(method, path, body, false);
    accessToken = null;
    listeners.forEach((l) => l());
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(data.error ?? 'error'),
      String(data.message ?? res.statusText),
      data.details,
    );
  }
  return data as T;
}

export const get = <T>(p: string) => api<T>('GET', p);
export const post = <T>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const patch = <T>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const put = <T>(p: string, b: unknown) => api<T>('PUT', p, b);

/** Текст ошибки для уведомления, включая ошибки полей. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = Array.isArray(e.details)
      ? (e.details as { path?: string; message?: string }[])
          .map((x) => `${x.path ? `${x.path}: ` : ''}${x.message}`)
          .join('; ')
      : '';
    return d ? `${e.message}: ${d}` : e.message;
  }
  return String(e);
}
