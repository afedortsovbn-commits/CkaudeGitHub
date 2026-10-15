import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Файлы Excel (.xlsx) без сторонних библиотек.
 * Запись: листы с первой строкой-заголовком (жирные, закреплены, с автофильтром), ширина колонок по содержимому,
 * цвет ячеек (ошибки — красным, изменения — жёлтым, Д-064). Ячейки — текст или число. Zip без сжатия (STORE).
 * Чтение (Д-064): текст, числа, даты (по формату ячейки), общие строки; zip со сжатием и без.
 */
export type Cell = string | number | null | undefined;

/** Стили ячеек (номера в styles.xml). */
export const XS = {
  normal: 0,
  header: 1,
  error: 2,
  changed: 3,
  wrap: 4,
  headerRequired: 5,
  ok: 6,
} as const;

export interface SheetSpec {
  name: string;
  header: string[];
  rows: Cell[][];
  /** Стиль ячейки данных (ri — номер строки данных с 0, ci — колонка); заголовок — свой стиль. */
  style?: (ri: number, ci: number) => number;
  /** Стиль ячейки заголовка (по умолчанию жирный). */
  headerStyle?: (ci: number) => number;
  /** Ширины колонок (иначе — по содержимому). */
  widths?: number[];
  /** Автофильтр по заголовку (по умолчанию есть). */
  filter?: boolean;
}

// Символы, недопустимые в XML 1.0 (управляющие, кроме табуляции и переводов строк), — убираются.
const validXml = (s: string) =>
  [...s]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 0xfffe && c !== 0xffff);
    })
    .join('');
const esc = (s: string) =>
  validXml(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(sh: SheetSpec): string {
  const { header, rows } = sh;
  const widths =
    sh.widths ??
    header.map((h, i) =>
      Math.min(
        60,
        Math.max(
          8,
          h.length + 2,
          ...rows.slice(0, 500).map((r) => String(r[i] ?? '').split('\n')[0]!.length + 2),
        ),
      ),
    );
  const cell = (v: Cell, ref: string, style = 0) => {
    const s = style ? ` s="${style}"` : '';
    if (v === null || v === undefined || v === '') return style ? `<c r="${ref}"${s}/>` : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
  };
  const head = `<row r="1">${header.map((v, ci) => cell(v, `${colName(ci)}1`, sh.headerStyle?.(ci) ?? XS.header)).join('')}</row>`;
  const body = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 2}">${r.map((v, ci) => cell(v, `${colName(ci)}${ri + 2}`, sh.style?.(ri, ci) ?? 0)).join('')}</row>`,
    )
    .join('');
  const last = `${colName(Math.max(0, header.length - 1))}${rows.length + 1}`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${head}${body}</sheetData>` +
    (sh.filter === false ? '' : `<autoFilter ref="A1:${last}"/>`) +
    '</worksheet>'
  );
}

/** Zip без сжатия (метод STORE): локальные заголовки, центральный каталог, конец каталога. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // версия
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(0, 8); // без сжатия
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // дата 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.data.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/></cellXfs>' +
  '</styleSheet>';

/** Книга из нескольких листов. */
export function buildWorkbook(sheets: SheetSpec[]): Buffer {
  const names = sheets.map((s) => esc(s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)));
  const f = (n: string, s: string) => ({ name: n, data: Buffer.from(s, 'utf8') });
  return zip([
    f(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    ),
    f(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    f(
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        `<definedNames>${sheets
          .map((s, i) =>
            s.filter === false
              ? ''
              : `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${names[i]}'!$A$1:$${colName(Math.max(0, s.header.length - 1))}$${s.rows.length + 1}</definedName>`,
          )
          .join('')}</definedNames>` +
        '</workbook>',
    ),
    f(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    f('xl/styles.xml', STYLES),
    ...sheets.map((s, i) => f(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s))),
  ]);
}

export function buildXlsx(sheetName: string, header: string[], rows: Cell[][]): Buffer {
  return buildWorkbook([{ name: sheetName, header, rows }]);
}

// ---------------------------------------------------------------- чтение

/** Файлы zip-архива: имя → содержимое (поддерживаются STORE и DEFLATE). */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Текст из XML: сущности и экранирование Excel _xHHHH_ (например, _x000D_ — возврат каретки). */
const unxml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/_x([0-9A-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\r\n?/g, '\n');
/** Весь текст узлов <t> внутри фрагмента (строка с форматированием — из нескольких кусков). */
const texts = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)]
    .map((m) => unxml(m[1] ?? ''))
    .join('');
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Номер колонки по ссылке ячейки (B12 → 1). */
const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

// Встроенные форматы дат и времени Excel (14–22 — дата и время, 45–47 — минуты и секунды, прочие — восточные).
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const pad = (n: number) => String(n).padStart(2, '0');
/** Дата Excel (дни с 30.12.1899) → «ГГГГ-ММ-ДД[ ЧЧ:ММ:СС]» или «ЧЧ:ММ:СС» для времени без даты. */
function excelDate(v: number): string {
  const ms = Math.round(v * 86_400_000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (v < 1) return time;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return time === '00:00:00' ? date : `${date} ${time}`;
}

export interface ReadSheet {
  name: string;
  /** Строки как текст (пустые ячейки — ''); номер строки Excel = индекс + 1. */
  rows: string[][];
}

/** Прочитать книгу .xlsx: все листы, значения как текст (даты — ГГГГ-ММ-ДД ЧЧ:ММ:СС). */
export function readXlsx(buf: Buffer): ReadSheet[] {
  const files = unzip(buf);
  const get = (n: string) => files.get(n)?.toString('utf8') ?? '';
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  // Форматы ячеек: какие стили — даты.
  const styles = get('xl/styles.xml');
  const custom = new Map(
    [...styles.matchAll(/<numFmt\s[^>]*>/g)].map((m) => [
      Number(attr(m[0], 'numFmtId')),
      unxml(attr(m[0], 'formatCode') ?? ''),
    ]),
  );
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const isDateStyle = [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    if (DATE_FMT_IDS.has(id)) return true;
    // Свой формат — дата, если в нём (без текста в кавычках и [цвета]) есть день, год, час или секунды.
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[dyhs]/i.test(code);
  });
  const wb = get('xl/workbook.xml');
  const rels = new Map(
    [...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s[^>]*>/g)].map((m) => [
      attr(m[0], 'Id'),
      attr(m[0], 'Target') ?? '',
    ]),
  );
  return [...wb.matchAll(/<sheet\s[^>]*>/g)].map((m) => {
    const target = rels.get(attr(m[0], 'r:id')) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = get(path);
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\s([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rn = Number(attr(` ${r[1]}`, 'r')) || rows.length + 1;
      const row: string[] = [];
      for (const c of (r[2] ?? '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = ` ${c[1]}`;
        const ref = attr(a, 'r') ?? '';
        const ci = ref ? colIndex(ref) : row.length;
        const type = attr(a, 't') ?? 'n';
        const inner = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let val = '';
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = texts(inner);
        else if (type === 'str' || type === 'e') val = unxml(v ?? '');
        else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined && v !== '') {
          const num = Number(v);
          val = isDateStyle[Number(attr(a, 's') ?? 0)] && Number.isFinite(num) ? excelDate(num) : v;
        }
        while (row.length < ci) row.push('');
        row[ci] = val;
      }
      while (rows.length < rn - 1) rows.push([]);
      rows[rn - 1] = row;
    }
    return { name: unxml(attr(m[0], 'name') ?? ''), rows };
  });
}
