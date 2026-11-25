import { Camera, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { PHOTO_ACCEPT, photoFileError } from '@/lib/meters/model';

type Props = {
  label?: string;
  files: File[];
  onChange: (files: File[]) => void;
  /** API siniri: olay basina 6 fotograf. */
  max?: number;
  disabled?: boolean;
};

/**
 * Coklu fotograf secici (talep / bakim): kamera veya galeri, onizleme, tur ve boyut kontrolu
 * (JPEG/PNG/WEBP/HEIC, 10 MB). Yukleme gonderimde yapilir (`uploadPhotos`).
 */
export function PhotoPicker({ label = 'Fotoğraflar (isteğe bağlı)', files, onChange, max = 6, disabled }: Props) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const full = files.length >= max;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-small font-medium">
        {label} <span className="text-xs font-normal text-muted">({files.length}/{max})</span>
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {files.map((f, i) => (
          <Thumb
            key={`${f.name}-${i}`}
            file={f}
            disabled={disabled}
            onRemove={() => {
              onChange(files.filter((_, j) => j !== i));
              setError(null);
            }}
          />
        ))}
        {!full && (
          <label
            htmlFor={id}
            className="inline-flex h-14 cursor-pointer items-center gap-2 rounded-md border border-dashed border-border-strong bg-surface/80 px-3 text-small font-medium hover:bg-surface-muted has-disabled:cursor-not-allowed has-disabled:opacity-60"
          >
            <Camera className="size-4" aria-hidden="true" />
            Fotoğraf ekle
            <input
              key={resetKey}
              id={id}
              type="file"
              accept={PHOTO_ACCEPT}
              multiple
              disabled={disabled}
              className="sr-only"
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                setResetKey((k) => k + 1);
                const bad = picked.map(photoFileError).find(Boolean);
                const ok = picked.filter((f) => !photoFileError(f));
                const room = max - files.length;
                setError(bad ?? (ok.length > room ? `En fazla ${max} fotoğraf eklenebilir.` : null));
                if (ok.length) onChange([...files, ...ok.slice(0, room)]);
              }}
            />
          </label>
        )}
      </div>
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function Thumb({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled?: boolean }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (file.type === 'image/heic' || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <span className="relative inline-flex size-14 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-muted text-[10px] text-muted">
      {preview ? <img src={preview} alt={file.name} className="size-full object-cover" /> : <span className="truncate px-1">{file.name}</span>}
      <button
        type="button"
        aria-label={`${file.name} fotoğrafını kaldır`}
        disabled={disabled}
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-scrim text-white"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}

/** Ayni dosya tekrar gonderimde (ag hatasi sonrasi) yeniden yuklenmez: idempotency parmak izi ayni kalir. */
const uploaded = new WeakMap<File, string>();

/** Secilen dosyalari sirayla yukler; yukleme kimliklerini dondurur. */
export async function uploadPhotos(files: readonly File[], upload: (f: File) => Promise<string>): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) {
    const known = uploaded.get(f);
    const id = known ?? (await upload(f));
    uploaded.set(f, id);
    ids.push(id);
  }
  return ids;
}
