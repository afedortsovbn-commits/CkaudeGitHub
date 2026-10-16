"""Синтез речи edge-tts (Д-097): маленький HTTP-сервис для api.

POST /synthesize {"text": "...", "voice": "ru-RU-SvetlanaNeural", "rate": "-4%"} -> audio/mpeg (MP3 24 кГц).
GET /health -> {"ok": true}.

edge-tts обращается к онлайн-сервису Microsoft Edge: нужен интернет, текст уходит наружу. Поэтому сервис —
отдельный и отключаемый провайдер (выбор в «Аудиобиблиотека → Синтез речи»), только для демо-стенда; для
сервера заказчика — локальный движок (Д-003).
"""
import json
import re

import edge_tts
from aiohttp import web

MAX_TEXT = 3000
VOICE_RE = re.compile(r"^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$")
RATE_RE = re.compile(r"^[+-]\d{1,2}%$")


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def fail(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": code, "message": message}, status=status)


async def synthesize(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return fail(400, "bad_json", "Некорректный запрос")
    text = str(body.get("text") or "").strip()
    voice = str(body.get("voice") or "ru-RU-SvetlanaNeural")
    rate = str(body.get("rate") or "+0%")
    if not text:
        return fail(400, "empty", "Пустой текст")
    if len(text) > MAX_TEXT:
        return fail(400, "too_long", f"Текст длиннее {MAX_TEXT} символов")
    if not VOICE_RE.match(voice) or not RATE_RE.match(rate):
        return fail(400, "bad_voice", "Неизвестный голос или скорость")
    audio = bytearray()
    try:
        async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
            if chunk["type"] == "audio":
                audio.extend(chunk["data"])
    except Exception as e:  # сеть, сервис Microsoft недоступен, отказ сервиса
        return fail(502, "tts_unavailable", f"Сервис озвучки недоступен: {type(e).__name__}")
    if not audio:
        return fail(502, "tts_empty", "Сервис озвучки вернул пустой звук")
    return web.Response(body=bytes(audio), content_type="audio/mpeg")


app = web.Application(client_max_size=64 * 1024)
app.add_routes([web.get("/health", health), web.post("/synthesize", synthesize)])

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=8080, access_log=None)
