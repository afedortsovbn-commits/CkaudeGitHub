import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { imageInfo, photoProblems } from './image-info';

/** Минимальный PNG заданного размера (одна строка пикселей повторяется). */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** JPEG-заголовок: SOI, APP0 и SOF0 с размерами (для разбора достаточно). */
function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

describe('фото сотрудника (Д-095)', () => {
  it('размеры PNG и JPEG по заголовку', () => {
    expect(imageInfo(png(320, 400))).toEqual({ type: 'image/png', width: 320, height: 400 });
    expect(imageInfo(jpeg(640, 480))).toEqual({ type: 'image/jpeg', width: 640, height: 480 });
    expect(imageInfo(Buffer.from('это не картинка, а просто текстовый файл'))).toBeNull();
  });
  it('подходящее фото — без замечаний, неподходящее — с понятными причинами', () => {
    expect(photoProblems(png(400, 400), 'image/png')).toEqual([]);
    expect(photoProblems(png(100, 100), 'image/png')[0]).toMatch(/маленькое/);
    expect(photoProblems(png(800, 300), 'image/png')[0]).toMatch(/по ширине/);
    expect(photoProblems(png(300, 800), 'image/png')[0]).toMatch(/по высоте/);
    expect(photoProblems(jpeg(400, 400), 'image/png')).toContain('Расширение файла не совпадает с содержимым');
    expect(photoProblems(Buffer.from('x'.repeat(100)), 'image/png')[0]).toMatch(/JPG, PNG или WebP/);
  });
});
