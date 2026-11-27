import { Archive, CalendarClock, Pencil, Plus, Scale, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useArchiveMaintenanceTemplate, useCreateMaintenanceTemplate, useMaintenancePresets, useMaintenanceTemplates, useUpdateMaintenanceTemplate } from '@/hooks/useMaintenance';
import { useEquipmentNames } from '@/hooks/useEquipment';
import { useTicketPermissions } from '@/hooks/useTickets';
import { errorMessage } from '@/lib/api/errors';
import type { MaintenancePreset, MaintenanceTemplate, TemplateInput } from '@/lib/api/maintenance';
import { formatDate } from '@/lib/dates';
import { MAX_KURUS, formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';
import { SCHEDULE_UNITS, type ScheduleUnit, istanbulToday, scheduleText } from '@/lib/maintenance/schedule';
import { CATEGORY_LABELS, TICKET_CATEGORIES, type TicketCategory } from '@/lib/tickets/model';
import { EquipmentSelect } from './EquipmentSelect';
import { useTicketLabels } from './shared';

const UNIT_LABELS: Record<ScheduleUnit, string> = { week: 'hafta', month: 'ay', year: 'yıl' };

/** Periyodik bakim sablonlari: hazir sablondan olusturma, duzenleme, arsivleme (yonetim; denetci ve gorevli okur). */
export function MaintenanceTemplatesPanel({ onOpenTask: _onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const p = useTicketPermissions();
  const labels = useTicketLabels();
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const templates = useMaintenanceTemplates(status);
  const archive = useArchiveMaintenanceTemplate();
  const [editing, setEditing] = useState<MaintenanceTemplate | 'new' | null>(null);
  const equipmentName = useEquipmentNames((templates.data ?? []).map((t) => t.equipmentId));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterChips label="Şablon durumu" value={status} onChange={setStatus} options={[{ value: 'active', label: 'Aktif' }, { value: 'archived', label: 'Arşiv' }]} />
        {p.canManage && (
          <Button size="sm" className="ml-auto" onClick={() => setEditing('new')}>
            <Plus className="size-4" aria-hidden="true" />
            Yeni bakım şablonu
          </Button>
        )}
      </div>
      {archive.isError && <Alert tone="danger">{errorMessage(archive.error)}</Alert>}
      {templates.isPending ? (
        <Skeleton className="h-40" />
      ) : templates.isError ? (
        <Alert tone="danger">{errorMessage(templates.error)}</Alert>
      ) : templates.data.length === 0 ? (
        <p className="py-8 text-center text-small text-muted">{status === 'active' ? 'Henüz bakım şablonu yok. Asansör, hidrofor, jeneratör gibi hazır şablonlardan başlayabilirsiniz.' : 'Arşivlenmiş şablon yok.'}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.data.map((t) => (
            <Card key={t.templateId} className="flex flex-col gap-2 p-4 md:p-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold">{t.name}</h3>
                  <p className="text-xs text-muted">
                    {CATEGORY_LABELS[t.category]}
                    {t.asset ? ` · ${t.asset}` : ''}
                    {t.equipmentId && equipmentName(t.equipmentId) !== t.asset ? ` · ekipman: ${equipmentName(t.equipmentId) ?? 'Ekipman kaydı'}` : ''}
                  </p>
                </div>
                <Badge tone="accent">
                  <CalendarClock className="size-3" aria-hidden="true" />
                  {scheduleText(t.schedule)}
                </Badge>
              </div>
              <p className="text-xs text-muted">
                Başlangıç {formatDate(t.schedule.startDate)} · {t.checklist.length} kontrol maddesi · {t.leadDays} gün önceden hazırlanır
                {t.defaultAssigneeId ? ` · ${labels.nameOf(t.defaultAssigneeId) ?? 'görevli'}` : ''}
                {t.expectedCost ? ` · tahmini ${formatTRY(t.expectedCost)}` : ''}
              </p>
              {t.legalNote && (
                <p className="flex gap-1.5 text-xs text-text-secondary">
                  <Scale className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {t.legalNote}
                </p>
              )}
              {p.canManage && t.status === 'active' && (
                <div className="mt-1 flex gap-2">
                  <Button size="xs" variant="subtle" onClick={() => setEditing(t)}>
                    <Pencil className="size-3.5" aria-hidden="true" />
                    Düzenle
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    loading={archive.isPending && archive.variables?.id === t.templateId}
                    onClick={() => {
                      if (window.confirm(`"${t.name}" arşivlensin mi? Başlamamış gelecek görevleri iptal edilir.`)) archive.mutate({ id: t.templateId, version: t.version });
                    }}
                  >
                    <Archive className="size-3.5" aria-hidden="true" />
                    Arşivle
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {editing && <TemplateDialog template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

type CheckRow = { text: string; required: boolean };

export function presetDefaults(preset: MaintenancePreset | undefined) {
  return {
    name: preset?.name ?? '',
    category: (preset?.category ?? 'other') as TicketCategory,
    every: preset?.every ?? 1,
    unit: (preset?.unit ?? 'month') as ScheduleUnit,
    checklist: (preset?.checklist ?? []).map((text) => ({ text, required: true })),
    expenseAccountId: preset?.expenseAccountId ?? '',
    legalNote: preset?.legalNote ?? '',
  };
}

function TemplateDialog({ template, onClose }: { template: MaintenanceTemplate | null; onClose: () => void }) {
  const presets = useMaintenancePresets();
  const labels = useTicketLabels();
  const expenseAccounts = useFinanceAccounts('expense');
  const payables = useFinanceAccounts('payable');
  const create = useCreateMaintenanceTemplate();
  const update = useUpdateMaintenanceTemplate();
  const [preset, setPreset] = useState('');
  const [name, setName] = useState(template?.name ?? '');
  const [category, setCategory] = useState<TicketCategory>(template?.category ?? 'other');
  const [asset, setAsset] = useState(template?.asset ?? '');
  const [equipmentId, setEquipmentId] = useState(template?.equipmentId ?? '');
  const [every, setEvery] = useState(String(template?.schedule.every ?? 1));
  const [unit, setUnit] = useState<ScheduleUnit>(template?.schedule.unit ?? 'month');
  const [startDate, setStartDate] = useState(template?.schedule.startDate ?? istanbulToday());
  const [checklist, setChecklist] = useState<CheckRow[]>(template?.checklist.map((c) => ({ text: c.text, required: c.required })) ?? []);
  const [assignee, setAssignee] = useState(template?.defaultAssigneeId ?? '');
  const [expenseAccountId, setExpenseAccountId] = useState(template?.expenseAccountId ?? '');
  const [supplierAccountId, setSupplierAccountId] = useState(template?.supplierAccountId ?? '');
  const [expectedCost, setExpectedCost] = useState(template?.expectedCost ? kurusToInput(template.expectedCost) : '');
  const [leadDays, setLeadDays] = useState(String(template?.leadDays ?? 7));
  const [legalNote, setLegalNote] = useState(template?.legalNote ?? '');
  const mutation = template ? update : create;

  const applyPreset = (id: string) => {
    setPreset(id);
    const d = presetDefaults(presets.data?.find((x) => x.preset === id));
    if (!id) return;
    setName(d.name);
    setCategory(d.category);
    setEvery(String(d.every));
    setUnit(d.unit);
    setChecklist(d.checklist);
    setExpenseAccountId(d.expenseAccountId);
    setLegalNote(d.legalNote);
  };

  const cost = expectedCost.trim() ? parseTRYToKurus(expectedCost) : null;
  const n = Number(every);
  const lead = Number(leadDays);
  const valid =
    name.trim().length >= 3 &&
    Number.isInteger(n) && n >= 1 && n <= 52 &&
    Number.isInteger(lead) && lead >= 0 && lead <= 60 &&
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
    (!expectedCost.trim() || (cost !== null && cost <= MAX_KURUS)) &&
    checklist.every((c) => c.text.trim().length >= 2);

  const submit = () => {
    const input: TemplateInput = {
      ...(preset && !template ? { preset } : {}),
      name: name.trim(),
      category,
      asset: asset.trim() || null,
      equipmentId: equipmentId || null,
      schedule: { every: n, unit, startDate },
      checklist: checklist.map((c) => ({ text: c.text.trim(), required: c.required })),
      defaultAssigneeId: assignee || null,
      expenseAccountId: expenseAccountId || null,
      supplierAccountId: supplierAccountId || null,
      expectedCost: cost,
      legalNote: legalNote.trim() || null,
      leadDays: lead,
    };
    if (template) update.mutate({ id: template.templateId, input: { ...input, version: template.version } }, { onSuccess: onClose });
    else create.mutate(stripNulls(input), { onSuccess: onClose });
  };

  return (
    <Dialog open onClose={onClose} title={template ? 'Bakım şablonunu düzenle' : 'Yeni bakım şablonu'} variant="wide">
      <div className="grid gap-4 sm:grid-cols-2">
        {!template && (
          <div className="sm:col-span-2">
            <FormField label="Hazır şablon" hint="Seçince alanlar doldurulur; dilediğiniz gibi değiştirebilirsiniz.">
              <Select value={preset} onChange={(e) => applyPreset(e.target.value)}>
                <option value="">Özel (boş)</option>
                {(presets.data ?? []).map((x) => (
                  <option key={x.preset} value={x.preset}>
                    {x.name} · {scheduleText(x)}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        )}
        <FormField label="Ad">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </FormField>
        <FormField label="Ekipman / yer (isteğe bağlı)" hint="Örn. B Blok asansörü">
          <Input value={asset} onChange={(e) => setAsset(e.target.value)} maxLength={80} />
        </FormField>
        <div className="sm:col-span-2">
          <EquipmentSelect label="Ekipman kaydı (isteğe bağlı)" hint="Görevler ve görevden açılan arızalar ekipmanın geçmişinde görünür." value={equipmentId} onChange={(id) => setEquipmentId(id)} />
        </div>
        <FormField label="Kategori" hint="Görevden açılan arızanın kategorisi.">
          <Select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="İlk tarih">
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </FormField>
        <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
          <legend className="text-small font-medium">Sıklık</legend>
          <div className="flex items-center gap-2 text-small">
            <Input type="number" min={1} max={52} value={every} onChange={(e) => setEvery(e.target.value)} className="w-20" aria-label="Kaç birimde bir" />
            <Select value={unit} onChange={(e) => setUnit(e.target.value as ScheduleUnit)} aria-label="Birim">
              {SCHEDULE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u]}
                </option>
              ))}
            </Select>
            <span className="text-muted">da bir</span>
          </div>
          {template && <p className="text-xs text-muted">Takvim değişirse başlamamış gelecek görevler yeni takvime uyarlanır; başlamış ve tamamlanmış görevler değişmez.</p>}
        </fieldset>

        <fieldset className="flex flex-col gap-2 sm:col-span-2">
          <legend className="text-small font-medium">Kontrol listesi</legend>
          {checklist.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={c.text} onChange={(e) => setChecklist(checklist.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} maxLength={200} aria-label={`Madde ${i + 1}`} />
              <label className="flex shrink-0 items-center gap-1.5 text-xs">
                <input type="checkbox" checked={c.required} onChange={(e) => setChecklist(checklist.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} className="accent-accent" />
                Zorunlu
              </label>
              <Button size="xs" variant="subtle" aria-label={`Madde ${i + 1} sil`} onClick={() => setChecklist(checklist.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button size="xs" variant="secondary" className="self-start" disabled={checklist.length >= 30} onClick={() => setChecklist([...checklist, { text: '', required: true }])}>
            <Plus className="size-3.5" aria-hidden="true" />
            Madde ekle
          </Button>
        </fieldset>

        <FormField label="Varsayılan görevli">
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Atanmamış (havuz)</option>
            {labels.assignees.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Kaç gün önceden" hint="Görev bu kadar gün önce oluşur ve 'yaklaşan' sayılır (0-60).">
          <Input type="number" min={0} max={60} value={leadDays} onChange={(e) => setLeadDays(e.target.value)} />
        </FormField>
        <FormField label="Gider hesabı (masraf formu)">
          <Select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}>
            <option value="">Kategoriye göre öner</option>
            {(expenseAccounts.data ?? []).map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Tedarikçi carisi (isteğe bağlı)">
          <Select value={supplierAccountId} onChange={(e) => setSupplierAccountId(e.target.value)}>
            <option value="">—</option>
            {(payables.data ?? []).map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Tahmini maliyet (TL, isteğe bağlı)">
          <Input inputMode="decimal" value={expectedCost} onChange={(e) => setExpectedCost(e.target.value)} />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Mevzuat notu (isteğe bağlı)" hint="Bilgi amaçlıdır; uygulama yasal yükümlülük hesaplamaz.">
            <Textarea rows={2} value={legalNote} onChange={(e) => setLegalNote(e.target.value)} maxLength={500} />
          </FormField>
        </div>
      </div>
      {mutation.isError && (
        <div className="mt-4">
          <Alert tone="danger">{errorMessage(mutation.error)}</Alert>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Vazgeç
        </Button>
        <Button loading={mutation.isPending} disabled={!valid} onClick={submit}>
          {template ? 'Kaydet' : 'Oluştur'}
        </Button>
      </div>
    </Dialog>
  );
}

/** Yeni sablonda bos alanlar gonderilmez (null yalnizca duzenlemede "kaldir" anlamindadir). */
function stripNulls(input: TemplateInput): TemplateInput {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null)) as TemplateInput;
}
