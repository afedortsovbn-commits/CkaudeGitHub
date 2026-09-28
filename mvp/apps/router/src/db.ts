import type { Pool, PoolClient, QueryResultRow } from 'pg';

export type Db = Pool | PoolClient;

export async function withTx<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const r = await fn(tx);
    await tx.query('COMMIT');
    return r;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    tx.release();
  }
}

export async function rows<T extends QueryResultRow>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export async function one<T extends QueryResultRow>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await db.query<T>(sql, params)).rows[0];
}
