import { Button, Center, Group, Paper, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import JsSIP from 'jssip';
import type { RTCSession } from 'jssip/lib/RTCSession';
import type { UA } from 'jssip/lib/UA';
import { useEffect, useRef, useState } from 'react';
import { errorText, post } from '../lib/api';
import { fastIceReady } from '../lib/ice-ready';
import { AUDIO_CONSTRAINTS } from '../lib/softphone';
import { t } from '../lib/i18n';

interface DemoCreds {
  wsUri: string;
  sipUri: string;
  authorizationUser: string;
  password: string;
  displayName: string;
  domain: string;
  did: string;
  iceServers: RTCIceServer[];
}

/**
 * Демо-страница «Позвонить в КЦ» (02-архитектура 8.1): клиент звонит из браузера по WebRTC — для показа
 * телефонии без SIP-транка. Доступна только на демо-стенде (DEMO_CALLER_ENABLED).
 */
const PHONE_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23f76707'/%3E%3Cpath d='M11 7c1.2 0 2.4 2.4 3 4.2.4 1.2-.7 1.9-1.4 2.6 1.2 2.6 3.1 4.5 5.8 5.8.7-.7 1.4-1.8 2.6-1.4 1.8.6 4.2 1.8 4.2 3 0 1.9-2.1 3.6-4 3.3C14.6 23.6 9 18 8.4 11 8.2 9.1 9.1 7 11 7z' fill='white'/%3E%3C/svg%3E";

export function DemoCallPage() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [did, setDid] = useState('');
  const [state, setState] = useState<'idle' | 'calling' | 'talking' | 'ended'>('idle');
  const [info, setInfo] = useState('');
  const ua = useRef<UA | null>(null);
  const session = useRef<RTCSession | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => () => ua.current?.stop(), []);
  // Своя иконка и заголовок вкладки браузера — «Звонилка» отличается от вкладок сотрудников.
  useEffect(() => {
    document.title = t.demoCall.tabTitle;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = PHONE_ICON;
  }, []);

  const call = async () => {
    setInfo('');
    let c: DemoCreds;
    try {
      c = await post<DemoCreds>('/telephony/demo-caller', {
        name: name || undefined,
        phone: phone || undefined,
      });
    } catch (e) {
      setInfo(errorText(e));
      return;
    }
    ua.current?.stop();
    const u = new JsSIP.UA({
      sockets: [new JsSIP.WebSocketInterface(c.wsUri)],
      uri: c.sipUri,
      authorization_user: c.authorizationUser,
      password: c.password,
      display_name: c.displayName,
      register: false,
      session_timers: false,
    });
    ua.current = u;
    u.on('connected', () => {
      setState('calling');
      const s = u.call(`sip:${did.trim() || c.did}@${c.domain}`, {
        mediaConstraints: { audio: AUDIO_CONSTRAINTS, video: false },
        pcConfig: { iceServers: c.iceServers },
        eventHandlers: { icecandidate: fastIceReady() },
      });
      session.current = s;
      s.connection?.addEventListener('track', (t: RTCTrackEvent) => {
        if (audio.current) {
          audio.current.srcObject = t.streams[0] ?? new MediaStream([t.track]);
          void audio.current.play().catch(() => undefined);
        }
      });
      s.on('confirmed', () => setState('talking'));
      const done = (e: { cause?: string }) => {
        setState('ended');
        setInfo(e?.cause ? t.demoCall.zvonokZavershen(e.cause) : t.demoCall.zvonokZavershen2);
        u.stop();
      };
      s.on('ended', done);
      s.on('failed', done);
    });
    u.start();
  };

  return (
    <Center h="100vh">
      <Paper withBorder shadow="sm" p="lg" w={380}>
        <Stack>
          <Title order={3}>{t.demoCall.pozvonitVKontaktTsentr}</Title>
          <Text size="sm" c="dimmed">
            {t.demoCall.demoZvonokIzBrauzera}
          </Text>
          <TextInput
            label={t.demoCall.vasheImya}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <TextInput
            label={t.demoCall.vashNomerDlyaUznavaniya}
            placeholder="+375 29 123-45-67"
            value={phone}
            onChange={(e) => setPhone(e.currentTarget.value)}
            data-testid="demo-phone"
          />
          <TextInput
            label={t.demoCall.nomerKontaktTsentra}
            description={t.demoCall.n2000CherezIvrDemo}
            placeholder="2000"
            value={did}
            onChange={(e) => setDid(e.currentTarget.value)}
            data-testid="demo-did"
          />
          {state === 'idle' || state === 'ended' ? (
            <Button color="green" onClick={() => void call()} data-testid="demo-call">
              {t.demoCall.pozvonit}
            </Button>
          ) : (
            <>
              <Text data-testid="demo-state">
                {state === 'talking' ? t.demoCall.idetRazgovor : t.demoCall.soedinenie}
              </Text>
              <SimpleGrid cols={3} spacing={4}>
                {'123456789*0#'.split('').map((d) => (
                  <Button
                    key={d}
                    variant="default"
                    // RFC 4733 (как у транка), а не SIP INFO: цифры идут в медиапотоке.
                    onClick={() =>
                      session.current?.sendDTMF(d, { transportType: JsSIP.C.DTMF_TRANSPORT.RFC2833 })
                    }
                    data-testid={`demo-dtmf-${d === '*' ? 'star' : d === '#' ? 'hash' : d}`}
                  >
                    {d}
                  </Button>
                ))}
              </SimpleGrid>
              <Group grow>
                <Button color="red" onClick={() => session.current?.terminate()} data-testid="demo-hangup">
                  {t.demoCall.polozhitTrubku}
                </Button>
              </Group>
            </>
          )}
          {info && (
            <Text size="sm" data-testid="demo-info">
              {info}
            </Text>
          )}
          <audio ref={audio} autoPlay />
        </Stack>
      </Paper>
    </Center>
  );
}
