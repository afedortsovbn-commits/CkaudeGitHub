import type { ChannelInstance } from '@cc/connector-kit';
import {
  type InboundMessage,
  normalizeGuid,
  type ReviewMeta,
  reviewPlatformName,
  reviewPlatformOf,
  type RocketDataChannelConfig,
} from '@cc/contracts';
import { createHash } from 'node:crypto';
import { parseRdDate, type RdReview } from './rocketdata-api';

/**
 * Отзыв Rocket Data → входящее сообщение канала «Отзыв» (контракт коннектора M-CH-07).
 *
 * Ключ идемпотентности — номер отзыва (TicketMapId) и отпечаток текста: повторная передача того же отзыва не
 * создаёт дубля, а изменённый текст (если Rocket Data передаст отзыв повторно) становится новым сообщением обращения.
 * АЗС — по GUID объекта (StationGuid = objguid справочника), тип, номер и предприятие — для оператора.
 */
export function reviewToInbound(
  r: RdReview,
  channel: Pick<ChannelInstance<RocketDataChannelConfig>, 'id' | 'config'>,
): Omit<InboundMessage, 'id' | 'receivedAt'> {
  const body = r.Message.trim();
  const rating = r.Rating ?? null;
  const version = createHash('sha256')
    .update(`${rating ?? ''}\n${body}`)
    .digest('hex')
    .slice(0, 16);
  const platform = reviewPlatformOf(r.Site);
  const meta: ReviewMeta = {
    id: r.TicketMapId,
    platform,
    rating,
    author: r.ClientName?.trim() || null,
    url: r.Link || null,
    publishedAt: parseRdDate(r.DateReceipt),
    locationId: normalizeGuid(r.StationGuid),
    locationCode: r.StationNum,
    answered: false,
    urgent: rating !== null && rating <= channel.config.low_rating_max,
    skipAnswered: false,
    stationType: r.StationType,
    emitent: r.EmitentName,
  };
  const author = meta.author ?? 'Автор отзыва';
  return {
    channelId: channel.id,
    channelKind: 'review',
    externalId: `rd:${channel.id}:${r.TicketMapId}:${version}`,
    // У площадок нет устойчивого идентификатора автора: «клиент» обращения — автор этого отзыва.
    identity: { kind: 'other', value: `review:${channel.id}:${r.TicketMapId}` },
    contact: { displayName: `${author} (${reviewPlatformName(platform)})`.slice(0, 200) },
    body,
    attachments: [],
    meta: { review: meta },
  };
}
