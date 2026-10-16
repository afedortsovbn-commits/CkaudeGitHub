/**
 * Размеры картинки по заголовку файла (JPEG, PNG, WebP) — без сторонних библиотек: для проверки фото сотрудника
 * (Д-095). Неизвестный или повреждённый файл — null.
 */
export interface ImageInfo {
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
}

export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length < 24) return null;
  // PNG: подпись, затем блок IHDR (ширина и высота — big-endian).
  if (b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR')
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  // JPEG: маркеры до SOFn (C0–CF, кроме C4 DHT, C8, CC DAC).
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X.
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && b.length >= 30) {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ')
      return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X')
      return { type: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** Требования к фото сотрудника (Д-095): показываются в справочнике и проверяются при загрузке. */
export const PHOTO_RULES = {
  maxBytes: 2 * 1024 * 1024,
  minSide: 200,
  maxSide: 4000,
  /** Отношение ширины к высоте: от 3:4 (портрет) до 4:3. */
  minRatio: 0.75,
  maxRatio: 4 / 3,
};

/** Причины, по которым фото не подходит (пусто — подходит). */
export function photoProblems(b: Buffer, declaredType: string): string[] {
  const out: string[] = [];
  const info = imageInfo(b);
  if (!info) return ['Формат не поддерживается: нужен JPG, PNG или WebP'];
  if (b.length > PHOTO_RULES.maxBytes)
    out.push(`Файл ${(b.length / 1024 / 1024).toFixed(1)} МБ — больше 2 МБ`);
  if (declaredType && declaredType !== info.type && !(declaredType === 'image/jpg' && info.type === 'image/jpeg'))
    out.push('Расширение файла не совпадает с содержимым');
  const { width: w, height: h } = info;
  if (w < PHOTO_RULES.minSide || h < PHOTO_RULES.minSide)
    out.push(`Слишком маленькое: ${w}×${h} пикселей, нужно не меньше ${PHOTO_RULES.minSide}×${PHOTO_RULES.minSide}`);
  if (w > PHOTO_RULES.maxSide || h > PHOTO_RULES.maxSide)
    out.push(`Слишком большое: ${w}×${h} пикселей, нужно не больше ${PHOTO_RULES.maxSide} по стороне`);
  const r = w / h;
  if (r < PHOTO_RULES.minRatio) out.push(`Слишком вытянуто по высоте (${w}×${h}): нужно почти квадратное фото`);
  if (r > PHOTO_RULES.maxRatio) out.push(`Слишком вытянуто по ширине (${w}×${h}): нужно почти квадратное фото`);
  return out;
}
