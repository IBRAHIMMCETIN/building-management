import {
  Briefcase,
  Building2,
  DoorOpen,
  HandCoins,
  Landmark,
  Lock,
  type LucideIcon,
  Receipt,
  ScrollText,
  ShieldCheck,
  Split,
  UserRound,
  Users,
  Vote,
  Wrench,
} from 'lucide-react';

/*
 * Tanitim sayfasinin metinleri. Yalnizca bugun calisan ozellikler yazilir (README "API Modulleri",
 * "Guvenlik ve izleme", "Finansal Kurallar"); canli olmayanlar acikca "henuz" / "yakinda" diye
 * belirtilir: kartla online odeme, mobil uygulamanin magazalarda yayini. Musteri logosu, yorum veya
 * istatistik yoktur.
 */

export const SECTION_IDS = {
  features: 'ozellikler',
  audiences: 'kimler-icin',
  mobile: 'mobil',
  trust: 'guven',
  faq: 'sss',
  pricing: 'fiyatlandirma',
  contact: 'iletisim',
} as const;

/** Ust menu baglantilari (sayfa ici). */
export const NAV_LINKS: readonly { href: string; label: string }[] = [
  { href: `#${SECTION_IDS.features}`, label: 'Özellikler' },
  { href: `#${SECTION_IDS.audiences}`, label: 'Kimler için' },
  { href: `#${SECTION_IDS.mobile}`, label: 'Mobil' },
  { href: `#${SECTION_IDS.faq}`, label: 'SSS' },
  { href: `#${SECTION_IDS.contact}`, label: 'İletişim' },
];

export const HERO = {
  title: 'Aidattan genel kurula, sitenizin bütün işleri tek yerde',
  lead: 'YÖNESİST; apartman, site ve toplu konut yönetimleri için aidat ve tahsilat, arıza ve bakım, kapı ve ziyaretçi, anket ve genel kurul işlerini bir araya getirir. Yönetici panelde, sakin portalda, görevli ve güvenlik sahada aynı kayıtlarla çalışır.',
  points: [
    'Kat Mülkiyeti Kanunu’na uygun malik ve kiracı carisi',
    'Silinemeyen, değiştirilemeyen finansal defter',
    'Çok bloklu, yüzlerce bağımsız bölümlü siteler için',
  ],
} as const;

export type ModuleItem = { title: string; text: string };
export type ModuleGroup = { id: string; title: string; icon: LucideIcon; items: readonly ModuleItem[] };

export const MODULE_GROUPS: readonly ModuleGroup[] = [
  {
    id: 'para',
    title: 'Aidat ve muhasebe',
    icon: HandCoins,
    items: [
      {
        title: 'Aidat, tahakkuk ve tahsilat',
        text: 'Eşit, m² veya arsa payına göre toplu tahakkuk; gecikme tazminatı ve makbuz. Sakin, IBAN’ı ve kişisel referans kodunu portaldan kopyalayıp havale veya EFT ile öder. Kartla online ödeme altyapısı hazır, henüz kullanıma açılmadı.',
      },
      {
        title: 'Banka ekstresi ve muhasebe defteri',
        text: 'CSV veya Excel ekstreyi yükleyin; ödemeler referans koduyla eşleştirilsin, kalanları tek tek eşleyin. Gider, tedarikçi borcu, bütçe ve aylık dönem kapanışı aynı defterde.',
      },
      {
        title: 'Raporlar',
        text: 'Gelir-gider özeti, aidat durumu ve gecikmeler, aylık mizan; banka mutabakatı ve sayaç dağıtım dökümü PDF olarak alınır.',
      },
    ],
  },
  {
    id: 'bina',
    title: 'Bina ve bakım',
    icon: Wrench,
    items: [
      {
        title: 'Arıza ve talep',
        text: 'Sakin fotoğrafla bildirir, talep görevliye atanır, süre aşımları görünür. Çözülen talep sakinin onayıyla kapanır.',
      },
      {
        title: 'Periyodik bakım ve ekipman sicili',
        text: 'Asansör, jeneratör, hidrofor gibi ekipmanların garanti, servis sözleşmesi ve periyodik kontrol tarihleri; bakım görevleri takvimden otomatik oluşur.',
      },
      {
        title: 'Ortak alan rezervasyonu',
        text: 'Toplantı salonu, spor alanı, misafirhane: saat dilimleri, kişi sınırı, onay, ücret ve iptal kuralı.',
      },
    ],
  },
  {
    id: 'kapi',
    title: 'Kapı ve güvenlik',
    icon: DoorOpen,
    items: [
      {
        title: 'Güvenlik kapısı',
        text: 'Sakin misafirine QR’lı geçiş gönderir; güvenlik okutup giriş kaydeder. Kurye geldiğinde sakin “İçeri alınsın” der. Plaka sorgusu ve günlük giriş-çıkış kayıtları.',
      },
    ],
  },
  {
    id: 'karar',
    title: 'Karar ve iletişim',
    icon: Vote,
    items: [
      {
        title: 'Anket, oylama ve genel kurul',
        text: 'Bağımsız bölüm veya arsa payı ağırlıklı oylama. Kat malikleri kurulu için çağrı, hazirun cetveli, KMK m.30 yeter sayı ve m.31 çoğunluk hesapları, tutanak ve karar defteri.',
      },
      {
        title: 'İhale ve teklif şeffaflığı',
        text: 'Mantolama, asansör, çatı gibi işler için teklifler toplanır, KDV dahil karşılaştırılır; karar ve gerekçesi sakinlerle paylaşılır.',
      },
      {
        title: 'Duyurular ve bildirimler',
        text: 'Blok bazında duyuru, yayın onayı ve arşiv. Duyurular sakin portalında ve mobil uygulamada görünür.',
      },
    ],
  },
  {
    id: 'firma',
    title: 'Birden çok site',
    icon: Briefcase,
    items: [
      {
        title: 'Yönetim firması portföyü',
        text: 'Yönettiğiniz bütün siteler tek ekranda: tahsilat oranı, vadesi geçmiş alacak, açık talepler, geciken bakımlar ve yaklaşan genel kurullar.',
      },
      {
        title: 'Kişiler ve toplu aktarım',
        text: 'Daireler, kişiler ve açılış bakiyeleri Excel veya CSV ile önizlenerek aktarılır; hatalı satırlar raporlanır.',
      },
    ],
  },
];

