import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useAccountChart, useCreateAccount, useUpdateAccount } from '@/hooks/useFinance';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { FinanceAccount } from '@/lib/api/finance';
import { formatTRY } from '@/lib/money';

const TYPES = [
  { type: 'income', label: 'Gelir hesapları' },
  { type: 'expense', label: 'Gider hesapları' },
  { type: 'cash', label: 'Kasa' },
  { type: 'bank', label: 'Banka' },
] as const;
type ChartType = (typeof TYPES)[number]['type'];
const CODE_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/;

/**
 * Finans 2.4 - Hesap plani: gelir, gider, kasa ve banka hesaplari; isteğe bagli hesap kodu
 * (mizan ve raporlarda siralama/gosterim). Sistem hesaplari pasife alinamaz; bakiyesi olan
 * hesap da pasife alinamaz (API kurali).
 */
export function AccountChartCard({ canWrite }: { canWrite: boolean }) {
  const chart = useAccountChart();
  const [editing, setEditing] = useState<{ type: ChartType; account?: FinanceAccount } | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Hesap planı</CardTitle>
        <label className="inline-flex items-center gap-2 text-small text-muted">
          <input type="checkbox" className="size-4 accent-accent" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Pasifleri göster
        </label>
      </div>
      {chart.isPending && <Skeleton className="h-40" />}
      {chart.isError && <Alert tone="danger">{errorMessage(chart.error)}</Alert>}
      {chart.data &&
        TYPES.map(({ type, label }) => {
          const items = chart.data
            .filter((a) => a.type === type && (showInactive || a.status === 'active'))
            .sort((a, b) => (a.code ?? '~').localeCompare(b.code ?? '~', 'tr', { numeric: true }) || a.name.localeCompare(b.name, 'tr'));
          return (
            <section key={type} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <h3 className="text-small font-medium">{label}</h3>
                {canWrite && (
                  <Button size="xs" variant="subtle" onClick={() => setEditing({ type })}>
                    <Plus className="size-3.5" aria-hidden="true" />
                    Ekle
                  </Button>
                )}
              </div>
              <ul className="divide-y divide-border rounded-lg border border-border text-small">
                {items.map((a) => (
                  <li key={a.accountId} className="flex items-center gap-3 px-3 py-1.5">
                    <span className="w-16 shrink-0 font-mono text-xs text-muted">{a.code ?? '—'}</span>
                    <span className="flex-1">
                      {a.name}
                      {a.system && <span className="ml-1 text-xs text-muted">(hazır)</span>}
                      {a.status === 'inactive' && (
                        <Badge className="ml-2" tone="neutral">
                          pasif
                        </Badge>
                      )}
                    </span>
                    <span className="tabular-nums text-muted">{a.balance !== 0 ? formatTRY(Math.abs(a.balance)) : ''}</span>
                    {canWrite && (
                      <Button size="xs" variant="subtle" aria-label={`${a.name} hesabını düzenle`} onClick={() => setEditing({ type, account: a })}>
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                ))}
                {items.length === 0 && <li className="px-3 py-1.5 text-muted">Hesap yok.</li>}
              </ul>
            </section>
          );
        })}
      {canWrite && <AccountDialog editing={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function AccountDialog({ editing, onClose }: { editing: { type: ChartType; account?: FinanceAccount } | null; onClose: () => void }) {
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const a = editing?.account;
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [active, setActive] = useState(true);
  const [opened, setOpened] = useState<typeof editing>(null);
  if (editing !== opened) {
    setOpened(editing);
    setName(a?.name ?? '');
    setCode(a?.code ?? '');
    setActive(a ? a.status === 'active' : true);
    create.reset();
    update.reset();
  }
  const codeError = code && !CODE_RE.test(code.trim()) ? 'Harf, rakam, nokta ve tire; en fazla 20 karakter.' : undefined;
  const error = create.error ?? update.error;
  const fieldError = error instanceof ApiError && error.field === 'code' ? error.message : undefined;
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!editing) return;
    const trimmed = code.trim();
    if (a) {
      update.mutate(
        { accountId: a.accountId, input: { name: name.trim(), code: trimmed || null, ...(active !== (a.status === 'active') ? { status: active ? 'active' : 'inactive' } : {}) } },
        { onSuccess: onClose },
      );
    } else {
      create.mutate({ type: editing.type, name: name.trim(), ...(trimmed ? { code: trimmed } : {}) }, { onSuccess: onClose });
    }
  };

  return (
    <Dialog open={!!editing} onClose={onClose} title={a ? 'Hesabı düzenle' : 'Yeni hesap'}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormField label="Hesap adı">
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label="Hesap kodu (isteğe bağlı)" error={codeError ?? fieldError} hint="Örn. 600.01 — raporlarda sıralama için">
          <Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} />
        </FormField>
        {a && !a.system && (
          <FormField label="Durum" hint={a.balance !== 0 ? 'Bakiyesi olan hesap pasife alınamaz.' : undefined}>
            <Select value={active ? 'active' : 'inactive'} onChange={(e) => setActive(e.target.value === 'active')}>
              <option value="active">Aktif</option>
              <option value="inactive">Pasif</option>
            </Select>
          </FormField>
        )}
        {error && !fieldError && <Alert tone="danger">{errorMessage(error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" disabled={name.trim().length < 2 || !!codeError} loading={pending}>
            Kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
