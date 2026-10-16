import { Body, Controller, Get, HttpCode, Inject, Post, Put, Res } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, withTx } from '../lib/db';
import { ApiError, parse } from '../lib/errors';

/**
 * Синтез речи (Д-097, РЕШЕНИЯ 16.10): написал текст — система озвучивает (объявления о сбоях, аудиобиблиотека,
 * автоответы, фразы сценариев). Движок выбирается в настройках:
 * - `off` — выключено;
 * - `edge` — edge-tts, голос «Светлана» (сервис `tts`): нужен интернет, текст уходит в Microsoft — только стенд;
 * - `http` — локальный движок по адресу, совместимый с OpenAI `/v1/audio/speech` (для сервера заказчика, Д-003).
 * Звук возвращается как есть (MP3/WAV); в формат IVR (WAV 8 кГц) его приводит браузер перед сохранением.
 */
export const EDGE_VOICES = [
  { value: 'ru-RU-SvetlanaNeural', label: 'Светлана' },
  { value: 'ru-RU-DmitryNeural', label: 'Дмитрий' },
];
const Settings = z
  .object({
    provider: z.enum(['off', 'edge', 'http']),
    voice: z.string().trim().max(100).default('ru-RU-SvetlanaNeural'),
    /** Скорость, %: −50…+50 (по умолчанию −4 % — как в демо-файлах). */
    rate: z.number().int().min(-50).max(50).default(-4),
    httpUrl: z.string().trim().url().max(300).nullable().default(null),
    httpModel: z.string().trim().max(100).default('tts-1'),
    httpVoice: z.string().trim().max(100).default(''),
  })
  .strict();
type TtsSettings = z.infer<typeof Settings>;
const DEFAULTS: TtsSettings = {
  provider: 'edge',
  voice: 'ru-RU-SvetlanaNeural',
  rate: -4,
  httpUrl: null,
  httpModel: 'tts-1',
  httpVoice: '',
};
const SynthBody = z
  .object({
    text: z.string().trim().min(1, 'Пустой текст').max(3000, 'Текст длиннее 3000 символов'),
    voice: z.string().trim().max(100).optional(),
    rate: z.number().int().min(-50).max(50).optional(),
  })
  .strict();

const MANAGE = ['ivr.manage', 'settings.manage'] as const;

@Controller('api/v1/tts')
export class TtsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  private async load(): Promise<TtsSettings> {
    const r = await one<{ value: unknown }>(
      this.ctx.pool,
      `SELECT value FROM system_setting WHERE key = 'tts.settings'`,
    );
    const p = Settings.safeParse({ ...DEFAULTS, ...((r?.value as object) ?? {}) });
    return p.success ? p.data : DEFAULTS;
  }

  @Get('settings')
  @RequirePerm(...MANAGE)
  async settings() {
    return { ...(await this.load()), edgeVoices: EDGE_VOICES };
  }

  @Put('settings')
  @RequirePerm(...MANAGE)
  @HttpCode(200)
  async putSettings(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(Settings, body);
    if (b.provider === 'http' && !b.httpUrl)
      throw new ApiError(400, 'tts_url', 'Укажите адрес локального движка');
    await withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, `SELECT value FROM system_setting WHERE key = 'tts.settings'`);
      await tx.query(
        `INSERT INTO system_setting (key, value) VALUES ('tts.settings', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(b)],
      );
      await audit(tx, p, 'update', 'system_setting', 'tts.settings', before, { value: b });
    });
    return this.settings();
  }

  /** Озвучить текст выбранным движком: в ответе — звук (audio/mpeg или audio/wav). */
  @Post('synthesize')
  @RequirePerm(...MANAGE, 'autoreplies.manage')
  async synthesize(@Body() body: unknown, @Res() reply: FastifyReply) {
    const b = parse(SynthBody, body);
    const s = await this.load();
    const rate = b.rate ?? s.rate;
    let res: Response;
    try {
      if (s.provider === 'edge') {
        res = await fetch(`${this.ctx.config.TTS_EDGE_URL}/synthesize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: b.text,
            voice: b.voice || s.voice,
            rate: `${rate >= 0 ? '+' : ''}${rate}%`,
          }),
          signal: AbortSignal.timeout(60_000),
        });
      } else if (s.provider === 'http' && s.httpUrl) {
        res = await fetch(s.httpUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: s.httpModel,
            input: b.text,
            voice: s.httpVoice || b.voice || s.voice,
            response_format: 'wav',
            speed: Math.round((1 + rate / 100) * 100) / 100,
          }),
          signal: AbortSignal.timeout(120_000),
        });
      } else
        throw new ApiError(
          409,
          'tts_off',
          'Синтез речи выключен — включите его в «Аудиобиблиотека → Синтез речи»',
        );
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, 'tts_unavailable', 'Движок озвучки недоступен');
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new ApiError(502, 'tts_failed', j?.message ?? `Движок озвучки ответил ошибкой ${res.status}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return reply
      .header('content-type', res.headers.get('content-type') ?? 'audio/mpeg')
      .header('cache-control', 'no-store')
      .send(audio);
  }
}
