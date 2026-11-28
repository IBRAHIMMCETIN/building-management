import type { SignedDownload } from '@bm/shared/api/documents';

/*
 * Web onizlemesi (react-native-web): yeni sekme. Belge sekmesi TIKLAMA ANINDA acilir, link gelince
 * yonlendirilir (aksi halde await sonrasi acilir pencere engelleyicisine takilir); web uygulamasindaki
 * openSignedDocument ile ayni (apps/web/src/lib/api/documentModel.ts).
 */

export async function openInAppBrowser(url: string): Promise<void> {
  // `noopener` ozelligi verilirse window.open null doner; bu yuzden opener elle kesilir.
  const win = window.open(url, '_blank');
  if (win) win.opener = null;
  else window.location.assign(url);
}

export async function openDocument(load: () => Promise<SignedDownload>): Promise<void> {
  const win = window.open('', '_blank');
  try {
    const { url } = await load();
    if (win) {
      win.opener = null;
      win.location.href = url;
    } else {
      window.location.assign(url);
    }
  } catch (err) {
    win?.close();
    throw err;
  }
}

export function webAppUrl(base: string, path: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
