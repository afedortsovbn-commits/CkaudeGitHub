import { Pool, type PoolConfig } from 'pg';

export function createPool(connectionString: string, extra: PoolConfig = {}): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: process.env.SERVICE_NAME ?? 'cc',
    ...extra,
  });
}
