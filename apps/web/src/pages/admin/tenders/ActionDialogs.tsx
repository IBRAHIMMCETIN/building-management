import { type FormEvent, useEffect, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import type { Tender } from '@/lib/api/tenders';
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

type DecideProps = { open: boolean; onClose: () => void; tender: Tender; pending: boolean; onConfirm: (v: { quoteId: string; reason: string; reference?: string }) => Promise<unknown> };

/** Karar: secilen teklif, gerekce ve istege bagli genel kurul / anket karari referansi. */
export function DecideDialog({ open, onClose, tender, pending, onConfirm }: DecideProps) {
  const { columns } = comparisonColumns(tender);
  const [quoteId, setQuoteId] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setQuoteId(tender.comparison.lowestQuoteIds[0] ?? '');
      setReason('');
      setReference('');
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
      await onConfirm({ quoteId, reason: reason.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) });
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
        <FormField label="Karar referansı (isteğe bağlı)" hint="Örn. genel kurul / yönetim kurulu karar no, anket bağlantısı.">
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
