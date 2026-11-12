import { Download, FileSpreadsheet, Play, RotateCcw, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, FormField, Input } from '@/components/ui';
import { useImportPreview, useInvalidateApartment } from '@/hooks/useImports';
import { errorMessage } from '@/lib/api/errors';
import { type ImportPreview, importsApi } from '@/lib/api/imports';
import { formatDate, nowIstanbulLocal } from '@/lib/dates';
import { IMPORT_ACCEPT, type ReadFilesResult, downloadReport, downloadTemplate, readImportFiles } from '@/lib/import/excel';
import { type ImportPlan, type ImportRunState, initialRunState, runImport, summarize } from '@/lib/import/runImport';
import { type ReportLine, SHEETS, SHEET_KINDS, SHEET_LABEL, withoutRows } from '@/lib/import/sheetModel';
import { formatTRY, parseTRYToKurus } from '@/lib/money';
import { ImportProgress } from './ImportProgress';

type Step =
  | { name: 'file' }
  | { name: 'preview'; file: ReadFilesResult; preview: ImportPreview }
  | { name: 'run'; plan: ImportPlan; state: ImportRunState };

const MAX_ERROR_ROWS_SHOWN = 100;

function newImportId() {
  return `imp_${crypto.randomUUID().replaceAll('-', '')}`;
}

function previewErrorLines(p: ImportPreview): ReportLine[] {
  return [
    ...p.globalErrors.map((message) => ({ sheet: 'general' as const, label: '', message })),
    ...p.rows
      .filter((r) => r.status === 'error')
      .map((r) => ({ sheet: r.sheet, row: r.row, label: r.label, message: (r.errors ?? []).map((e) => e.message).join('; ') })),
  ];
}

/** Toplu aktarim sihirbazi: dosya -> onizleme -> kasa/banka -> yazim (ilerleme) -> sonuc. */
export function ImportWizard() {
  const [step, setStep] = useState<Step>({ name: 'file' });
  const reset = () => setStep({ name: 'file' });

  if (step.name === 'file') return <FileStep onPreview={(file, preview) => setStep({ name: 'preview', file, preview })} />;
  if (step.name === 'preview') {
    return (
      <PreviewStep
        file={step.file}
        preview={step.preview}
        onBack={reset}
        onStart={(plan) => setStep({ name: 'run', plan, state: initialRunState(plan) })}
      />
    );
  }
  return <RunStep plan={step.plan} initial={step.state} onDone={reset} />;
}

// ---------------------------------------------------------------------------
// 1. Dosya
// ---------------------------------------------------------------------------

