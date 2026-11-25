/**
 * Faz 3 (O1-3) - Hazir bakim sablonlari. Degerler yalnizca baslangic onerisidir; yonetici her alani
 * degistirebilir. Mevzuat notlari bilgilendirme amaclidir, yasal yukumluluk hesaplanmaz.
 */
import type { TicketCategory } from '../tickets/types.js';
import type { ScheduleUnit } from './types.js';

export type MaintenancePreset = {
  preset: string;
  name: string;
  category: TicketCategory;
  every: number;
  unit: ScheduleUnit;
  checklist: string[];
  /** Hazir gider hesabi onerisi (O1-4 masraf formu). */
  expenseAccountId?: string;
  legalNote?: string;
};

export const MAINTENANCE_PRESETS: readonly MaintenancePreset[] = [
  {
    preset: 'elevator_monthly',
    name: 'Asansör aylık bakımı',
    category: 'elevator',
    every: 1,
    unit: 'month',
    checklist: ['Kabin ve kat kapıları çalışıyor', 'Fren ve halatlar kontrol edildi', 'Acil durum alarmı ve aydınlatma çalışıyor', 'Bakım formu imzalandı'],
    expenseAccountId: 'exp-elevator',
    legalNote: 'Asansör İşletme, Bakım ve Periyodik Kontrol Yönetmeliği: bakım ayda en az bir kez yetkili firmaca yapılır.',
  },
  {
    preset: 'elevator_annual_inspection',
    name: 'Asansör yıllık periyodik kontrol',
    category: 'elevator',
    every: 1,
    unit: 'year',
    checklist: ['A tipi muayene kuruluşu kontrolü yapıldı', 'Etiket rengi kaydedildi', 'Eksiklikler için iş emri açıldı'],
    expenseAccountId: 'exp-elevator',
    legalNote: 'Yıllık periyodik kontrol A tipi muayene kuruluşunca yapılır; kırmızı/sarı etikette eksiklikler süresinde giderilmelidir.',
  },
  {
    preset: 'water_pump',
    name: 'Hidrofor bakımı',
    category: 'water_pump',
    every: 3,
    unit: 'month',
    checklist: ['Basınç ve tank ön basıncı ölçüldü', 'Pompa sesi / sızıntı kontrolü', 'Otomatik çalışma testi'],
  },
  {
    preset: 'generator_test',
    name: 'Jeneratör test çalıştırması',
    category: 'generator',
    every: 1,
    unit: 'month',
    checklist: ['Yükte en az 15 dakika çalıştırıldı', 'Yakıt seviyesi kontrol edildi', 'Akü durumu kontrol edildi'],
  },
  {
    preset: 'generator_service',
    name: 'Jeneratör yıllık bakımı',
    category: 'generator',
    every: 1,
    unit: 'year',
    checklist: ['Yağ ve filtreler değişti', 'Soğutma sıvısı kontrol edildi', 'Transfer panosu testi'],
  },
  {
    preset: 'chimney',
    name: 'Baca temizliği',
    category: 'heating',
    every: 6,
    unit: 'month',
    checklist: ['Baca temizlendi', 'Çekiş kontrolü yapıldı', 'Baca temizlik belgesi alındı'],
    legalNote: 'Katı yakıtlı sistemlerde baca temizliği ve kontrolü yerel yönetim / itfaiye düzenlemelerine tabidir.',
  },
  {
    preset: 'fire_extinguisher',
    name: 'Yangın tüpü kontrol / dolum',
    category: 'security',
    every: 1,
    unit: 'year',
    checklist: ['Tüp basınç göstergeleri kontrol edildi', 'Son kullanma / dolum tarihleri güncellendi', 'Tüp yerleri ve işaretleri yerinde'],
    legalNote: 'Binaların Yangından Korunması Hakkında Yönetmelik: taşınabilir söndürücüler yılda bir kontrol edilir.',
  },
  {
    preset: 'pool',
    name: 'Havuz kimyasal / filtre bakımı',
    category: 'pool',
    every: 1,
    unit: 'week',
    checklist: ['Klor ve pH ölçüldü', 'Filtre ters yıkama yapıldı', 'Yüzey ve dip temizliği'],
  },
  {
    preset: 'water_tank',
    name: 'Su deposu temizliği',
    category: 'plumbing',
    every: 6,
    unit: 'month',
    checklist: ['Depo boşaltılıp temizlendi', 'Dezenfeksiyon yapıldı', 'Numune / analiz raporu alındı'],
  },
  {
    preset: 'irrigation',
    name: 'Bahçe sulama sistemi kontrolü',
    category: 'garden',
    every: 1,
    unit: 'month',
    checklist: ['Vanalar ve zamanlayıcılar kontrol edildi', 'Kaçak / kırık başlık kontrolü'],
    expenseAccountId: 'exp-garden',
  },
  {
    preset: 'boiler',
    name: 'Kazan / kombi bakımı',
    category: 'heating',
    every: 1,
    unit: 'year',
    checklist: ['Brülör ayarı ve yanma analizi', 'Emniyet ventili testi', 'Genleşme tankı basıncı'],
    expenseAccountId: 'exp-heating',
  },
];

export const presetOf = (id: string) => MAINTENANCE_PRESETS.find((p) => p.preset === id);
