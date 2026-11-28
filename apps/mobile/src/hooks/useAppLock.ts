import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import type { AppLockState } from '@/lib/lock/appLock';
import type { BiometricStatus } from '@/lib/lock/types';
import { useServices } from '@/services';

export function useAppLock(): AppLockState {
  const { lock } = useServices();
  return useSyncExternalStore(lock.subscribe, lock.getState, lock.getState);
}

/**
 * Kilit ekrani veya gizlilik ortusu acikken uygulamanin diger pencereleri (Sheet, daire secici) gizlenir:
 * iki kardes RN Modal'da hangisinin ustte kalacagi garanti degildir. Pencere kendi `open` durumunu korur,
 * kilit acilinca yeniden gorunur.
 */
export function useModalsSuspended(): boolean {
  const { status, covered } = useAppLock();
  return status !== 'unlocked' || covered;
}

/** Cihaza gore yontem adi: iOS Face ID / Touch ID, Android yuz tanima / parmak izi. */
export function biometricName(kind: BiometricStatus['kind'] | undefined): string {
  if (Platform.OS === 'ios') return kind === 'fingerprint' ? 'Touch ID' : 'Face ID';
  if (kind === 'face') return 'yüz tanıma';
  if (kind === 'iris') return 'iris tanıma';
  return 'parmak izi';
}
