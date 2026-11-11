import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * PDF icin gomulu yazi tipleri (Noto Sans, SIL OFL 1.1 - assets/fonts/OFL.txt).
 * Standart PDF fontlari (Helvetica) Turkce karakterleri (ğ, ş, ı, İ) ve ₺ isaretini
 * icermez; bu yuzden TrueType font gomulur. Fontlar Latin + Turkce + ₺ karakterleriyle
 * onceden alt kumeye indirilmistir (her biri ~21 KB; bkz. assets/fonts/README.md).
 *
 * Dosya yeri calisma bicimine gore degisir; sirayla denenir:
 *   PDF_FONT_DIR ortam degiskeni (elle ayar)
 *   ./fonts/                 Lambda paketi (build:lambda dist/lambda/fonts'a kopyalar)
 *   ../assets/fonts/         yerel derleme (dist/server.mjs)
 *   ../../../assets/fonts/   kaynak (tsx / vitest: src/modules/documents/)
 */
export type PdfFonts = { regular: Uint8Array; bold: Uint8Array };

let cached: Promise<PdfFonts> | undefined;

function candidates(): URL[] {
  const dirs: URL[] = [];
  const env = process.env.PDF_FONT_DIR;
  if (env) dirs.push(pathToFileURL(join(env, '/')));
  for (const rel of ['./fonts/', '../assets/fonts/', '../../../assets/fonts/']) dirs.push(new URL(rel, import.meta.url));
  return dirs;
}

async function load(): Promise<PdfFonts> {
  const errors: string[] = [];
  for (const dir of candidates()) {
    try {
      const [regular, bold] = await Promise.all([
        readFile(new URL('NotoSans-Regular.ttf', dir)),
        readFile(new URL('NotoSans-Bold.ttf', dir)),
      ]);
      return { regular: new Uint8Array(regular), bold: new Uint8Array(bold) };
    } catch (err) {
      errors.push(`${dir.href}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`PDF yazi tipleri bulunamadi:\n${errors.join('\n')}`);
}

export function loadPdfFonts(): Promise<PdfFonts> {
  cached ??= load().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}
