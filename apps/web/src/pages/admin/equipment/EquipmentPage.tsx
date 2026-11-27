import { Plus, Search, Tag } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Badge, Button, Card, FilterChips, Input, Skeleton } from '@/components/ui';
import { useEquipmentExpiring, useEquipmentList, useEquipmentPermissions } from '@/hooks/useEquipment';
import { useBlocks } from '@/hooks/useUnits';
import type { Equipment, EquipmentListQuery, ExpiryItem } from '@/lib/api/equipment';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { EQUIPMENT_CATEGORIES, EQUIPMENT_CATEGORY_LABELS, equipmentLocationText } from '@/lib/equipment/model';
import { FilterSelect } from '../tickets/TicketBoard';
import { EquipmentDetailPanel } from './EquipmentDetailPanel';
import { EquipmentDialog } from './EquipmentDialog';
import { EquipmentStatusBadge, ExpiryBadge } from './shared';

const PAGE = 100;
const EXPIRY_PREVIEW = 8;

type StatusFilter = 'in_service' | 'active' | 'out_of_service' | 'retired' | 'all';
const STATUS_FILTERS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'in_service', label: 'Hizmette' },
  { value: 'active', label: 'Çalışıyor' },
  { value: 'out_of_service', label: 'Devre dışı' },
  { value: 'retired', label: 'Hizmetten çıkan' },
  { value: 'all', label: 'Tümü' },
];
const WARRANTY_FILTERS = [
  { value: '30', label: '30 gün içinde' },
  { value: '90', label: '90 gün içinde' },
  { value: '365', label: '1 yıl içinde' },
];

/**
 * Ariza & bakim v2 "Ekipman": asansor, jenerator, hidrofor gibi ekipmanin sicili, garanti / servis
 * sozlesmesi / periyodik kontrol hatirlatmalari, belgeler ve gecmis. Ayrinti `?equipment=<id>` ile
 * acilir (paylasilabilir, geri tusu calisir). Yonetim yazar; denetci ve bina gorevlisi okur.
 */
export function EquipmentPage() {
  const { canRead, canWrite } = useEquipmentPermissions();
  const [params, setParams] = useSearchParams();
  const blocks = useBlocks();
  const [editor, setEditor] = useState<{ equipment?: Equipment } | null>(null);
  const activeBlocks = (blocks.data ?? []).filter((b) => b.status === 'active');
  const blockName = (id: string) => (blocks.data ?? []).find((b) => b.blockId === id)?.name;
  const selected = params.get('equipment');

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Ekipman</h1>
        <Alert>Bu rol ekipman sicilini görüntüleyemez.</Alert>
      </div>
    );
  }

  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('equipment', id);
    else next.delete('equipment');
    setParams(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Ekipman</h1>
          <p className="text-small text-muted">Ekipman sicili, garanti ve servis sözleşmesi tarihleri, periyodik kontroller, belgeler ve arıza / bakım geçmişi.</p>
        </div>
        {canWrite && (
          <Button onClick={() => setEditor({})}>
            <Plus className="size-4" aria-hidden="true" />
            Yeni ekipman
          </Button>
        )}
      </div>

      <ExpiringPanel onOpen={open} />
      <EquipmentList canWrite={canWrite} blocks={activeBlocks} blockName={blockName} onOpen={open} onCreate={() => setEditor({})} />

      <EquipmentDetailPanel equipmentId={selected} onClose={() => open(null)} onEdit={(e) => setEditor({ equipment: e })} blockName={blockName} />
      {canWrite && <EquipmentDialog open={editor !== null} onClose={() => setEditor(null)} equipment={editor?.equipment} blocks={activeBlocks} onSaved={(id) => !editor?.equipment && open(id)} />}
    </div>
  );
}

/** Onumuzdeki 30 gun icinde dolacak ve dolmus tarihler (gunluk ozetle ayni kalemler). */
function ExpiringPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const expiring = useEquipmentExpiring();
  const [all, setAll] = useState(false);
  if (expiring.isPending) return <Skeleton className="h-24" />;
  if (expiring.isError) return <Alert tone="danger">{errorMessage(expiring.error)}</Alert>;
  const items = expiring.data;
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, EXPIRY_PREVIEW);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="equipment-expiring">
      <div className="flex items-center gap-2">
        <h2 id="equipment-expiring" className="text-small font-semibold">
          Yaklaşan ve dolan tarihler
        </h2>
        <Badge tone="warning">{items.length}</Badge>
      </div>
      <p className="text-small text-muted">Garanti, servis sözleşmesi ve periyodik kontrol tarihleri 30 gün kala burada ve günlük özet e-postasında görünür.</p>
      <ul className="flex flex-col gap-2">
        {shown.map((i) => (
          <li key={`${i.equipmentId}-${i.kind}`}>
            <ExpiryRow item={i} onOpen={onOpen} />
          </li>
        ))}
      </ul>
      {items.length > EXPIRY_PREVIEW && (
        <Button size="xs" variant="subtle" className="self-start" onClick={() => setAll(!all)}>
          {all ? 'Daha az göster' : `${items.length - EXPIRY_PREVIEW} kalem daha`}
        </Button>
      )}
    </section>
  );
}

function ExpiryRow({ item, onOpen }: { item: ExpiryItem; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item.equipmentId)}
      className={cn(
        'flex w-full flex-col gap-1 rounded-xl border bg-surface p-3 text-left text-small shadow-xs hover:border-border-strong',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        item.expired ? 'border-danger/40' : 'border-border',
      )}
    >
      <span className="font-medium">{item.name}</span>
      <span>
        <ExpiryBadge item={item} />
      </span>
    </button>
  );
}

