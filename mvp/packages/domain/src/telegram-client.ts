/**
 * Минимальный клиент Telegram Bot API для бота сотрудников (Д-010, Д-012): уведомления, привязка, аналитика.
 * Адрес API настраивается (локальный Bot API-сервер в контуре или мок на стенде). Клиентские боты каналов —
 * в connector-telegram, у них свой клиент.
 */
export class StaffBotError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface StaffKeyboardButton {
  text: string;
  /** Кнопка мини-приложения (только публичный https-адрес). */
  web_app?: { url: string };
}

export interface StaffUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string; type?: string };
    from?: { id: number | string; first_name?: string; username?: string };
  };
}

export class StaffTelegramApi {
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
    const r = await fetch(`${this.root.replace(/\/$/, '')}/bot${this.token}/${method}`, {
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
    if (!data.ok) throw new StaffBotError(data.error_code ?? r.status, data.description ?? 'ошибка Bot API');
    return data.result as T;
  }

  getMe() {
    return this.call<{ id: number; username?: string; first_name?: string }>('getMe', {});
  }

  getUpdates(offset: number, timeoutS: number, signal: AbortSignal) {
    return this.call<StaffUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutS, allowed_updates: ['message'] },
      AbortSignal.any([signal, AbortSignal.timeout((timeoutS + 10) * 1000)]),
    );
  }

  /** Текст (до 4096 знаков — длиннее режется) с клавиатурой ответа или без неё. */
  sendMessage(chatId: string, text: string, keyboard?: StaffKeyboardButton[][]) {
    const reply_markup = keyboard?.length
      ? { keyboard, resize_keyboard: true, is_persistent: true }
      : { remove_keyboard: true };
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4096),
      reply_markup,
    });
  }

  sendDocument(
    chatId: string,
    file: { filename: string; contentType: string; body: Buffer },
    caption?: string,
  ) {
    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption.slice(0, 1024));
    form.set('document', new Blob([new Uint8Array(file.body)], { type: file.contentType }), file.filename);
    return this.call<{ message_id: number }>('sendDocument', form);
  }
}
