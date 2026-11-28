import type { SignedDownload } from '@bm/shared/api/documents';
import { errorMessage } from '@bm/shared/api/errors';
import { useCallback, useState } from 'react';
import { openDocument } from '@/lib/openExternal';

/**
 * Belge acma (web: hooks/useOpenDocument.ts; Borçlarım'daki makbuz akisiyla ayni): API'nin 5 dakikalik
 * imzali linki istenir ve sistem goruntuleyicisinde / tarayicida acilir; link saklanmaz, dosya
 * cihazin ortak deposuna indirilmez. Hangi ogenin yuklendigini ve son hatayi tutar.
 */
export function useSignedDocument() {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((id: string, load: () => Promise<SignedDownload>) => {
    setPendingId(id);
    setError(null);
    openDocument(load)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setPendingId(null));
  }, []);

  return { open, pendingId, error };
}
