import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarPlus, ChevronRight, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useCreatePeriod, useExpenseOptions, useMeterPermissions, usePeriods, useTemplates } from '@/hooks/useMeters';
import type { MeterPeriod } from '@/lib/api/meters';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { formatDate } from '@/lib/dates';
import { CATEGORY_LABELS, PERIOD_STATUS_META, splitLabel, todayIstanbul } from '@/lib/meters/model';
import { formatTRY } from '@/lib/money';
import { cn } from '@/lib/cn';
import { type PeriodForm, type PeriodValues, periodSchema } from './schemas';

type Filter = 'open' | 'all' | 'cancelled';

/** Dagitim donemleri listesi; satira tiklayinca donem ayrintisi (okuma, hesap, onay, geri alma) acilir. */
export function PeriodsPanel({ onOpen }: { onOpen: (periodId: string) => void }) {
  const { canManage } = useMeterPermissions();
  const [filter, setFilter] = useState<Filter>('all');
  const periods = usePeriods(filter);
  // Silinen (iptal) taslaklar "Tümü"nde gizlenir; ayri filtrede gorunur (UX-09).
  const items = filter === 'all' ? (periods.data ?? []).filter((p) => p.status !== 'cancelled') : periods.data;
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterChips<Filter>
          label="Dönem durumu"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Tümü' },
            { value: 'open', label: 'Okuma açık' },
            { value: 'cancelled', label: 'Silinen taslaklar' },
          ]}
        />
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <CalendarPlus className="size-4" aria-hidden="true" />
            Yeni dönem
          </Button>
        )}
      </div>

      {periods.isError && <Alert tone="danger">{errorMessage(periods.error)}</Alert>}
      {periods.isPending && <Skeleton className="h-24" />}
      {items?.length === 0 &&
        (filter === 'cancelled' ? (
          <Alert>Silinen taslak dönem yok.</Alert>
        ) : (
          <Alert>Dağıtım dönemi yok. Önce bir şablon oluşturun, sonra dönemi açın.</Alert>
        ))}

      <ul className="flex flex-col gap-2">
        {items?.map((p) => (
          <li key={p.periodId}>
            <button
              type="button"
              onClick={() => onOpen(p.periodId)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface/60 p-4 text-left transition-colors hover:border-border-strong"
            >
              <PeriodSummary period={p} />
              <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      <PeriodDialog open={creating} onClose={() => setCreating(false)} onCreated={onOpen} />
    </div>
  );
}

export function PeriodSummary({ period: p }: { period: MeterPeriod }) {
  const meta = PERIOD_STATUS_META[p.status];
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{p.name}</span>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {p.supersedesPeriodId && <Badge tone="accent">Düzeltilmiş dönem</Badge>}
      </div>
      <p className="text-small text-muted">
        {CATEGORY_LABELS[p.template.category]} · {splitLabel(p.template.commonShareBps, p.template.commonKey)} · {formatDate(p.startDate)} –{' '}
        {formatDate(p.endDate)} · vade {formatDate(p.dueDate)}
      </p>
      <p className="text-small tabular-nums">
        {p.totalAmount !== undefined ? formatTRY(p.totalAmount) : <span className="text-warning">Tutar girilmedi</span>}
        {p.expenseIds.length > 0 && <span className="text-muted"> · {p.expenseIds.length} fatura bağlı</span>}
      </p>
    </div>
  );
}

/** Onceki takvim ayi: varsayilan donem araligi; vade bitisten 15 gun sonra. */
function defaultDates(today = todayIstanbul()) {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 2, 1));
  const end = new Date(Date.UTC(y, m - 1, 0));
  const due = new Date(Date.UTC(y, m - 1, 15));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const name = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(start);
  return { startDate: iso(start), endDate: iso(end), dueDate: iso(due), name: name.charAt(0).toLocaleUpperCase('tr-TR') + name.slice(1) };
}

const FIELDS = ['templateId', 'name', 'startDate', 'endDate', 'dueDate', 'amount', 'expenseIds'] as const;

