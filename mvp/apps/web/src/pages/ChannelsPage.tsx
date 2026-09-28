import { Code, Text } from '@mantine/core';
import { DictPage } from '../components/DictPage';
import { type Row, options, useList } from '../lib/data';

/** Каналы: веб-чат и чат в приложении (Telegram и email — Ф4). */
export function ChannelsPage() {
  const queues = useList('/dict/queues');
  const toForm = (r: Row) => {
    const c = (r.config ?? {}) as Record<string, unknown>;
    return {
      ...r,
      publicKey: c.public_key,
      allowedOrigins: ((c.allowed_origins as string[]) ?? []).join(', '),
      consentText: c.consent_text,
      consentVersion: c.consent_version,
      greeting: c.greeting,
      maxFileMb: c.max_file_mb,
    };
  };
  return (
    <>
      <DictPage
        kind="channels"
        title="Каналы"
        columns={[
          { key: 'name', label: 'Название' },
          { key: 'kind', label: 'Тип' },
          {
            key: 'key',
            label: 'Ключ виджета',
            render: (r) => <Code>{String((r.config as Record<string, unknown>)?.public_key ?? '')}</Code>,
          },
          {
            key: 'origins',
            label: 'Разрешённые сайты',
            render: (r) =>
              String(
                ((r.config as Record<string, unknown>)?.allowed_origins as string[] | undefined)?.join(
                  ', ',
                ) ?? '',
              ),
          },
        ]}
        toForm={toForm}
        fromForm={(v) => {
          const { publicKey, allowedOrigins, consentText, consentVersion, greeting, maxFileMb, ...rest } = v;
          return {
            ...rest,
            config: {
              ...(publicKey ? { public_key: publicKey } : {}),
              allowed_origins: String(allowedOrigins ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              ...(consentText ? { consent_text: consentText } : {}),
              consent_version: String(consentVersion ?? '1'),
              ...(greeting ? { greeting } : {}),
              ...(maxFileMb ? { max_file_mb: maxFileMb } : {}),
            },
          };
        }}
        fields={[
          {
            key: 'kind',
            label: 'Тип',
            type: 'select',
            required: true,
            createOnly: true,
            options: [
              { value: 'webchat', label: 'Чат на сайте' },
              { value: 'app', label: 'Чат в приложении' },
            ],
          },
          { key: 'name', label: 'Название', required: true },
          { key: 'queueId', label: 'Очередь по умолчанию', type: 'select', options: options(queues.data) },
          { key: 'publicKey', label: 'Ключ виджета (латиница, от 8 символов)', required: true },
          { key: 'allowedOrigins', label: 'Разрешённые сайты через запятую (https://site.by) или *' },
          { key: 'greeting', label: 'Приветствие', type: 'textarea' },
          { key: 'consentText', label: 'Текст согласия на обработку ПДн', type: 'textarea' },
          {
            key: 'consentVersion',
            label: 'Версия текста согласия',
            description: 'Измените при изменении текста — клиенты дадут согласие заново',
          },
          { key: 'maxFileMb', label: 'Макс. размер файла, МБ', type: 'number' },
        ]}
      />
      <Text size="sm" mt="md">
        Код для сайта:{' '}
        <Code>{'<script src="https://<адрес-кц>/widget/widget.js" data-key="<ключ>" async></script>'}</Code>.
        Демо-страница:{' '}
        <a href="/widget/demo.html" target="_blank" rel="noreferrer">
          /widget/demo.html
        </a>
        , для WebView приложения — <Code>/widget/mobile.html?key=&lt;ключ&gt;</Code>.
      </Text>
    </>
  );
}
