/*
 * Faz B3.5 - Yukleme sihirbazinda sutun eslemesinin hesaba kaydedilmesi (saf yardimcilar).
 */

export type FormatSource = 'request' | 'saved' | 'detected';

export const FORMAT_SOURCE_LABELS: Record<FormatSource, string> = {
  saved: 'Hesaba kayıtlı eşleme kullanıldı',
  request: 'Elle seçtiğiniz sütun eşlemesi kullanıldı',
  detected: 'Sütunlar başlıklardan otomatik algılandı',
};

/**
 * "Bu eslemeyi hesap icin hatirla" secenegi: kayitli esleme kullanildiysa gosterilmez (zaten
 * kayitli); elle veya otomatik eslemede varsayilan acik.
 */
export function rememberFormatOption(source: FormatSource): { visible: boolean; defaultChecked: boolean } {
  return source === 'saved' ? { visible: false, defaultChecked: false } : { visible: true, defaultChecked: true };
}

/** Aktarim sonucundaki esleme bilgisi (bildirim metni). */
export function formatSavedMessage(formatSaved: { version: number } | null | undefined): string | null {
  if (formatSaved === undefined) return null;
  if (formatSaved === null) return 'Sütun eşlemesi zaten kayıtlıydı; değişiklik yok.';
  return formatSaved.version === 1
    ? 'Sütun eşlemesi bu hesap için kaydedildi; sonraki ekstreler otomatik okunacak.'
    : `Hesabın sütun eşlemesi güncellendi (sürüm ${formatSaved.version}).`;
}
