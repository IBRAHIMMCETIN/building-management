import type { ImportStatus } from '@/lib/api/imports';

export const STATUS_LABEL: Record<ImportStatus, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  completed: { label: 'Tamamlandı', tone: 'success' },
  in_progress: { label: 'Yarım kaldı', tone: 'warning' },
  rolled_back: { label: 'Geri alındı', tone: 'neutral' },
};
