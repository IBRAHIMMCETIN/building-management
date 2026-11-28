import { type FormEvent, useEffect, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import type { AssemblyDecisionOption, AssemblyDecisionRef, SupplierAccountOption, Tender } from '@/lib/api/tenders';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { formatTRY } from '@/lib/money';
import { comparisonColumns, publishBlockers } from '@/lib/tenders/model';

type ReasonProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  label: string;
  minLength: number;
  maxLength?: number;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
};

/** Gerekceli islem (iptal, teklif geri cekme): gerekce denetim gunlugune ve sakin gorunumune yazilir. */
export function ReasonDialog({ open, onClose, title, description, label, minLength, maxLength = 500, confirmLabel, danger, pending, onConfirm }: ReasonProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < minLength) {
      setError(`Gerekçe en az ${minLength} karakter olmalı.`);
      return;
    }
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open={open} onClose={() => !pending && onClose()} title={title}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
        {description && <p className="text-small text-muted">{description}</p>}
        <FormField label={label} error={error ?? undefined}>
          <Textarea rows={3} maxLength={maxLength} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={pending}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type PublishProps = { open: boolean; onClose: () => void; tender: Tender; pending: boolean; onConfirm: (shortfallReason?: string) => Promise<unknown> };

/**
 * Sakinlerle paylasma: yayindan sonra teklifler donar ve sakinler / denetciler tum teklifleri ve
 * belgeleri gorur. Asgari teklif sayisi altinda gerekce zorunludur (sakinler de gorur).
 */
export function PublishDialog({ open, onClose, tender, pending, onConfirm }: PublishProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);
  const blockers = publishBlockers(tender);
  const shortfall = tender.readiness?.shortfall ?? false;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (shortfall && reason.trim().length < 10) {
      setError('Eksik teklifle yayınlamak için en az 10 karakterlik gerekçe yazın.');
      return;
    }
    try {
      await onConfirm(shortfall ? reason.trim() : undefined);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open={open} onClose={() => !pending && onClose()} title="Sakinlerle paylaş">
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
        <p className="text-small text-text-secondary">
          {tender.quoteCount} teklif yan yana, KDV dahil toplamlarıyla ve belgeleriyle tüm sakinlere ve denetçilere açılır. Yayından sonra teklifler değiştirilemez.
        </p>
        {blockers.length > 0 && (
          <Alert tone="danger">
            {blockers.map((b) => (
              <span key={b} className="block">
                {b}
              </span>
            ))}
          </Alert>
        )}
        {shortfall && blockers.length === 0 && (
          <FormField label={`Asgari ${tender.minQuotes} teklif yerine ${tender.quoteCount} teklifle yayınlama gerekçesi`} error={error ?? undefined} hint="Sakinler bu gerekçeyi görür.">
            <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        )}
        {!shortfall && error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={pending} disabled={blockers.length > 0}>
            Paylaş
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type DecideProps = {
  open: boolean;
  onClose: () => void;
  tender: Tender;
  pending: boolean;
  /** Genel kurul karar baglantisi secenekleri (yuklenmediyse bos). */
  assemblyOptions?: readonly AssemblyDecisionOption[];
  onConfirm: (v: { quoteId: string; reason: string; reference?: string; assemblyDecision?: AssemblyDecisionRef }) => Promise<unknown>;
};

/** Secici degeri `<toplanti>|<madde>`. */
const refKey = (o: { assemblyId: string; itemId: string }) => `${o.assemblyId}|${o.itemId}`;
const refOf = (key: string): AssemblyDecisionRef | undefined => {
  const [assemblyId, itemId] = key.split('|');
  return assemblyId && itemId ? { assemblyId, itemId } : undefined;
};
export const assemblyOptionLabel = (o: AssemblyDecisionOption) => `${formatDate(o.meetingAt)} · ${o.itemTitle}${o.decision === 'accepted' ? '' : ' (reddedildi)'}`;

/** Ayni apartmanin genel kurul kararlari; yalnizca kabul edilmis karar secilebilir (API de dogrular). */
function AssemblyDecisionSelect({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: readonly AssemblyDecisionOption[]; label: string }) {
  return (
    <FormField label={label} hint={options.length ? 'Sakinlerden malik olanlar karara genel kurul sayfasından ulaşır.' : 'Bu apartmanda kayıtlı genel kurul kararı yok.'}>
      <Select value={value} disabled={!options.length} onChange={(e) => onChange(e.target.value)}>
        <option value="">Bağlantı yok</option>
        {options.map((o) => (
          <option key={refKey(o)} value={refKey(o)} disabled={o.decision !== 'accepted'}>
            {assemblyOptionLabel(o)}
          </option>
        ))}
      </Select>
    </FormField>
  );
}

/** Karar: secilen teklif, gerekce ve istege bagli genel kurul / anket karari referansi. */
export function DecideDialog({ open, onClose, tender, pending, assemblyOptions = [], onConfirm }: DecideProps) {
  const { columns } = comparisonColumns(tender);
  const [quoteId, setQuoteId] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [assembly, setAssembly] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setQuoteId(tender.comparison.lowestQuoteIds[0] ?? '');
      setReason('');
      setReference('');
      setAssembly('');
      setError(null);
    }
  }, [open, tender.comparison.lowestQuoteIds]);
  const selectedLowest = tender.comparison.lowestQuoteIds.includes(quoteId);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!quoteId) {
      setError('Bir teklif seçin.');
      return;
    }
    if (reason.trim().length < 10) {
      setError('Karar gerekçesi en az 10 karakter olmalı.');
      return;
    }
    try {
      const assemblyDecision = refOf(assembly);
      await onConfirm({ quoteId, reason: reason.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}), ...(assemblyDecision ? { assemblyDecision } : {}) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open={open} onClose={() => !pending && onClose()} title="Karara bağla" variant="wide">
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-small font-medium">Seçilen teklif</legend>
          {columns.map(({ quote, row }) => (
            <label
              key={quote.quoteId}
              className={cn('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-small', quoteId === quote.quoteId ? 'border-accent bg-accent/5' : 'border-border hover:border-border-strong')}
            >
              <input type="radio" name="quote" className="size-4 accent-accent" checked={quoteId === quote.quoteId} onChange={() => setQuoteId(quote.quoteId)} />
              <span className="min-w-0 flex-1 font-medium break-words">{quote.supplierName}</span>
              {row.isLowest && <Badge tone="success">En düşük</Badge>}
              <span className="tabular-nums">{formatTRY(row.totalKurus)}</span>
            </label>
          ))}
        </fieldset>
        <FormField label="Karar gerekçesi" hint={selectedLowest ? 'Sakinler kararı ve gerekçeyi görür.' : 'En düşük teklif seçilmedi: nedenini açıkça yazın (garanti, referans, süre…). Sakinler görür.'}>
          <Textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <AssemblyDecisionSelect label="Genel kurul kararı (isteğe bağlı)" value={assembly} onChange={setAssembly} options={assemblyOptions} />
        <FormField label="Diğer karar referansı (isteğe bağlı)" hint="Örn. yönetim kurulu karar no, anket bağlantısı.">
          <Input maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} />
        </FormField>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={pending}>
            Kararı kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type LinkProps = {
  open: boolean;
  onClose: () => void;
  tender: Tender;
  options: readonly AssemblyDecisionOption[];
  loading: boolean;
  pending: boolean;
  onConfirm: (assemblyDecision: AssemblyDecisionRef | null) => Promise<unknown>;
};