export type Audience = { title: string; where: string; icon: LucideIcon; points: readonly string[] };

export const AUDIENCES: readonly Audience[] = [
  {
    title: 'Site ve apartman yöneticisi',
    where: 'Yönetim paneli, web',
    icon: Building2,
    points: [
      'Aylık aidatı tek seferde tahakkuk edin, ekstreyle tahsilatı eşleyin.',
      'Arızaları, bakımları ve ekipman tarihlerini kaçırmayın.',
      'Genel kurulu çağrıdan tutanağa kadar sistemde hazırlayın.',
    ],
  },
  {
    title: 'Profesyonel yönetim firması',
    where: 'Portföy ve ekip, web',
    icon: Briefcase,
    points: [
      'Bütün sitelerinizin özetini tek ekranda görün.',
      'Yönetici, denetçi, görevli ve güvenlik rollerini site bazında verin.',
      'Her sitenin verisi ayrı tutulur; kullanmadığınız modüller sitede gizlenir.',
    ],
  },
  {
    title: 'Kat maliki ve kiracı',
    where: 'Sakin portalı, web ve mobil',
    icon: UserRound,
    points: [
      'Borcunuzu, son ödeme gününü ve makbuzlarınızı görün.',
      'Arıza bildirin, misafirinize QR gönderin, ortak alan ayırtın, oylamaya katılın.',
      'Genel kurul bilgileri kat maliklerine, kişisel bilgiler yalnızca size açıktır.',
    ],
  },
  {
    title: 'Bina görevlisi ve güvenlik',
    where: 'Saha ekranları, mobil',
    icon: Users,
    points: [
      'Görevli: size atanan talepler ve bakım görevleri, fotoğraflı tamamlama, sayaç okuma.',
      'Güvenlik: QR veya kısa kodla misafir doğrulama, kurye onayı, plaka sorgusu.',
    ],
  },
];

export const MOBILE = {
  title: 'Sakin, görevli ve güvenlik için mobil uygulama',
  lead: 'iOS ve Android için yerel uygulama mağaza yayınına hazırlanıyor: yakında App Store ve Google Play’de. Yönetim paneli web’de kalır.',
  roles: [
    { title: 'Sakin', text: 'Ana sayfa, borçlar ve makbuzlar, talepler, ziyaretçi ve kurye, rezervasyon, oylamalar, genel kurul.' },
    { title: 'Güvenlik', text: 'Kamera ile QR okutma, kısa kod, kurye masası, plaka sorgusu ve kapı kayıtları.' },
    { title: 'Bina görevlisi', text: 'İşlerim listesi, önce-sonra fotoğraflı talep ve bakım tamamlama, sayaç okuma.' },
  ],
  note: 'O zamana kadar sakin portalı telefonun tarayıcısında çalışır ve ana ekrana eklenebilir.',
} as const;

export type TrustItem = { title: string; text: string; icon: LucideIcon };

