// `qrcode` paketinin yalnizca kodlama cekirdegi (tuval / PNG / dosya cizicileri olmadan; components/gate/QrCode.tsx).
declare module 'qrcode/lib/core/qrcode' {
  import type { QRCode, QRCodeOptions } from 'qrcode';
  export function create(text: string, options?: QRCodeOptions): QRCode;
}