function EquipmentList({
  canWrite,
  blocks,
  blockName,
  onOpen,
  onCreate,
}: {
  canWrite: boolean;
  blocks: { blockId: string; name: string }[];
  blockName: (id: string) => string | undefined;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [q, setQ] = useState<EquipmentListQuery>({ limit: PAGE });
  const [status, setStatus] = useState<StatusFilter>('in_service');
  const [term, setTerm] = useState('');
  const list = useEquipmentList({ ...q, ...(status === 'in_service' ? {} : { status }) });
  const set = (patch: Partial<EquipmentListQuery>) => setQ({ ...q, ...patch, cursor: undefined });
  const filtered = status !== 'in_service' || !!(q.q || q.category || q.blockId || q.warrantyWithin || q.expiring);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <form
          className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted"
          onSubmit={(ev) => {
            ev.preventDefault();
            set({ q: term.trim() || undefined });
          }}
        >
          <label htmlFor="equipment-search">Ara (ad, marka, model, seri no)</label>
          <div className="relative">
            <Input id="equipment-search" value={term} onChange={(ev) => setTerm(ev.target.value)} placeholder="Asansör, SN-1001…" className="pl-9" />
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          </div>
        </form>
        <FilterSelect label="Kategori" value={q.category ?? ''} onChange={(v) => set({ category: v || undefined })} options={EQUIPMENT_CATEGORIES.map((c) => ({ value: c, label: EQUIPMENT_CATEGORY_LABELS[c] }))} />
        {blocks.length > 1 && <FilterSelect label="Blok" value={q.blockId ?? ''} onChange={(v) => set({ blockId: v || undefined })} options={blocks.map((b) => ({ value: b.blockId, label: b.name }))} />}
        <FilterSelect label="Garanti bitişi" value={q.warrantyWithin ?? ''} onChange={(v) => set({ warrantyWithin: v || undefined })} options={WARRANTY_FILTERS} />
        <label className="flex h-10 items-center gap-2 text-small">
          <input type="checkbox" checked={q.expiring === 'true'} onChange={(ev) => set({ expiring: ev.target.checked ? 'true' : undefined })} className="size-4 accent-accent" />
          Hatırlatması olanlar
        </label>
      </div>
      <FilterChips
        label="Ekipman durumu"
        value={status}
        onChange={(v) => {
          setStatus(v);
          setQ({ ...q, cursor: undefined });
        }}
        options={STATUS_FILTERS}
      />

      {list.isPending ? (
        <Skeleton className="h-48" />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : list.data.items.length === 0 ? (
        filtered ? (
          <p className="py-8 text-center text-small text-muted">Bu filtrelere uyan ekipman yok.</p>
        ) : (
          <Card className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
              <Tag className="size-6" aria-hidden="true" />
            </div>
            <p className="font-semibold">Henüz ekipman kaydı yok</p>
            <p className="max-w-content text-small text-muted">Asansör, jeneratör, hidrofor, kazan gibi ekipmanı seri no, garanti ve servis firmasıyla kaydedin; tarihler yaklaşınca hatırlatılır, arıza ve bakımlar ekipmanın geçmişinde toplanır.</p>
            {canWrite && (
              <Button variant="secondary" onClick={onCreate}>
                İlk ekipmanı kaydedin
              </Button>
            )}
          </Card>
        )
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-small">
            <caption className="sr-only">Ekipman ({list.data.total})</caption>
            <thead className="border-b border-border bg-surface-muted/50 text-xs tracking-wide text-muted uppercase">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Ad</th>
                <th scope="col" className="px-3 py-2 font-medium">Kategori</th>
                <th scope="col" className="px-3 py-2 font-medium">Konum</th>
                <th scope="col" className="px-3 py-2 font-medium">Marka / model</th>
                <th scope="col" className="px-3 py-2 font-medium">Seri no</th>
                <th scope="col" className="px-3 py-2 font-medium">Garanti bitişi</th>
                <th scope="col" className="px-3 py-2 font-medium">Durum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.data.items.map((e) => (
                <tr key={e.equipmentId} className="cursor-pointer hover:bg-surface-muted/40" onClick={() => onOpen(e.equipmentId)}>
                  <td className="max-w-64 px-3 py-2">
                    <button type="button" className="truncate font-medium underline-offset-2 hover:underline" onClick={() => onOpen(e.equipmentId)}>
                      {e.name}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-muted">{EQUIPMENT_CATEGORY_LABELS[e.category]}</td>
                  <td className="px-3 py-2 text-muted">{equipmentLocationText(e, blockName)}</td>
                  <td className="px-3 py-2 text-muted">{[e.brand, e.model].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.serialNumber ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{e.warrantyEndDate ? formatDate(e.warrantyEndDate) : '—'}</td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <EquipmentStatusBadge status={e.status} />
                      {e.expiry.length > 0 && <Badge tone={e.expiry.some((x) => x.expired) ? 'danger' : 'warning'}>{e.expiry.length} tarih</Badge>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.items.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted">
          <span>Toplam {list.data.total} ekipman</span>
          <span className="flex gap-2">
            {q.cursor && (
              <Button size="sm" variant="secondary" onClick={() => setQ({ ...q, cursor: String(Math.max(Number(q.cursor) - PAGE, 0)) || undefined })}>
                Önceki
              </Button>
            )}
            {list.data.nextCursor && (
              <Button size="sm" variant="secondary" onClick={() => setQ({ ...q, cursor: list.data.nextCursor })}>
                Sonraki
              </Button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
