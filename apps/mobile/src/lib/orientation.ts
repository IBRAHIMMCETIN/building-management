import * as Device from 'expo-device';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Platform } from 'react-native';

/*
 * Ekran yonu: telefonda dikey (M1 gibi), tablette serbest. Kapidaki tablet yatay da kullanilir; Kapı
 * ekrani genis ekranda iki sutuna gecer. app.json `orientation: default` + iOS baslangic kilidi dikey
 * (expo-screen-orientation eklentisi); karar acilista bir kez verilir. iPad destegi (`ios.supportsTablet`)
 * mağaza kararidir ve kapalidir: iPad'de uygulama telefon gibi dikey acilir.
 */
export async function applyOrientationPolicy(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const type = await Device.getDeviceTypeAsync();
    if (type === Device.DeviceType.TABLET) await ScreenOrientation.unlockAsync();
    else await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  } catch {
    // Yon kilidi desteklenmiyorsa (ornek: test ortami) sistem varsayilani kalir.
  }
}
