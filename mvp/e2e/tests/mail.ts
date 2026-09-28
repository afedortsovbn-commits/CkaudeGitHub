/**
 * Минимальные SMTP- и IMAP-клиенты для e2e против GreenMail (профиль test, авторизация отключена):
 * «клиент» отправляет письмо в ящик КЦ и читает ответ оператора в своём ящике.
 */
import { connect, type Socket } from 'node:net';

const HOST = process.env.E2E_MAIL_HOST ?? '127.0.0.1';
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 3025);
const IMAP_PORT = Number(process.env.E2E_IMAP_PORT ?? 3143);

class Conn {
  private buf = '';
  private waiters: (() => void)[] = [];
  constructor(private readonly s: Socket) {
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      this.buf += d;
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  static open(port: number): Promise<Conn> {
    return new Promise((resolve, reject) => {
      const s = connect(port, HOST, () => resolve(new Conn(s)));
      s.once('error', reject);
    });
  }
  /** Ждёт, пока накопленный ответ не будет удовлетворять условию; возвращает его и очищает буфер. */
  async until(done: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!done(this.buf)) {
      if (Date.now() > deadline) throw new Error(`нет ответа почтового сервера: ${this.buf.slice(-300)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 200);
      });
    }
    const out = this.buf;
    this.buf = '';
    return out;
  }
  write(line: string): void {
    this.s.write(`${line}\r\n`);
  }
  close(): void {
    this.s.end();
  }
}

const smtpReply = (code: string) => (t: string) => new RegExp(`(^|\\r\\n)${code} [^\\r\\n]*\\r\\n$`).test(t);

export async function sendMail(m: {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  references?: string[];
}): Promise<void> {
  const c = await Conn.open(SMTP_PORT);
  await c.until(smtpReply('220'));
  c.write('HELO e2e.local');
  await c.until(smtpReply('250'));
  c.write(`MAIL FROM:<${m.from}>`);
  await c.until(smtpReply('250'));
  c.write(`RCPT TO:<${m.to}>`);
  await c.until(smtpReply('250'));
  c.write('DATA');
  await c.until(smtpReply('354'));
  const subject = `=?UTF-8?B?${Buffer.from(m.subject).toString('base64')}?=`;
  const refs = m.references?.length
    ? [`In-Reply-To: ${m.references[m.references.length - 1]}`, `References: ${m.references.join(' ')}`]
    : [];
  const body = Buffer.from(m.text).toString('base64');
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${subject}`,
    `Message-ID: ${m.messageId}`,
    ...refs,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...(body.match(/.{1,76}/g) ?? []),
    '.',
  ];
  c.write(lines.join('\r\n'));
  await c.until(smtpReply('250'));
  c.write('QUIT');
  c.close();
}

export interface ReceivedMail {
  raw: string;
  subject: string;
  inReplyTo: string | null;
  messageId: string | null;
  text: string;
}

function decodeWord(v: string): string {
  return v.replace(/=\?utf-8\?(b|q)\?([^?]*)\?=/gi, (_, enc: string, data: string) =>
    enc.toLowerCase() === 'b'
      ? Buffer.from(data, 'base64').toString('utf8')
      : Buffer.from(
          data
            .replace(/_/g, ' ')
            .replace(/=([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
          'latin1',
        ).toString('utf8'),
  );
}

function parse(raw: string): ReceivedMail {
  const [head = '', ...rest] = raw.split(/\r\n\r\n/);
  const unfolded = head.replace(/\r\n[ \t]+/g, ' ');
  const header = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded)?.[1]?.trim() ?? null;
  let text = rest.join('\r\n\r\n');
  const cte = (header('Content-Transfer-Encoding') ?? '').toLowerCase();
  if (cte === 'base64') text = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
  else if (cte === 'quoted-printable')
    text = Buffer.from(
      text
        .replace(/=\r\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
      'latin1',
    ).toString('utf8');
  return {
    raw,
    subject: decodeWord((header('Subject') ?? '').replace(/\?=\s+=\?/g, '?==?')),
    inReplyTo: header('In-Reply-To'),
    messageId: header('Message-ID'),
    text,
  };
}

/** Все письма ящика (GreenMail создаёт ящик при первом входе, пароль при отключённой авторизации любой). */
export async function readMailbox(user: string): Promise<ReceivedMail[]> {
  const c = await Conn.open(IMAP_PORT);
  const tagged = (tag: string) => (t: string) =>
    new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n$`).test(t);
  await c.until((t) => t.includes('\r\n'));
  c.write(`a1 LOGIN "${user}" "pw"`);
  await c.until(tagged('a1'));
  c.write('a2 SELECT INBOX');
  const sel = await c.until(tagged('a2'));
  const exists = Number(/\* (\d+) EXISTS/.exec(sel)?.[1] ?? 0);
  const out: ReceivedMail[] = [];
  for (let i = 1; i <= exists; i++) {
    c.write(`f${i} FETCH ${i} BODY.PEEK[]`);
    const r = await c.until(tagged(`f${i}`));
    const m = /\{(\d+)\}\r\n/.exec(r);
    if (!m) continue;
    const start = m.index + m[0].length;
    out.push(parse(Buffer.from(r.slice(start), 'utf8').subarray(0, Number(m[1])).toString('utf8')));
  }
  c.write('a3 LOGOUT');
  c.close();
  return out;
}
