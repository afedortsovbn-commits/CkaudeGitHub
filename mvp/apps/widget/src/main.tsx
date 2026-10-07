import { Fragment, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChatApi, type Msg, store, uuid, type WidgetConfig } from './api';
import { css } from './styles';
import { t } from './lib/i18n';

const script = document.currentScript as HTMLScriptElement | null;
const base = script ? new URL(script.src).href.replace(/\/widget\/widget\.js.*$/, '') : location.origin;
const key = script?.dataset.key ?? 'demo-webchat';
const inline = script?.dataset.mode === 'inline';
const appUser = script?.dataset.appUserId
  ? { id: script.dataset.appUserId, signature: script.dataset.appSig ?? '' }
  : undefined;
const TOKEN_KEY = `cc-widget:${key}`;

/** Значки (SVG): облако чата, крестик, скрепка, отправить, гарнитура оператора. */
const ICON = {
  chat: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
      <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" stroke-width="3" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  clip: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M3.4 20.4l17.4-7.5a1 1 0 0 0 0-1.8L3.4 3.6a.9.9 0 0 0-1.2 1.1L4.5 11 13 12l-8.5 1-2.3 6.3a.9.9 0 0 0 1.2 1.1z" />
    </svg>
  ),
  agent: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="13" width="4" height="6" rx="1.5" />
      <rect x="17" y="13" width="4" height="6" rx="1.5" />
      <path d="M19 19c0 1.5-2 2.5-5 2.5" />
    </svg>
  ),
};

