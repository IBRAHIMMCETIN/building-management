import { FileText } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useCancelConsent, useCloseConsent, useConsent, useRecordConsent } from '@/hooks/useAssemblies';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { useBlocks } from '@/hooks/useUnits';
import {
  CONSENT_CHOICES,
  CONSENT_CHOICE_LABELS,
  CONSENT_METHODS,
  CONSENT_METHOD_LABELS,
  CONSENT_STATUS_LABELS,
  CONSENT_STATUS_TONES,
  type ConsentChoice,
  type ConsentDetail,
  type ConsentMethod,
  type ConsentRow,
  type DecisionOutcome,
  MAJORITY_LABELS,
  assembliesApi,
  kindLabel,
  requiredText,
} from '@/lib/api/assemblies';
import { INVOICE_ACCEPT, documentsApi, invoiceFileError } from '@/lib/api/documents';
import { errorMessage } from '@/lib/api/errors';
import { formatBps } from '@/lib/api/pollModel';
import { formatDate, formatDateTime } from '@/lib/dates';
import { istanbulToday } from '@/lib/reservations/model';
import { consentEntryInput } from './schemas';

type Props = { consentId: string | null; canWrite: boolean; onClose: () => void };

/** Rizanin ozeti: kisi / oy / bolum / arsa payi; gerekli cogunluk ve gerekceler. */
export function consentSummary(o: DecisionOutcome): string[] {
  const land = o.landShareBps ? ` · arsa payı ${formatBps(o.landShareBps.yes)}` : '';
  return [
    `Rıza: ${o.persons?.yes ?? 0} kat maliki · ${o.votes.yes} oy · ${o.units?.yes ?? 0} bölüm${land}`,
    `İtiraz: ${o.persons?.no ?? 0} kat maliki · ${o.units?.no ?? 0} bölüm · kaydı olmayan ${o.units?.absent ?? 0} bölüm`,
    `Gerekli: ${requiredText(o)}`,
  ];
}

/**
 * Yazili riza talebi ayrintisi: dayanak, sonuc (acikken ara sonuc), bolum bazinda gecerli kayit
 * (imzalayan, tarih, yontem, belge), riza / itiraz kaydi ve duzeltmesi, kapatma, iptal, PDF.
 */
