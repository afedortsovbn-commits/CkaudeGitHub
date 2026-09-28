import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChatApi, type Msg, store, uuid, type WidgetConfig } from './api';
import { css } from './styles';

const script = document.currentScript as HTMLScriptElement | null;
const base = script ? new URL(script.src).href.replace(/\/widget\/widget\.js.*$/, '') : location.origin;
const key = script?.dataset.key ?? 'demo-webchat';
const inline = script?.dataset.mode === 'inline';
const appUser = script?.dataset.appUserId
  ? { id: script.dataset.appUserId, signature: script.dataset.appSig ?? '' }
  : undefined;
const TOKEN_KEY = `cc-widget:${key}`;

function Chat() {
  const api = useRef(new ChatApi(base, key)).current;
  const [open, setOpen] = useState(inline);
  const [cfg, setCfg] = useState<WidgetConfig | null>(null);
  const [token, setToken] = useState<string | null>(store.get(TOKEN_KEY));
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<Msg['attachments']>([]);
  const [form, setForm] = useState({ name: '', phone: '', consent: false });
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
    if (!token || !open) return;
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
        if (d.type === 'message') merge([d.message]);
        if (d.type === 'typing') {
          setTyping(true);
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
  }, [token, open]);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [msgs, typing]);

  const start = async () => {
    setError(null);
    try {
      const s = await api.session({
        consentAccepted: true,
        consentVersion: cfg!.consentVersion,
        name: form.name || undefined,
        phone: form.phone || undefined,
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
    } catch {
      // Повтор с тем же clientMessageId безопасен — дубль не создастся.
      setMsgs((cur) => cur.map((x) => (x.id === m.id ? { ...x, failed: true } : x)));
      setTimeout(() => void deliver(m), 3000);
    }
  };

  const send = () => {
    if (!text.trim() && !pendingFiles.length) return;
    const id = uuid();
    const m: Msg = {
      id,
      clientMessageId: id,
      direction: 'in',
      body: text.trim(),
      attachments: pendingFiles,
      sentAt: new Date().toISOString(),
      pending: true,
    };
    setMsgs((cur) => [...cur, m]);
    setText('');
    setPendingFiles([]);
    void deliver(m);
  };

  const attach = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (cfg && f.size > cfg.maxFileMb * 1024 * 1024) {
      setError(`Файл больше ${cfg.maxFileMb} МБ`);
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

  const panel = (
    <div class={`panel${inline ? ' inline' : ''}`} data-testid="cc-panel">
      <div class="head">
        <span>{cfg?.name ?? 'Чат'}</span>
        {!inline && <button onClick={() => setOpen(false)}>×</button>}
      </div>
      {!token ? (
        <div class="form">
          <div>{cfg?.greeting}</div>
          <input
            placeholder="Ваше имя (необязательно)"
            value={form.name}
            onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })}
          />
          <input
            placeholder="Телефон (необязательно)"
            value={form.phone}
            onInput={(e) => setForm({ ...form, phone: (e.target as HTMLInputElement).value })}
          />
          <label>
            <input
              type="checkbox"
              checked={form.consent}
              onChange={(e) => setForm({ ...form, consent: (e.target as HTMLInputElement).checked })}
            />
            <span>{cfg?.consentText}</span>
          </label>
          {error && <div class="err">{error}</div>}
          <button class="primary" disabled={!form.consent || !cfg} onClick={() => void start()}>
            Начать чат
          </button>
        </div>
      ) : (
        <>
          <div class="body" ref={bodyRef}>
            {msgs.length === 0 && <div class="m system">{cfg?.greeting}</div>}
            {msgs.map((m) => (
              <div
                key={m.id}
                class={`m ${m.direction}${m.failed ? ' failed' : ''}`}
                data-testid={`cc-msg-${m.direction}`}
              >
                {m.direction === 'out' && m.authorName && <div class="who">{m.authorName}</div>}
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
                {m.failed && <div class="err">не отправлено, повторяем…</div>}
              </div>
            ))}
          </div>
          {typing && <div class="typing">Оператор печатает…</div>}
          {pendingFiles.map((f) => (
            <div class="chip" key={f.id}>
              📎 {f.filename} {f.id === 'uploading' ? '(загрузка…)' : ''}
            </div>
          ))}
          {error && (
            <div class="err" style="padding:0 10px">
              {error}
            </div>
          )}
          <div class="foot">
            <label
              class="icon"
              title="Прикрепить файл"
              style="display:flex;align-items:center;justify-content:center"
            >
              📎
              <input type="file" style="display:none" onChange={(e) => void attach(e)} />
            </label>
            <textarea
              rows={1}
              placeholder="Сообщение…"
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
            <button class="icon send" title="Отправить" data-testid="cc-send" onClick={send}>
              ➤
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
        <button class="btn" title="Чат с поддержкой" data-testid="cc-open" onClick={() => setOpen(!open)}>
          💬
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