function FileStep({ onPreview }: { onPreview: (file: ReadFilesResult, preview: ImportPreview) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const [asOfDate, setAsOfDate] = useState(() => nowIstanbulLocal().slice(0, 10));
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const preview = useImportPreview();

  const handleFiles = async (list: FileList | null) => {
    const files = list ? [...list] : [];
    if (!files.length) return;
    setFileErrors([]);
    preview.reset();
    setReading(true);
    try {
      const file = await readImportFiles(files);
      if (file.errors.length) {
        setFileErrors(file.errors);
        return;
      }
      const p = await preview.mutateAsync({ asOfDate, ...file.sheets });
      onPreview(file, p);
    } catch {
      // Hata `preview.error` ile gosterilir.
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Yeni aktarım</CardTitle>
          <p className="text-small text-muted">
            Daireleri, malik/kiracıları ve devir bakiyelerini tek dosyadan yükleyin. Hiçbir kayıt önizlemeyi onaylamadan yazılmaz.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={templateBusy}
          onClick={async () => {
            setTemplateBusy(true);
            try {
              await downloadTemplate();
            } finally {
              setTemplateBusy(false);
            }
          }}
        >
          <Download className="size-4" aria-hidden="true" />
          Şablonu indir
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Devir tarihi" hint="Açılış bakiyeleri bu tarihle deftere yazılır; ileri tarih olamaz.">
          <Input type="date" value={asOfDate} max={nowIstanbulLocal().slice(0, 10)} onChange={(e) => setAsOfDate(e.target.value)} />
        </FormField>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fileId} className="text-small font-medium text-text">
            Dosya (.xlsx veya .csv)
          </label>
          <input
            ref={inputRef}
            id={fileId}
            type="file"
            multiple
            accept={IMPORT_ACCEPT}
            className="sr-only"
            disabled={reading || !asOfDate}
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button variant="primary" loading={reading} disabled={!asOfDate} onClick={() => inputRef.current?.click()}>
            <Upload className="size-4" aria-hidden="true" />
            Dosya seç ve önizle
          </Button>
          <p className="text-small text-muted">CSV kullanıyorsanız her sayfa için ayrı dosya seçebilirsiniz. En fazla 1000 satır.</p>
        </div>
      </div>

      {fileErrors.length > 0 && (
        <Alert tone="danger">
          <ul className="list-disc pl-4">
            {fileErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      {preview.isError && <Alert tone="danger">{errorMessage(preview.error)}</Alert>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2. Onizleme + kasa/banka
// ---------------------------------------------------------------------------

function PreviewStep({
  file,
  preview,
  onBack,
  onStart,
}: {
  file: ReadFilesResult;
  preview: ImportPreview;
  onBack: () => void;
  onStart: (plan: ImportPlan) => void;
}) {
  const [skipErrors, setSkipErrors] = useState(false);
  const [cashText, setCashText] = useState('');
  const [bankText, setBankText] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const errorLines = previewErrorLines(preview);
  const errorRows = preview.rows.filter((r) => r.status === 'error');
  const blocked = preview.globalErrors.length > 0 || (errorRows.length > 0 && !skipErrors);

  const parseFunds = (t: string) => (t.trim() === '' ? 0 : parseTRYToKurus(t));
  const cash = parseFunds(cashText);
  const bank = parseFunds(bankText);
  const fundsInvalid = cash === null || bank === null;

  const sheets = skipErrors ? withoutRows(file.sheets, errorRows) : file.sheets;
  const writeCount = SHEET_KINDS.reduce((n, k) => n + preview.counts[k].create, 0) + (cash ? 1 : 0) + (bank ? 1 : 0);

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Önizleme</CardTitle>
            <p className="text-small text-muted">
              <FileSpreadsheet className="mr-1 inline size-4" aria-hidden="true" />
              {file.fileName} · devir tarihi {formatDate(preview.asOfDate)}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Başka dosya
          </Button>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-small">
            <thead className="bg-surface-muted text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Sayfa</th>
                <th className="px-3 py-2 text-right">Eklenecek</th>
                <th className="px-3 py-2 text-right">Zaten var (atlanır)</th>
                <th className="px-3 py-2 text-right">Hatalı</th>
              </tr>
            </thead>
            <tbody>
              {SHEET_KINDS.map((k) => (
                <tr key={k} className="border-t border-border">
                  <td className="px-3 py-2">{SHEETS[k].title}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{preview.counts[k].create}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{preview.counts[k].exists}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {preview.counts[k].error > 0 ? <Badge tone="danger">{preview.counts[k].error}</Badge> : 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {preview.blocksToCreate.length > 0 && (
          <p className="text-small text-muted">Yeni açılacak bloklar: {preview.blocksToCreate.join(', ')}</p>
        )}
        {preview.globalErrors.map((e) => (
          <Alert key={e} tone="danger">
            {e}
          </Alert>
        ))}
        {preview.ok && <Alert tone="success">Dosyada hata yok.</Alert>}

        {errorRows.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-small font-medium text-danger">{errorRows.length} satırda hata var</p>
              <Button
                variant="secondary"
                size="sm"
                loading={reportBusy}
                onClick={async () => {
                  setReportBusy(true);
                  try {
                    await downloadReport(errorLines, 'aktarim-onizleme-hatalari.xlsx');
                  } finally {
                    setReportBusy(false);
                  }
                }}
              >
                <Download className="size-4" aria-hidden="true" />
                Hata raporunu indir
              </Button>
            </div>
            <ErrorTable lines={errorLines.filter((l) => l.sheet !== 'general')} />
            <label className="inline-flex items-center gap-2 text-body">
              <input type="checkbox" className="size-4 accent-accent" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} />
              Hatalı satırları atlayarak devam et
            </label>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>Kasa ve banka devir bakiyeleri</CardTitle>
        <p className="text-small text-muted">İsteğe bağlı. Devir tarihindeki nakit ve banka bakiyesi; boş bırakılırsa yazılmaz.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Kasa (₺)" error={cash === null ? 'Geçerli bir tutar girin' : undefined}>
            <Input inputMode="decimal" autoComplete="off" placeholder="0,00" value={cashText} onChange={(e) => setCashText(e.target.value)} />
          </FormField>
          <FormField label="Banka (₺)" error={bank === null ? 'Geçerli bir tutar girin' : undefined}>
            <Input inputMode="decimal" autoComplete="off" placeholder="0,00" value={bankText} onChange={(e) => setBankText(e.target.value)} />
          </FormField>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <p className="text-small text-muted">
          {writeCount} kayıt yazılacak. Kullanıcı hesapları <strong>davet e-postası gönderilmeden</strong> açılır; kontrol ettikten sonra
          aşağıdaki geçmişten davetleri gönderebilirsiniz. Aktarım tek işlemle geri alınabilir (bakiyeler ters kayıtla iptal edilir).
        </p>
        <div>
          <Button
            disabled={blocked || fundsInvalid || writeCount === 0}
            onClick={() =>
              onStart({
                importId: newImportId(),
                asOfDate: preview.asOfDate,
                fileName: file.fileName,
                sheets,
                cash: cash ?? 0,
                bank: bank ?? 0,
              })
            }
          >
            <Play className="size-4" aria-hidden="true" />
            Aktarımı başlat
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ErrorTable({ lines }: { lines: ReportLine[] }) {
  const shown = lines.slice(0, MAX_ERROR_ROWS_SHOWN);
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border">
      <table className="w-full text-small">
        <thead className="sticky top-0 bg-surface-muted text-xs uppercase text-muted">
          <tr>
            <th className="px-3 py-2 text-left">Sayfa</th>
            <th className="px-3 py-2 text-right">Satır</th>
            <th className="px-3 py-2 text-left">Kayıt</th>
            <th className="px-3 py-2 text-left">Hata</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((l, i) => (
            <tr key={`${l.sheet}-${l.row ?? i}-${i}`} className="border-t border-border align-top">
              <td className="px-3 py-2 whitespace-nowrap">{SHEET_LABEL[l.sheet]}</td>
              <td className="px-3 py-2 text-right tabular-nums">{l.row ?? '—'}</td>
              <td className="px-3 py-2">{l.label}</td>
              <td className="px-3 py-2 text-danger">{l.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {lines.length > shown.length && (
        <p className="px-3 py-2 text-small text-muted">… ve {lines.length - shown.length} satır daha (tamamı raporda).</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Yazim
// ---------------------------------------------------------------------------

function RunStep({ plan, initial, onDone }: { plan: ImportPlan; initial: ImportRunState; onDone: () => void }) {
  const [state, setState] = useState(initial);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [reportBusy, setReportBusy] = useState(false);
  const started = useRef(false);
  const invalidate = useInvalidateApartment();

  const go = async () => {
    setRunning(true);
    setError(undefined);
    try {
      await runImport(importsApi, plan, state, setState);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
      void invalidate();
    }
  };

  // Adim acilinca bir kez baslar (StrictMode cift calistirmasina karsi ref ile korunur).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca ilk acilista
  }, []);

  const done = !!state.job;
  const summary = summarize(state);
  const percent = state.totalRows ? Math.round((state.processedRows / state.totalRows) * 100) : done ? 100 : 0;

  return (
    <Card className="flex flex-col gap-5">
      <CardTitle>{done ? 'Aktarım tamamlandı' : 'Aktarılıyor…'}</CardTitle>
      <ImportProgress percent={done ? 100 : percent} label={`${state.processedRows} / ${state.totalRows} satır`} />
      {!done && !error && <p className="text-small text-muted">Lütfen sayfayı kapatmayın. Bağlantı koparsa kaldığı yerden devam edebilirsiniz.</p>}

      {error && (
        <div className="flex flex-col items-start gap-3">
          <Alert tone="danger">Aktarım durdu: {error}</Alert>
          <Button onClick={() => void go()} loading={running}>
            Kaldığı yerden devam et
          </Button>
        </div>
      )}

      {(done || state.results.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-3">
          {SHEET_KINDS.map((k) => (
            <div key={k} className="rounded-lg border border-border p-3">
              <p className="text-small text-muted">{SHEETS[k].title}</p>
              <p className="text-body">
                <span className="font-semibold tabular-nums">{summary.bySheet[k].created}</span> eklendi
                {summary.bySheet[k].exists > 0 && <span className="text-muted"> · {summary.bySheet[k].exists} vardı</span>}
                {summary.bySheet[k].error > 0 && <span className="text-danger"> · {summary.bySheet[k].error} hata</span>}
              </p>
            </div>
          ))}
        </div>
      )}
      {done && (plan.cash || plan.bank) ? (
        <p className="text-small text-muted">
          Devir: {plan.cash ? `Kasa ${formatTRY(plan.cash)}` : ''}
          {plan.cash && plan.bank ? ' · ' : ''}
          {plan.bank ? `Banka ${formatTRY(plan.bank)}` : ''}
        </p>
      ) : null}

      {summary.errors.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-small font-medium text-danger">{summary.errors.length} satır yazılamadı</p>
            <Button
              variant="secondary"
              size="sm"
              loading={reportBusy}
              onClick={async () => {
                setReportBusy(true);
                try {
                  await downloadReport(summary.errors);
                } finally {
                  setReportBusy(false);
                }
              }}
            >
              <Download className="size-4" aria-hidden="true" />
              Hata raporunu indir
            </Button>
          </div>
          <ErrorTable lines={summary.errors} />
        </div>
      )}

      {done && (
        <div className="flex flex-col items-start gap-3">
          <Alert tone="success">
            Kayıtlar oluşturuldu. Davet e-postaları henüz gönderilmedi; aşağıdaki geçmişten kontrol edip gönderebilir veya aktarımı geri
            alabilirsiniz.
          </Alert>
          <Button variant="secondary" onClick={onDone}>
            Yeni aktarım
          </Button>
        </div>
      )}
    </Card>
  );
}
