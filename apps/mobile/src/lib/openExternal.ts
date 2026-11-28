import type { SignedDownload } from '@bm/shared/api/documents';
import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';
import { palettes } from '@/theme/tokens';

/*
 * Uygulama disi icerik (web karsiligi: openExternal.web.ts).
 *  - Web uygulamasi sayfalari (mobilde henuz olmayan ekranlar, online odeme): uygulama ici tarayici
 *    (iOS SFSafariViewController, Android Custom Tabs). Kart bilgisi uygulamaya hic girmez.
 *  - Makbuz PDF'i: API'nin 5 dakikalik imzali linki istenir ve sistem goruntuleyicisinde acilir;
 *    link saklanmaz.
 */

export async function openInAppBrowser(url: string): Promise<void> {
  await WebBrowser.openBrowserAsync(url, {
    controlsColor: palettes.light.accent,
    toolbarColor: palettes.light.surface,
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    enableBarCollapsing: true,
  });
}

export async function openDocument(load: () => Promise<SignedDownload>): Promise<void> {
  const { url } = await load();
  await Linking.openURL(url);
}

/** Web uygulamasindaki bir sayfanin tam adresi (`EXPO_PUBLIC_WEB_URL` bossa null). */
export function webAppUrl(base: string, path: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