function Chat() {
  const api = useRef(new ChatApi(base, key)).current;
  const [open, setOpen] = useState(inline);
  const [cfg, setCfg] = useState<WidgetConfig | null>(null);
  const [token, setToken] = useState<string | null>(store.get(TOKEN_KEY));
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState<string | false>(false);
  const [unread, setUnread] = useState(0);
  const openRef = useRef(open);
  openRef.current = open;
  const showTypingRef = useRef(true);
  showTypingRef.current = cfg?.showTyping !== false;
  const [pendingFiles, setPendingFiles] = useState<Msg['attachments']>([]);
  const [form, setForm] = useState({ name: '', phone: '', email: '', consent: false });
  const wsRef = useRef<WebSocket | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastAt = useRef<string | undefined>(undefined);

  api.token = token;

  useEffect(() => {
    api
      .config()
      .then(setCfg)
      .catch((e: Error) => setError(e.message));
  }, []);

  const merge = (incoming: Msg[]) =>
    setMsgs((cur) => {
      const byId = new Map(cur.map((m) => [m.id, m]));
      for (const m of incoming) {
        // Подтверждённое сообщение клиента заменяет «отправляется…» с тем же clientMessageId.
        if (m.externalId) byId.delete(m.externalId);
        byId.set(m.id, m);
      }
      const list = [...byId.values()].sort((a, b) =>
        a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0,
      );
      const confirmed = list.filter((m) => !m.pending);
      if (confirmed.length) lastAt.current = confirmed[confirmed.length - 1]!.sentAt;
      return list;
    });

  // Подключение: догрузка истории, затем WebSocket с переподключением (после 1012 — к другому экземпляру).
  useEffect(() => {
    // Соединение держится и при свёрнутом чате: ответ оператора даёт счётчик на значке.
    if (!token) return;
    let stopped = false;
    let retry = 0;
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        merge(await api.messages(lastAt.current));
      } catch (e) {
        if ((e as { status?: number }).status === 401) {
          store.set(TOKEN_KEY, null);
          setToken(null);
          return;
        }
      }
      if (stopped) return;
      const ws = new WebSocket(api.wsUrl());
      wsRef.current = ws;
      ws.onopen = () => (retry = 0);
      ws.onmessage = (ev) => {
        const d = JSON.parse(String(ev.data));
        if (d.type === 'message') {
          merge([d.message]);
          // Ответ пришёл, пока чат свёрнут, — счётчик на значке.
          if (!openRef.current && d.message?.direction === 'out') setUnread((n) => n + 1);
          if (d.message?.direction === 'out') setTyping(false);
        }
        if (d.type === 'typing' && showTypingRef.current) {
          setTyping(String(d.name ?? ''));
          clearTimeout(typingTimer);
          typingTimer = setTimeout(() => setTyping(false), 4000);
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        const delay = Math.min(500 * 2 ** retry++, 10_000);
        setTimeout(() => void connect(), delay);
      };
    };
    void connect();
    return () => {
      stopped = true;
      wsRef.current?.close();
    };
  }, [token]);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [msgs, typing]);

  const start = async () => {
    setError(null);
    try {
      const s = await api.session({
        consentAccepted: true,
        consentVersion: cfg!.consentVersion,
        name: form.name.trim() || undefined,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        appUser,
      });
      store.set(TOKEN_KEY, s.token);
      setToken(s.token);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deliver = async (m: Msg) => {
    try {
      await api.send(
        m.clientMessageId!,
        m.body,
        m.attachments.map((a) => a.id),
      );
      setMsgs((cur) => cur.map((x) => (x.id === m.id ? { ...x, failed: false } : x)));
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 401) {
        // Сессия устарела (например, клиента нет после сброса стенда): начать чат заново, текст не теряется.
        store.set(TOKEN_KEY, null);
        setToken(null);
        setMsgs([]);
        setText(m.body);
        setError(t.widget.sessionExpired);
        return;
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        // Ошибка в данных — повтор не поможет: показать причину.
        setMsgs((cur) => cur.map((x) => (x.id === m.id ? { ...x, failed: true } : x)));
        setError((e as Error).message || t.widget.notSent);
        return;
      }
      // Сеть или сервер недоступны — повтор с тем же clientMessageId безопасен (дубль не создастся).
      setMsgs((cur) => cur.map((x) => (x.id === m.id ? { ...x, failed: true } : x)));
      setTimeout(() => void deliver(m), 3000);
    }
  };

  const rate = async (m: Msg, score: number) => {
    try {
      await api.csat(m.conversationId!, score);
      setMsgs((cur) => cur.map((x) => (x.id === m.id ? { ...x, rated: true } : x)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const send = (quick?: string) => {
    const body = quick ?? text.trim();
    if (!body && (quick !== undefined || !pendingFiles.length)) return;
    const id = uuid();
    const m: Msg = {
      id,
      clientMessageId: id,
      direction: 'in',
      body,
      attachments: quick !== undefined ? [] : pendingFiles,
      sentAt: new Date().toISOString(),
      pending: true,
    };
    setMsgs((cur) => [...cur, m]);
    if (quick === undefined) {
      setText('');
      setPendingFiles([]);
    }
    void deliver(m);
  };

  const attach = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (cfg && f.size > cfg.maxFileMb * 1024 * 1024) {
      setError(t.widget.faylBolsheMb(cfg.maxFileMb));
      return;
    }
    try {
      setPendingFiles((p) => [
        ...p,
        { id: 'uploading', filename: f.name, contentType: f.type, size: f.size },
      ]);
      const a = await api.upload(f);
      setPendingFiles((p) => [...p.filter((x) => x.id !== 'uploading'), a]);
    } catch (err) {
      setPendingFiles((p) => p.filter((x) => x.id !== 'uploading'));
      setError((err as Error).message);
    }
  };

  const onType = (v: string) => {
    setText(v);
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'typing' }));
  };

  // Анкета перед чатом (п.2 требований): поля и обязательность — из настроек канала.
  const fields = cfg?.prechatFields ?? [
    { key: 'name' as const, required: false },
    { key: 'phone' as const, required: false },
  ];
  const missing = appUser ? [] : fields.filter((f) => f.required && !form[f.key].trim());

  const panel = (
    <div class={`panel${inline ? ' inline' : ''}`} data-testid="cc-panel">
      <div class="head">
        <div class="ttl">
          <div class="avatar">{ICON.agent}</div>
          <div style="min-width:0">
            <div class="name">{cfg?.name ?? t.widget.chat}</div>
            <div class="sub">
              <i />
              {t.widget.online}
            </div>
          </div>
        </div>
        {!inline && (
          <button onClick={() => setOpen(false)} title={t.widget.close} aria-label={t.widget.close}>
            {ICON.close}
          </button>
        )}
      </div>
      {!token ? (
        <div class="form">
          <div class="greet">{cfg?.greeting}</div>
          {fields.map((f) => (
            <input
              key={f.key}
              type={f.key === 'phone' ? 'tel' : f.key === 'email' ? 'email' : 'text'}
              autoComplete={f.key === 'phone' ? 'tel' : f.key === 'email' ? 'email' : 'name'}
              placeholder={`${t.widget.field[f.key]}${f.required ? ' *' : t.widget.optional}`}
              value={form[f.key]}
              class={f.required && !form[f.key].trim() ? 'need' : ''}
              data-testid={`cc-field-${f.key}`}
              onInput={(e) => setForm({ ...form, [f.key]: (e.target as HTMLInputElement).value })}
            />
          ))}
          <label>
            <input
              type="checkbox"
              checked={form.consent}
              onChange={(e) => setForm({ ...form, consent: (e.target as HTMLInputElement).checked })}
            />
            <span>{cfg?.consentText}</span>
          </label>
          {error && <div class="err">{error}</div>}
          {missing.length > 0 && (
            <div class="hint" data-testid="cc-missing">
              {t.widget.zapolnite(missing.map((f) => t.widget.field[f.key]).join(', '))}
            </div>
          )}
          <button
            class="primary"
            disabled={!form.consent || !cfg || missing.length > 0}
            onClick={() => void start()}
            data-testid="cc-start"
          >
            {t.widget.nachatChat}
          </button>
        </div>
      ) : (
        <>
          <div class="body" ref={bodyRef}>
            {msgs.length === 0 && <div class="m system">{cfg?.greeting}</div>}
            {msgs.map((m, i) => (
              <Fragment key={m.id}>
                <div
                  class={`m ${m.direction}${m.failed ? ' failed' : m.pending ? ' pending' : ''}`}
                  data-testid={`cc-msg-${m.direction}`}
                >
                  {m.direction === 'out' && (m.meta?.auto || m.authorName) && (
                    <div class="who">
                      {m.meta?.auto === 'bot'
                        ? t.widget.bot
                        : m.meta?.auto
                          ? t.widget.avtootvet
                          : m.authorName}
                    </div>
                  )}
                  {m.body}
                  {m.attachments.map((a) => (
                    <div key={a.id}>
                      📎{' '}
                      {a.id === 'uploading' ? (
                        a.filename
                      ) : (
                        <a href={api.fileUrl(a.id)} target="_blank" rel="noopener">
                          {a.filename}
                        </a>
                      )}
                    </div>
                  ))}
                  {m.failed && <div class="err">{t.widget.neOtpravlenoPovtoryaem}</div>}
                </div>
                {/* Кнопки бота — только у последнего сообщения: нажатие отправляет текст кнопки. */}
                {i === msgs.length - 1 && m.meta?.buttons?.length ? (
                  <div class="btns" data-testid="cc-buttons">
                    {m.meta.buttons.map((b) => (
                      <button key={b.id} onClick={() => send(b.label)}>
                        {b.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {m.meta?.csat && m.conversationId && (
                  <div class="csat" data-testid="cc-csat">
                    {m.rated ? (
                      t.widget.spasiboZaOtsenku
                    ) : (
                      <>
                        <div>{t.widget.otsenitePozhaluystaObsluzhivanie}</div>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button key={n} onClick={() => void rate(m, n)} data-testid={`cc-csat-${n}`}>
                            {n}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </Fragment>
            ))}
            {typing !== false && (
              <div class="typing" data-testid="cc-typing">
                <div class="dots">
                  <span />
                  <span />
                  <span />
                </div>
                <div class="lbl">{t.widget.typingName(typing)}</div>
              </div>
            )}
          </div>
          {pendingFiles.map((f) => (
            <div class="chip" key={f.id}>
              📎 {f.filename} {f.id === 'uploading' ? t.widget.zagruzka : ''}
            </div>
          ))}
          {error && <div class="notice">{error}</div>}
          <div class="foot">
            <label class="icon" title={t.widget.prikrepitFayl}>
              {ICON.clip}
              <input type="file" style="display:none" onChange={(e) => void attach(e)} />
            </label>
            <textarea
              rows={1}
              placeholder={t.widget.soobshchenie}
              value={text}
              data-testid="cc-input"
              onInput={(e) => onType((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button class="icon send" title={t.widget.otpravit} data-testid="cc-send" onClick={() => send()}>
              {ICON.send}
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <style>{css}</style>
      {open ? panel : null}
      {!inline && (
        <button
          class={`btn${open ? ' opened' : ''}${!open && unread ? ' attn' : ''}`}
          title={t.widget.chatSPodderzhkoy}
          aria-label={t.widget.chatSPodderzhkoy}
          data-testid="cc-open"
          onClick={() => {
            setOpen(!open);
            setUnread(0);
          }}
        >
          {open ? ICON.close : ICON.chat}
          {!open && unread > 0 && <span class="badge">{unread}</span>}
        </button>
      )}
    </>
  );
}

const host = document.createElement('div');
host.id = 'cc-widget';
document.body.appendChild(host);
const root = host.attachShadow({ mode: 'open' });
render(<Chat />, root);
