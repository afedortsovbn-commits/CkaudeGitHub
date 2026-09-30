import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../lib/errors';

/**
 * Обязательный тег при закрытии — опция очереди (M-CARD-06): обращение очереди с отметкой `require_tag` нельзя
 * закрыть или передать на 2-ю линию без хотя бы одного тега. Проверяется по текущей очереди обращения.
 */
export async function ensureRequiredTag(db: Pool | PoolClient, conversationId: string): Promise<void> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT q.name FROM conversation c JOIN queue q ON q.id = c.queue_id
      WHERE c.id = $1 AND q.require_tag
        AND NOT EXISTS (SELECT 1 FROM conversation_tag ct WHERE ct.conversation_id = c.id)`,
    [conversationId],
  );
  if (rows[0])
    throw new ApiError(
      400,
      'tag_required',
      `Укажите хотя бы один тег: в очереди «${rows[0].name}» тег обязателен при закрытии`,
    );
}
