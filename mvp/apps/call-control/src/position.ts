import { newId } from '@cc/contracts';
import { callEvent, queuePosition } from '@cc/domain';
import { positionKeys } from '@cc/flow-engine';
import type { Logger } from '@cc/service-kit';
import type { Pool, PoolClient } from 'pg';
import type { Ari } from './ari';

export interface PositionDeps {
  node: string;
  ari: Ari;
  pool: Pool;
  logger: Logger;
  mediaBaseUrl: string;
  tx<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T>;
}

/** Первое сообщение — через столько после постановки: router успевает предложить звонок свободному оператору. */
const FIRST_AFTER_MS = 2_000;
const CACHE_MS = 5_000;
export const POSITION_PLAYBACK_PREFIX = 'pos-';

/**
 * Позиция в очереди для звонящего (Ф14, M-TEL-07): опция очереди «сообщать позицию» (по умолчанию выключена).
 * Фраза «Вы второй в очереди» собирается из фрагментов аудиобиблиотеки (как числа в IVR) и звучит при постановке
 * и затем раз в период, пока звонящий ждёт оператора; между сообщениями — музыка. Позиция — в порядке распределения
 * router (`queuePosition`). Отметка последнего сообщения и идущее проигрывание — в строке вызова: после смены
 * активного call-control период продолжается. Каждое сообщение — событие `position` в журнале вызова. Настройку
 * читает каждый тик из БД — включение и выключение действуют без перезапуска.
 */
export class PositionAnnouncer {
  private fragments: { at: number; value: Map<string, string> } | null = null;
  private readonly warned = new Set<string>();

  constructor(private readonly d: PositionDeps) {}

  private async fragmentIds(): Promise<Map<string, string>> {
    if (!this.fragments || Date.now() - this.fragments.at > CACHE_MS) {
      const { rows } = await this.d.pool.query<{ fragment_key: string; id: string }>(
        `SELECT fragment_key, id FROM audio_file WHERE kind = 'fragment' AND is_active`,
      );
      this.fragments = { at: Date.now(), value: new Map(rows.map((r) => [r.fragment_key, r.id])) };
    }
    return this.fragments.value;
  }

  /** Звонящие, которым пора сообщить позицию (тик активного экземпляра). */
  async tick(): Promise<void> {
    const { rows } = await this.d.pool.query<{ id: string; conversation_id: string; client_channel: string }>(
      `SELECT c.id, c.conversation_id, c.client_channel
         FROM call c JOIN conversation cv ON cv.id = c.conversation_id JOIN queue q ON q.id = cv.queue_id
        WHERE c.node = $1 AND c.state = 'queued' AND cv.status = 'queued' AND q.announce_position
          AND c.position_playback IS NULL AND COALESCE(c.ivr_state ->> 'playback', '') = ''
          AND CASE WHEN c.position_announced_at IS NULL OR c.position_announced_at < cv.queued_at
                   THEN cv.queued_at <= now() - make_interval(secs => $2)
                   ELSE c.position_announced_at <= now() - make_interval(secs => q.announce_position_every_s) END
        ORDER BY cv.queued_at LIMIT 20`,
      [this.d.node, FIRST_AFTER_MS / 1000],
    );
    for (const r of rows) await this.announce(r);
  }

  private async announce(r: { id: string; conversation_id: string; client_channel: string }): Promise<void> {
    const pos = await queuePosition(this.d.pool, r.conversation_id);
    if (!pos) return;
    const keys = positionKeys(pos);
    const frags = await this.fragmentIds();
    const ids = keys.map((k) => frags.get(k));
    const playback = ids.length && ids.every(Boolean) ? `${POSITION_PLAYBACK_PREFIX}${newId()}` : null;
    if (!playback) {
      const missing = keys.filter((k) => !frags.has(k)).join(', ') || `позиция ${pos}`;
      if (!this.warned.has(missing)) {
        this.warned.add(missing);
        this.d.logger.warn({ missing }, 'позиция в очереди не озвучена: нет фрагментов в аудиобиблиотеке');
      }
    }
    const started = await this.d.tx(async (tx) => {
      const u = await tx.query(
        `UPDATE call SET position_announced_at = now(), position_playback = $2, updated_at = now()
          WHERE id = $1 AND state = 'queued' AND position_playback IS NULL RETURNING id`,
        [r.id, playback],
      );
      if (!u.rowCount) return false;
      await callEvent(tx, r.id, 'position', null, { position: pos, ...(playback ? {} : { spoken: false }) });
      return true;
    });
    if (!started || !playback) return;
    try {
      await this.d.ari.channels.mohStop(r.client_channel);
      await this.d.ari.channels.play(
        r.client_channel,
        playback,
        ids.map((id) => `sound:${this.d.mediaBaseUrl}/media/${id}.wav`),
      );
    } catch (err) {
      this.d.logger.warn({ err: String(err), callId: r.id }, 'позиция в очереди: не удалось проиграть');
      await this.finished(playback);
    }
  }

  /** Проигрывание позиции закончилось — снова музыка (если звонящий всё ещё ждёт). true — проигрывание наше. */
  async finished(playbackId: string): Promise<boolean> {
    if (!playbackId.startsWith(POSITION_PLAYBACK_PREFIX)) return false;
    const { rows } = await this.d.pool.query<{ client_channel: string; state: string }>(
      `UPDATE call SET position_playback = NULL, updated_at = now()
        WHERE node = $1 AND position_playback = $2 RETURNING client_channel, state`,
      [this.d.node, playbackId],
    );
    // Звонок уже предлагается оператору — до ответа клиент по-прежнему слушает музыку.
    if (rows[0] && (rows[0].state === 'queued' || rows[0].state === 'dialing'))
      await this.d.ari.channels.mohStart(rows[0].client_channel);
    return true;
  }

  /** Оператор ответил или звонок ушёл из очереди — сообщение прерывается. */
  async stop(c: { id: string; position_playback?: string | null }): Promise<void> {
    if (!c.position_playback) return;
    await this.d.pool.query(`UPDATE call SET position_playback = NULL WHERE id = $1`, [c.id]);
    await this.d.ari.playbacks.stop(c.position_playback);
  }
}
