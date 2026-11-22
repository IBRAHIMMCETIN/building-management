import { CheckCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FormField, Select } from '@/components/ui';
import { useAutoMatch, useAutoMatchPreview, useBankStatements } from '@/hooks/useBank';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import type { AutoMatchResult } from '@/lib/api/bank';
import { errorMessage } from '@/lib/api/errors';
import { DEFAULT_MIN_CONFIDENCE, MIN_CONFIDENCE_OPTIONS, autoMatchMessage, latestCommittedStatement } from '@/lib/bank/autoMatch';
import { confidenceBadge } from '@/lib/bank/allocation';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';

const pct = (n: number) => `%${Math.round(n * 100)}`;

/**
 * Faz B3 - Eslestirme kuyrugunun ustunde: secili ekstredeki yuksek guvenli, cakismasiz satirlari
 * tek onayla eslestirir. Once on izleme (yazim yok), sonra onay ozeti, sonra sonuc bildirimi.
 */
export function AutoMatchBar({ bankAccountId, canWrite }: { bankAccountId: string; canWrite: boolean }) {
  const statements = useBankStatements(bankAccountId);
  const committed = useMemo(
    () => (statements.data ?? []).filter((s) => s.status === 'committed' && s.period).sort((a, b) => (b.period?.to ?? '').localeCompare(a.period?.to ?? '')),
    [statements.data],
  );
  const [statementId, setStatementId] = useState('');
  const [min, setMin] = useState<number>(DEFAULT_MIN_CONFIDENCE);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<AutoMatchResult | null>(null);
  const [key, renewKey] = useIdempotencyKey();
  const run = useAutoMatch();

  // Varsayilan: en son biten ekstre. Secim, listede kaldigi surece korunur (yenilemelerde sifirlanmaz).
  useEffect(() => {
    const list = statements.data ?? [];
    if (!list.some((s) => s.statementId === statementId && s.status === 'committed')) {
      setStatementId(latestCommittedStatement(list)?.statementId ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statements.data]);
  useEffect(() => setResult(null), [bankAccountId]);

  const preview = useAutoMatchPreview(statementId || undefined, min);
  if (!canWrite || committed.length === 0) return null;

  const n = preview.data?.eligibleCount ?? 0;
  const message = result ? autoMatchMessage(result) : null;

  return (
    <Card className="flex flex-col gap-3" aria-label="Toplu otomatik onay">
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Ekstre">
          <Select value={statementId} onChange={(e) => (setStatementId(e.target.value), setResult(null))}>
            {committed.map((s) => (
              <option key={s.statementId} value={s.statementId}>
                {s.fileName}
                {s.period ? ` · ${formatDate(s.period.from)}–${formatDate(s.period.to)}` : ''}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Güven eşiği">
          <Select value={String(min)} onChange={(e) => (setMin(Number(e.target.value)), setResult(null))}>
            {MIN_CONFIDENCE_OPTIONS.map((o) => (
              <option key={o} value={String(o)}>
                {pct(o)} ve üzeri
              </option>
            ))}
          </Select>
        </FormField>
        <Button disabled={n === 0 || preview.isPending} loading={run.isPending} onClick={() => setConfirming(true)}>
          <CheckCheck className="size-4" aria-hidden="true" />
          Yüksek güvenli {n} satırı onayla
        </Button>
      </div>
      {preview.isError && <Alert tone="danger">{errorMessage(preview.error)}</Alert>}
      {preview.data && (
        <p className="text-small text-muted">
          Eşik üzerinde {n} satır ({formatTRY(preview.data.eligibleAmount)}). Bekleyen giren: {preview.data.unmatchedIn}
          {preview.data.skippedAmbiguous ? ` · belirsiz: ${preview.data.skippedAmbiguous}` : ''}
          {preview.data.skippedClosed ? ` · kapalı cariye düşen: ${preview.data.skippedClosed}` : ''}
          {preview.data.unmatchedOut ? ` · bekleyen çıkan: ${preview.data.unmatchedOut} (gider olarak işlenebilir)` : ''}
        </p>
      )}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {run.isError && <Alert tone="danger">{errorMessage(run.error)}</Alert>}

      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Toplu onay">
        <div className="flex flex-col gap-3">
          <p className="text-small">
            {pct(min)} ve üzeri güvenli, tek adaylı <strong>{n}</strong> satır ({formatTRY(preview.data?.eligibleAmount ?? 0)}) tahsilata çevrilecek. Her satır
            için makbuz kesilir, kesinleşen gecikme tazminatı yazılır; yanlış olan satır “Geri al” ile tek tek iptal edilebilir.
          </p>
          <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-lg border border-border text-small">
            {(preview.data?.items ?? []).slice(0, 50).map((i) => {
              const badge = confidenceBadge(i.suggestion.confidence);
              return (
                <li key={i.lineId} className="flex items-start justify-between gap-2 px-3 py-2">
                  <span>
                    <span className="block font-medium">{i.suggestion.allocations.map((a) => a.unitLabel).join(' + ')}</span>
                    <span className="block text-xs text-muted">
                      {formatDate(i.date)} · {i.description}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <span className="tabular-nums">{formatTRY(i.amount)}</span>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Vazgeç
            </Button>
            <Button
              loading={run.isPending}
              onClick={async () => {
                try {
                  setResult(await run.mutateAsync({ statementId, minConfidence: min, idempotencyKey: key }));
                  renewKey();
                } catch {
                  // karttaki hata alaninda gosterilir; ayni anahtarla tekrar denenebilir
                } finally {
                  setConfirming(false);
                }
              }}
            >
              {n} satırı onayla
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
