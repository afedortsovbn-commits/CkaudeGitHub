import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Drawer,
  Group,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { notifications } from '@mantine/notifications';
import { useMutation } from '@tanstack/react-query';
import { errorText, post } from '../lib/api';
import { t } from '../lib/i18n';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  links?: { to: string; label: string }[];
  stub?: boolean;
}

/**
 * Помощник администратора и супервизора (Д-031): значок в шапке, окно чата справа. Отвечает модель из
 * «Подсказки: провайдеры» (функция «Помощник»), пока её нет — заглушка по правилам на сервере.
 */
export function AiAssistant() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [msgs]);
  // Ошибка запроса — тостом (вопрос остаётся в переписке, можно спросить снова).
  const ask = useMutation({
    onError: (e) =>
      notifications.show({ color: 'red', title: t.error, message: errorText(e), autoClose: 8000 }),
    mutationFn: async (question: string) => {
      const history = msgs.slice(-10).map((m) => ({ role: m.role, text: m.text }));
      setMsgs((m) => [...m, { role: 'user', text: question }]);
      setQ('');
      const r = await post<{ answer: string; links: { to: string; label: string }[]; stub: boolean }>(
        '/assistant/ask',
        { question, history },
      );
      setMsgs((m) => [...m, { role: 'assistant', text: r.answer, links: r.links, stub: r.stub }]);
    },
  });
  const send = (text: string) => {
    if (text.trim() && !ask.isPending) ask.mutate(text.trim());
  };
  return (
    <>
      <Tooltip label={t.ai.assistant}>
        <ActionIcon
          variant="subtle"
          color="violet"
          size="lg"
          onClick={() => setOpen(true)}
          aria-label={t.ai.assistant}
          data-testid="ai-assistant-open"
        >
          <IconSparkles size={20} />
        </ActionIcon>
      </Tooltip>
      <Drawer
        opened={open}
        onClose={() => setOpen(false)}
        position="right"
        size="md"
        title={<Text fw={700}>{t.ai.assistantTitle}</Text>}
      >
        <Stack gap="sm" h="calc(100vh - 90px)">
          <Text size="xs" c="dimmed">
            {t.ai.assistantHint}
          </Text>
          <Stack gap={8} style={{ flex: 1, overflowY: 'auto' }} data-testid="ai-assistant-log">
            {msgs.length === 0 && (
              <Group gap={6}>
                {t.ai.assistantExamples.map((e) => (
                  <Button key={e} size="compact-xs" variant="light" color="violet" onClick={() => send(e)}>
                    {e}
                  </Button>
                ))}
              </Group>
            )}
            {msgs.map((m, i) => (
              <Box
                key={i}
                p="xs"
                maw="90%"
                className="cc-appear"
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  background:
                    m.role === 'user' ? 'var(--mantine-color-blue-1)' : 'var(--mantine-color-violet-0)',
                  borderRadius: 10,
                }}
                data-testid={m.role === 'user' ? 'ai-q' : 'ai-a'}
              >
                <Group gap={6} mb={2}>
                  <Text size="xs" c="dimmed">
                    {m.role === 'user' ? t.ai.you : t.ai.bot}
                  </Text>
                  {m.stub && (
                    <Badge size="xs" variant="outline" color="gray">
                      {t.ai.assistantStub}
                    </Badge>
                  )}
                </Group>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {m.text}
                </Text>
                {(m.links ?? []).length > 0 && (
                  <Group gap={8} mt={4}>
                    {m.links!.map((l) => (
                      <Anchor key={l.to} component={Link} to={l.to} size="xs" onClick={() => setOpen(false)}>
                        {l.label} →
                      </Anchor>
                    ))}
                  </Group>
                )}
              </Box>
            ))}
            <div ref={end} />
          </Stack>
          <Textarea
            autosize
            minRows={2}
            maxRows={5}
            placeholder={t.ai.assistantPlaceholder}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(q);
              }
            }}
            data-testid="ai-assistant-input"
          />
          <Button
            color="violet"
            onClick={() => send(q)}
            loading={ask.isPending}
            data-testid="ai-assistant-send"
          >
            {t.ai.assistantSend}
          </Button>
        </Stack>
      </Drawer>
    </>
  );
}
