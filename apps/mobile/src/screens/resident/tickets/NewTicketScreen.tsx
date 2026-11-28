import { unitChoicesFrom } from '@bm/shared/api/portal';
import { commonAreaSchema, newTicketTextSchema } from '@bm/shared/api/portalTickets';
import { type TicketCategory, categoriesForLocation, categoryLabelFor } from '@bm/shared/tickets/model';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { ArrowLeft, Building2, Check, Circle, House, Info } from '@/components/icons';
import { FilterChips } from '@/components/portal/FilterChips';
import { TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { PhotoPicker } from '@/components/tickets/PhotoPicker';
import { Alert, AppText, Button, Card, CardTitle, ListRow, Screen, Skeleton, TextField } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitProvider';
import { useMySummary } from '@/hooks/usePortal';
import { useCreateMyTicket, usePhotoUploader, useSimilarTickets } from '@/hooks/useTickets';
import { fieldErrors } from '@/lib/forms';
import { useIdempotencyKey } from '@/lib/idempotency';
import { type PreparedPhoto, photoErrorMessage, uploadPhotos } from '@/lib/photos';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Where = { kind: 'unit'; unitId: string; label: string } | { kind: 'common'; area: string };
const STEPS = ['Konum', 'Kategori', 'Açıklama'] as const;
const TITLE_HINT = "Kısa ve açık: örn. 'Banyo tavanından su damlıyor'";
const DESCRIPTION_HINT = 'Ne zamandan beri, nerede, ne gözlemlediniz?';
const AREA_HINT = 'Örn. B blok asansörü, otopark girişi';

/**
 * Adim adim yeni talep (web: pages/resident/tickets/NewTicketWizard.tsx): 1) daire ici (birden fazla
 * dairede secim) veya ortak alan, 2) kategori (ortak alanda benzer acik talep uyarisi), 3) baslik,
 * aciklama ve en fazla 6 fotograf (kamera / galeri). Oncelik sakin tarafindan secilmez. Gonderilince
 * talep ayrintisina gecilir.
 */
export function NewTicketScreen() {
  const router = useRouter();
  const create = useCreateMyTicket();
  const upload = usePhotoUploader();
  const [key] = useIdempotencyKey();
  const [step, setStep] = useState(0);
  const [where, setWhere] = useState<Where | null>(null);
  const [category, setCategory] = useState<TicketCategory | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Konum degisince (ortak alan -> daire ici) o konumda gecersiz kalan kategori secimi temizlenir.
  const changeWhere = (next: Where) => {
    setWhere(next);
    if (category && !categoriesForLocation(next.kind).includes(category)) setCategory(null);
  };

  const submit = async () => {
    if (!where || !category) return;
    const parsed = newTicketTextSchema.safeParse({ title, description });
    setErrors(fieldErrors(parsed));
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      const ids = await uploadPhotos(photos, upload);
      const r = await create.mutateAsync({
        idempotencyKey: key,
        title: parsed.data.title,
        description: parsed.data.description,
        category,
        location: where.kind === 'unit' ? { kind: 'unit', unitId: where.unitId } : { kind: 'common', area: where.area.trim() },
        ...(ids.length ? { photos: ids } : {}),
      });
      router.replace({ pathname: '/resident/tickets/[id]', params: { id: r.ticket.ticketId } });
    } catch (err) {
      setError(photoErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.steps} accessible accessibilityLabel={`Adım ${step + 1} / ${STEPS.length}: ${STEPS[step]}`}>
        {STEPS.map((s, i) => (
          <StepPill key={s} label={`${i + 1}. ${s}`} state={i === step ? 'current' : i < step ? 'done' : 'todo'} />
        ))}
      </View>

      {step === 0 && <LocationStep value={where} onChange={changeWhere} onNext={() => setStep(1)} />}
      {step === 1 && where && <CategoryStep where={where} value={category} onChange={setCategory} onNext={() => setStep(2)} />}
      {step === 2 && (
        <Card>
          <CardTitle>Sorunu anlatın</CardTitle>
          <View style={styles.field}>
            <TextField label="Başlık" value={title} onChangeText={setTitle} error={errors.title} accessibilityHint={errors.title ?? TITLE_HINT} maxLength={120} editable={!busy} />
            {!errors.title && (
              <AppText variant="small" tone="muted">
                {TITLE_HINT}
              </AppText>
            )}
          </View>
          <View style={styles.field}>
            <TextField
              label="Açıklama"
              value={description}
              onChangeText={setDescription}
              error={errors.description}
              accessibilityHint={errors.description ?? DESCRIPTION_HINT}
              maxLength={4000}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              editable={!busy}
            />
            {!errors.description && (
              <AppText variant="small" tone="muted">
                {DESCRIPTION_HINT}
              </AppText>
            )}
          </View>
          <PhotoPicker photos={photos} onChange={setPhotos} disabled={busy} />
          {error && <Alert tone="danger">{error}</Alert>}
          <Button label="Talebi gönder" block loading={busy} onPress={() => void submit()} />
        </Card>
      )}

      {step > 0 && <Button variant="ghost" icon={ArrowLeft} label="Geri" disabled={busy} onPress={() => setStep(step - 1)} />}
    </Screen>
  );
}

function StepPill({ label, state }: { label: string; state: 'current' | 'done' | 'todo' }) {
  const { colors } = useTheme();
  const color = state === 'current' ? colors.accent : state === 'done' ? colors.success : colors.muted;
  return (
    <View
      style={[
        styles.pill,
        { borderColor: state === 'todo' ? colors.border : withAlpha(color, 0.3), backgroundColor: state === 'current' ? withAlpha(colors.accent, 0.1) : 'transparent' },
      ]}
    >
      <AppText variant="caption" weight={state === 'current' ? 'semibold' : 'medium'} style={{ color }} numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
}

function LocationStep({ value, onChange, onNext }: { value: Where | null; onChange: (w: Where) => void; onNext: () => void }) {
  const summary = useMySummary();
  const { selectUnit } = usePortalUnit();
  const { colors } = useTheme();
  const choices = unitChoicesFrom(summary.error);
  const [area, setArea] = useState(value?.kind === 'common' ? value.area : '');
  const [error, setError] = useState<string>();
  const units = summary.data ? [{ unitId: summary.data.unitId, label: summary.data.unitLabel }] : (choices ?? []).map((c) => ({ unitId: c.unitId, label: c.label }));
  const common = value?.kind === 'common';
  const mark = (selected: boolean) => (selected ? <Check size={20} color={colors.accent} aria-hidden /> : <Circle size={20} color={colors.borderStrong} aria-hidden />);

  const next = () => {
    if (!value) {
      setError('Arızanın yerini seçin.');
      return;
    }
    if (value.kind === 'common') {
      const parsed = commonAreaSchema.safeParse(area);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message);
        return;
      }
    }
    setError(undefined);
    onNext();
  };

  return (
    <Card>
      <CardTitle>Arıza nerede?</CardTitle>
      {summary.isPending ? (
        <View accessible accessibilityRole="progressbar" accessibilityLabel="Daireleriniz yükleniyor">
          <Skeleton height={56} />
        </View>
      ) : (
        <View style={styles.field}>
          <View style={styles.choices}>
            {units.map((u) => {
              const selected = value?.kind === 'unit' && value.unitId === u.unitId;
              return (
                <ListRow
                  key={u.unitId}
                  icon={House}
                  title={`Daire içi · ${u.label}`}
                  subtitle="Dairenizdeki tesisat, ısınma, elektrik vb."
                  selected={selected}
                  trailing={mark(selected)}
                  onPress={() => {
                    onChange({ kind: 'unit', unitId: u.unitId, label: u.label });
                    setError(undefined);
                    if (choices) selectUnit(u.unitId);
                  }}
                />
              );
            })}
            <ListRow
              icon={Building2}
              title="Ortak alan"
              subtitle="Asansör, merdiven, otopark, bahçe vb."
              selected={common}
              trailing={mark(common)}
              onPress={() => {
                onChange({ kind: 'common', area });
                setError(undefined);
              }}
            />
          </View>
          {error && !common && <ChoiceError message={error} />}
        </View>
      )}
      {common && (
        <View style={styles.field}>
          <TextField
            label="Alan"
            value={area}
            onChangeText={(t) => {
              setArea(t);
              onChange({ kind: 'common', area: t });
            }}
            error={error}
            accessibilityHint={error ?? AREA_HINT}
            maxLength={80}
          />
          {!error && (
            <AppText variant="small" tone="muted">
              {AREA_HINT}
            </AppText>
          )}
        </View>
      )}
      <Button label="Devam" block onPress={next} />
    </Card>
  );
}

