import { CameraOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { DECODER_LOAD_ERROR, SUPPORT_TEXT, cameraErrorMessage, scanEngine, scannerSupport } from '@/lib/gate/camera';
import { type FrameScanner, SCAN_INTERVAL_MS, createFrameScanner } from '@/lib/gate/qrDecode';

type State = { kind: 'starting' } | { kind: 'scanning' } | { kind: 'error'; message: string };

/**
 * Arka kamerayla QR okuma. Yerlesik `BarcodeDetector` varsa o, yoksa (iPhone Safari) kucultulmus
 * kareler `jsqr` ile cozulur (ilk acilista ayri parca olarak yuklenir); kareler 250 ms'de bir
 * sorgulanir. Ilk okunan degerde kamera kapanir ve `onResult` cagrilir. Sekme arka plana gecince
 * kamera kapanir, geri gelince yeniden acilir; ekrandan cikinca (unmount) kapanir. Izin verilmezse /
 * kamera yoksa aciklama gosterilir; gorevli kisa kodu elle yazar.
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
    let done = false;
    /** Her kamera acilisi yeni bir nesil: eski nesnin gecikmeli devami hicbir sey yapmaz. */
    let gen = 0;
    // Motor ve (gerekirse) yedek cozucu kamerayla paralel hazirlanir.
    const scanner: Promise<FrameScanner> = scanEngine().then((engine) => createFrameScanner(engine));
    scanner.catch(() => undefined);

    const halt = () => {
      gen++;
      if (timer) clearTimeout(timer);
      timer = undefined;
      stream?.getTracks().forEach((t) => t.stop());
      stream = undefined;
      video.srcObject = null;
    };
    const finish = () => {
      done = true;
      halt();
    };
    const tick = async (g: number, scan: FrameScanner) => {
      if (g !== gen) return;
      try {
        const text = await scan(video);
        if (g !== gen) return;
        if (text) {
          finish();
          resultRef.current(text);
          return;
        }
      } catch {
        // Kare hazir degil: bir sonraki denemede.
      }
      timer = setTimeout(() => void tick(g, scan), SCAN_INTERVAL_MS);
    };
    const start = async () => {
      if (done) return;
      halt();
      const g = gen;
      setState({ kind: 'starting' });
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (err) {
        if (g === gen && !done) setState({ kind: 'error', message: cameraErrorMessage(err) });
        return;
      }
      if (g !== gen || done) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      try {
        video.srcObject = s;
        // play() reddedilirse (otomatik oynatma politikasi, kesilen izin) kamera kapatilir.
        await video.play();
      } catch (err) {
        if (g !== gen) return;
        finish();
        setState({ kind: 'error', message: cameraErrorMessage(err) });
        return;
      }
      let scan: FrameScanner;
      try {
        scan = await scanner;
      } catch {
        if (g !== gen) return;
        finish();
        setState({ kind: 'error', message: DECODER_LOAD_ERROR });
        return;
      }
      if (g !== gen) return;
      setState({ kind: 'scanning' });
      void tick(g, scan);
    };
    // Arka plandaki sekmede kamera acik kalmaz (isik, pil); geri gelince yeniden acilir.
    const onVisibility = () => {
      if (done) return;
      if (document.hidden) halt();
      else void start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      finish();
    };
  }, []);

  const failed = state.kind === 'error';
  return (
    <div className="flex flex-col gap-3">
      {failed && (
        <Alert tone="danger">
          <span className="inline-flex items-center gap-2">
            <CameraOff className="size-4" aria-hidden="true" />
            {state.message}
          </span>
        </Alert>
      )}
      {/* Video her zaman DOM'da (hata durumunda gizli): sekmeye donuste yeniden acilan akis ayni ogeye baglanir. */}
      <div className={cn('relative overflow-hidden rounded-xl border border-border-strong bg-surface-muted', failed && 'hidden')}>
        <video ref={videoRef} className="aspect-square w-full object-cover" playsInline muted aria-label="Kamera görüntüsü" />
        <div className="pointer-events-none absolute inset-8 rounded-lg border-4 border-white/80" aria-hidden="true" />
        {!failed && (
          <p className="absolute inset-x-0 bottom-3 text-center text-small font-medium text-white" role="status">
            {state.kind === 'starting' ? 'Kamera açılıyor…' : 'QR kodu çerçeveye getirin'}
          </p>
        )}
      </div>
      <Button variant="secondary" className="h-12 text-body" onClick={onClose}>
        Kamerayı kapat
      </Button>
    </div>
  );
}
