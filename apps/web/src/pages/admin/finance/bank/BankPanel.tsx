import { Check, FileUp, Landmark, Split, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useBankAccounts, useBankQueue, useIgnoreLine, useMatchLine, useReconciliation, useSaveBankProfile, useUnmatchLine } from '@/hooks/useBank';
import { type BankAccount, type BankLine, LINE_STATUS_LABELS, type LineStatus } from '@/lib/api/bank';
import { errorMessage } from '@/lib/api/errors';
import { canQuickConfirm, confidenceBadge, groupIban } from '@/lib/bank/allocation';
import { formatDate } from '@/lib/dates';
import { formatSignedTRY, formatTRY } from '@/lib/money';
import { MatchDialog, ReasonDialog } from './MatchDialog';
import { UploadWizard } from './UploadWizard';

type StatusFilter = LineStatus | 'all';
const FILTERS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'unmatched', label: 'Eşleşmeyen' },
  { value: 'matched', label: 'Eşleşen' },
  { value: 'ignored', label: 'Yoksayılan' },
  { value: 'all', label: 'Tümü' },
];

function ReconciliationCard({ bankAccountId }: { bankAccountId: string }) {
  const r = useReconciliation(bankAccountId);
  if (r.isPending) return <Skeleton className="h-28 w-full" />;
  if (r.isError) return <Alert tone="danger">{errorMessage(r.error)}</Alert>;
  const d = r.data;
  const diff = d.difference;
  return (
    <Card className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Mutabakat özeti">
      <div>
        <p className="text-small text-muted">Ekstre bakiyesi</p>
        <p className="font-semibold tabular-nums">{d.statement?.closingBalance !== undefined ? formatSignedTRY(d.statement.closingBalance) : '—'}</p>
        {d.statement?.period && <p className="text-xs text-muted">{formatDate(d.statement.period.to)} itibarıyla</p>}
      </div>
      <div>
        <p className="text-small text-muted">Defter bakiyesi</p>
        <p className="font-semibold tabular-nums">{formatSignedTRY(d.ledgerBalanceAtStatementEnd ?? d.ledgerBalance)}</p>
        <p className="text-xs text-muted">Güncel: {formatSignedTRY(d.ledgerBalance)}</p>
      </div>
      <div>
        <p className="text-small text-muted">Fark</p>
        <p className={`font-semibold tabular-nums ${diff === undefined ? '' : diff === 0 ? 'text-success' : 'text-warning'}`}>
          {diff === undefined ? '—' : formatSignedTRY(diff)}
        </p>
      </div>
      <div>
        <p className="text-small text-muted">Eşleşmeyen satır</p>
        <p className="font-semibold tabular-nums">{d.lines.unmatchedIn.count + d.lines.unmatchedOut.count}</p>
        <p className="text-xs text-muted">
          Giren {formatTRY(d.lines.unmatchedIn.amount)} · Çıkan {formatTRY(d.lines.unmatchedOut.amount)}
        </p>
      </div>
    </Card>
  );
}

