import type { ChannelInstance, ChannelJournal, ConnectorStorage } from '@cc/connector-kit';
import { publishInbound } from '@cc/connector-kit';
import { type EmailChannelConfig, emailMessageId, newId, type OutboundMessage } from '@cc/contracts';
import type { KvLease, Logger } from '@cc/service-kit';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { JetStreamClient, KV } from 'nats';
import nodemailer, { type Transporter } from 'nodemailer';
import { parseEmail } from './parse';

const RECHECK_MS = 15_000;

const sleep = (ms: number, signal: AbortSignal, wake?: (fn: () => void) => void) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const done = () => (clearTimeout(t), resolve());
    signal.addEventListener('abort', done, { once: true });
    wake?.(done);
  });

interface MailState {
  uidValidity: string;
  lastUid: number;
}

/**
 * Один почтовый ящик (экземпляр канала email). Приём по IMAP (IDLE + страховочная проверка) ведёт только
 * владелец аренды ящика; последний обработанный UID — в NATS KV, поэтому новый владелец продолжает с того же
 * места, а повторно прочитанное письмо отсекается уникальным ключом (Message-ID) в БД. Письмо помечается
 * прочитанным только после записи в поток CC_INBOUND. Отправка ответов — по SMTP с любого экземпляра.
 */
export class MailboxRunner {
  private readonly abort = new AbortController();
  private loop?: Promise<void>;
  private readonly transport: Transporter;

  constructor(
    readonly channel: ChannelInstance<EmailChannelConfig>,
    private readonly o: {
      js: JetStreamClient;
      lease: KvLease;
      state: KV;
      storage: ConnectorStorage;
      journal: ChannelJournal;
      logger: Logger;
    },
  ) {
    const c = channel.config;
    this.transport = nodemailer.createTransport({
      host: c.smtp_host,
      port: c.smtp_port,
      secure: c.smtp_secure,
      auth: c.smtp_user ? { user: c.smtp_user, pass: c.smtp_password ?? '' } : undefined,
      tls: { rejectUnauthorized: !c.tls_insecure },
    });
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
    await this.o.lease.release();
    this.transport.close();
  }

  /** Ответ оператора письмом в ту же цепочку (In-Reply-To/References), Message-ID — детерминированный. */
  async send(msg: OutboundMessage): Promise<{ externalId: string }> {
    const c = this.channel.config;
    const messageId = emailMessageId(msg.messageId, c.address.split('@')[1] ?? 'cc.local');
    const attachments = [];
    for (const a of msg.attachments) {
      const f = await this.o.storage.read(a.id);
      attachments.push({ filename: f.filename, contentType: f.contentType, content: f.body });
    }
    await this.transport.sendMail({
      from: { name: c.display_name ?? '', address: c.address },
      to: msg.to,
      subject: msg.email?.subject ?? 'Ответ на ваше обращение',
      text: msg.body,
      messageId,
      inReplyTo: msg.email?.inReplyTo ?? undefined,
      references: msg.email?.references.length ? msg.email.references : undefined,
      attachments,
    });
    return { externalId: messageId };
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        if (!(await this.o.lease.refresh())) {
          await sleep(5000, signal);
          continue;
        }
        await this.session(signal);
      } catch (err) {
        if (signal.aborted) break;
        this.o.logger.warn({ err: String(err), channelId: this.channel.id }, 'ошибка почтового ящика');
        this.o.journal.status(this.channel.id, 'error', String(err).slice(0, 300));
        await sleep(5000, signal);
      }
    }
  }

  private async session(signal: AbortSignal): Promise<void> {
    const c = this.channel.config;
    const client = new ImapFlow({
      host: c.imap_host,
      port: c.imap_port,
      secure: c.imap_secure,
      auth: { user: c.imap_user, pass: c.imap_password },
      tls: { rejectUnauthorized: !c.tls_insecure },
      logger: false,
    });
    let wake: (() => void) | undefined;
    client.on('exists', () => wake?.());
    client.on('error', (err: unknown) => this.o.logger.warn({ err: String(err) }, 'IMAP'));
    await client.connect();
    const lock = await client.getMailboxLock(c.mailbox);
    try {
      this.o.journal.status(this.channel.id, 'connected', `${c.address}, IMAP ${c.imap_host}`);
      while (!signal.aborted && client.usable) {
        await this.sync(client);
        if (!(await this.o.lease.refresh())) break;
        await sleep(RECHECK_MS, signal, (fn) => (wake = fn));
      }
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }
  }

  private async sync(client: ImapFlow): Promise<void> {
    const { id } = this.channel;
    const mailbox = client.mailbox;
    if (!mailbox) return;
    const uidValidity = String(mailbox.uidValidity);
    const saved = await this.o.state.get(id);
    const prev = saved?.value.length ? (JSON.parse(saved.string()) as MailState) : null;
    // Первый запуск (или ящик пересоздан): берём только непрочитанные, историю ящика не импортируем.
    const fresh = !prev || prev.uidValidity !== uidValidity;
    const found = fresh
      ? await client.search({ seen: false }, { uid: true })
      : await client.search({ uid: `${prev.lastUid + 1}:*` }, { uid: true });
    const uids = (found || []).filter((u) => fresh || u > prev!.lastUid).sort((a, b) => a - b);
    let lastUid = fresh ? Math.max(0, Number(mailbox.uidNext) - 1) : prev.lastUid;
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (msg && msg.source) await this.ingest(msg.source, uidValidity, uid);
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      lastUid = Math.max(lastUid, uid);
      await this.o.state.put(id, JSON.stringify({ uidValidity, lastUid } satisfies MailState));
    }
    if (fresh) await this.o.state.put(id, JSON.stringify({ uidValidity, lastUid } satisfies MailState));
  }

  private async ingest(source: Buffer, uidValidity: string, uid: number): Promise<void> {
    const { id, config } = this.channel;
    const p = parseEmail(await simpleParser(source), config.address);
    if (!p) return;
    if (p.automatic) {
      this.o.journal.log(id, 'in', 'автоответ/рассылка — пропущено');
      return;
    }
    const attachments = [];
    for (const a of p.attachments) {
      const saved = await this.o.storage.saveInbound(a);
      if (saved) attachments.push(saved);
    }
    await publishInbound(this.o.js, {
      id: newId(),
      channelId: id,
      channelKind: 'email',
      externalId: (p.email.messageId ?? `${id}:${uidValidity}:${uid}`).slice(0, 200),
      identity: { kind: 'email', value: p.from },
      contact: { displayName: p.displayName ?? undefined, email: p.from },
      body: p.body || (p.email.subject ? `[${p.email.subject}]` : ''),
      attachments,
      receivedAt: Date.now(),
      meta: { email: p.email },
    });
    this.o.journal.log(id, 'in', attachments.length ? `письмо, вложений: ${attachments.length}` : 'письмо');
  }
}
