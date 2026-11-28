import * as Device from 'expo-device';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Platform } from 'react-native';

/*
 * Ekran yonu: telefonda dikey (M1 gibi), tablette (iPad ve Android tablet) serbest. Kapidaki tablet yatay
 * da kullanilir; Kapı ekrani yatay genis pencerede iki sutuna gecer, diger ekranlar genis ekranda ortali
 * en fazla 720 pt (Screen). app.json `orientation: default` + iOS baslangic kilidi dikey
 * (expo-screen-orientation eklentisi); karar acilista bir kez verilir. iPad destegi acik
 * (`ios.supportsTablet: true`, coklu gorev: iPad'de iOS yon kilidini zaten uygulamaz; bolunmus ekranda dar
 * pencere telefon yerlesimini kullanir).
 */
/**
 * RN Modal iOS'ta varsayilan olarak yalnizca dikey destekler: iPad yatayda acilan pencere uygulamayi
 * dondururdu. Tum pencereler (Sheet, daire secici, kilit) iki yonu de destekler; telefon zaten dikey kilitli.
 */
export const MODAL_ORIENTATIONS: ('portrait' | 'landscape')[] = ['portrait', 'landscape'];

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
