import { CheckCircle2, Download, FileSpreadsheet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Dialog } from '@/components/ui';
import { useImportReadings } from '@/hooks/useMeters';
import { type ImportResult, type ImportRowInput, type SheetRow, itemErrorsOf } from '@/lib/api/meters';
import { errorMessage } from '@/lib/api/errors';
import { parseCsv } from '@/lib/import/sheetModel';
import { READING_FLAG_LABELS, formatIndex, parseImportTable } from '@/lib/meters/model';

const ACCEPT = '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

async function readTable(file: File): Promise<unknown[][]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) return parseCsv(await file.text());
  if (lower.endsWith('.xlsx')) {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    const sheets = await readXlsxFile(file);
    return (sheets[0]?.data ?? []) as unknown[][];
  }
  throw new Error('Yalnızca .xlsx veya .csv yüklenebilir.');
}

/** Okuma listesi (CSV, `;` ayracli - Turkce Excel dogrudan acar): sayac, daire, baslangic endeksi, bos endeks sutunu. */
export function downloadReadingList(periodName: string, rows: SheetRow[]) {
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [
    ['Sayaç', 'Daire', 'Sayaç adı', 'Başlangıç endeksi', 'Endeks', 'Not'].join(';'),
    ...rows
      .filter((r) => r.inScope)
      .map((r) =>
        [r.serialNo ?? r.meterId, r.unitNumber ?? '', r.label, r.startIndex !== undefined ? formatIndex(r.startIndex, r.scale) : '', '', '']
          .map(esc)
          .join(';'),
      ),
  ];
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `okuma-listesi-${periodName.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

type Props = { periodId: string | null; periodName: string; rows: SheetRow[]; onClose: () => void };

/**
 * Excel/CSV toplu endeks aktarimi: once kuru calistirma (dryRun) ile satir satir kontrol
 * (hata / sicrama uyarisi), sonra hatasizsa tek tikla aktarim.
 */
export function ImportReadingsDialog({ periodId, periodName, rows, onClose }: Props) {
  const mutation = useImportReadings();
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ImportRowInput[] | null>(null);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [inputKey, setInputKey] = useState(0);

  useEffect(() => {
    if (!periodId) return;
    mutation.reset();
    setFileError(null);
    setFileName(null);
    setParsed(null);
    setParseErrors([]);
    setPreview(null);
    setDone(null);
    setInputKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [periodId]);

  if (!periodId) return null;
  const byMeter = new Map(rows.map((r) => [r.meterId, r]));

  async function onFile(file: File | undefined) {
    setPreview(null);
    setDone(null);
    setParsed(null);
    setParseErrors([]);
    mutation.reset();
    setFileError(null);
    if (!file) return;
    setFileName(file.name);
    if (file.size > MAX_FILE_BYTES) {
      setFileError('Dosya 5 MB’tan büyük.');
      return;
    }
    try {
      const table = await readTable(file);
      const result = parseImportTable(table);
      setParseErrors(result.errors);
      if (result.rows.length === 0) return;
      setParsed(result.rows);
      // Kuru calistirma: hicbir sey yazilmaz.
      setPreview(await mutation.mutateAsync({ periodId: periodId as string, rows: result.rows, dryRun: true }));
    } catch (err) {
      setFileError(err instanceof Error && !('status' in err) ? err.message : errorMessage(err));
    }
  }

  async function commit() {
    if (!parsed) return;
    try {
      const r = await mutation.mutateAsync({ periodId: periodId as string, rows: parsed, dryRun: false });
      setDone(r.imported ?? parsed.length);
    } catch {
      /* hata asagida */
    }
  }

  const commitErrors = itemErrorsOf(mutation.error);
  const errors = preview?.errors.length ? preview.errors : commitErrors;
  const spikes = preview?.rows.filter((r) => r.flags.includes('spike')) ?? [];
  const canCommit = !!preview && preview.errors.length === 0 && parseErrors.length === 0 && (preview.valid ?? 0) > 0;

  return (
    <Dialog open={!!periodId} onClose={() => !mutation.isPending && onClose()} title="Toplu endeks aktarımı" className="max-w-2xl">
      {done !== null ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
          <p className="font-semibold">{done} okuma aktarıldı</p>
          <p className="text-small text-muted">Dönem yeniden hesaplanmalıdır (önizleme taslağa döndü).</p>
          <Button onClick={onClose}>Kapat</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">
            İlk satır başlık olabilir: <strong>Sayaç</strong> (seri no veya sayaç kimliği), <strong>Endeks</strong> (1.234,567 biçiminde),{' '}
            <strong>Not</strong>. Önce kontrol edilir; hatasız ise aktarılır.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-surface/80 px-3 text-small font-medium hover:bg-surface-muted">
              <FileSpreadsheet className="size-4" aria-hidden="true" />
              Dosya seç (.xlsx / .csv)
              <input key={inputKey} type="file" accept={ACCEPT} className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
            <Button variant="ghost" size="sm" onClick={() => downloadReadingList(periodName, rows)}>
              <Download className="size-4" aria-hidden="true" />
              Okuma listesini indir
            </Button>
            {fileName && <span className="text-small text-muted">{fileName}</span>}
          </div>

          {fileError && <Alert tone="danger">{fileError}</Alert>}
          {mutation.isPending && <p className="text-small text-muted" role="status">Kontrol ediliyor…</p>}
          {parseErrors.length > 0 && (
            <Alert tone="danger">
              <ul className="list-disc pl-4">
                {parseErrors.slice(0, 10).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          )}

          {preview && (
            <div className="flex flex-wrap gap-2 text-small">
              <Badge tone="success">{preview.valid ?? 0} geçerli</Badge>
              {(preview.invalid ?? 0) > 0 && <Badge tone="danger">{preview.invalid} hatalı</Badge>}
              {spikes.length > 0 && <Badge tone="warning">{spikes.length} olağan dışı artış</Badge>}
            </div>
          )}

          {errors.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-md border border-danger/30">
              <table className="w-full text-small" aria-label="Satır hataları">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="px-2 py-1">Satır</th>
                    <th className="px-2">Hata</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e) => (
                    <tr key={`${e.ref}-${e.code}-${e.meterId ?? ''}`} className="border-t border-border">
                      <td className="px-2 py-1 tabular-nums">{e.ref}</td>
                      <td className="px-2 text-danger">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview && preview.rows.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-md border border-border">
              <table className="w-full text-small" aria-label="Aktarılacak okumalar">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="px-2 py-1">Satır</th>
                    <th className="px-2">Daire</th>
                    <th className="px-2">Sayaç</th>
                    <th className="px-2 text-right">Endeks</th>
                    <th className="px-2 text-right">Tüketim</th>
                    <th className="px-2">Uyarı</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => {
                    const m = byMeter.get(r.meterId);
                    const scale = m?.scale ?? 0;
                    return (
                      <tr key={`${r.ref}-${r.meterId}`} className="border-t border-border">
                        <td className="px-2 py-1 tabular-nums">{r.ref}</td>
                        <td className="px-2">{r.unitNumber ?? m?.unitNumber ?? r.unitId}</td>
                        <td className="px-2">{m ? `${m.label}${m.serialNo ? ` · ${m.serialNo}` : ''}` : r.meterId}</td>
                        <td className="px-2 text-right tabular-nums">{formatIndex(r.endIndex, scale)}</td>
                        <td className="px-2 text-right tabular-nums">{formatIndex(r.delta, scale)}</td>
                        <td className="px-2">
                          {r.flags.map((f) => (
                            <Badge key={f} tone={f === 'spike' ? 'warning' : 'accent'} className="mr-1">
                              {READING_FLAG_LABELS[f] ?? f}
                            </Badge>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {mutation.isError && commitErrors.length === 0 && !fileError && <Alert tone="danger">{errorMessage(mutation.error)}</Alert>}
          {spikes.length > 0 && canCommit && (
            <Alert>Olağan dışı artışlar aktarımı engellemez; okumaları ve sayaç fotoğraflarını kontrol etmeniz önerilir.</Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
              Vazgeç
            </Button>
            <Button onClick={() => void commit()} disabled={!canCommit} loading={mutation.isPending && !!preview}>
              {preview?.valid ?? 0} okumayı aktar
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
