import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { ChipGroup, Screen } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { gateKeys, useDeskCouriers } from '@/hooks/useGate';
import { space } from '@/theme/tokens';
import { CourierDesk } from './CourierDesk';
import { GateLog } from './GateLog';
import { PassDesk } from './PassDesk';
import { PlateDesk } from './PlateDesk';

export type GateTab = 'pass' | 'plate' | 'courier' | 'log';

/** Genis ekran (yatay tablet): bolum secimi tek satir, misafir masasi iki sutun. */
export const WIDE_MIN = 768;

/**
 * Kapı (web: pages/admin/gate/GatePage.tsx gorevli gorunumu): misafir QR / kisa kod, plaka sorgusu,
 * kurye ve dun + bugunun kapi kayitlari. Buyuk dokunma alanli bolum secimi; kurye sekmesinde bekleyen
 * sayisi. `active`: sekme gorunur (kamera ve kurye yenilemesi yalnizca o zaman).
 */
export function GateScreen({ active = true, initialTab = 'pass' }: { active?: boolean; initialTab?: GateTab }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_MIN;
  const [tab, setTab] = useState<GateTab>(initialTab);
  const [refreshing, setRefreshing] = useState(false);
  const couriers = useDeskCouriers('open', active);
  // Web gibi: bekleyen / iceride (acik) kurye sayisi.
  const waiting = couriers.data?.items.length;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.refetchQueries({ queryKey: gateKeys.all(user?.apartmentId ?? ''), type: 'active' });
    } finally {
      setRefreshing(false);
    }
  };

  const manualEntry = (plate?: string) => router.push({ pathname: '/guard/manual-entry', params: plate ? { plate } : {} });

  return (
    <Screen title="Kapı" refreshing={refreshing} onRefresh={() => void refresh()}>
      <View style={[styles.body, wide && styles.bodyWide]}>
        <ChipGroup
          label="Kapı işlemleri"
          size="large"
          columns={wide ? 4 : 2}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'pass', label: 'Misafir QR / kod' },
            { value: 'plate', label: 'Plaka sorgu' },
            { value: 'courier', label: 'Kurye', ...(waiting ? { count: waiting } : {}) },
            { value: 'log', label: 'Kapı kayıtları' },
          ]}
        />
        {tab === 'pass' && <PassDesk active={active} wide={wide} />}
        {tab === 'plate' && <PlateDesk onManualEntry={(plate) => manualEntry(plate)} />}
        {tab === 'courier' && <CourierDesk active={active} />}
        {tab === 'log' && <GateLog onManualEntry={() => manualEntry()} />}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: space(4) },
  bodyWide: { width: '100%', maxWidth: 960, alignSelf: 'center' },
});
