import { Link2, Link2Off, Plus, ReceiptText, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { type CostTarget, useAddCost, useChargeUnit, useExpenseOptions, useTicketPermissions, useUnlinkCost, useWorkCosts } from '@/hooks/useTickets';
import { errorMessage } from '@/lib/api/errors';
import { maintenanceApi } from '@/lib/api/maintenance';
import { type WorkCosts, ticketsApi } from '@/lib/api/tickets';
import { formatDate } from '@/lib/dates';
import { MAX_KURUS, formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';
import { istanbulToday } from '@/lib/maintenance/schedule';

const apiOf = (kind: CostTarget['kind']) => (kind === 'ticket' ? ticketsApi : maintenanceApi);

/**
 * O1-4 masraf karti (talep ve bakim gorevi): bagli giderler (Finans'ta ters kaydedilen "iptal"),
 * yeni gider, var olan gideri baglama / bagi kaldirma ve (daire ici talepte) yonetici onayli
 * daireye yansitma. Yazim yalnizca yonetim; denetci salt okur.
 */
export function WorkCostCard({ target, ticketStatus }: { target: CostTarget; ticketStatus?: string }) {
  const p = useTicketPermissions();
  const api = apiOf(target.kind);
  const costs = useWorkCosts(target, api);
  const unlink = useUnlinkCost(target.id, api);
  const [dialog, setDialog] = useState<'expense' | 'link' | 'charge' | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const editable = p.canWriteCosts && ticketStatus !== 'cancelled' && costs.data?.target.status !== 'cancelled';

  return (
    <Card className="flex flex-col gap-3 p-4 md:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle className="flex items-center gap-2 text-base md:text-base">
          <ReceiptText className="size-4" aria-hidden="true" />
          Masraf
        </CardTitle>
        {costs.data && <span className="ml-auto text-small font-semibold tabular-nums">{formatTRY(costs.data.total)}</span>}
      </div>

      {costs.isPending ? (
        <Skeleton className="h-16" />
      ) : costs.isError ? (
        <Alert tone="danger">{errorMessage(costs.error)}</Alert>
      ) : (
        <>
          {costs.data.items.length === 0 ? (
            <p className="text-small text-muted">Bağlı masraf yok.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-small">
              {costs.data.items.map((i) => (
                <li key={i.expenseId} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    <span className={i.reversed ? 'line-through' : undefined}>{i.description}</span>
                    <span className="block text-xs text-muted">
                      {formatDate(i.date)}
                      {i.supplier ? ` · ${i.supplier}` : ''}
                      {i.invoiceNumber ? ` · Fatura ${i.invoiceNumber}` : ''}
                      {` · ${i.mode === 'expense' ? 'bu işten kaydedildi' : 'bağlandı'}`}
                    </span>
                  </span>
                  {i.reversed && <Badge tone="neutral">İptal (ters kayıt)</Badge>}
                  <span className="tabular-nums">{formatTRY(i.amount)}</span>
                  {editable && i.mode === 'link' && (
                    <Button size="xs" variant="subtle" aria-label={`${i.description} bağını kaldır`} onClick={() => setUnlinking(i.expenseId)}>
                      <Link2Off className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {costs.data.recharges.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg bg-surface-muted/40 p-2 text-xs">
              <span className="font-medium">Daireye yansıtılan</span>
              {costs.data.recharges.map((r) => (
                <span key={r.transactionId} className="flex items-center gap-2">
                  <span className={r.reversed ? 'line-through' : undefined}>
                    {r.liableParty === 'owner' ? 'Kat maliki' : 'Oturan'} · vade {formatDate(r.dueDate)}
                  </span>
                  {r.reversed && <Badge tone="neutral">İptal</Badge>}
                  <span className="ml-auto tabular-nums">{formatTRY(r.amount)}</span>
                </span>
              ))}
            </div>
          )}

          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setDialog('expense')}>
                <Plus className="size-4" aria-hidden="true" />
                Yeni gider
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDialog('link')}>
                <Link2 className="size-4" aria-hidden="true" />
                Var olan gideri bağla
              </Button>
              {target.kind === 'ticket' && costs.data.rechargeable > 0 && (
                <Button size="sm" variant="secondary" onClick={() => setDialog('charge')}>
                  Daireye yansıt
                </Button>
              )}
            </div>
          )}
          <Link to="/admin/finance" className="text-xs text-accent underline-offset-4 hover:underline">
            Finans'ta görüntüle
          </Link>
        </>
      )}

      {dialog === 'expense' && costs.data && <NewExpenseDialog target={target} costs={costs.data} onClose={() => setDialog(null)} />}
      {dialog === 'link' && <LinkExpenseDialog target={target} onClose={() => setDialog(null)} />}
      {dialog === 'charge' && costs.data && <ChargeDialog ticketId={target.id} costs={costs.data} onClose={() => setDialog(null)} />}

      <Dialog open={!!unlinking} onClose={() => setUnlinking(null)} title="Masraf bağını kaldır">
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">Gider Finans'ta kalır; yalnızca bu işle bağı kaldırılır ve başka bir işe bağlanabilir.</p>
          <FormField label="Gerekçe">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </FormField>
          {unlink.isError && <Alert tone="danger">{errorMessage(unlink.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setUnlinking(null)}>
              Vazgeç
            </Button>
            <Button
              variant="danger"
              loading={unlink.isPending}
              disabled={reason.trim().length < 3}
              onClick={() =>
                unlink.mutate(
                  { expenseId: unlinking ?? '', reason: reason.trim() },
                  {
                    onSuccess: () => {
                      setUnlinking(null);
                      setReason('');
                    },
                  },
                )
              }
            >
              Bağı kaldır
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

function NewExpenseDialog({ target, costs, onClose }: { target: CostTarget; costs: WorkCosts; onClose: () => void }) {
  const [key] = useIdempotencyKey();
  const add = useAddCost(target.id, apiOf(target.kind));
  const expenseAccounts = useFinanceAccounts('expense');
  const allAccounts = useFinanceAccounts();
  const payAccounts = (allAccounts.data ?? []).filter((a) => a.type === 'cash' || a.type === 'bank' || a.type === 'payable');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(istanbulToday());
  const [expenseAccountId, setExpenseAccountId] = useState(costs.suggestion.expenseAccountId);
  const [creditAccountId, setCreditAccountId] = useState(costs.suggestion.creditAccountId ?? 'cash');
  const [description, setDescription] = useState(costs.target.label);
  const [supplier, setSupplier] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  // Daire ici talep: gideri kaydederken ayni tutari tek adimda daireye yansitma secenegi.
  const canRecharge = target.kind === 'ticket' && !!costs.target.unitId;
  const [recharge, setRecharge] = useState(false);
  const [party, setParty] = useState<'owner' | 'occupant'>('occupant');
  const [dueDate, setDueDate] = useState('');
  const [rechargeError, setRechargeError] = useState<string | null>(null);
  const kurus = parseTRYToKurus(amount);
  const rechargeValid = !recharge || /^\d{4}-\d{2}-\d{2}$/.test(dueDate);
  const valid = kurus !== null && kurus <= MAX_KURUS && description.trim().length > 0 && rechargeValid;

  const submit = () =>
    add.mutate(
      {
        mode: 'expense',
        idempotencyKey: key,
        amount: kurus as number,
        date,
        expenseAccountId,
        creditAccountId,
        description: description.trim(),
        ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
        ...(invoiceNumber.trim() ? { invoiceNumber: invoiceNumber.trim() } : {}),
        ...(canRecharge && recharge ? { recharge: { liableParty: party, dueDate } } : {}),
      },
      {
        onSuccess: (r) => {
          // Gider kaydedildi ama yansitma yapilamadiysa pencere acik kalir ve neden gosterilir;
          // kart ustundeki "Daireye yansit" ile sonradan tamamlanabilir.
          if (r.rechargeError) setRechargeError(r.rechargeError);
          else onClose();
        },
      },
    );

  return (
    <Dialog open onClose={onClose} title="Yeni gider" variant="wide">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Tutar (TL)">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1.500,00" />
        </FormField>
        <FormField label="Tarih" hint="Kapalı döneme gider girilemez.">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </FormField>
        <FormField label="Gider hesabı" hint="İş kategorisine göre önerildi.">
          <Select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}>
            {(expenseAccounts.data ?? []).map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.code ? `${a.code} · ` : ''}
                {a.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Ödeme" hint="Kasa / banka (peşin) veya tedarikçi (vadeli).">
          <Select value={creditAccountId} onChange={(e) => setCreditAccountId(e.target.value)}>
            {payAccounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
                {a.type === 'payable' ? ' (vadeli)' : ` · ${formatTRY(a.balance)}`}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Açıklama">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          </FormField>
        </div>
        <FormField label="Tedarikçi (isteğe bağlı)">
          <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} />
        </FormField>
        <FormField label="Fatura no (isteğe bağlı)">
          <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} maxLength={60} />
        </FormField>
      </div>
      {canRecharge && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border p-3">
          <label className="flex items-start gap-2 text-small">
            <input
              type="checkbox"
              checked={recharge}
              onChange={(e) => setRecharge(e.target.checked)}
              disabled={!!rechargeError}
              className="mt-0.5 size-4 accent-accent"
            />
            Gideri kaydettikten sonra doğrudan bu daireye (Oturan / Kat maliki) borç olarak yansıt
          </label>
          {recharge && (
            <div className="grid gap-4 sm:grid-cols-2">
              <fieldset className="flex flex-col gap-2 text-small">
                <legend className="mb-1 font-medium">Borçlu</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" name="inline-party" checked={party === 'occupant'} onChange={() => setParty('occupant')} className="accent-accent" />
                  Oturan (kiracı; boş dairede kat maliki)
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="inline-party" checked={party === 'owner'} onChange={() => setParty('owner')} className="accent-accent" />
                  Kat maliki
                </label>
              </fieldset>
              <FormField label="Son ödeme tarihi">
                <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </FormField>
              <p className="text-xs text-muted sm:col-span-2">
                Gider tutarının tamamı "Onarım Yansıtma Gelirleri" hesabına tahakkuk olarak dairenin carisine yazılır. Kısmi yansıtma için
                kutuyu boş bırakıp sonradan "Daireye yansıt"ı kullanın.
              </p>
            </div>
          )}
        </div>
      )}
      {add.isError && (
        <div className="mt-4">
          <Alert tone="danger">{errorMessage(add.error)}</Alert>
        </div>
      )}
      {rechargeError && (
        <div className="mt-4">
          <Alert tone="danger">
            Gider kaydedildi ancak daireye yansıtılamadı: {rechargeError}. Kartta "Daireye yansıt" ile tekrar deneyebilirsiniz.
          </Alert>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant={rechargeError ? 'secondary' : 'ghost'} onClick={onClose}>
          {rechargeError ? 'Kapat' : 'Vazgeç'}
        </Button>
        {!rechargeError && (
          <Button loading={add.isPending} disabled={!valid} onClick={submit}>
            Gideri kaydet
          </Button>
        )}
      </div>
    </Dialog>
  );
}

function LinkExpenseDialog({ target, onClose }: { target: CostTarget; onClose: () => void }) {
  const [key] = useIdempotencyKey();
  const add = useAddCost(target.id, apiOf(target.kind));
  const options = useExpenseOptions(true);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const items = useMemo(() => {
    const term = q.trim().toLocaleLowerCase('tr');
    return (options.data ?? []).filter((o) => !term || `${o.description} ${o.supplier ?? ''} ${o.invoiceNumber ?? ''}`.toLocaleLowerCase('tr').includes(term));
  }, [options.data, q]);

  return (
    <Dialog open onClose={onClose} title="Var olan gideri bağla" variant="wide">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Açıklama, tedarikçi veya fatura no" className="pl-9" aria-label="Gider ara" />
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        </div>
        {options.isPending ? (
          <Skeleton className="h-32" />
        ) : options.isError ? (
          <Alert tone="danger">{errorMessage(options.error)}</Alert>
        ) : items.length === 0 ? (
          <p className="text-small text-muted">Gider bulunamadı.</p>
        ) : (
          <ul role="radiogroup" aria-label="Giderler" className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border text-small">
            {items.map((o) => (
              <li key={o.expenseId}>
                <label className={`flex items-center gap-3 px-3 py-2 ${o.linkedTo ? 'opacity-60' : 'cursor-pointer hover:bg-surface-muted/40'}`}>
                  <input type="radio" name="expense" disabled={!!o.linkedTo} checked={selected === o.expenseId} onChange={() => setSelected(o.expenseId)} className="accent-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.description}</span>
                    <span className="block text-xs text-muted">
                      {formatDate(o.date)}
                      {o.supplier ? ` · ${o.supplier}` : ''}
                      {o.linkedTo ? ` · bağlı: ${o.linkedTo.label}` : ''}
                    </span>
                  </span>
                  <span className="tabular-nums">{formatTRY(o.amount)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {add.isError && <Alert tone="danger">{errorMessage(add.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button loading={add.isPending} disabled={!selected} onClick={() => add.mutate({ mode: 'link', idempotencyKey: key, expenseId: selected ?? '' }, { onSuccess: onClose })}>
            Bağla
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Karar 4: yalnizca yonetici, acik onay kutusu ve malik / oturan secimiyle. */
function ChargeDialog({ ticketId, costs, onClose }: { ticketId: string; costs: WorkCosts; onClose: () => void }) {
  const [key] = useIdempotencyKey();
  const charge = useChargeUnit(ticketId);
  const [party, setParty] = useState<'owner' | 'occupant'>('occupant');
  const [amount, setAmount] = useState(kurusToInput(costs.rechargeable));
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState(`Onarım yansıtma: ${costs.target.label}`.slice(0, 200));
  const [confirmed, setConfirmed] = useState(false);
  const kurus = parseTRYToKurus(amount);
  const over = kurus !== null && kurus > costs.rechargeable;
  const valid = kurus !== null && !over && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && confirmed && description.trim().length > 0;

  return (
    <Dialog open onClose={onClose} title="Masrafı daireye yansıt">
      <div className="flex flex-col gap-4">
        <Alert>
          Sakin kusurundan doğan daire içi onarım masrafı, "Onarım Yansıtma Gelirleri" hesabına tahakkuk olarak dairenin carisine yazılır. Yansıtılabilir tutar en fazla{' '}
          <strong>{formatTRY(costs.rechargeable)}</strong>.
        </Alert>
        <fieldset className="flex flex-col gap-2 text-small">
          <legend className="mb-1 font-medium">Borçlu</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="party" checked={party === 'occupant'} onChange={() => setParty('occupant')} className="accent-accent" />
            Oturan (kiracı; boş dairede kat maliki)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="party" checked={party === 'owner'} onChange={() => setParty('owner')} className="accent-accent" />
            Kat maliki
          </label>
        </fieldset>
        <FormField label="Tutar (TL)" error={over ? 'Yansıtılabilir tutarı aşıyor.' : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label="Son ödeme tarihi">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </FormField>
        <FormField label="Açıklama (sakinin borç dökümünde görünür)">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
        </FormField>
        <label className="flex items-start gap-2 text-small">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
          Masrafın sakin kusurundan kaynaklandığını ve daireye borç olarak yansıtılmasını onaylıyorum.
        </label>
        {charge.isError && <Alert tone="danger">{errorMessage(charge.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            loading={charge.isPending}
            disabled={!valid}
            onClick={() => charge.mutate({ idempotencyKey: key, confirm: true, liableParty: party, amount: kurus as number, dueDate, description: description.trim() }, { onSuccess: onClose })}
          >
            Daireye yansıt
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
