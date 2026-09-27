#!/usr/bin/env node
/* eslint-disable no-console */
import { createPool } from './pool';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан');
  const pool = createPool(url, { max: 1 });
  try {
    const r = await migrate(pool, { log: (m) => console.log(JSON.stringify({ level: 'info', msg: m })) });
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'миграции выполнены',
        applied: r.applied,
        skipped: r.skipped.length,
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'ошибка миграций', err: String(e) }));
  process.exit(1);
});
