import { useCallback, useState } from 'react';
import { type SignedDownload, openSignedDocument } from '@/lib/api/documents';
import { errorMessage } from '@/lib/api/errors';

/** Belge acma: hangi satirin yuklendigini ve son hatayi tutar (link saklanmaz). */
export function useOpenDocument() {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (id: string, load: () => Promise<SignedDownload>) => {
    setPendingId(id);
    setError(null);
    try {
      await openSignedDocument(load);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingId(null);
    }
  }, []);

  return { open, pendingId, error, clearError: () => setError(null) };
}
