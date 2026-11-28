import { ChevronDown, House } from '@/components/icons';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText, Button, ListRow } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitProvider';
import { useActiveResidentContext } from '@/hooks/useContexts';
import { MIN_TOUCH, radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

export const RELATION_LABELS = { owner: 'Malik', tenant: 'Kiracı' } as const;

export type UnitOption = { unitId: string; label: string; relationLabel: string };

/** Aktif sakin baglaminin daireleri: "Daire 12" + "Kiracı". */
export function useUnitOptions(): UnitOption[] {
  const ctx = useActiveResidentContext();
  return (ctx?.units ?? []).map((u) => ({
    unitId: u.unitId,
    label: u.unitNumber ? `Daire ${u.unitNumber}` : u.unitId,
    relationLabel: RELATION_LABELS[u.relation],
  }));
}

/**
 * Ust cubuk daire secici (web: PortalUnitContext + "Daire değiştir"). Yalnizca birden fazla dairesi
 * olan sakinde gorunur; secim kullanici + apartman bazinda saklanir, API her istekte dogrular.
 */
export function UnitPicker() {
  const options = useUnitOptions();
  const { unitId, selectUnit } = usePortalUnit();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);

  if (options.length < 2) return null;
  const current = options.find((o) => o.unitId === unitId);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={current ? `Seçili daire: ${current.label}. Daire değiştir` : 'Daire seçin'}
        onPress={() => setOpen(true)}
        // Gorunen yukseklik 36 pt; dokunma alani 44 pt'ye tamamlanir.
        hitSlop={{ top: 4, bottom: 4 }}
        style={({ pressed }) => [styles.trigger, { borderColor: colors.borderStrong, backgroundColor: pressed ? colors.surfaceMuted : colors.surface }]}
      >
        <House size={16} color={colors.accent} aria-hidden />
        <AppText variant="small" weight="medium" numberOfLines={1}>
          {current?.label ?? 'Daire seçin'}
        </AppText>
        <ChevronDown size={16} color={colors.muted} aria-hidden />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Kapat" style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={() => setOpen(false)}>
          <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
            <Pressable style={[styles.sheet, { backgroundColor: colors.bg }]} onPress={(e) => e.stopPropagation()}>
              <AppText variant="heading" weight="semibold" accessibilityRole="header">
                Daire seçin
              </AppText>
              <AppText variant="small" tone="muted">
                Bu apartmanda birden fazla daireniz var. Hangisinin hesabını görmek istersiniz?
              </AppText>
              <View style={styles.list}>
                {options.map((o) => (
                  <ListRow
                    key={o.unitId}
                    icon={House}
                    title={o.label}
                    subtitle={o.relationLabel}
                    selected={o.unitId === unitId}
                    onPress={() => {
                      selectUnit(o.unitId);
                      setOpen(false);
                    }}
                  />
                ))}
              </View>
              <Button variant="ghost" label="Vazgeç" onPress={() => setOpen(false)} />
            </Pressable>
          </SafeAreaView>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    minHeight: MIN_TOUCH - 8,
    minWidth: MIN_TOUCH,
    maxWidth: 160,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    paddingHorizontal: space(3),
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    marginRight: space(3),
  },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, padding: space(4), gap: space(3) },
  list: { gap: space(2) },
});