/** Genel kurul karar bagini sonradan kurar, degistirir veya kaldirir (denetimli). */
export function AssemblyLinkDialog({ open, onClose, tender, options, loading, pending, onConfirm }: LinkProps) {
  const current = tender.assemblyDecision ? refKey(tender.assemblyDecision) : '';
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue(current);
      setError(null);
    }
  }, [open, current]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onConfirm(refOf(value) ?? null);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open={open} onClose={() => !pending && onClose()} title="Genel kurul kararı bağlantısı">
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
        {loading ? <p className="text-small text-muted">Kararlar yükleniyor…</p> : <AssemblyDecisionSelect label="Genel kurul kararı" value={value} onChange={setValue} options={options} />}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={pending} disabled={loading || value === current}>
            {value ? 'Bağla' : 'Bağlantıyı kaldır'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type SupplierProps = {
  open: boolean;
  onClose: () => void;
  tender: Tender;
  options: readonly SupplierAccountOption[];
  loading: boolean;
  pending: boolean;
  onConfirm: (accountId: string | null) => Promise<unknown>;
};

/**
 * Kazanan firmayi Finans tedarikci (vadeli borc) hesabina baglar: gider / hakedis kaydinda odeme
 * hesabi varsayilani olur. Firma adina benzeyen hesaplar once listelenir.
 */
export function SupplierDialog({ open, onClose, tender, options, loading, pending, onConfirm }: SupplierProps) {
  const current = tender.supplierAccount?.accountId ?? '';
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setValue(current || options.find((o) => o.suggested)?.accountId || '');
  }, [open, current, options]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onConfirm(value || null);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open={open} onClose={() => !pending && onClose()} title="Tedarikçi hesabı">
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
        <p className="text-small text-muted">“{tender.decision?.supplierName}” için Finans’taki tedarikçi (vadeli borç) hesabını seçin. Hesap yoksa Finans → Hesaplar ekranından ekleyin.</p>
        {loading ? (
          <p className="text-small text-muted">Hesaplar yükleniyor…</p>
        ) : (
          <FormField label="Tedarikçi hesabı">
            <Select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">Eşleştirme yok</option>
              {options.map((o) => (
                <option key={o.accountId} value={o.accountId}>
                  {o.name}
                  {o.code ? ` (${o.code})` : ''}
                  {o.suggested ? ' · önerilen' : ''}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={pending} disabled={loading || value === current}>
            Kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
