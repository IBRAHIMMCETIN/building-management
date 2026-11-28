import type { SignedDownload } from '@bm/shared/api/documents';
import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform } from 'react-native';
import { palettes } from '@/theme/tokens';

/*
 * Uygulama disi icerik (web karsiligi: openExternal.web.ts).
 *  - Web uygulamasi sayfalari (mobilde henuz olmayan ekranlar, online odeme): uygulama ici tarayici
 *    (iOS SFSafariViewController, Android Custom Tabs). Kart bilgisi uygulamaya hic girmez.
 *  - Belge PDF'leri (makbuz, tutanak, dokum, teklif): API'nin 5 dakikalik imzali linki istenir;
 *    iOS'ta sistem goruntuleyicisinde, Android'de uygulama ici tarayicida acilir; link saklanmaz.
 */

/**
 * Uygulama ici tarayici. `closed`: kullanici kapatana kadar beklendi (iOS SFSafariViewController);
 * `opened`: hemen dondu (Android Custom Tabs uygulamayi arka plana alir; donus AppState ile anlasilir).
 */
export async function openInAppBrowser(url: string): Promise<'closed' | 'opened'> {
  const result = await WebBrowser.openBrowserAsync(url, {
    controlsColor: palettes.light.accent,
    toolbarColor: palettes.light.surface,
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    enableBarCollapsing: true,
  });
  return result.type === 'opened' ? 'opened' : 'closed';
}

export async function openDocument(load: () => Promise<SignedDownload>): Promise<void> {
  const { url } = await load();
  // Android: varsayilan tarayiciya verilen PDF linki sessizce indirilebilir (Indirilenler); uygulama
  // ici tarayici (Custom Tabs) kullaniciya ne oldugunu gosterir. iOS sistem goruntuleyicisinde acar.
  if (Platform.OS === 'android') await openInAppBrowser(url);
  else await Linking.openURL(url);
}

/** Web uygulamasindaki bir sayfanin tam adresi (`EXPO_PUBLIC_WEB_URL` bossa null). */
export function webAppUrl(base: string, path: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
