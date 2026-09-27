import { makeEvent, newId } from '@cc/contracts';
import { enqueueEvent } from '@cc/service-kit';
import type { PoolClient } from 'pg';

export interface Actor {
  id: string;
  ip?: string;
}

/**
 * Пишет запись аудита (было → стало) и событие config.changed в одной транзакции с изменением.
 * Сервисы по config.changed сбрасывают кэши — настройки применяются без перезапуска (M-ADM-04).
 */
export async function audit(
  tx: PoolClient,
  actor: Actor | null,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
  opts: { configChanged?: boolean } = { configChanged: true },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, before, after, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newId(),
      actor?.id ?? null,
      action,
      entity,
      entityId,
      // jsonb: сериализуем явно — иначе драйвер передаст JS-массив как массив PostgreSQL
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      actor?.ip ?? null,
    ],
  );
  if (opts.configChanged !== false) {
    await enqueueEvent(
      tx,
      makeEvent({ type: 'config.changed', source: 'api', data: { entity, id: entityId, action } }),
    );
  }
}
