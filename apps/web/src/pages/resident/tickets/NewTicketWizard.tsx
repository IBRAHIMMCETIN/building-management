import { ArrowLeft, Building2, Home, Info } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { PhotoPicker, uploadPhotos } from '@/components/tickets/PhotoPicker';
import { TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { Alert, Button, Card, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useMySummary } from '@/hooks/usePortal';
import { useCreateMyTicket, useSimilarTickets } from '@/hooks/usePortalTickets';
import { errorMessage } from '@/lib/api/errors';
import { unitChoicesFrom } from '@/lib/api/portal';
import { portalTicketsApi } from '@/lib/api/portalTickets';
import { cn } from '@/lib/cn';
import { CATEGORY_LABELS, TICKET_CATEGORIES, type TicketCategory } from '@/lib/tickets/model';

type Where = { kind: 'unit'; unitId: string; label: string } | { kind: 'common'; area: string };
const STEPS = ['Konum', 'Kategori', 'Açıklama'] as const;

/** Sakinin secebilecegi kategoriler (API ile ayni liste). */
export const RESIDENT_CATEGORIES: readonly TicketCategory[] = TICKET_CATEGORIES;

/**
 * Adim adim yeni talep: 1) daire ici (birden fazla dairede secim) veya ortak alan, 2) kategori
 * (ortak alanda benzer acik talep uyarisi), 3) baslik, aciklama ve en fazla 6 fotograf.
 * Oncelik sakin tarafindan secilmez (yonetim belirler).
 */
export function NewTicketWizard() {
  const navigate = useNavigate();
  const create = useCreateMyTicket();
  const [key] = useIdempotencyKey();
  const [step, setStep] = useState(0);
  const [where, setWhere] = useState<Where | null>(null);
  const [category, setCategory] = useState<TicketCategory | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!where || !category) return;
    setBusy(true);
    setError(null);
    try {
      const photos = await uploadPhotos(files, (f) => portalTicketsApi.uploadPhoto(f));
      const r = await create.mutateAsync({
        idempotencyKey: key,
        title: title.trim(),
        description: description.trim(),
        category,
        location: where.kind === 'unit' ? { kind: 'unit', unitId: where.unitId } : { kind: 'common', area: where.area.trim() },
        ...(photos.length ? { photos } : {}),
      });
      navigate(`/app/talepler/${encodeURIComponent(r.ticket.ticketId)}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => (step === 0 ? navigate('/app/talepler') : setStep(step - 1))} className="inline-flex items-center gap-1 self-start text-small text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {step === 0 ? 'Taleplerim' : 'Geri'}
      </button>
      <h1 className="text-title font-bold">Yeni talep</h1>
      <ol className="flex gap-2 text-xs" aria-label="Adımlar">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} className={cn('flex-1 rounded-full border px-2 py-1 text-center', i === step ? 'border-accent bg-accent/10 font-semibold text-accent' : i < step ? 'border-success/30 text-success' : 'border-border text-muted')}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {step === 0 && <LocationStep value={where} onChange={setWhere} onNext={() => setStep(1)} />}
      {step === 1 && where && <CategoryStep where={where} value={category} onChange={setCategory} onNext={() => setStep(2)} />}
      {step === 2 && (
        <Card className="flex flex-col gap-4">
          <FormField label="Başlık" hint="Kısa ve açık: örn. 'Banyo tavanından su damlıyor'">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </FormField>
          <FormField label="Açıklama" hint="Ne zamandan beri, nerede, ne gözlemlediniz?">
            <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
          </FormField>
          <PhotoPicker files={files} onChange={setFiles} disabled={busy} />
          {error && <Alert tone="danger">{error}</Alert>}
          <Button loading={busy} disabled={title.trim().length < 3 || !description.trim()} onClick={() => void submit()}>
            Talebi gönder
          </Button>
        </Card>
      )}
    </div>
  );
}

function LocationStep({ value, onChange, onNext }: { value: Where | null; onChange: (w: Where) => void; onNext: () => void }) {
  const summary = useMySummary();
  const { selectUnit } = usePortalUnit();
  const choices = unitChoicesFrom(summary.error);
  const [area, setArea] = useState(value?.kind === 'common' ? value.area : '');
  const units = summary.data ? [{ unitId: summary.data.unitId, label: summary.data.unitLabel }] : (choices ?? []).map((c) => ({ unitId: c.unitId, label: c.label }));
  const common = value?.kind === 'common';

  return (
    <Card className="flex flex-col gap-4">
      <h2 className="font-semibold">Arıza nerede?</h2>
      {summary.isPending ? (
        <Skeleton className="h-14" />
      ) : (
        <ul className="flex flex-col gap-2">
          {units.map((u) => (
            <li key={u.unitId}>
              <Choice
                selected={value?.kind === 'unit' && value.unitId === u.unitId}
                onClick={() => {
                  onChange({ kind: 'unit', unitId: u.unitId, label: u.label });
                  if (choices) selectUnit(u.unitId);
                }}
                icon={<Home className="size-5 text-accent" aria-hidden="true" />}
                title={`Daire içi · ${u.label}`}
                detail="Dairenizdeki tesisat, ısınma, elektrik vb."
              />
            </li>
          ))}
          <li>
            <Choice selected={common} onClick={() => onChange({ kind: 'common', area })} icon={<Building2 className="size-5 text-accent" aria-hidden="true" />} title="Ortak alan" detail="Asansör, merdiven, otopark, bahçe vb." />
          </li>
        </ul>
      )}
      {common && (
        <FormField label="Alan" hint="Örn. B blok asansörü, otopark girişi">
          <Input
            value={area}
            onChange={(e) => {
              setArea(e.target.value);
              onChange({ kind: 'common', area: e.target.value });
            }}
            maxLength={80}
          />
        </FormField>
      )}
      <Button disabled={!value || (value.kind === 'common' && value.area.trim().length < 2)} onClick={onNext}>
        Devam
      </Button>
    </Card>
  );
}

function CategoryStep({ where, value, onChange, onNext }: { where: Where; value: TicketCategory | null; onChange: (c: TicketCategory) => void; onNext: () => void }) {
  const similar = useSimilarTickets(where.kind === 'common' ? value : null);
  const others = (similar.data ?? []).filter((s) => !s.mine);
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="font-semibold">Ne tür bir sorun?</h2>
      <div role="radiogroup" aria-label="Kategori" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {RESIDENT_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value === c}
            onClick={() => onChange(c)}
            className={cn('min-h-12 rounded-lg border px-3 py-2 text-small font-medium', value === c ? 'border-accent bg-accent/10 text-accent' : 'border-border-strong hover:bg-surface-muted')}
          >
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      {others.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-small" role="status">
          <p className="flex items-center gap-2 font-medium">
            <Info className="size-4 text-warning" aria-hidden="true" />
            Ortak alanda bu kategoride açık talep var
          </p>
          <ul className="flex flex-col gap-1 text-xs">
            {others.map((s) => (
              <li key={s.number} className="flex items-center gap-2">
                <span className="font-mono">{s.number}</span>
                <span className="flex-1">{s.area}</span>
                <TicketStatusBadge status={s.status} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">Aynı arızaysa yeniden bildirmenize gerek yok; yönetim takip ediyor. Farklı bir sorunsa devam edebilirsiniz.</p>
        </div>
      )}
      <Button disabled={!value} onClick={onNext}>
        Devam
      </Button>
    </Card>
  );
}

function Choice({ selected, onClick, icon, title, detail }: { selected: boolean; onClick: () => void; icon: ReactNode; title: string; detail: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn('flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left', selected ? 'border-accent bg-accent/5' : 'border-border hover:border-border-strong')}
    >
      {icon}
      <span className="flex flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted">{detail}</span>
      </span>
    </button>
  );
}
