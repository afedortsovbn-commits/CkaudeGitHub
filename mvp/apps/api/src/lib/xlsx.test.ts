import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildXlsx } from './xlsx';

/** Разбор zip без сжатия: имя файла → содержимое (для проверки собранного .xlsx). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    i += 30 + nameLen + extra + size;
  }
  return out;
}

describe('выгрузка в Excel (.xlsx)', () => {
  it('файлы книги, заголовок, текст с кириллицей и спецсимволами, числа', () => {
    const buf = buildXlsx(
      'Обращения',
      ['№', 'Суть'],
      [
        [1001, 'Клиент <жалуется> & "просит"\nвторая строка'],
        [1002, null],
      ],
    );
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const files = unzip(buf);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
        'xl/styles.xml',
      ]),
    );
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="A2"><v>1001</v></c>');
    expect(sheet).toContain('Клиент &lt;жалуется&gt; &amp; &quot;просит&quot;\nвторая строка');
    expect(sheet).toContain('<autoFilter ref="A1:B3"/>');
    expect(files.get('xl/workbook.xml')).toContain('name="Обращения"');
  });
});
