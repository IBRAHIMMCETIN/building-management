import {
  MAX_IMPORT_ROWS,
  type RawCell,
  type ReportLine,
  SAMPLE_BLOCK,
  SHEETS,
  SHEET_KINDS,
  type SheetKind,
  type WorkbookParseResult,
  parseCsv,
  parseWorkbook,
  reportTable,
} from './sheetModel';

/*
 * Tarayici tarafi Excel okuma/yazma. Kutuphaneler (MIT) yalnizca aktarim ekrani acildiginda
 * dinamik olarak yuklenir; ana pakete eklenmez.
 *   read-excel-file  -> .xlsx okuma
 *   write-excel-file -> sablon ve hata raporu
 */

export const IMPORT_ACCEPT = '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

export type ReadFilesResult = WorkbookParseResult & { fileName: string };

export async function readImportFiles(files: readonly File[]): Promise<ReadFilesResult> {
  const input: { name?: string; data: RawCell[][] }[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${file.name}: dosya 5 MB'tan büyük`);
      continue;
    }
    try {
      if (lower.endsWith('.csv')) {
        input.push({ name: baseName(file.name), data: parseCsv(await file.text()) });
      } else if (lower.endsWith('.xlsx')) {
        const { default: readXlsxFile } = await import('read-excel-file/browser');
        const sheets = await readXlsxFile(file);
        for (const s of sheets) input.push({ name: s.sheet, data: s.data as unknown as RawCell[][] });
      } else {
        errors.push(`${file.name}: yalnızca .xlsx veya .csv yüklenebilir (eski .xls dosyasını Excel'de .xlsx olarak kaydedin)`);
      }
    } catch {
      errors.push(`${file.name}: dosya okunamadı (bozuk veya şifreli olabilir)`);
    }
  }
  const parsed = parseWorkbook(input);
  return {
    ...parsed,
    errors: [...errors, ...(input.length ? parsed.errors : [])],
    fileName: files.map((f) => f.name).join(', ').slice(0, 200),
  };
}

/** Sablonda bu kadar satir onceden bicimlenir (aktarim siniri ile ayni). */
const TEMPLATE_ROWS = MAX_IMPORT_ROWS;
const DATE_FORMAT = 'yyyy-mm-dd';
const SAMPLE_STYLE = { fontStyle: 'italic' as const, textColor: '#71717A' };

type ColumnSpec = (typeof SHEETS)[SheetKind]['columns'][number];

/**
 * Bos veri hucresi, sutun tipine gore ACIK bicimle (bkz. sheetModel ColumnDef):
 * metin `@` (String), tarih `yyyy-mm-dd` (Date), sayi Genel.
 */
function emptyCell(c: ColumnSpec) {
  if (c.numeric) return null;
  if (c.date) return { type: Date, format: DATE_FORMAT };
  return { type: String, format: '@' };
}

/** 2. satirdaki ornek: ayni bicimde ve gri/italik; Blok = "Örnek" oldugu icin aktarilmaz. */
function sampleCell(c: ColumnSpec) {
  const v = c.sample;
  if (v === undefined) return emptyCell(c);
  if (c.date && typeof v === 'string') {
    const [y, m, d] = v.split('-').map(Number);
    return { type: Date, value: new Date(Date.UTC(y!, m! - 1, d!)), format: DATE_FORMAT, ...SAMPLE_STYLE };
  }
  if (typeof v === 'number') return { type: Number, value: v, ...SAMPLE_STYLE };
  return { type: String, value: v, format: '@', ...SAMPLE_STYLE };
}

const header = (title: string) => ({ value: title, type: String, fontWeight: 'bold' as const, backgroundColor: '#E4E4E7' });
const text = (value: string) => ({ value, type: String });

/**
 * 3 veri sayfasi + Açıklama. Her veri sayfasinda: baslik (bicim ipuclu), gri ornek satir ve
 * sutun tipine gore onceden bicimlenmis 1000 bos satir.
 */
export async function downloadTemplate() {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const dataSheets = SHEET_KINDS.map((kind) => {
    const def = SHEETS[kind];
    return {
      sheet: def.title,
      data: [
        def.columns.map((c) => header(c.required ? `${c.title}*` : c.title)),
        def.columns.map(sampleCell),
        ...Array.from({ length: TEMPLATE_ROWS }, () => def.columns.map(emptyCell)),
      ],
      columns: def.columns.map((c) => ({ width: c.width ?? 14 })),
      stickyRowsCount: 1,
    };
  });
  const guide: ReturnType<typeof text>[][] = [
    [header('Önemli'), header(''), header('')],
    [text('Tarihler'), text('Tarihlerin her ortamda (Excel Web / Masaüstü, her bölge ayarı) sorunsuz algılanması için YYYY-AA-GG (örn: 2026-01-01) biçiminde giriniz.'), text('')],
    [text('Oranlar'), text("Hisse ve kesirli oranları (1/1, 10/100) girerken tarihe dönüşmemesi için başına tek tırnak koyarak ('1/1) yazınız."), text('')],
    [text('Örnek satır'), text(`Her sayfanın 2. satırı gri örnektir (Blok = ${SAMPLE_BLOCK}); aktarılmaz. Altına yazın, isterseniz silebilirsiniz.`), text('')],
    [text('Yapıştırma'), text('Başka dosyadan kopyalarken "Yalnızca değerleri yapıştır" kullanın; aksi halde kaynağın hücre biçimi de gelir.'), text('')],
    [],
    [header('Sayfa'), header('Sütun'), header('Açıklama')],
    ...SHEET_KINDS.flatMap((kind) =>
      SHEETS[kind].columns.map((c) => [text(SHEETS[kind].title), text(c.required ? `${c.title} (zorunlu)` : c.title), text(c.hint)]),
    ),
    [],
    [header('Notlar'), header(''), header('')],
    [text(''), text('Kiracı aidat/işletme borçlarını, malik demirbaş/yatırım borçlarını görür. Negatif tutar alacaktır (fazla ödeme).'), text('')],
    [text(''), text('Kullanıcılar sessiz oluşturulur; davet e-postaları aktarım kontrol edildikten sonra ayrıca gönderilir.'), text('')],
    [text(''), text('Kasa ve banka devir bakiyeleri sihirbazın son adımında girilir.'), text('')],
    [text(''), text('En fazla 1000 satır. Aynı dosya tekrar yüklenirse mevcut kayıtlar atlanır.'), text('')],
  ];
  await writeXlsxFile(
    [...dataSheets, { sheet: 'Açıklama', data: guide, columns: [{ width: 14 }, { width: 90 }, { width: 30 }] }],
  ).toFile('toplu-aktarim-sablonu.xlsx');
}

export async function downloadReport(lines: readonly ReportLine[], fileName = 'aktarim-hata-raporu.xlsx') {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const [head, ...rows] = reportTable(lines);
  await writeXlsxFile(
    [head!.map(header), ...rows.map((r) => r.map(text))],
    { sheet: 'Hatalar', columns: [{ width: 12 }, { width: 8 }, { width: 36 }, { width: 70 }], stickyRowsCount: 1 },
  ).toFile(fileName);
}
