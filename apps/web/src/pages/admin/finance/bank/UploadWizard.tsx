import { FileUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Select } from '@/components/ui';
import { useCommitStatement, useStatementPreview } from '@/hooks/useBank';
import { type AmountMode, type BankField, FLAG_LABELS, type FormatSpec, type StatementPreview, sampleRowsFrom } from '@/lib/api/bank';
import { errorMessage } from '@/lib/api/errors';
import { previewCounts, previewNeedsAck } from '@/lib/bank/allocation';
import { formatDate } from '@/lib/dates';
import { formatSignedTRY, formatTRY } from '@/lib/money';

type Step = 'file' | 'mapping' | 'preview' | 'done';

const MODE_LABELS: Record<AmountMode, string> = {
  signed: 'Tek tutar sütunu (+ giren / − çıkan)',
  debit_credit: 'Ayrı Borç ve Alacak sütunları',
  amount_direction: 'Tutar + yön sütunu (B/A)',
};

const FIELD_LABELS: Record<BankField, string> = {
  date: 'İşlem tarihi',
  valueDate: 'Valör',
  description: 'Açıklama',
  amount: 'Tutar',
  debit: 'Borç (çıkan)',
  credit: 'Alacak (giren)',
  direction: 'Yön (B/A)',
  balance: 'Bakiye',
  reference: 'Dekont / referans no',
  counterpartyName: 'Gönderen adı',
  counterpartyIban: 'Gönderen IBAN',
};

const REQUIRED: Record<AmountMode, BankField[]> = {
  signed: ['date', 'description', 'amount'],
  debit_credit: ['date', 'description', 'debit', 'credit'],
  amount_direction: ['date', 'description', 'amount', 'direction'],
};
const OPTIONAL: BankField[] = ['valueDate', 'balance', 'reference', 'counterpartyName', 'counterpartyIban'];

