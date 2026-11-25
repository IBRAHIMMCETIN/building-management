import { ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, Dialog, Spinner } from '@/components/ui';
import type { SignedDownload } from '@/lib/api/documentModel';
import { errorMessage } from '@/lib/api/errors';
import { photoIdOf } from '@/lib/tickets/model';

/**
 * Fotograf listesi: imzali linkler (5 dk) yalnizca acilinca istenir; olay gorunurlugu API'de
 * uygulanir (ic nottaki fotografi sakin acamaz).
 */
export function PhotoGallery({ keys, load, label = 'Fotoğraf' }: { keys: readonly string[]; load: (photoId: string) => Promise<SignedDownload>; label?: string }) {
  const [open, setOpen] = useState<{ index: number; url?: string; error?: string } | null>(null);
  if (!keys.length) return null;

  const show = async (index: number) => {
    setOpen({ index });
    try {
      const r = await load(photoIdOf(keys[index] as string));
      setOpen({ index, url: r.url });
    } catch (err) {
      setOpen({ index, error: errorMessage(err) });
    }
  };

  return (
    <>
      <ul className="flex flex-wrap gap-2" aria-label="Fotoğraflar">
        {keys.map((k, i) => (
          <li key={k}>
            <button
              type="button"
              onClick={() => void show(i)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface/80 px-2 py-1 text-xs font-medium hover:bg-surface-muted"
            >
              <ImageIcon className="size-3.5" aria-hidden="true" />
              {label} {i + 1}
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={`${label} ${(open?.index ?? 0) + 1}`} variant="wide">
        {open?.error ? (
          <Alert tone="danger">{open.error}</Alert>
        ) : open?.url ? (
          <img src={open.url} alt={`${label} ${(open.index ?? 0) + 1}`} className="mx-auto max-h-[70dvh] w-auto rounded-md object-contain" />
        ) : (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        )}
      </Dialog>
    </>
  );
}
