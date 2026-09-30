import type { ChannelInstance } from '@cc/connector-kit';
import {
  type InboundMessage,
  type ReviewMeta,
  reviewPlatformName,
  type RocketDataChannelConfig,
} from '@cc/contracts';
import { createHash } from 'node:crypto';
import type { RdReview } from './rocketdata-api';

/**
 * Отзыв Rocket Data → входящее сообщение канала «Отзыв» (контракт коннектора M-CH-07).
 *
 * Ключ идемпотентности — id отзыва и отпечаток его содержимого (оценка + текст): повторная загрузка того же отзыва
 * не создаёт дубля, а изменённый автором отзыв становится новым сообщением обращения. Изменение только ответа или
 * служебных полей (updated_at) новым сообщением не становится.
 */
export function reviewToInbound(
  r: RdReview,
  channel: Pick<ChannelInstance<RocketDataChannelConfig>, 'id' | 'config'>,
): Omit<InboundMessage, 'id' | 'receivedAt'> {
  const text = (r.text ?? '').trim();
  const rating = r.rating ?? null;
  const version = createHash('sha256')
    .update(`${rating ?? ''}\n${text}`)
    .digest('hex')
    .slice(0, 16);
  const meta: ReviewMeta = {
    id: r.id,
    platform: r.platform,
    rating,
    author: r.author_name?.trim() || null,
    url: r.url || null,
    publishedAt: r.published_at ?? null,
    locationId: r.location_id || null,
    locationCode: r.location_code || null,
    answered: !!r.answer?.text,
    urgent: rating !== null && rating <= channel.config.low_rating_max,
    skipAnswered: channel.config.skip_answered,
  };
  const author = meta.author ?? 'Автор отзыва';
  return {
    channelId: channel.id,
    channelKind: 'review',
    externalId: `rd:${channel.id}:${r.id}:${version}`,
    // У площадок нет устойчивого идентификатора автора: «клиент» обращения — автор этого отзыва.
    identity: { kind: 'other', value: `review:${channel.id}:${r.id}` },
    contact: { displayName: `${author} (${reviewPlatformName(r.platform)})`.slice(0, 200) },
    body: text || (rating ? `Оценка ${rating} из 5 без текста` : 'Отзыв без текста'),
    attachments: [],
    meta: { review: meta },
  };
}
