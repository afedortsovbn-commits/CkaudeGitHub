import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@cc/contracts';
import { type FlowEdge, type FlowGraph, type FlowNode, validateGraph } from '@cc/flow-engine';
import { sealSecret } from '@cc/service-kit';
import type { PoolClient } from 'pg';
import type { Storage } from '../lib/storage';

export const DEMO_FLOW_NAME = 'Демо: контакт-центр сети АЗС';
export const DEMO_IVR_DID = '2000';

interface Phrases {
  prompts: Record<string, string>;
  fragments: Record<string, string>;
}

/**
 * Демо-сценарий IVR (01, разд. 5, сценарий 1) для демо-стенда: аудиобиблиотека (фразы и фрагменты чисел,
 * синтезированы espeak-ng — `ops/ivr-demo/gen-audio.mjs`), интеграционные операции мока самообслуживания,
 * объявление о сбое, очередь «Перезвонить», опубликованный сценарий на номере 2000 (номер 1000 по-прежнему
 * ведёт сразу в очередь — на нём работают проверки Ф5). Идемпотентно: сценарий с этим именем уже есть — пропуск.
 */
export async function seedIvrDemo(
  tx: PoolClient,
  storage: Storage,
  o: { assetsDir: string; selfserviceUrl: string; selfserviceToken: string; secretsKey?: string },
): Promise<boolean> {
  const exists = await tx.query(`SELECT 1 FROM flow WHERE name = $1`, [DEMO_FLOW_NAME]);
  if (exists.rowCount) return false;
  const voice = await tx.query<{ id: string; queue_id: string | null }>(
    `SELECT id, queue_id FROM channel WHERE kind = 'voice' AND is_active ORDER BY created_at LIMIT 1`,
  );
  const mainQueue = voice.rows[0]?.queue_id;
  if (!voice.rows[0] || !mainQueue) return false; // нет базовых демо-данных

  const phrases = JSON.parse(readFileSync(join(o.assetsDir, 'phrases.json'), 'utf8')) as Phrases;
  const upload = async (file: string, name: string, kind: 'prompt' | 'fragment', key: string | null) => {
    const body = readFileSync(join(o.assetsDir, `${file}.wav`));
    const id = newId();
    const storageKey = `ivr-audio/${id}.wav`;
    await storage.put(storageKey, body, 'audio/wav');
    await tx.query(
      `INSERT INTO audio_file (id, name, kind, fragment_key, storage_key, size_bytes, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, kind, key, storageKey, body.length, Math.round(((body.length - 44) / 16000) * 1000)],
    );
    return id;
  };
  const a: Record<string, string> = {};
  for (const [key, text] of Object.entries(phrases.prompts))
    a[key] = await upload(key, `Демо: ${text.length > 70 ? `${text.slice(0, 70)}…` : text}`, 'prompt', null);
  const have = await tx.query<{ fragment_key: string }>(
    `SELECT fragment_key FROM audio_file WHERE kind = 'fragment' AND is_active`,
  );
  const present = new Set(have.rows.map((r) => r.fragment_key));
  for (const [key, text] of Object.entries(phrases.fragments))
    if (!present.has(key)) await upload(`n_${key}`, `Число: ${text}`, 'fragment', key);

  // Очередь задач «перезвонить» (M-TEL-08) — те же операторы, что и в основной очереди.
  const cbQueue = newId();
  await tx.query(
    `INSERT INTO queue (id, name, channels, priority) VALUES ($1, 'Перезвонить', '{voice}', 0)`,
    [cbQueue],
  );
  await tx.query(
    `INSERT INTO user_queue (user_id, queue_id) SELECT user_id, $2 FROM user_queue WHERE queue_id = $1`,
    [mainQueue, cbQueue],
  );

  // Интеграционные операции мока самообслуживания (M-INT-03): баланс — в IVR и в карточке, история — в карточке.
  const secret = o.secretsKey ? sealSecret(o.selfserviceToken, o.secretsKey) : o.selfserviceToken;
  const op = async (
    code: string,
    name: string,
    path: string,
    outputs: unknown[],
    fallback: Record<string, string>,
  ) => {
    const id = newId();
    await tx.query(
      `INSERT INTO integration_op (id, code, name, method, url, auth, inputs, outputs, timeout_ms, fallback, show_in_card, card_input)
       VALUES ($1, $2, $3, 'GET', $4, $5, $6, $7, 3000, $8, true, 'phone')`,
      [
        id,
        code,
        name,
        `${o.selfserviceUrl.replace(/\/$/, '')}${path}?phone={{phone}}`,
        JSON.stringify({ type: 'bearer', secret }),
        JSON.stringify([{ name: 'phone', label: 'Телефон клиента', sample: '+375291234567' }]),
        JSON.stringify(outputs),
        JSON.stringify(fallback),
      ],
    );
    return id;
  };
  const opBalance = await op(
    'selfservice.balance',
    'Бонусный счёт (мок самообслуживания)',
    '/balance',
    [
      { name: 'balance', label: 'Баланс бонусов', path: '$.balance' },
      { name: 'card', label: 'Карта', path: '$.card' },
      { name: 'level', label: 'Уровень', path: '$.level' },
    ],
    { balance: '' },
  );
  await op(
    'selfservice.history',
    'Последние заправки (мок самообслуживания)',
    '/history',
    [
      { name: 'lastStation', label: 'Последняя заправка', path: '$.operations[0].station' },
      { name: 'lastDate', label: 'Дата', path: '$.operations[0].date' },
      { name: 'lastFuel', label: 'Топливо', path: '$.operations[0].fuel' },
    ],
    {},
  );

  const schedule = await tx.query<{ id: string }>(
    `SELECT id FROM schedule WHERE name = 'Круглосуточно' LIMIT 1`,
  );
  const bonusTopic = await tx.query<{ id: string }>(
    `SELECT id FROM topic WHERE name = 'Баланс бонусов' AND is_active LIMIT 1`,
  );

  const n = (
    id: string,
    type: FlowNode['type'],
    x: number,
    y: number,
    params: Record<string, unknown>,
    name?: string,
  ): FlowNode => ({
    id,
    type,
    ...(name ? { name } : {}),
    position: { x, y },
    params,
  });
  const nodes: FlowNode[] = [
    n('start', 'start', 0, 0, {}),
    n('hours', 'schedule', 0, 110, { scheduleId: schedule.rows[0]?.id ?? '' }, 'Рабочее время'),
    n('ann', 'announcements', 0, 230, {}),
    n('hello', 'play', 0, 340, { audio: [a.hello] }, 'Приветствие'),
    n(
      'main',
      'menu',
      0,
      460,
      { audio: [a.main], digits: ['1', '2', '0'], timeoutSec: 6, retries: 2, invalidAudio: [a.invalid] },
      'Главное меню',
    ),
    n(
      'bonus',
      'menu',
      -448,
      640,
      {
        audio: [a.bonus],
        digits: ['1', '0'],
        timeoutSec: 6,
        retries: 2,
        invalidAudio: [a.invalid],
        backDigit: '*',
      },
      'Бонусная программа',
    ),
    n(
      'balance',
      'http',
      -728,
      820,
      { operationId: opBalance, input: { phone: '{{caller}}' } },
      'Запрос баланса',
    ),
    n(
      'say',
      'sayNumber',
      -868,
      990,
      {
        variable: 'balance',
        gender: 'm',
        before: [a.balance],
        unit: { one: a.unit1, few: a.unit2, many: a.unit5 },
      },
      'Озвучить баланс',
    ),
    n('sorry', 'play', -504, 990, { audio: [a.sorry] }, 'Сервис недоступен'),
    n(
      'cards',
      'menu',
      56,
      640,
      {
        audio: [a.cards],
        digits: ['1', '0'],
        timeoutSec: 6,
        retries: 2,
        invalidAudio: [a.invalid],
        backDigit: '*',
      },
      'Топливные карты',
    ),
    n(
      'cardblock',
      'menu',
      56,
      820,
      {
        audio: [a.cardblock],
        digits: ['0'],
        timeoutSec: 6,
        retries: 1,
        invalidAudio: [a.invalid],
        backDigit: '*',
      },
      'Блокировка карты',
    ),
    n(
      'queue',
      'queue',
      588,
      820,
      {
        queueId: mainQueue,
        topicId: bonusTopic.rows[0]?.id ?? null,
        announceAudio: [a.wait],
        announceEverySec: 30,
        maxWaitSec: 300,
        checkAgents: true,
      },
      'Очередь «Общая»',
    ),
    n(
      'csat',
      'csat',
      588,
      1000,
      { audio: [a.rate], timeoutSec: 7, retries: 1, thanksAudio: [a.ratethanks] },
      'Оценка',
    ),
    n(
      'vm',
      'voicemail',
      1064,
      1000,
      { mode: 'voicemail', audio: [a.vm], maxSec: 60, queueId: cbQueue },
      'Голосовое сообщение',
    ),
    n('vmthanks', 'play', 1064, 1150, { audio: [a.vmthanks] }, 'Сообщение принято'),
    n('closed', 'play', 1064, 230, { audio: [a.closed] }, 'Нерабочее время'),
    n('bye', 'hangup', 588, 1300, { audio: [a.bye] }, 'До свидания'),
  ];
  const e = (source: string, exit: string, target: string): FlowEdge => ({
    id: `${source}-${exit}`,
    source,
    exit,
    target,
  });
  const edges: FlowEdge[] = [
    e('start', 'next', 'hours'),
    e('hours', 'open', 'ann'),
    e('hours', 'closed', 'closed'),
    e('closed', 'next', 'vm'),
    e('ann', 'next', 'hello'),
    e('hello', 'next', 'main'),
    e('main', 'digit:1', 'bonus'),
    e('main', 'digit:2', 'cards'),
    e('main', 'digit:0', 'queue'),
    e('main', 'noinput', 'queue'),
    e('bonus', 'digit:1', 'balance'),
    e('bonus', 'digit:0', 'queue'),
    e('bonus', 'noinput', 'queue'),
    e('balance', 'ok', 'say'),
    e('balance', 'error', 'sorry'),
    e('say', 'next', 'bonus'),
    e('sorry', 'next', 'bonus'),
    e('cards', 'digit:1', 'cardblock'),
    e('cards', 'digit:0', 'queue'),
    e('cards', 'noinput', 'queue'),
    e('cardblock', 'digit:0', 'queue'),
    e('cardblock', 'noinput', 'queue'),
    e('queue', 'after', 'csat'),
    e('queue', 'timeout', 'vm'),
    e('queue', 'noAgents', 'vm'),
    e('csat', 'next', 'bye'),
    e('vm', 'next', 'vmthanks'),
    e('vmthanks', 'next', 'bye'),
  ];
  const graph: FlowGraph = { version: 1, kind: 'voice', nodes, edges };
  const check = validateGraph(graph);
  if (check.errors.length) throw new Error(`демо-сценарий IVR некорректен: ${JSON.stringify(check.errors)}`);

  const flowId = newId();
  const versionId = newId();
  await tx.query(
    `INSERT INTO flow (id, name, kind, description, dids, draft) VALUES ($1, $2, 'voice', $3, $4, $5)`,
    [
      flowId,
      DEMO_FLOW_NAME,
      'Приветствие, объявление о сбое, меню «Бонусы → Баланс» с запросом во внешнюю систему, «0» — оператор, CSAT',
      [DEMO_IVR_DID],
      JSON.stringify(graph),
    ],
  );
  await tx.query(
    `INSERT INTO flow_version (id, flow_id, version, graph, comment) VALUES ($1, $2, 1, $3, 'Демо-данные')`,
    [versionId, flowId, JSON.stringify(graph)],
  );
  await tx.query(`UPDATE flow SET published_version_id = $2 WHERE id = $1`, [flowId, versionId]);
  await tx.query(
    `INSERT INTO announcement (id, name, audio_id) VALUES ($1, 'Задержка начисления бонусов (демо)', $2)`,
    [newId(), a.announce],
  );
  // Номер IVR — у голосового канала демо-стенда.
  await tx.query(
    `UPDATE channel SET config = jsonb_set(config, '{dids}', COALESCE(config -> 'dids', '[]'::jsonb) || to_jsonb($2::text))
      WHERE id = $1 AND NOT COALESCE(config -> 'dids', '[]'::jsonb) ? $2`,
    [voice.rows[0].id, DEMO_IVR_DID],
  );
  return true;
}