/** Sakin kartinda gosterilen IBAN ve hesap sahibi (apartmanin kendi tahsilat hesabi). */
function ProfileDialog({ open, onClose, account }: { open: boolean; onClose: () => void; account: BankAccount | undefined }) {
  const save = useSaveBankProfile();
  const [iban, setIban] = useState('');
  const [holder, setHolder] = useState('');
  const [bankName, setBankName] = useState('');
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!open) return;
    setIban(account?.profile?.iban ?? '');
    setHolder(account?.profile?.accountHolderName ?? '');
    setBankName(account?.profile?.bankName ?? '');
    setVisible(account?.profile?.residentVisible ?? true);
    save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.accountId]);
  if (!account) return null;
  return (
    <Dialog open={open} onClose={onClose} title={`Hesap bilgileri · ${account.name}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await save.mutateAsync({
              bankAccountId: account.accountId,
              input: {
                iban: iban.replace(/\s/g, ''),
                accountHolderName: holder,
                ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
                residentVisible: visible,
                ...(account.profile ? { expectedVersion: account.profile.version } : {}),
              },
            });
            onClose();
          } catch {
            // asagida
          }
        }}
      >
        <FormField label="IBAN">
          <Input value={iban} onChange={(e) => setIban(e.target.value.toUpperCase())} placeholder="TR00 0000 0000 0000 0000 0000 00" />
        </FormField>
        <FormField label="Hesap sahibi">
          <Input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="… Sitesi Yönetimi" />
        </FormField>
        <FormField label="Banka (isteğe bağlı)">
          <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
        </FormField>
        <label className="flex items-start gap-2 text-small">
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} className="mt-1" />
          Sakinlerin “Havale / EFT ile Öde” kartında bu hesabı göster (aynı anda tek hesap gösterilir)
        </label>
        {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" loading={save.isPending}>
            Kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Modal =
  | { kind: 'upload' }
  | { kind: 'profile' }
  | { kind: 'match'; line: BankLine }
  | { kind: 'ignore'; line: BankLine }
  | { kind: 'unmatch'; line: BankLine }
  | null;

function SuggestionCell({ line }: { line: BankLine }) {
  if (line.status !== 'unmatched') return <span className="text-muted">—</span>;
  const s = line.suggestion;
  if (!s) return <span className="text-small text-muted">{line.direction === 'out' ? 'Çıkan hareket' : 'Öneri yok'}</span>;
  const badge = confidenceBadge(s.confidence);
  return (
    <span className="flex flex-col gap-1" title={s.reasons.join('\n')}>
      <span className="text-small font-medium">
        {s.allocations.map((a) => `${a.unitLabel}${a.former ? ' (ayrılan)' : ''}`).join(' + ')}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <span className="text-xs text-muted">{s.reasons[0]}</span>
      </span>
    </span>
  );
}

/** Finans -> Banka: hesap secici, mutabakat ozeti, ekstre yukleme ve eslestirme kuyrugu. */
export function BankPanel({ canWrite }: { canWrite: boolean }) {
  const accounts = useBankAccounts();
  const [accountId, setAccountId] = useState<string>('');
  const [filter, setFilter] = useState<StatusFilter>('unmatched');
  const [modal, setModal] = useState<Modal>(null);
  const quick = useMatchLine();
  const ignore = useIgnoreLine();
  const unmatch = useUnmatchLine();

  useEffect(() => {
    if (!accountId && accounts.data?.length) setAccountId(accounts.data[0]?.accountId ?? '');
  }, [accounts.data, accountId]);
  const account = accounts.data?.find((a) => a.accountId === accountId);
  const queue = useBankQueue(accountId || undefined, filter === 'all' ? undefined : filter);
  const rows = useMemo(() => queue.data?.pages.flatMap((p) => p.items) ?? [], [queue.data]);
  const close = () => setModal(null);

  if (accounts.isPending) return <Skeleton className="h-40 w-full" />;
  if (accounts.isError) return <Alert tone="danger">{errorMessage(accounts.error)}</Alert>;
  if (!accounts.data.length) return <Alert>Aktif banka hesabı yok. Önce finans hesaplarından bir banka hesabı oluşturun.</Alert>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FormField label="Banka hesabı">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.data.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
                {a.profile ? ` · ${groupIban(a.profile.iban).slice(-9)}` : ''}
              </option>
            ))}
          </Select>
        </FormField>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setModal({ kind: 'profile' })}>
              <Landmark className="size-4" aria-hidden="true" />
              Hesap bilgileri
            </Button>
            <Button onClick={() => setModal({ kind: 'upload' })}>
              <FileUp className="size-4" aria-hidden="true" />
              Ekstre yükle
            </Button>
          </div>
        )}
      </div>
      {canWrite && account && !account.profile && (
        <Alert>Sakinlerin Havale/EFT kartı için bu hesabın IBAN’ını “Hesap bilgileri”nden girin.</Alert>
      )}

      {accountId && <ReconciliationCard bankAccountId={accountId} />}

      <FilterChips label="Satır durumu" value={filter} options={FILTERS} onChange={setFilter} />
      {quick.isError && <Alert tone="danger">{errorMessage(quick.error)}</Alert>}

      {queue.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : queue.isError ? (
        <Alert tone="danger">{errorMessage(queue.error)}</Alert>
      ) : rows.length === 0 ? (
        <Card className="py-8 text-center text-small text-muted">Bu filtrede banka hareketi yok.</Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm">
          <table className="w-full text-left text-small">
            <caption className="sr-only">Banka hareketleri ve eşleştirme önerileri</caption>
            <thead className="border-b border-border bg-surface-muted/50 text-xs tracking-wide text-muted uppercase">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Tarih</th>
                <th scope="col" className="px-3 py-2 font-medium">Açıklama</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Tutar</th>
                <th scope="col" className="px-3 py-2 font-medium">Öneri</th>
                <th scope="col" className="px-3 py-2 font-medium">Durum</th>
                {canWrite && <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">İşlemler</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((l) => {
                const s = l.suggestion;
                return (
                  <tr key={l.lineId} className="align-top">
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">{formatDate(l.valueDate ?? l.date)}</td>
                    <td className="px-3 py-2">
                      <span className="block">{l.description}</span>
                      <span className="block text-xs text-muted">
                        {[l.counterpartyName, l.counterpartyIbanMasked, l.bankReference].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-right whitespace-nowrap tabular-nums ${l.direction === 'in' ? 'text-success' : ''}`}>
                      {formatSignedTRY(l.direction === 'in' ? l.amount : -l.amount)}
                    </td>
                    <td className="px-3 py-2">
                      <SuggestionCell line={l} />
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={l.status === 'matched' ? 'success' : l.status === 'ignored' ? 'neutral' : 'warning'}>{LINE_STATUS_LABELS[l.status]}</Badge>
                    </td>
                    {canWrite && (
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap justify-end gap-1">
                          {l.status === 'unmatched' && l.direction === 'in' && canQuickConfirm(s) && (
                            <Button
                              size="xs"
                              loading={quick.isPending && quick.variables?.lineId === l.lineId}
                              onClick={() =>
                                quick.mutate({
                                  lineId: l.lineId,
                                  input: {
                                    bankAccountId: accountId,
                                    expectedVersion: l.version,
                                    allocations: s.allocations.map((a) => ({ accountId: a.accountId, amount: a.amount })),
                                    source: 'suggestion',
                                    confidence: s.confidence,
                                  },
                                })
                              }
                            >
                              <Check className="size-3.5" aria-hidden="true" />
                              Onayla
                            </Button>
                          )}
                          {l.status === 'unmatched' && l.direction === 'in' && (
                            <Button size="xs" variant="secondary" onClick={() => setModal({ kind: 'match', line: l })}>
                              <Split className="size-3.5" aria-hidden="true" />
                              Eşleştir / Böl
                            </Button>
                          )}
                          {l.status === 'unmatched' && (
                            <Button size="xs" variant="ghost" onClick={() => setModal({ kind: 'ignore', line: l })}>
                              <X className="size-3.5" aria-hidden="true" />
                              Yoksay
                            </Button>
                          )}
                          {l.status !== 'unmatched' && (
                            <Button size="xs" variant="ghost" onClick={() => setModal({ kind: 'unmatch', line: l })}>
                              <Undo2 className="size-3.5" aria-hidden="true" />
                              Geri al
                            </Button>
                          )}
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {queue.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={queue.isFetchingNextPage} onClick={() => void queue.fetchNextPage()}>
            Daha fazla yükle
          </Button>
        </div>
      )}

      {canWrite && accountId && (
        <>
          <UploadWizard open={modal?.kind === 'upload'} onClose={close} bankAccountId={accountId} />
          <ProfileDialog open={modal?.kind === 'profile'} onClose={close} account={account} />
          <MatchDialog open={modal?.kind === 'match'} onClose={close} line={modal?.kind === 'match' ? modal.line : null} bankAccountId={accountId} />
          <ReasonDialog
            open={modal?.kind === 'ignore'}
            title="Satırı yoksay"
            description="İç virman, banka masrafı veya aidat dışı hareketler defter kaydı oluşturmadan kuyruktan çıkarılır."
            actionLabel="Yoksay"
            pending={ignore.isPending}
            error={ignore.error}
            onClose={() => (ignore.reset(), close())}
            onSubmit={async (reason) => {
              if (modal?.kind !== 'ignore') return;
              try {
                await ignore.mutateAsync({ lineId: modal.line.lineId, bankAccountId: accountId, expectedVersion: modal.line.version, reason });
                close();
              } catch {
                // diyalogda gosterilir
              }
            }}
          />
          <ReasonDialog
            open={modal?.kind === 'unmatch'}
            title={modal?.kind === 'unmatch' && modal.line.status === 'ignored' ? 'Yoksaymayı geri al' : 'Eşleştirmeyi geri al'}
            description={
              modal?.kind === 'unmatch' && modal.line.status === 'ignored'
                ? 'Satır yeniden eşleştirme kuyruğuna alınır.'
                : 'Bağlı tahsilat ve kesinleşen tazminat ters kayıtla iptal edilir, makbuzlar “iptal” olarak görünür ve satır kuyruğa döner.'
            }
            actionLabel="Geri al"
            danger
            pending={unmatch.isPending}
            error={unmatch.error}
            onClose={() => (unmatch.reset(), close())}
            onSubmit={async (reason) => {
              if (modal?.kind !== 'unmatch') return;
              try {
                await unmatch.mutateAsync({ lineId: modal.line.lineId, bankAccountId: accountId, expectedVersion: modal.line.version, reason });
                close();
              } catch {
                // diyalogda gosterilir
              }
            }}
          />
        </>
      )}
    </div>
  );
}
