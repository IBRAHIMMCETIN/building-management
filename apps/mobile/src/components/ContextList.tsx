import type { SelectableContext } from '@bm/shared/auth/contextsSchema';
import type { ActiveContext } from '@bm/shared/auth/session';
import { ROLE_LABELS } from '@bm/shared/roles';
import { Building2, Check } from '@/components/icons';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { AppText, ListRow } from '@/components/ui';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { RELATION_LABELS } from './portal/UnitPicker';

/** "Kiracı · Daire 12", birden fazla dairede "Malik · Daire 3, 4" (web: components/context/ContextList.tsx). */
export function describeContext(ctx: SelectableContext): string {
  if (ctx.role !== 'resident' || !ctx.units?.length) return ROLE_LABELS[ctx.role];
  const relations = [...new Set(ctx.units.map((u) => RELATION_LABELS[u.relation]))].join(' / ');
  const numbers = ctx.units.map((u) => u.unitNumber).filter(Boolean);
  return numbers.length ? `${relations} · Daire ${numbers.join(', ')}` : relations;
}

type Props = {
  contexts: SelectableContext[];
  active?: { apartmentId?: string; role?: string } | null;
  pending?: ActiveContext | null;
  disabled?: boolean;
  onSelect: (context: ActiveContext) => void;
};

/** Baglamlari apartmana gore gruplar; her rol ayri secilebilir satirdir. */
export function ContextList({ contexts, active, pending, disabled, onSelect }: Props) {
  const { colors } = useTheme();
  const groups = new Map<string, { name: string; items: SelectableContext[] }>();
  for (const ctx of contexts) {
    const group = groups.get(ctx.apartmentId) ?? { name: ctx.apartmentName, items: [] };
    group.items.push(ctx);
    groups.set(ctx.apartmentId, group);
  }

  return (
    <View style={styles.groups}>
      {[...groups].map(([apartmentId, group]) => (
        <View key={apartmentId} style={styles.group}>
          <View style={styles.groupTitle}>
            <Building2 size={16} color={colors.muted} aria-hidden />
            <AppText variant="small" weight="semibold" tone="muted" accessibilityRole="header">
              {group.name}
            </AppText>
          </View>
          {group.items.map((ctx) => {
            const isActive = active?.apartmentId === ctx.apartmentId && active.role === ctx.role;
            const isPending = pending?.apartmentId === ctx.apartmentId && pending.role === ctx.role;
            return (
              <ListRow
                key={ctx.role}
                title={ROLE_LABELS[ctx.role]}
                subtitle={ctx.role === 'resident' ? describeContext(ctx) : undefined}
                selected={isActive}
                disabled={disabled || isActive}
                accessibilityHint={isActive ? 'Aktif bağlam' : `${group.name} için bu rolle devam et`}
                onPress={() => onSelect({ apartmentId: ctx.apartmentId, role: ctx.role })}
                trailing={
                  isPending ? (
                    <ActivityIndicator size="small" color={colors.muted} accessibilityLabel="Geçiliyor" />
                  ) : isActive ? (
                    <View style={styles.active}>
                      <Check size={16} color={colors.accent} aria-hidden />
                      <AppText variant="small" tone="accent">
                        Aktif
                      </AppText>
                    </View>
                  ) : undefined
                }
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  groups: { gap: space(4) },
  group: { gap: space(2) },
  groupTitle: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  active: { flexDirection: 'row', alignItems: 'center', gap: space(1) },
});
