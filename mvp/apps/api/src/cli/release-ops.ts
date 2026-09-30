/* eslint-disable no-console */
/**
 * Служебные команды выпуска релиза (Ф11, ops/release.sh и ops/update-media.sh). Запуск из образа api:
 *   docker compose run --rm --no-deps migrate node dist/cli/release-ops.js <команда> …
 * Команды:
 *   release-start <тег> [предыдущий]        — запись в журнал выпусков, печатает id
 *   release-finish <id> <succeeded|failed|rolled_back> [отчёт JSON]
 *   flags <enable|disable> <ключ[,ключ…]>  — фиче-флаги (после обновления всех экземпляров)
 *   flags list
 *   announce-version <версия>               — событие app.version: открытые вкладки предлагают обновиться
 *   turn <disable|enable> <coturn-N>        — вывод coturn из выдачи ICE-серверов и возврат
 *   turn status
 * Любое изменение — в одной транзакции с аудитом и config.changed (сервисы сбрасывают кэши).
 */
import { APP_EVENTS, makeEvent, newId, TURN_DISABLED_SETTING } from '@cc/contracts';
import { createPool } from '@cc/db';
import { enqueueEvent } from '@cc/service-kit';
import type { Pool, PoolClient } from 'pg';
import { audit } from '../lib/audit';
import { withTx } from '../lib/db';

class UsageError extends Error {}
const fail = (msg: string): never => {
  throw new UsageError(msg);
};

async function turnDisabled(tx: PoolClient): Promise<string[]> {
  const { rows } = await tx.query<{ value: unknown }>('SELECT value FROM system_setting WHERE key = $1', [
    TURN_DISABLED_SETTING,
  ]);
  return Array.isArray(rows[0]?.value) ? (rows[0]!.value as string[]) : [];
}

/** Выполняет команду; результат — объект, который CLI печатает строкой JSON. */
export async function releaseOps(pool: Pool, argv: string[]): Promise<Record<string, unknown>> {
  const [cmd, a, b, c] = argv;
  {
    switch (cmd) {
      case 'release-start': {
        if (!a) fail('укажите тег');
        const id = newId();
        await withTx(pool, async (tx) => {
          await tx.query('INSERT INTO release_log (id, tag, prev_tag, status) VALUES ($1, $2, $3, $4)', [
            id,
            a,
            b || null,
            'started',
          ]);
          await audit(
            tx,
            null,
            'release.start',
            'release',
            id,
            null,
            { tag: a, prevTag: b || null },
            {
              configChanged: false,
            },
          );
        });
        return { id };
      }
      case 'release-finish': {
        if (!a || !['succeeded', 'failed', 'rolled_back'].includes(b ?? ''))
          fail('release-finish <id> <итог>');
        let report: unknown = {};
        try {
          report = c ? JSON.parse(c) : {};
        } catch {
          report = { text: c };
        }
        await withTx(pool, async (tx) => {
          await tx.query(
            'UPDATE release_log SET status = $2, finished_at = now(), report = $3 WHERE id = $1',
            [a, b, JSON.stringify(report)],
          );
          await audit(tx, null, `release.${b}`, 'release', a!, null, report, { configChanged: false });
        });
        return { id: a, status: b };
      }
      case 'flags': {
        if (a === 'list') {
          const { rows } = await pool.query('SELECT key, enabled FROM feature_flag ORDER BY key');
          return { flags: rows };
        }
        if (a !== 'enable' && a !== 'disable') fail('flags <enable|disable|list> <ключи>');
        const keys = (b ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!keys.length) fail('укажите ключи флагов через запятую');
        await withTx(pool, async (tx) => {
          for (const key of keys) {
            const before = await tx.query('SELECT enabled FROM feature_flag WHERE key = $1', [key]);
            await tx.query(
              `INSERT INTO feature_flag (key, enabled) VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
              [key, a === 'enable'],
            );
            await audit(tx, null, 'update', 'feature_flag', key, before.rows[0] ?? null, {
              enabled: a === 'enable',
            });
          }
        });
        return { flags: keys, enabled: a === 'enable' };
      }
      case 'announce-version': {
        if (!a) fail('укажите версию');
        await withTx(pool, (tx) =>
          enqueueEvent(
            tx,
            makeEvent({
              type: APP_EVENTS.version,
              source: 'release',
              data: { component: 'web', version: a },
            }),
          ),
        );
        return { announced: a };
      }
      case 'turn': {
        if (a === 'status') {
          const list = await withTx(pool, (tx) => turnDisabled(tx));
          return { disabled: list };
        }
        if ((a !== 'disable' && a !== 'enable') || !b || !/^[A-Za-z0-9_.-]{1,64}$/.test(b)) {
          fail('turn <disable|enable> <coturn-N>');
        }
        const list = await withTx(pool, async (tx) => {
          await tx.query(
            `INSERT INTO system_setting (key, value) VALUES ($1, '[]') ON CONFLICT (key) DO NOTHING`,
            [TURN_DISABLED_SETTING],
          );
          await tx.query('SELECT 1 FROM system_setting WHERE key = $1 FOR UPDATE', [TURN_DISABLED_SETTING]);
          const before = await turnDisabled(tx);
          const after = a === 'disable' ? [...new Set([...before, b!])] : before.filter((n) => n !== b);
          await tx.query('UPDATE system_setting SET value = $2, updated_at = now() WHERE key = $1', [
            TURN_DISABLED_SETTING,
            JSON.stringify(after),
          ]);
          await audit(
            tx,
            null,
            'update',
            'system_setting',
            TURN_DISABLED_SETTING,
            { value: before },
            {
              value: after,
            },
          );
          return after;
        });
        return { disabled: list };
      }
      default:
        return fail(`неизвестная команда ${cmd ?? ''}`);
    }
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL не задан');
  const pool = createPool(url!, { max: 1 });
  try {
    console.log(JSON.stringify(await releaseOps(pool, process.argv.slice(2))));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(JSON.stringify({ level: 'error', msg: 'ошибка release-ops', err: String(e) }));
    process.exit(e instanceof UsageError ? 2 : 1);
  });
}
