import { useEffect, useState } from 'react';

/**
 * Metin -> QR (PNG data URL). `qrcode` kutuphanesi yalnizca QR gosteren ekranda (MFA kurulumu,
 * misafir gecisi) ayri parca olarak bu anda indirilir.
 */
export function useQrDataUrl(text: string | undefined, width = 208) {
  const [state, setState] = useState<{ text: string; url: string }>();
  useEffect(() => {
    if (!text) return;
    let cancelled = false;
    void import('qrcode')
      .then(({ toDataURL }) => toDataURL(text, { margin: 1, width, errorCorrectionLevel: 'M' }))
      .then((url) => {
        if (!cancelled) setState({ text, url });
      });
    return () => {
      cancelled = true;
    };
  }, [text, width]);
  return text && state?.text === text ? state.url : undefined;
}
