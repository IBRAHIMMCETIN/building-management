import { Camera, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { PHOTO_ACCEPT, photoFileError } from '@/lib/meters/model';

type Props = {
  label?: string;
  file: File | null;
  onChange: (file: File | null, error: string | null) => void;
  error?: string | null;
  disabled?: boolean;
  /** Telefonda dogrudan arka kamerayi acar (masaustunde dosya secici). */
  capture?: boolean;
  /** Input'u sifirlamak icin anahtar degisimi. */
  resetKey?: number;
};

/** Sayac fotografi secici: kamera / galeri, onizleme, tur ve boyut kontrolu (JPEG/PNG/WEBP/HEIC, 10 MB). */
export function PhotoInput({ label = 'Fotoğraf (isteğe bağlı)', file, onChange, error, disabled, capture = true, resetKey }: Props) {
  const id = useId();
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file || file.type === 'image/heic' || typeof URL.createObjectURL !== 'function') {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-small font-medium">{label}</span>
      <div className="flex items-center gap-3">
        <label
          htmlFor={id}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-surface/80 px-3 text-small font-medium hover:bg-surface-muted has-disabled:cursor-not-allowed has-disabled:opacity-60"
        >
          <Camera className="size-4" aria-hidden="true" />
          {file ? 'Değiştir' : 'Fotoğraf çek / seç'}
          <input
            key={resetKey}
            id={id}
            type="file"
            accept={PHOTO_ACCEPT}
            {...(capture ? { capture: 'environment' as const } : {})}
            disabled={disabled}
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              onChange(f, f ? photoFileError(f) : null);
            }}
          />
        </label>
        {file && (
          <span className="flex min-w-0 items-center gap-2 text-small text-muted">
            {preview && <img src={preview} alt="Seçilen sayaç fotoğrafı" className="size-10 rounded object-cover" />}
            <span className="truncate">{file.name}</span>
            <button
              type="button"
              aria-label="Fotoğrafı kaldır"
              disabled={disabled}
              onClick={() => onChange(null, null)}
              className="grid size-7 place-items-center rounded hover:bg-surface-muted"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </span>
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
