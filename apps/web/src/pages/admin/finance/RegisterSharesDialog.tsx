import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Dialog, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { useSetRegister, useUnitOwnership } from '@/hooks/useOwnership';
import { errorMessage } from '@/lib/api/errors';
import type { Share } from '@/lib/api/ownership';
import { formatBps, formatShare, isCompleteTable, parseShare, sharesToBps, totalShare } from '@/lib/ownership/shares';
import { reasonError } from '../units/moveOut';
import { todayIstanbul } from './schemas';

type Props = {
  open: boolean;
  unitId: string;
  unitLabel: string;
  names: Map<string, string>;
  onClose: () => void;
};

/**
 * Pay tablosu satirlarini dogrular: her satir gecerli kesir, toplam tam 1. Hata metni veya
 * API'ye gonderilecek paylar.
 */
export function validateShareRows(rows: readonly { userId: string; share: string }[]): { error: string } | { owners: { userId: string; share: Share }[] } {
  if (rows.length === 0) return { error: 'Bu tarihte kayıtlı malik yok; önce malik üyeliğini ekleyin.' };
  const owners: { userId: string; share: Share }[] = [];
  for (const r of rows) {
    const share = parseShare(r.share);
    if (!share) return { error: 'Her malik için geçerli bir pay girin (örn. 1/2).' };
    owners.push({ userId: r.userId, share });
  }
  if (!isCompleteTable(owners.map((o) => o.share))) {
    return { error: `Payların toplamı tam 1 olmalı (şu an ${formatShare(totalShare(owners.map((o) => o.share)))}).` };
  }
  return { owners };
}

/**
 * Hisse tamamlama / sicil duzeltmesi: dairenin bugunku maliklerine pay girilir (toplam tam 1).
 * Cari hareketi yoktur; uyeliklerdeki pay alanlari ayni islemde guncellenir.
 */
export function RegisterSharesDialog({ open, unitId, unitLabel, names, onClose }: Props) {
  const ownership = useUnitOwnership(open ? unitId : undefined);
  const save = useSetRegister();
  const [rows, setRows] = useState<{ userId: string; share: string }[]>([]);
  const [validFrom, setValidFrom] = useState(todayIstanbul());
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  const data = ownership.data;
  useEffect(() => {
    if (!open || !data) return;
    const source = data.current?.owners ?? data.incomplete?.owners ?? [];
    setRows(source.map((o) => ({ userId: o.userId, share: o.share ? formatShare(o.share) : '' })));
    setValidFrom(data.current?.validFrom && !data.registered ? data.current.validFrom : todayIstanbul());
    setReason('');
    setTouched(false);
    save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista / veri gelince
  }, [open, data?.version, data?.registered]);

  const checked = useMemo(() => validateShareRows(rows), [rows]);
  const bps = 'owners' in checked ? sharesToBps(checked.owners.map((o) => o.share)) : [];

  const submit = async () => {
    setTouched(true);
    if (!('owners' in checked) || reasonError(reason) || !data) return;
    try {
      await save.mutateAsync({ unitId, input: { owners: checked.owners, validFrom, reason: reason.trim(), version: data.version } });
      onClose();
    } catch {
      // Uyari asagida.
    }
  };

  return (
    <Dialog open={open} onClose={() => !save.isPending && onClose()} title={`Hisseleri düzenle · ${unitLabel}`}>
      <div className="flex flex-col gap-3">
        {ownership.isPending && <Skeleton className="h-20 w-full" />}
        {ownership.isError && <Alert tone="danger">{errorMessage(ownership.error)}</Alert>}
        {data && (
          <>
            <p className="text-small text-muted">Paylar bağımsız bölümün tamamına göre kesirdir; toplam tam 1 olmalıdır (örn. 1/3 + 2/3).</p>
            {rows.map((r, i) => (
              <FormField key={r.userId} label={names.get(r.userId) ?? 'Adı kayıtlı değil'} hint={bps[i] !== undefined ? formatBps(bps[i] ?? 0) : undefined}>
                <Input
                  inputMode="numeric"
                  placeholder="1/2"
                  value={r.share}
                  onChange={(e) => setRows((list) => list.map((x, j) => (j === i ? { ...x, share: e.target.value } : x)))}
                />
              </FormField>
            ))}
            {'error' in checked && rows.length > 0 && <Alert tone="danger">{checked.error}</Alert>}
            <FormField label="Geçerlilik başlangıcı">
              <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </FormField>
            <FormField label="Gerekçe" error={touched ? reasonError(reason) : undefined}>
              <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Tapu kaydına göre" />
            </FormField>
            {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
                Vazgeç
              </Button>
              <Button loading={save.isPending} disabled={!('owners' in checked)} onClick={() => void submit()}>
                Hisseleri kaydet
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
