import AsyncStorage from '@react-native-async-storage/async-storage';

/*
 * Gizli olmayan kucuk tercihler (secili daire, mock senaryo bilgisi). AsyncStorage: cihazda
 * uygulama verisi, web'de localStorage. Token ve kisisel finansal veri buraya YAZILMAZ.
 * Depolama hatasi sessizce yutulur: tercih yalnizca bellekte kalir.
 */
export const preferences = {
  async get(key: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string | null): Promise<void> {
    try {
      if (value === null) await AsyncStorage.removeItem(key);
      else await AsyncStorage.setItem(key, value);
    } catch {
      // yalnizca bellekte
    }
  },
};
