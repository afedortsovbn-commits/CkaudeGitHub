/**
 * Проверка аудиофайла IVR: WAV (RIFF) PCM 16 бит, моно, 8 кГц — формат, который Asterisk воспроизводит без
 * перекодирования фрагментов на лету (slin). Браузер приводит к нему любой файл перед загрузкой.
 */
export function parseWav(buf: Buffer): { durationMs: number } | string {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    return 'Нужен файл WAV';
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) return 'Повреждённый WAV: нет описания формата';
      if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 8000 || fmt.bits !== 16)
        return 'Нужен WAV PCM 16 бит, моно, 8000 Гц';
      const bytes = Math.min(size, buf.length - body);
      if (bytes < 1600) return 'Слишком короткая запись';
      return { durationMs: Math.round((bytes / 16000) * 1000) };
    }
    off = body + size + (size % 2);
  }
  return 'Повреждённый WAV: нет данных';
}
