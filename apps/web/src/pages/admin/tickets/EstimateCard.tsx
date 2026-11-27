import { Calculator, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, CardTitle, FormField, Input } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import type { EstimateInput, StaffEstimate } from '@/lib/api/tickets';
import { formatDateTime } from '@/lib/dates';
import { MAX_KURUS, formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';

type Mutation = { mutate: (input: EstimateInput, opts?: { onSuccess?: () => void }) => void; isPending: boolean; isError: boolean; error: unknown };

/**
 * v2: gorevlinin tahmini tutar notu (talep ve bakim gorevi). Bilgi amaclidir; Finans'a / deftere
 * yazilmaz, sakin gormez. Gorevli kendi isinde, yonetim her acik iste girer; surumle kaydedilir.
 */
export function EstimateCard({ estimate, canEdit, version, mutation, nameOf }: { estimate?: StaffEstimate; canEdit: boolean; version: number; mutation: Mutation; nameOf: (userId: string) => string | undefined }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(estimate ? kurusToInput(estimate.amount) : '');
  const [note, setNote] = useState(estimate?.note ?? '');
  if (!estimate && !canEdit) return null;
  // Sifir gecerli bir tahmindir ("ucretsiz yapilabilir").
  const kurus = amount.trim() ? parseTRYToKurus(amount, { allowZero: true }) : null;
  const valid = kurus !== null && kurus <= MAX_KURUS;
  const save = (input: EstimateInput) => mutation.mutate(input, { onSuccess: () => setEditing(false) });

  return (
    <Card className="flex flex-col gap-3 p-4 md:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle className="flex items-center gap-2 text-base md:text-base">
          <Calculator className="size-4" aria-hidden="true" />
          Tahmini tutar (görevli notu)
        </CardTitle>
        {canEdit && !editing && (
          <Button size="xs" variant="subtle" className="ml-auto" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden="true" />
            {estimate ? 'Düzenle' : 'Tutar gir'}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted">Bilgi amaçlıdır: Finans’a kaydedilmez, sakin görmez.</p>
      {editing ? (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Tutar (TL)" error={amount.trim() && !valid ? 'Geçerli bir tutar girin' : undefined}>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <div className="sm:col-span-2">
              <FormField label="Kısa not (isteğe bağlı)">
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Örn. conta ve işçilik" />
              </FormField>
            </div>
          </div>
          {mutation.isError && <Alert tone="danger">{errorMessage(mutation.error)}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            {estimate && (
              <Button size="sm" variant="ghost" className="mr-auto" disabled={mutation.isPending} onClick={() => save({ version, amount: null })}>
                Notu kaldır
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={mutation.isPending}>
              Vazgeç
            </Button>
            <Button size="sm" loading={mutation.isPending} disabled={!valid} onClick={() => kurus !== null && save({ version, amount: kurus, ...(note.trim() ? { note: note.trim() } : {}) })}>
              Kaydet
            </Button>
          </div>
        </div>
      ) : estimate ? (
        <p className="text-small">
          <span className="font-medium tabular-nums">{formatTRY(estimate.amount)}</span>
          {estimate.note && <span className="text-text-secondary"> · {estimate.note}</span>}
          <span className="block text-xs text-muted">
            {nameOf(estimate.by) ?? 'Görevli'} · {formatDateTime(estimate.at)}
          </span>
        </p>
      ) : (
        <p className="text-small text-muted">Henüz tahmini tutar girilmedi.</p>
      )}
    </Card>
  );
}