export function PeriodDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (periodId: string) => void }) {
  const templates = useTemplates();
  const expenses = useExpenseOptions(open);
  const create = useCreatePeriod();
  const active = (templates.data ?? []).filter((t) => t.status === 'active');
  const defaults = (): PeriodForm => ({
    templateId: active.find((t) => t.isDefault)?.templateId ?? active[0]?.templateId ?? '',
    ...defaultDates(),
    source: 'expenses',
    amount: '',
    expenseIds: [],
  });
  const form = useForm<PeriodForm, unknown, PeriodValues>({ resolver: zodResolver(periodSchema), defaultValues: defaults() });
  const { errors } = form.formState;
  const source = form.watch('source');
  const selected = form.watch('expenseIds');
  const selectedTotal = (expenses.data ?? []).filter((e) => selected.includes(e.expenseId)).reduce((s, e) => s + e.amount, 0);

  useEffect(() => {
    if (!open) return;
    create.reset();
    form.reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);

  // Sablonlar pencere acildiktan sonra gelirse varsayilan sablon secilir (kullanicinin secimi ezilmez).
  const defaultTemplateId = active.find((t) => t.isDefault)?.templateId ?? active[0]?.templateId;
  useEffect(() => {
    if (open && defaultTemplateId && !form.getValues('templateId')) form.setValue('templateId', defaultTemplateId);
  }, [open, defaultTemplateId, form]);

  const toggle = (id: string) =>
    form.setValue('expenseIds', selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id], { shouldValidate: form.formState.isSubmitted });

  const submit = form.handleSubmit(async (v) => {
    try {
      const p = await create.mutateAsync(v);
      onClose();
      onCreated(p.periodId);
    } catch (err) {
      applyApiFieldError(err, form.setError, FIELDS, { totalAmount: 'amount' });
    }
  });

  // 409: secilen fatura baska bir donemde dagitilmis.
  const clash = create.error instanceof ApiError && create.error.status === 409 && typeof create.error.body?.expenseId === 'string' ? create.error.body : null;

  return (
    <Dialog open={open} onClose={() => !create.isPending && onClose()} title="Yeni dağıtım dönemi" className="max-w-xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {active.length === 0 && !templates.isPending && <Alert tone="danger">Önce “Şablonlar” sekmesinden bir dağıtım şablonu oluşturun.</Alert>}
        <FormField label="Dağıtım şablonu" error={errors.templateId?.message}>
          <Select {...form.register('templateId')}>
            <option value="">Seçin…</option>
            {active.map((t) => (
              <option key={t.templateId} value={t.templateId}>
                {t.name} — {splitLabel(t.commonShareBps, t.commonKey)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Dönem adı" error={errors.name?.message}>
          <Input {...form.register('name')} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Başlangıç" error={errors.startDate?.message}>
            <Input type="date" {...form.register('startDate')} />
          </FormField>
          <FormField label="Bitiş" error={errors.endDate?.message}>
            <Input type="date" {...form.register('endDate')} />
          </FormField>
          <FormField label="Son ödeme" error={errors.dueDate?.message}>
            <Input type="date" {...form.register('dueDate')} />
          </FormField>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-small font-medium">Dağıtılacak tutar</legend>
          <div className="flex flex-wrap gap-4 text-small">
            <label className="flex items-center gap-2">
              <input type="radio" value="expenses" {...form.register('source')} />
              Faturaları bağla (tutar fatura toplamı olur)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" value="amount" {...form.register('source')} />
              Tutarı elle gir
            </label>
          </div>
        </fieldset>

        {source === 'amount' ? (
          <FormField label="Toplam tutar (₺)" error={errors.amount?.message} hint="Boş bırakılabilir; hesaplamadan önce girilmelidir.">
            <Input inputMode="decimal" placeholder="125.000,00" {...form.register('amount')} />
          </FormField>
        ) : (
          <div className="flex flex-col gap-2">
            {expenses.isPending && <Skeleton className="h-16" />}
            {expenses.isError && <Alert tone="danger">{errorMessage(expenses.error)}</Alert>}
            {expenses.data?.length === 0 && <Alert>Kayıtlı gider (fatura) yok. Finans → Gider kaydı ekle ile faturayı girin veya tutarı elle girin.</Alert>}
            {!!expenses.data?.length && (
              <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-md border border-border" aria-label="Faturalar">
                {expenses.data.map((e) => {
                  const locked = !!e.lockedBy;
                  return (
                    <li key={e.expenseId}>
                      <label className={cn('flex items-center gap-3 px-3 py-2 text-small', locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-muted')}>
                        <input type="checkbox" disabled={locked} checked={selected.includes(e.expenseId)} onChange={() => toggle(e.expenseId)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            {e.description}
                            {e.hasInvoice && <FileText className="ml-1 inline size-3.5 text-muted" aria-label="Fatura dosyası var" />}
                          </span>
                          <span className="block text-muted">
                            {formatDate(e.date)}
                            {e.supplier ? ` · ${e.supplier}` : ''}
                            {e.invoiceNumber ? ` · No ${e.invoiceNumber}` : ''}
                            {locked ? ' · başka dönemde dağıtıldı' : ''}
                          </span>
                        </span>
                        <span className="tabular-nums">{formatTRY(e.amount)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {errors.expenseIds?.message && (
              <p role="alert" className="text-small text-danger">
                {errors.expenseIds.message}
              </p>
            )}
            {selected.length > 0 && (
              <p className="text-small">
                Seçilen {selected.length} fatura toplamı: <strong className="tabular-nums">{formatTRY(selectedTotal)}</strong>
              </p>
            )}
          </div>
        )}

        {clash ? (
          <Alert tone="danger">Seçilen faturalardan biri başka bir dönemde dağıtılmış. Listeyi yenileyip tekrar seçin.</Alert>
        ) : (
          create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={create.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={create.isPending} disabled={active.length === 0}>
            Dönemi aç
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
