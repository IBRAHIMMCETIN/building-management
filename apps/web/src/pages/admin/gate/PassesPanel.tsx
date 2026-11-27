import { useState } from 'react';
import { Alert, Button, FilterChips, Skeleton } from '@/components/ui';
import { useDeskActions, useManagerPasses } from '@/hooks/useGate';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';
import { validityText } from '@/lib/gate/plate';
import { VerdictBadge } from '@/components/gate/GateUi';

/** Yonetim: misafir gecisleri (QR jetonu / kisa kod gosterilmez); yonetici iptali denetim gunlugune yazilir. */
export function PassesPanel() {
  const [status, setStatus] = useState<'active' | 'past' | ''>('active');
  const list = useManagerPasses(status);
  const a = useDeskActions();
  const [confirmId, setConfirmId] = useState<string>();
  const items = list.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <FilterChips
        label="Geçiş durumu"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'active', label: 'Geçerli / yaklaşan' },
          { value: 'past', label: 'Geçmiş' },
          { value: '', label: 'Tümü' },
        ]}
      />
      {a.revokePass.error && <Alert tone="danger">{errorMessage(a.revokePass.error)}</Alert>}
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-small text-muted">Misafir geçişi yok.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((p) => (
            <li key={p.passId} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-xs">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.guestName}</span>
                  <VerdictBadge verdict={p.verdict} />
                </span>
                <span className="text-small text-text-secondary">
                  {p.unitLabel} · {validityText(p.validFrom, p.validUntil)} · {p.entryMode === 'single' ? 'Tek giriş' : `Çoklu giriş (${p.entryCount})`}
                  {p.plateDisplay && <span className="font-mono"> · {p.plateDisplay}</span>}
                </span>
                {p.lastEntryAt && <span className="text-xs text-muted">Son giriş: {formatDateTime(p.lastEntryAt)}</span>}
                {p.revokeReason && <span className="text-xs text-muted">{p.revokeReason === 'taşınma' ? 'Geçişi oluşturan sakin taşındığı için otomatik iptal edildi' : `İptal nedeni: ${p.revokeReason}`}</span>}
              </span>
              {p.canRevoke &&
                (confirmId === p.passId ? (
                  <span className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setConfirmId(undefined)}>
                      Vazgeç
                    </Button>
                    <Button size="sm" variant="danger" loading={a.revokePass.isPending} onClick={() => a.revokePass.mutate({ id: p.passId, version: p.version }, { onSettled: () => setConfirmId(undefined) })}>
                      İptal et
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="subtle" onClick={() => setConfirmId(p.passId)}>
                    İptal et
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