export const TRUST_ITEMS: readonly TrustItem[] = [
  {
    title: 'KMK’ya uygun malik ve kiracı ayrımı',
    text: 'Her bağımsız bölümde malik ve kiracının ayrı carisi vardır. Rutin giderler oturana, demirbaş ve yatırım giderleri malike yazılır; boş dairede gider malike düşer.',
    icon: Split,
  },
  {
    title: 'Değiştirilemez finansal defter',
    text: 'Kayıtlar silinmez ve üzerine yazılmaz; düzeltme ters kayıtla yapılır. Bakiyeler her gece defterle karşılaştırılır.',
    icon: Receipt,
  },
  {
    title: 'Denetim kaydı',
    text: 'Hassas işlemler, her kaydı bir öncekine SHA-256 ile bağlayan ve 10 yıl saklanan bir günlüğe yazılır; zincir her gece doğrulanır.',
    icon: ScrollText,
  },
  {
    title: 'İki adımlı doğrulama',
    text: 'Yönetici, yönetim firması ve denetçi hesaplarında doğrulayıcı uygulama kodu zorunludur.',
    icon: ShieldCheck,
  },
  {
    title: 'KVKK',
    text: 'Borçlu isimleri herkese açık listelenmez. IP adresleri kısaltılarak, karşı taraf IBAN’ları özet olarak tutulur. Veriler Avrupa’da (AWS, Stockholm) saklanır.',
    icon: Lock,
  },
  {
    title: 'Site bazında ayrım',
    text: 'Her site yalnızca kendi verisini görür. Platform ekibi bir siteye yalnızca gerekçeli, en fazla 60 dakikalık, salt okunur ve kayıt altındaki destek oturumuyla bakabilir.',
    icon: Landmark,
  },
];

export type Faq = { question: string; answer: string };

export const FAQS: readonly Faq[] = [
  {
    question: 'Verilerimiz nerede saklanıyor?',
    answer:
      'Amazon Web Services’in Avrupa’daki Stockholm (eu-north-1) bölgesinde. Bağlantılar şifrelidir, veritabanında zamana göre geri dönüş (yedek) açıktır ve her site yalnızca kendi verisine erişir.',
  },
  {
    question: 'Sakinler aidatı nasıl öder? Online ödeme var mı?',
    answer:
      'Bugün havale veya EFT ile: sakin, sitenin IBAN’ını ve kendi referans kodunu portaldan kopyalar. Banka ekstresini yüklediğinizde ödemeler referans koduyla eşleştirilir. Kartla online ödeme altyapısı hazırdır ancak henüz kullanıma açılmadı.',
  },
  {
    question: 'Mobil uygulama var mı?',
    answer:
      'Sakinler, bina görevlileri ve güvenlik için iOS ve Android uygulaması mağaza yayınına hazırlanıyor; yakında App Store ve Google Play’de. O zamana kadar sakin portalı telefonun tarayıcısında çalışır ve ana ekrana eklenebilir.',
  },
  {
    question: 'Mevcut verilerimizi aktarabilir miyiz?',
    answer:
      'Evet. Daireleri, kişileri ve açılış bakiyelerini Excel veya CSV dosyasıyla toplu aktarabilirsiniz; aktarım önce önizlenir, hatalı satırlar raporlanır. Banka ekstreleri de CSV veya Excel olarak yüklenir.',
  },
  {
    question: 'Büyük ve çok bloklu sitelerde çalışır mı?',
    answer:
      'Evet. Bloklar ve bağımsız bölümler ayrı tanımlanır; 5.000 bölüme kadar toplu tahakkuk ve sayaç dağıtımı arka planda işlenir, ekrandan ilerlemesi izlenir.',
  },
  {
    question: 'Kullanmadığımız özellikleri kapatabilir miyiz?',
    answer:
      'Evet. Özellikler site bazında açılıp kapatılır; sade kurulumda yalnızca ihtiyacınız olan ekranlar görünür. Kapatılan bir özellik silinmez, istendiğinde yeniden açılır.',
  },
  {
    question: 'Fiyatlandırma nasıl?',
    answer: 'Fiyat, bağımsız bölüm sayısına ve kullanacağınız modüllere göre belirlenir. Demo formunu doldurun, sitenize özel teklif hazırlayalım.',
  },
];

export const PRICING = {
  title: 'Sitenizin büyüklüğüne göre teklif',
  text: 'Liste fiyatı yok: ücret, bağımsız bölüm sayısına ve kullanacağınız modüllere göre belirlenir. Pilot dönemde kurulum ve deneme ücretsizdir.',
} as const;

export const CONTACT = {
  title: 'Demo talep edin',
  lead: 'Formu doldurun; sitenize uygun kurulumu ve fiyatı birlikte konuşalım.',
  steps: [
    'Talebiniz bize ulaşır.',
    'Sizinle e-posta veya telefonla iletişime geçip sitenizin ihtiyaçlarını konuşuruz.',
    'Örnek verilerle sistemi birlikte inceler, pilot kurulumu planlarız.',
  ],
} as const;
