import { CameraOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { SUPPORT_TEXT, cameraErrorMessage, createDetector, scannerSupport } from '@/lib/gate/camera';

type State = { kind: 'starting' } | { kind: 'scanning' } | { kind: 'error'; message: string };

/**
 * Arka kamerayla QR okuma. Ilk okunan degerde kamera kapanir ve `onResult` cagrilir. Izin
 * verilmezse / tarayici desteklemezse aciklama gosterilir; gorevli kisa kodu elle yazar.
 */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  const [state, setState] = useState<State>(() => {
    const support = scannerSupport();
    return support === 'ok' ? { kind: 'starting' } : { kind: 'error', message: SUPPORT_TEXT[support] };
  });

  useEffect(() => {
    if (scannerSupport() !== 'ok') return;
    const video = videoRef.current;
    if (!video) return;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let detector: ReturnType<typeof createDetector>;
    try {
      detector = createDetector();
    } catch (err) {
      setState({ kind: 'error', message: cameraErrorMessage(err) });
      return;
    }
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const hit = (await detector.detect(video)).find((c) => c.rawValue);
        if (hit) {
          stop();
          resultRef.current(hit.rawValue);
          return;
        }
      } catch {
        // Kare hazir degil: bir sonraki denemede.
      }
      timer = setTimeout(() => void tick(), 250);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(async (s) => {
        stream = s;
        if (stopped) {
          stop();
          return;
        }
        video.srcObject = s;
        // play() reddedilirse (otomatik oynatma politikasi, kesilen izin) asagidaki catch kamerayi kapatir.
        await video.play();
        setState({ kind: 'scanning' });
        void tick();
      })
      .catch((err: unknown) => {
        // Her hata yolunda kamera serbest birakilir (isik yanik kalmasin).
        const wasStopped = stopped;
        stop();
        video.srcObject = null;
        if (!wasStopped) setState({ kind: 'error', message: cameraErrorMessage(err) });
      });
    return stop;
  }, []);

  return (
    <div className="flex flex-col gap-3">
      {state.kind === 'error' ? (
        <Alert tone="danger">
          <span className="inline-flex items-center gap-2">
            <CameraOff className="size-4" aria-hidden="true" />
            {state.message}
          </span>
        </Alert>
      ) : (
        <div className="relative overflow-hidden rounded-xl border border-border-strong bg-surface-muted">
          <video ref={videoRef} className="aspect-square w-full object-cover" playsInline muted aria-label="Kamera görüntüsü" />
          <div className="pointer-events-none absolute inset-8 rounded-lg border-4 border-white/80" aria-hidden="true" />
          <p className="absolute inset-x-0 bottom-3 text-center text-small font-medium text-white" role="status">
            {state.kind === 'starting' ? 'Kamera açılıyor…' : 'QR kodu çerçeveye getirin'}
          </p>
        </div>
      )}
      <Button variant="secondary" className="h-12 text-body" onClick={onClose}>
        Kamerayı kapat
      </Button>
    </div>
  );
}
