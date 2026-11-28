import { ApiError } from '@bm/shared/api/errors';
import { KIND_LABELS, PORTAL_PHASE_LABELS, PORTAL_PHASE_TONES, type PortalAssembly } from '@bm/shared/api/assemblies';
import { formatDateTime } from '@bm/shared/dates';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Landmark } from '@/components/icons';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { RowLink } from '@/components/portal/RowLink';
import { AppText, Badge, EmptyState, LoadingBlock, Screen } from '@/components/ui';
import { useMyAssemblies, useOwnerGate } from '@/hooks/useAssemblies';
import { space } from '@/theme/tokens';

/** Genel kurul yalnizca kat maliklerine acik (kiraci / uyeligi olmayan; web AssemblyQueryState 403). */
export function OwnersOnlyState() {
  return (
    <EmptyState
      icon={Landmark}
      title="Genel kurul bilgileri kat maliklerine açıktır"
      description="Kat malikleri kurulu toplantıları, kararlar ve tutanaklar bu apartmanda malik olarak kayıtlı kullanıcılara gösterilir."
    />
  );
}

/** 403: maliklere ozel bilgi; diger hatalar portalin ortak durumuna (daire secimi, tekrar dene). */
export function AssemblyQueryState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.status === 403) return <OwnersOnlyState />;
  return <PortalQueryState error={error} onRetry={onRetry} />;
}

export const assemblyTitle = (a: Pick<PortalAssembly, 'kind' | 'secondMeeting'>) => `${KIND_LABELS[a.kind]}${a.secondMeeting ? ' (ikinci toplantı)' : ''}`;

/**
 * Sakin "Genel Kurul" (web: pages/resident/assemblies/MyAssembliesPage.tsx), yalnizca kat maliki:
 * yaklasan toplantilar once, sonra gecmis toplantilar. Kiracida istek gonderilmez.
 */
export function AssembliesScreen() {
  const { notOwner } = useOwnerGate();
  const list = useMyAssemblies();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await list.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  if (notOwner) {
    return (
      <Screen>
        <OwnersOnlyState />
      </Screen>
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      {list.isPending ? (
        <LoadingBlock label="Toplantılar yükleniyor" />
      ) : list.isError ? (
        <AssemblyQueryState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={Landmark} title="Henüz toplantı yok" description="Yönetiminiz bir kat malikleri kurulu toplantısına çağrı yaptığında burada görünecek." />
      ) : (
        <View style={styles.list}>
          {list.data.map((a) => {
            const meta = `${formatDateTime(a.scheduledAt)} · ${a.location ?? 'Çevrim içi'} · ${a.agenda.length} gündem maddesi`;
            return (
              <RowLink
                key={a.assemblyId}
                accessibilityLabel={`${assemblyTitle(a)}, ${meta}, ${PORTAL_PHASE_LABELS[a.phase]}${a.minutesAvailable ? ', tutanak hazır' : ''}`}
                accessibilityHint="Toplantının ayrıntısını açar"
                onPress={() => router.push({ pathname: '/resident/assemblies/[id]', params: { id: a.assemblyId } })}
              >
                <AppText weight="semibold">{assemblyTitle(a)}</AppText>
                <AppText variant="caption" tone="muted">
                  {meta}
                </AppText>
                <View style={styles.meta}>
                  <Badge tone={PORTAL_PHASE_TONES[a.phase]} label={PORTAL_PHASE_LABELS[a.phase]} />
                  {a.minutesAvailable && (
                    <AppText variant="caption" tone="muted">
                      Tutanak hazır
                    </AppText>
                  )}
                </View>
              </RowLink>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(3) },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(1.5) },
});
