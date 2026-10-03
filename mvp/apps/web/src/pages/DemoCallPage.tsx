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
