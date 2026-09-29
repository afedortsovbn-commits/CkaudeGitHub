import { PermanentError } from '@cc/connector-kit';

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`Telegram ${code}: ${message}`);
  }
}

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_size?: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/**
 * Минимальный клиент Telegram Bot API (только нужные методы). Адрес API настраивается — это же позволяет
 * работать через локальный Bot API-сервер внутри контура и с моком в тестах.
 */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly root = 'https://api.telegram.org',
  ) {}

  private async call<T>(
    method: string,
    body: Record<string, unknown> | FormData,
    signal?: AbortSignal,
  ): Promise<T> {
    const isForm = body instanceof FormData;
    const r = await fetch(`${this.root}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const data = (await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }))) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
    };
    if (!data.ok) {
      const code = data.error_code ?? r.status;
      // 400 (нет такого чата), 403 (бот заблокирован клиентом) — повтор не поможет.
      if (code === 400 || code === 403)
        throw new PermanentError(`Telegram ${code}: ${data.description ?? ''}`);
      throw new TelegramError(code, data.description ?? 'ошибка Bot API');
    }
    return data.result as T;
  }

  getMe() {
    return this.call<TgUser>('getMe', {});
  }

  getUpdates(offset: number, timeoutS: number, signal: AbortSignal) {
    return this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutS, allowed_updates: ['message'] },
      AbortSignal.any([signal, AbortSignal.timeout((timeoutS + 10) * 1000)]),
    );
  }

  /**
   * Текст; кнопки бота (Ф7) — клавиатура ответа: нажатие приходит обычным сообщением с текстом кнопки,
   * поэтому обработка ответа одинакова для всех каналов. Без кнопок клавиатура бота убирается.
   */
  sendMessage(chatId: string, text: string, buttons?: string[]) {
    const reply_markup = buttons?.length
      ? { keyboard: buttons.map((b) => [{ text: b }]), resize_keyboard: true, one_time_keyboard: true }
      : { remove_keyboard: true };
    return this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text, reply_markup });
  }

  sendDocument(
    chatId: string,
    file: { filename: string; contentType: string; body: Buffer },
    caption?: string,
  ) {
    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption);
    form.set('document', new Blob([new Uint8Array(file.body)], { type: file.contentType }), file.filename);
    return this.call<{ message_id: number }>('sendDocument', form);
  }

  setWebhook(url: string, secret: string) {
    return this.call<boolean>('setWebhook', { url, secret_token: secret, allowed_updates: ['message'] });
  }

  deleteWebhook() {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: false });
  }

  async download(fileId: string): Promise<Buffer> {
    const f = await this.call<{ file_path: string }>('getFile', { file_id: fileId });
    const r = await fetch(`${this.root}/file/bot${this.token}/${f.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new TelegramError(r.status, 'не удалось скачать файл');
    return Buffer.from(await r.arrayBuffer());
  }
}
