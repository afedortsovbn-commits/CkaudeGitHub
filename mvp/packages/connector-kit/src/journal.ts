import { newId } from '@cc/contracts';
import type { Pool } from 'pg';

/**
 * Журнал обмена и состояние канала для админки (M-CH-07). Содержимое сообщений не пишется (ПДн) —
 * только факт и краткое описание. Ошибки записи журнала не должны мешать обмену — только логируются.
 */
export class ChannelJournal {
  constructor(
    private readonly pool: Pool,
    private readonly onError: (err: unknown) => void,
  ) {}

  log(channelId: string, direction: 'in' | 'out' | 'system', summary: string, ok = true): void {
    this.pool
      .query(`INSERT INTO channel_log (id, channel_id, direction, ok, summary) VALUES ($1, $2, $3, $4, $5)`, [
        newId(),
        channelId,
        direction,
        ok,
        summary.slice(0, 500),
      ])
      .catch(this.onError);
  }

  /** Состояние пишется только при изменении — не нагружает БД на каждом цикле опроса. */
  private readonly last = new Map<string, string>();
  status(channelId: string, status: 'connected' | 'error' | 'disabled', detail: string | null = null): void {
    const sig = `${status}|${detail ?? ''}`;
    if (this.last.get(channelId) === sig) return;
    this.last.set(channelId, sig);
    this.pool
      .query(`UPDATE channel SET status = $2, status_detail = $3, status_at = now() WHERE id = $1`, [
        channelId,
        status,
        detail?.slice(0, 500) ?? null,
      ])
      .then(() => this.log(channelId, 'system', detail ? `${status}: ${detail}` : status, status !== 'error'))
      .catch((e: unknown) => {
        this.last.delete(channelId);
        this.onError(e);
      });
  }
}