export function ConsentDetailDialog({ consentId, canWrite, onClose }: Props) {
  const detail = useConsent(consentId ?? undefined);
  const doc = useOpenDocument();
  const blocks = useBlocks();
  const [recording, setRecording] = useState<ConsentRow | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const data = detail.data;
  const c = data?.consent;
  const open = c?.status === 'open';
  const blockNames = useMemo(() => new Map((blocks.data ?? []).map((b) => [b.blockId, b.name])), [blocks.data]);
  const multiBlock = new Set((data?.rows ?? []).map((r) => r.blockId)).size > 1;
  const unitLabel = (r: ConsentRow) => `${multiBlock ? `${blockNames.get(r.blockId) ?? 'Blok'} · ` : ''}${r.number}`;

  return (
    <Dialog open={consentId !== null} onClose={onClose} title={c ? c.title : 'Yazılı rıza'} variant="panel">
      {detail.isPending ? (
        <div role="status" aria-label="Talep yükleniyor" className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      ) : detail.isError ? (
        <Alert tone="danger">{errorMessage(detail.error)}</Alert>
      ) : (
        c &&
        data && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2 text-small">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={CONSENT_STATUS_TONES[c.status]}>{CONSENT_STATUS_LABELS[c.status]}</Badge>
                <span className="text-muted">
                  {kindLabel(c.decisionKind)} · Gerekli: {MAJORITY_LABELS[c.rule]}
                </span>
              </div>
              {c.description && <p className="whitespace-pre-line break-words">{c.description}</p>}
              {data.legal && (
                <p className="text-muted">
                  Dayanak: {data.legal.legal}. {data.legal.note}
                </p>
              )}
              <p className="text-muted">Oy listesi {formatDate(c.rollDate)} itibarıyla donduruldu ({c.roll.units} bölüm); payda bütün kat malikleridir.</p>
              {c.cancelReason && <p className="text-muted">İptal gerekçesi: {c.cancelReason}</p>}
              {c.expiresOn && c.status === 'open' && <p className="text-muted">Son kayıt günü: {formatDate(c.expiresOn)} (en fazla 90 gün).</p>}
              {data.warnings.map((w) => (
                <Alert key={w}>
                  {w}
                </Alert>
              ))}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="secondary" loading={doc.pendingId === 'pdf'} onClick={() => void doc.open('pdf', () => assembliesApi.consentPdf(c.consentId))}>
                  <FileText className="size-4" aria-hidden="true" />
                  {c.status === 'closed' ? 'Sonuç tutanağı (PDF)' : 'Ara sonuç (PDF)'}
                </Button>
                {canWrite && open && <CloseButton detail={data} />}
                {canWrite && open && !cancelling && (
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(true)}>
                    Talebi iptal et
                  </Button>
                )}
              </div>
              {doc.error && <Alert tone="danger">{doc.error}</Alert>}
              {cancelling && <CancelConsentBox detail={data} onDone={() => setCancelling(false)} />}
            </div>

            <Card className="flex flex-col gap-2">
              <CardTitle>{c.status === 'closed' ? 'Sonuç' : 'Ara sonuç'}</CardTitle>
              <Alert tone={data.outcome.decision === 'accepted' ? 'success' : 'info'}>
                {data.outcome.decision === 'accepted' ? 'Gerekli çoğunluk sağlandı.' : 'Gerekli çoğunluk henüz sağlanmadı.'}
                {c.closedAt ? ` Kesinleşme: ${formatDateTime(c.closedAt)}.` : ''}
              </Alert>
              <div className="flex flex-col gap-1 text-xs text-muted tabular-nums">
                {consentSummary(data.outcome).map((line) => (
                  <span key={line}>{line}</span>
                ))}
                {data.outcome.reasons.map((r) => (
                  <span key={r} className="text-danger">
                    {r}
                  </span>
                ))}
                {data.outcome.warnings.map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>
            </Card>

            <Card className="flex flex-col gap-3">
              <CardTitle>Bölüm bazında rıza</CardTitle>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-left text-small">
                  <caption className="sr-only">Bölüm bazında yazılı rıza</caption>
                  <thead className="border-b border-border bg-surface-muted/50 text-xs text-muted">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Bölüm
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Kat maliki
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Beyan
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.rows.map((r) => (
                      <tr key={r.unitId} className="align-top">
                        <td className="px-3 py-2">{unitLabel(r)}</td>
                        <td className="px-3 py-2">
                          {r.owners.length ? r.owners.map((o) => o.name ?? 'Kayıtlı kişi').join(', ') : <span className="text-muted">Malik kaydı yok</span>}
                          {r.ownerChanged && (
                            <Badge tone="warning" className="ml-2">
                              Malik değişti
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {r.entry ? (
                            <div className="flex flex-col gap-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <Badge tone={r.entry.choice === 'consent' ? 'success' : 'danger'}>{CONSENT_CHOICE_LABELS[r.entry.choice]}</Badge>
                                <span className="text-xs text-muted">
                                  {r.entry.signerName ?? 'Kayıtlı kişi'} · {formatDate(r.entry.signedOn)} · {CONSENT_METHOD_LABELS[r.entry.method]}
                                  {(r.records ?? 1) > 1 ? ` · ${(r.records ?? 1) - 1} düzeltme` : ''}
                                </span>
                              </span>
                              {r.entry.correctionReason && <span className="text-xs text-muted">Düzeltme gerekçesi: {r.entry.correctionReason}</span>}
                              {r.entry.document && (
                                <Button
                                  size="xs"
                                  variant="subtle"
                                  className="self-start"
                                  loading={doc.pendingId === r.unitId}
                                  onClick={() => void doc.open(r.unitId, () => assembliesApi.consentDocument(c.consentId, r.unitId))}
                                >
                                  <FileText className="size-3.5" aria-hidden="true" />
                                  {r.entry.document.fileName}
                                </Button>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted">Kayıt yok</span>
                          )}
                          {canWrite && open && (
                            <Button size="xs" variant="subtle" className="mt-1" onClick={() => setRecording(r)}>
                              {r.entry ? 'Düzelt' : 'Rıza / itiraz gir'}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            {canWrite && open && (
              <RecordDialog
                consentId={c.consentId}
                row={recording}
                unitLabel={recording ? unitLabel(recording) : ''}
                openedOn={c.rollDate}
                allCoOwners={Boolean(data.allCoOwners)}
                onClose={() => setRecording(null)}
              />
            )}
          </div>
        )
      )}
    </Dialog>
  );
}

function CloseButton({ detail }: { detail: ConsentDetail }) {
  const close = useCloseConsent(detail.consent.consentId);
  return (
    <>
      <Button size="sm" loading={close.isPending} onClick={() => close.mutate(detail.consent.version)}>
        Sonucu kesinleştir
      </Button>
      {close.isError && <Alert tone="danger">{errorMessage(close.error)}</Alert>}
    </>
  );
}

function CancelConsentBox({ detail, onDone }: { detail: ConsentDetail; onDone: () => void }) {
  const cancel = useCancelConsent(detail.consent.consentId);
  const [reason, setReason] = useState('');
  return (
    <Card className="flex flex-col gap-3">
      <FormField label="İptal gerekçesi" hint="Kayıtlar silinmez; gerekçe denetim günlüğüne yazılır.">
        <Textarea maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      {cancel.isError && <Alert tone="danger">{errorMessage(cancel.error)}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={cancel.isPending}>
          Vazgeç
        </Button>
        <Button variant="danger" loading={cancel.isPending} disabled={reason.trim().length < 3} onClick={() => cancel.mutate({ version: detail.consent.version, reason: reason.trim() }, { onSuccess: onDone })}>
          İptal et
        </Button>
      </div>
    </Card>
  );
}

function RecordDialog({
  consentId,
  row,
  unitLabel,
  openedOn,
  allCoOwners,
  onClose,
}: {
  consentId: string;
  row: ConsentRow | null;
  unitLabel: string;
  openedOn: string;
  allCoOwners: boolean;
  onClose: () => void;
}) {
  const record = useRecordConsent(consentId);
  const [choice, setChoice] = useState<ConsentChoice>('consent');
  const [signedOn, setSignedOn] = useState('');
  const [method, setMethod] = useState<ConsentMethod>('wet_signature');
  const [methodNote, setMethodNote] = useState('');
  const [signer, setSigner] = useState('');
  const [signers, setSigners] = useState<string[]>([]);
  const [correctionReason, setCorrectionReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const today = istanbulToday();
  const coOwned = (row?.owners.length ?? 0) > 1;

  useEffect(() => {
    if (!row) return;
    record.reset();
    setChoice(row.entry?.choice ?? 'consent');
    setSignedOn(row.entry?.signedOn ?? today);
    setMethod(row.entry?.method ?? 'wet_signature');
    setMethodNote(row.entry?.methodNote ?? '');
    setSigner(coOwned ? (row.entry?.signerUserId ?? '') : '');
    setSigners(row.entry?.signerUserIds ?? []);
    setCorrectionReason('');
    setFile(null);
    setIssue(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [row]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!row) return;
    const r = consentEntryInput(
      { choice, signedOn, method, methodNote, signerUserId: signer, correctionReason, signerUserIds: signers },
      { coOwned, recorded: Boolean(row.entry), today, openedOn, allCoOwners, owners: row.owners.map((o) => o.userId) },
    );
    if ('issue' in r) return setIssue(r.issue);
    if (file && invoiceFileError(file)) return setIssue(invoiceFileError(file));
    setIssue(null);
    let document: { uploadId: string; fileName: string } | undefined;
    if (file) {
      setUploading(true);
      try {
        document = await documentsApi.uploadInvoice(file);
      } catch (err) {
        setUploading(false);
        return setIssue(errorMessage(err));
      }
      setUploading(false);
    }
    try {
      await record.mutateAsync({ unitId: row.unitId, input: { ...r.input, ...(document ? { document } : {}) } });
      onClose();
    } catch {
      // Hata diyalogda gosterilir.
    }
  };
  const pending = record.isPending || uploading;

  return (
    <Dialog open={row !== null} onClose={() => !pending && onClose()} title={`${row?.entry ? 'Kaydı düzelt' : 'Rıza / itiraz'} · ${unitLabel}`}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
        {row?.entry && <p className="text-small text-muted">Kayıtlı beyan değişmez: düzeltme gerekçesiyle yeni kayıt olarak eklenir, önceki kayıt silinmez.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Beyan">
            <Select value={choice} onChange={(e) => setChoice(e.target.value as ConsentChoice)}>
              {CONSENT_CHOICES.map((x) => (
                <option key={x} value={x}>
                  {CONSENT_CHOICE_LABELS[x]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="İmza tarihi">
            <Input type="date" min={openedOn} max={today} value={signedOn} onChange={(e) => setSignedOn(e.target.value)} />
          </FormField>
        </div>
        {coOwned && allCoOwners && choice === 'consent' ? (
          <fieldset className="flex flex-col gap-2 text-small">
            <legend className="font-medium">İmzalayan paydaşlar</legend>
            <span className="text-xs text-muted">Bu karar türünde hisseli bölümün bütün paydaşlarının imzası gerekir (TMK m.692 yorumu).</span>
            {row?.owners.map((o) => (
              <label key={o.userId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={signers.includes(o.userId)}
                  onChange={(e) => setSigners((cur) => (e.target.checked ? [...new Set([...cur, o.userId])] : cur.filter((u) => u !== o.userId)))}
                />
                {o.name ?? 'Kayıtlı kişi'}
              </label>
            ))}
          </fieldset>
        ) : coOwned && (
          <FormField label="İmzalayan paydaş (temsilci)" hint="Hisseli bölümde rıza paydaşların temsilcisinden alınır.">
            <Select value={signer} invalid={!signer} onChange={(e) => setSigner(e.target.value)}>
              <option value="">Paydaş seçin (zorunlu)</option>
              {row?.owners.map((o) => (
                <option key={o.userId} value={o.userId}>
                  {o.name ?? 'Kayıtlı kişi'}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Yöntem">
          <Select value={method} onChange={(e) => setMethod(e.target.value as ConsentMethod)}>
            {CONSENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {CONSENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </FormField>
        {method === 'other' && (
          <FormField label="Yöntem açıklaması">
            <Input maxLength={200} value={methodNote} onChange={(e) => setMethodNote(e.target.value)} />
          </FormField>
        )}
        <FormField label="Taranmış belge (isteğe bağlı)" hint="PDF veya fotoğraf, en fazla 10 MB. Asıl belge saklanmalıdır.">
          <Input
            type="file"
            accept={INVOICE_ACCEPT}
            className="h-auto py-1.5 file:mr-3 file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1 file:text-xs file:font-medium file:text-text"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </FormField>
        {row?.entry && (
          <FormField label="Düzeltme gerekçesi" hint="Gerekçe denetim günlüğüne ve sonuç tutanağına yazılır.">
            <Textarea maxLength={500} value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} />
          </FormField>
        )}
        {issue && <Alert tone="danger">{issue}</Alert>}
        {record.isError && <Alert tone="danger">{errorMessage(record.error)}</Alert>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={pending}>
            Kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