function CategoryStep({ where, value, onChange, onNext }: { where: Where; value: TicketCategory | null; onChange: (c: TicketCategory) => void; onNext: () => void }) {
  const { colors } = useTheme();
  const similar = useSimilarTickets(where.kind === 'common' ? value : null);
  const others = (similar.data ?? []).filter((s) => !s.mine);
  const [error, setError] = useState<string>();

  return (
    <Card>
      <CardTitle>Ne tür bir sorun?</CardTitle>
      <View style={styles.field}>
        <FilterChips
          label="Kategori"
          value={value ?? undefined}
          onChange={(c) => {
            onChange(c);
            setError(undefined);
          }}
          options={categoriesForLocation(where.kind).map((c) => ({ value: c, label: categoryLabelFor(c, where.kind) }))}
        />
        {error && <ChoiceError message={error} />}
      </View>
      {others.length > 0 && (
        <View accessibilityRole="summary" style={[styles.similar, { backgroundColor: withAlpha(colors.warning, 0.05), borderColor: withAlpha(colors.warning, 0.3) }]}>
          <View style={styles.similarHead}>
            <Info size={16} color={colors.warning} aria-hidden />
            <AppText variant="small" weight="medium" style={styles.flex}>
              Ortak alanda bu kategoride açık talep var
            </AppText>
          </View>
          {others.map((s) => (
            <View key={s.number} style={styles.similarRow}>
              <AppText variant="caption" style={styles.mono}>
                {s.number}
              </AppText>
              <AppText variant="caption" style={styles.flex}>
                {s.area}
              </AppText>
              <TicketStatusBadge status={s.status} />
            </View>
          ))}
          <AppText variant="caption" tone="muted">
            Aynı arızaysa yeniden bildirmenize gerek yok; yönetim takip ediyor. Farklı bir sorunsa devam edebilirsiniz.
          </AppText>
        </View>
      )}
      <Button
        label="Devam"
        block
        onPress={() => {
          if (!value) setError('Bir kategori seçin.');
          else onNext();
        }}
      />
    </Card>
  );
}

/** Secim grubunun hatasi, grubun altinda (TextField hatasiyla ayni yazim). */
function ChoiceError({ message }: { message: string }) {
  return (
    <AppText variant="small" tone="danger" accessibilityLiveRegion="polite">
      {message}
    </AppText>
  );
}

const styles = StyleSheet.create({
  steps: { flexDirection: 'row', gap: space(2) },
  pill: { flex: 1, alignItems: 'center', borderRadius: radii.full, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: space(2), paddingVertical: space(1) },
  choices: { gap: space(2) },
  field: { gap: space(1.5) },
  similar: { gap: space(2), borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(3) },
  similarHead: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  similarRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  flex: { flex: 1 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
