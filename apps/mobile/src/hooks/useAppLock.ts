import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import type { AppLockState } from '@/lib/lock/appLock';
import type { BiometricStatus } from '@/lib/lock/types';
import { useServices } from '@/services';

export function useAppLock(): AppLockState {
  const { lock } = useServices();
  return useSyncExternalStore(lock.subscribe, lock.getState, lock.getState);
}

/** Cihaza gore yontem adi: iOS Face ID / Touch ID, Android yuz tanima / parmak izi. */
export function biometricName(kind: BiometricStatus['kind'] | undefined): string {
  if (Platform.OS === 'ios') return kind === 'fingerprint' ? 'Touch ID' : 'Face ID';
  if (kind === 'face') return 'yüz tanıma';
  if (kind === 'iris') return 'iris tanıma';
  return 'parmak izi';
}
