/*
 * Hermes'te `TextDecoder` yoktur (TextEncoder, atob ve btoa vardir). Ortak paket
 * (@bm/shared/auth/session -> decodeClaims) JWT govdesini UTF-8 olarak cozmek icin kullanir.
 * Yalnizca eksikse ve yalnizca UTF-8 icin kucuk bir yedek tanimlanir.
 */

function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++] as number;
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc0 && b0 < 0xe0) {
      cp = ((b0 & 0x1f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      cp = ((b0 & 0x0f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    } else if (b0 >= 0xf0) {
      cp = ((b0 & 0x07) << 18) | (((bytes[i++] ?? 0) & 0x3f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    } else {
      cp = 0xfffd;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

class Utf8TextDecoder {
  readonly encoding = 'utf-8';
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return '';
    const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
    return decodeUtf8(bytes);
  }
}

export function installPolyfills(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  if (typeof target.TextDecoder !== 'function') target.TextDecoder = Utf8TextDecoder;
}

export { decodeUtf8 };

installPolyfills();