/** Elle sutun eslemesi: baslik satiri secilir, alanlar o satirin hucrelerinden eslenir. */
function MappingStep({ rows, onSubmit, pending }: { rows: string[][]; onSubmit: (f: FormatSpec) => void; pending: boolean }) {
  const [headerRow, setHeaderRow] = useState(1);
  const [mode, setMode] = useState<AmountMode>('signed');
  const [columns, setColumns] = useState<Partial<Record<BankField, string>>>({});
  const headers = (rows[headerRow - 1] ?? []).filter((c) => c.trim());
  const fields = [...REQUIRED[mode], ...OPTIONAL];
  const missing = REQUIRED[mode].filter((f) => !columns[f]);

  return (
    <div className="flex flex-col gap-4">
      <Alert>Sütun başlıkları otomatik tanınamadı. Başlık satırını ve sütunları seçin; bir sonraki yüklemede bu hesabın eşlemesi olarak kaydedebilirsiniz.</Alert>
      <div className="max-h-48 overflow-auto rounded-md border border-border text-xs">
        <table className="w-full">
          <tbody>
            {rows.slice(0, 15).map((r, i) => (
              <tr key={i} className={i + 1 === headerRow ? 'bg-accent/10 font-semibold' : ''}>
                <th scope="row" className="px-2 py-1 text-muted">
                  {i + 1}
                </th>
                {r.map((c, j) => (
                  <td key={j} className="px-2 py-1 whitespace-nowrap">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Başlık satırı">
          <Select value={String(headerRow)} onChange={(e) => (setHeaderRow(Number(e.target.value)), setColumns({}))}>
            {rows.slice(0, 15).map((_, i) => (
              <option key={i} value={i + 1}>
                {i + 1}. satır
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Tutar biçimi">
          <Select value={mode} onChange={(e) => setMode(e.target.value as AmountMode)}>
            {(Object.keys(MODE_LABELS) as AmountMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </Select>
        </FormField>
        {fields.map((f) => (
          <FormField key={f} label={`${FIELD_LABELS[f]}${REQUIRED[mode].includes(f) ? ' *' : ''}`}>
            <Select value={columns[f] ?? ''} onChange={(e) => setColumns((c) => ({ ...c, [f]: e.target.value || undefined }))}>
              <option value="">—</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </Select>
          </FormField>
        ))}
      </div>
      <div className="flex justify-end">
        <Button loading={pending} disabled={missing.length > 0} onClick={() => onSubmit({ headerRow, amountMode: mode, columns })}>
          Önizle
        </Button>
      </div>
    </div>
  );
}

function PreviewStep({ preview }: { preview: StatementPreview }) {
  const s = preview.statement;
  const counts = previewCounts(preview);
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 text-small sm:grid-cols-4">
        <div className="rounded-md bg-surface-muted p-2">
          <dt className="text-muted">Dönem</dt>
          <dd className="font-semibold">{s.period ? `${formatDate(s.period.from)} – ${formatDate(s.period.to)}` : '—'}</dd>
        </div>
        <div className="rounded-md bg-surface-muted p-2">
          <dt className="text-muted">Giren</dt>
          <dd className="font-semibold text-success tabular-nums">
            {s.credits.count} · {formatTRY(s.credits.amount)}
          </dd>
        </div>
        <div className="rounded-md bg-surface-muted p-2">
          <dt className="text-muted">Çıkan</dt>
          <dd className="font-semibold tabular-nums">
            {s.debits.count} · {formatTRY(s.debits.amount)}
          </dd>
        </div>
        <div className="rounded-md bg-surface-muted p-2">
          <dt className="text-muted">Kapanış bakiyesi</dt>
          <dd className="font-semibold tabular-nums">{s.closingBalance !== undefined ? formatSignedTRY(s.closingBalance) : '—'}</dd>
        </div>
      </dl>
      <p className="text-small">
        <strong>{counts.fresh}</strong> yeni satır aktarılacak · {counts.existing} satır daha önce aktarılmış · {counts.duplicate} dosya içi tekrar ·{' '}
        {counts.errors} okunamayan satır
      </p>
      {preview.warnings.length > 0 && (
        <Alert tone="danger">
          <ul className="list-disc pl-4">
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      {preview.errors.length > 0 && (
        <details className="text-small">
          <summary className="cursor-pointer">Okunamayan satırlar ({preview.errors.length})</summary>
          <ul className="mt-1 list-disc pl-4 text-muted">
            {preview.errors.slice(0, 50).map((e) => (
              <li key={`${e.row}-${e.field}`}>
                {e.row}. satır: {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="max-h-72 overflow-auto rounded-md border border-border">
        <table className="w-full text-left text-small">
          <thead className="sticky top-0 bg-surface text-xs text-muted uppercase">
            <tr>
              <th scope="col" className="px-3 py-2">Tarih</th>
              <th scope="col" className="px-3 py-2">Açıklama</th>
              <th scope="col" className="px-3 py-2 text-right">Tutar</th>
              <th scope="col" className="px-3 py-2">Durum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {preview.lines.slice(0, 100).map((l) => (
              <tr key={`${l.lineId}-${l.sourceRow}`}>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(l.date)}</td>
                <td className="px-3 py-2">
                  {l.description}
                  {l.counterpartyIbanMasked && <span className="block text-xs text-muted">{l.counterpartyIbanMasked}</span>}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${l.direction === 'in' ? 'text-success' : ''}`}>
                  {formatSignedTRY(l.direction === 'in' ? l.amount : -l.amount)}
                </td>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap gap-1">
                    {l.flags.map((f) => (
                      <Badge key={f} tone={f === 'balance_mismatch' ? 'danger' : 'warning'}>
                        {FLAG_LABELS[f]}
                      </Badge>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Ekstre yukleme sihirbazi: dosya -> (gerekirse) sutun esleme -> onizleme ve uyari onayi -> ice al. */
export function UploadWizard({ open, onClose, bankAccountId }: { open: boolean; onClose: () => void; bankAccountId: string }) {
  const [step, setStep] = useState<Step>('file');
  const [file, setFile] = useState<File | null>(null);
  const [statementId, setStatementId] = useState<string | undefined>();
  const [sample, setSample] = useState<string[][] | null>(null);
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [ack, setAck] = useState(false);
  const previewM = useStatementPreview();
  const commit = useCommitStatement();

  useEffect(() => {
    if (!open) return;
    setStep('file');
    setFile(null);
    setStatementId(undefined);
    setSample(null);
    setPreview(null);
    setAck(false);
    previewM.reset();
    commit.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const needsAck = useMemo(() => (preview ? previewNeedsAck(preview) : false), [preview]);

  const runPreview = async (format?: FormatSpec) => {
    if (!file) return;
    try {
      const r = await previewM.mutateAsync({ bankAccountId, file, ...(statementId ? { statementId } : {}), ...(format ? { format } : {}) });
      setStatementId(r.statementId);
      setPreview(r.preview);
      setAck(false);
      setStep('preview');
    } catch (err) {
      const sid = (err as { statementId?: string }).statementId;
      if (sid) setStatementId(sid);
      const rows = sampleRowsFrom(err);
      if (rows) {
        setSample(rows);
        setStep('mapping');
      }
    }
  };

  const runCommit = async () => {
    if (!preview || !statementId) return;
    try {
      await commit.mutateAsync({ statementId, expectedVersion: preview.statement.version, acknowledgeWarnings: ack });
      setStep('done');
    } catch {
      // asagida gosterilir
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Banka ekstresi yükle" className="max-w-4xl">
      <div className="flex flex-col gap-4">
        <ol className="flex gap-2 text-xs text-muted" aria-label="Adımlar">
          {(['file', 'mapping', 'preview', 'done'] as Step[]).map((s, i) => (
            <li key={s} aria-current={step === s ? 'step' : undefined} className={step === s ? 'font-semibold text-accent' : ''}>
              {i + 1}. {{ file: 'Dosya', mapping: 'Sütunlar', preview: 'Önizleme', done: 'Tamamlandı' }[s]}
            </li>
          ))}
        </ol>

        {step === 'file' && (
          <div className="flex flex-col gap-3">
            <FormField label="Ekstre dosyası" hint="Excel (.xlsx), CSV veya internet şubesinin Excel/HTML çıktısı; en fazla 5 MB">
              <Input type="file" accept=".xlsx,.xls,.csv,.txt,.html,.htm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </FormField>
            {previewM.isError && !sampleRowsFrom(previewM.error) && <Alert tone="danger">{errorMessage(previewM.error)}</Alert>}
            <div className="flex justify-end">
              <Button loading={previewM.isPending} disabled={!file} onClick={() => void runPreview()}>
                <FileUp className="size-4" aria-hidden="true" />
                Yükle ve önizle
              </Button>
            </div>
          </div>
        )}

        {step === 'mapping' && sample && (
          <>
            <MappingStep rows={sample} pending={previewM.isPending} onSubmit={(f) => void runPreview(f)} />
            {previewM.isError && !sampleRowsFrom(previewM.error) && <Alert tone="danger">{errorMessage(previewM.error)}</Alert>}
          </>
        )}

        {step === 'preview' && preview && (
          <>
            <PreviewStep preview={preview} />
            {needsAck && (
              <label className="flex items-start gap-2 text-small">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" />
                Uyarıları okudum; okunamayan satırlar aktarılmadan devam et.
              </label>
            )}
            {commit.isError && <Alert tone="danger">{errorMessage(commit.error)}</Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Vazgeç
              </Button>
              <Button loading={commit.isPending} disabled={needsAck && !ack} onClick={() => void runCommit()}>
                İçe al
              </Button>
            </div>
          </>
        )}

        {step === 'done' && commit.data && (
          <>
            <Alert tone="success">
              {commit.data.alreadyCommitted
                ? 'Bu ekstre daha önce içe alınmış.'
                : `${commit.data.written} yeni banka hareketi aktarıldı${commit.data.existing ? `, ${commit.data.existing} satır zaten vardı` : ''}. Eşleştirme kuyruğunda öneriler hazır.`}
            </Alert>
            <div className="flex justify-end">
              <Button onClick={onClose}>Kapat</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
