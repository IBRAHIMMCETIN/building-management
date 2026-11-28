import {
  Briefcase,
  Building2,
  DoorOpen,
  Earth,
  HandCoins,
  Lock,
  type LucideIcon,
  Receipt,
  ScrollText,
  ShieldCheck,
  Split,
  UserRound,
  Vote,
  Wrench,
} from 'lucide-react';

/*
 * Tanitim sayfasinin metinleri. Yalnizca bugun calisan ozellikler yazilir (README "API Modulleri",
 * "Guvenlik ve izleme", "Finansal Kurallar"); canli olmayanlar acikca "henuz" / "yakinda" diye
 * belirtilir: kartla online odeme, mobil uygulamanin magazalarda yayini. WhatsApp bildirimi henuz
 * canli olmadigi icin hic anilmaz. Musteri logosu, yorum veya istatistik yoktur; gorsellerdeki
 * rakamlar "Örnek veri" etiketlidir. Hedef: 200+ daireli, cok bloklu siteler (sahibin 28.11.2026
 * karari, README "Geliştirme sırası").
 */

export const SECTION_IDS = {
  how: 'nasil-calisir',
  audiences: 'kimler-icin',
  features: 'ozellikler',
  mobile: 'mobil',
  trust: 'guven',
  pilot: 'pilot',
  faq: 'sss',
  contact: 'iletisim',
} as const;

/** Ust menu ve alt bilgi baglantilari (sayfa ici). */
export const NAV_LINKS: readonly { href: string; label: string }[] = [
  { href: `#${SECTION_IDS.how}`, label: 'Nasıl çalışır' },
  { href: `#${SECTION_IDS.audiences}`, label: 'Kimler için' },
  { href: `#${SECTION_IDS.features}`, label: 'Özellikler' },
  { href: `#${SECTION_IDS.mobile}`, label: 'Mobil' },
  { href: `#${SECTION_IDS.trust}`, label: 'Güven ve uyum' },
  { href: `#${SECTION_IDS.faq}`, label: 'SSS' },
];

export const HERO = {
  offer: 'Pilot dönemde ücretsiz deneme',
  title: 'Çok bloklu siteler için aidat, tahsilat ve arıza takibi',
  lead: 'Sakin, borcunu ve kendi ödeme referans kodunu telefonda büyük yazıyla görür; havale veya EFT ile öder. Siz banka ekstresini yüklersiniz; referans kodlu ödemeler ilgili daireye önerilir, tek tıkla veya toplu onayla işlenir.',
  points: [
    '200’den fazla bağımsız bölümlü, çok bloklu siteler için',
    'Kat Mülkiyeti Kanunu’na uygun malik ve kiracı ayrımı',
    'Borçlu isimleri hiçbir yerde herkese açık gösterilmez',
  ],
} as const;

export type Step = { title: string; text: string };

/** "Nasıl çalışır": gercek bir sira oldugu icin numaralidir. */
export const STEPS: readonly Step[] = [
  {
    title: 'Site kurulumu ve veri aktarımı',
    text: 'Bloklar, daireler, malik ve kiracılar ile açılış bakiyeleri Excel veya CSV dosyasından önizlenerek aktarılır; hatalı satırlar tek tek gösterilir.',
  },
  {
    title: 'Aidat ve tahsilat',
    text: 'Aylık aidat tek seferde tahakkuk eder. Sakin, sitenin IBAN’ına kendi referans koduyla havale yapar; ekstreyi yüklediğinizde referans kodlu ödemeler ilgili daireye önerilir, tek tıkla veya toplu onayla işlenir; kodsuz ödemeleri elle eşlersiniz.',
  },
  {
    title: 'Sakin ekranı ve mobil',
    text: 'Sakin borcunu, son ödeme gününü ve makbuzlarını görür, arıza bildirir. Telefonun tarayıcısında çalışır; mobil uygulama yakında mağazalarda.',
  },
  {
    title: 'Raporlar',
    text: 'Gelir-gider özeti, aidat durumu, aylık mizan ve banka mutabakatı PDF olarak alınır; genel kurul hazırlığı da aynı kayıtlarla yapılır.',
  },
];

export type Audience = { title: string; icon: LucideIcon; points: readonly string[] };

/** "Kimler için": hedef kitle (rol listesi degil). */
export const AUDIENCES: readonly Audience[] = [
  {
    title: '200+ daireli, çok bloklu siteler',
    icon: Building2,
    points: [
      'Bloklar ve bağımsız bölümler ayrı tanımlanır; duyurular blok bazında gönderilir.',
      '5.000 bölüme kadar toplu tahakkuk ve sayaç dağıtımı arka planda işlenir, ilerlemesi ekrandan izlenir.',
      'Her dairede malik ve kiracının carisi ayrıdır; boş dairede gider malike yazılır.',
    ],
  },
  {
    title: 'Yarı profesyonel yöneticiler',
    icon: Briefcase,
    points: [
      'Aidat, gider ve tahsilat sade ekranlarda; muhasebe defteri arka planda tutulur.',
      'Kullanmadığınız modüller talebiniz üzerine sitenizde gizlenir; ekranda yalnızca işinize yarayanlar kalır.',
      'Genel kurul çağrısı, hazirun cetveli ve KMK yeter sayı hesapları sistemde hazır.',
    ],
  },
  {
    title: 'Teknolojiyle arası iyi olmayan sakinler',
    icon: UserRound,
    points: [
      'Büyük yazı, sade ekran: borç ve son ödeme günü ilk bakışta görünür.',
      'IBAN ve referans kodu tek dokunuşla kopyalanır; muhasebe terimleri kullanılmaz.',
      'Uygulama kurmak gerekmez: telefonun tarayıcısında açılır, ana ekrana eklenebilir.',
    ],
  },
];

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
        text: 'Eşit, m² veya arsa payına göre toplu tahakkuk, gecikme tazminatı ve makbuz. Ödeme havale veya EFT ile; kartla online ödeme altyapısı hazır, henüz kullanıma açılmadı.',
      },
      {
        title: 'Banka ekstresi ve muhasebe defteri',
        text: 'CSV veya Excel ekstre yüklenir; referans kodlu ödemeler daireye önerilir, onayınızla işlenir. Gider, tedarikçi borcu, bütçe ve aylık dönem kapanışı aynı defterde.',
      },
      {
        title: 'Raporlar',
        text: 'Gelir-gider özeti, aidat durumu ve gecikmeler, aylık mizan, banka mutabakatı ve sayaç dağıtım dökümü PDF olarak.',
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
        text: 'Asansör, jeneratör, hidrofor gibi ekipmanların garanti ve kontrol tarihleri; bakım görevleri takvimden otomatik oluşur.',
      },
      {
        title: 'Ortak alan rezervasyonu',
        text: 'Toplantı salonu, spor alanı, misafirhane: saat dilimleri, kişi sınırı, onay ve iptal kuralı.',
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
        text: 'Sakin misafirine QR’lı geçiş gönderir, güvenlik okutup giriş kaydeder. Kurye gelince sakin “İçeri alınsın” der. Plaka sorgusu ve günlük kapı kayıtları.',
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
        text: 'Bağımsız bölüm veya arsa payı ağırlıklı oylama. Çağrı, hazirun cetveli, KMK m.30 yeter sayı ve m.31 çoğunluk hesapları, tutanak ve karar defteri.',
      },
      {
        title: 'İhale ve teklif şeffaflığı',
        text: 'Mantolama, asansör, çatı gibi işler için teklifler KDV dahil karşılaştırılır; karar ve gerekçesi sakinlerle paylaşılır.',
      },
      {
        title: 'Duyurular',
        text: 'Blok bazında duyuru, yayın onayı ve arşiv; duyurular sakin ekranında görünür.',
      },
    ],
  },
  {
    id: 'ekip',
    title: 'Kurulum ve ekip',
    icon: Briefcase,
    items: [
      {
        title: 'Toplu aktarım',
        text: 'Daireler, kişiler ve açılış bakiyeleri Excel veya CSV ile önizlenerek aktarılır; hatalı satırlar raporlanır.',
      },
      {
        title: 'Ekip ve roller',
        text: 'Yönetici, denetçi, bina görevlisi ve güvenlik rolleri site bazında verilir; herkes yalnızca kendi işini görür.',
      },
      {
        title: 'Birden çok site',
        text: 'Yönetim firmaları için portföy ekranı: sitelerin tahsilat oranı, açık talepleri ve yaklaşan genel kurulları tek yerde.',
      },
    ],
  },
];

export type MobileRoleId = 'resident' | 'guard' | 'staff';
export type MobileRole = { id: MobileRoleId; title: string; text: string };

export const MOBILE = {
  status: 'Yakında App Store ve Google Play’de',
  title: 'Sakin, görevli ve güvenlik için mobil uygulama',
  lead: 'iOS ve Android uygulaması mağaza yayınına hazırlanıyor. O zamana kadar sakin ekranı telefonun tarayıcısında çalışır ve ana ekrana eklenebilir; yönetim paneli web’de kalır.',
  stores: ['App Store', 'Google Play'],
  roles: [
    { id: 'resident', title: 'Sakin', text: 'Borç ve makbuzlar, arıza bildirimi, ziyaretçi ve kurye onayı, rezervasyon, oylamalar.' },
    { id: 'guard', title: 'Güvenlik', text: 'Kamera ile QR okutma, kısa kod, kurye masası, plaka sorgusu ve kapı kayıtları.' },
    { id: 'staff', title: 'Bina görevlisi', text: 'Günün işleri, önce-sonra fotoğraflı talep ve bakım tamamlama, sayaç okuma.' },
  ] satisfies readonly MobileRole[],
} as const;

export type TrustItem = { title: string; text: string; icon: LucideIcon };

export const TRUST = {
  title: 'Güven ve uyum',
  promise: 'Borçlu isimleri hiçbir yerde herkese açık gösterilmez.',
  promiseText: 'Bir dairenin borcunu yalnızca o dairenin sakinleri ve sitenin yetkili yönetimi görür.',
  items: [
    {
      title: 'Kat Mülkiyeti Kanunu’na uygun',
      text: 'Malik ve kiracının ayrı carisi: rutin gider oturana, demirbaş ve yatırım gideri malike yazılır. Genel kurulda KMK yeter sayı ve çoğunluk hesapları.',
      icon: Split,
    },
    {
      title: 'KVKK',
      text: 'Kişisel veride en az bilgi: IP adresleri kısaltılarak, karşı taraf IBAN’ları özet olarak tutulur. Aydınlatma metni yayında (taslak, hukuki incelemede).',
      icon: Lock,
    },
    {
      title: 'Değiştirilemez finansal defter',
      text: 'Kayıtlar silinmez ve üzerine yazılmaz; düzeltme ters kayıtla yapılır. Bakiyeler her gece defterle karşılaştırılır.',
      icon: Receipt,
    },
    {
      title: 'Denetim kaydı',
      text: 'Hassas işlemler, her kaydı bir öncekine bağlayan ve 10 yıl saklanan bir günlüğe yazılır; zincir her gece doğrulanır.',
      icon: ScrollText,
    },
    {
      title: 'İki adımlı doğrulama',
      text: 'Yönetici, yönetim firması ve denetçi hesaplarında doğrulayıcı uygulamasıyla iki adımlı giriş; bu hesaplar için zorunlu tutulabilir.',
      icon: ShieldCheck,
    },
    {
      title: 'Veriler Avrupa’da',
      text: 'Amazon Web Services’in Stockholm (eu-north-1) bölgesinde şifreli olarak saklanır; bağlantılar da şifrelidir. Her site yalnızca kendi verisini görür.',
      icon: Earth,
    },
  ] satisfies readonly TrustItem[],
} as const;

export const PILOT = {
  title: 'Pilot dönemde ücretsiz deneme',
  lead: 'YÖNESİST pilot aşamasında. Pilot dönemde kurulum, veri aktarımı ve kullanım ücretsizdir; ücretli kullanıma geçmeden önce fiyatı sitenizin büyüklüğüne göre sizinle konuşuruz.',
  points: [
    'Kurulumu ve veri aktarımını sizinle birlikte yaparız.',
    'İsterseniz önce bir iki blokla başlarsınız.',
    'Yöneticinin ve sakinlerin geri bildirimiyle ekranları birlikte düzeltiriz.',
  ],
  note: 'Liste fiyatı yok: ücret, bağımsız bölüm sayısına ve kullanacağınız modüllere göre belirlenir.',
} as const;

export type Faq = { question: string; answer: string };

export const FAQS: readonly Faq[] = [
  {
    question: 'Pilot dönemde ücret ödeyecek miyiz?',
    answer:
      'Hayır. Pilot dönem ücretsiz deneme olarak yürür. Ücretli kullanıma geçmeden önce fiyatı, bağımsız bölüm sayısına ve kullanacağınız modüllere göre sizinle konuşuruz; liste fiyatı yoktur.',
  },
  {
    question: 'Sakinler aidatı nasıl öder? Online ödeme var mı?',
    answer:
      'Bugün havale veya EFT ile: sakin, sitenin IBAN’ını ve kendi referans kodunu ekrandan kopyalar. Banka ekstresini yüklediğinizde referans kodlu ödemeler ilgili daireye önerilir; tek tıkla veya toplu onayla işlenir. Kartla online ödeme altyapısı hazırdır ancak henüz kullanıma açılmadı.',
  },
  {
    question: 'Yaşlı ya da teknolojiyle arası iyi olmayan sakinler kullanabilir mi?',
    answer:
      'Sakin ekranı bunun için sade tutuldu: borç ve son ödeme günü büyük yazıyla en üstte, IBAN ve referans kodu tek dokunuşla kopyalanır, “Arıza bildir” düğmesi ana sayfadadır. Uygulama kurmak gerekmez; ekran telefonun tarayıcısında açılır.',
  },
  {
    question: 'Mevcut verilerimizi aktarabilir miyiz?',
    answer:
      'Evet. Daireleri, kişileri ve açılış bakiyelerini Excel veya CSV dosyasıyla toplu aktarabilirsiniz; aktarım önce önizlenir, hatalı satırlar raporlanır. Pilot dönemde aktarımı sizinle birlikte yaparız.',
  },
  {
    question: 'Büyük ve çok bloklu sitelerde çalışır mı?',
    answer:
      'Evet, hedefimiz tam olarak bu siteler. Bloklar ve bağımsız bölümler ayrı tanımlanır; 5.000 bölüme kadar toplu tahakkuk ve sayaç dağıtımı arka planda işlenir, ilerlemesi ekrandan izlenir.',
  },
  {
    question: 'Verilerimiz nerede saklanıyor, kimler görebilir?',
    answer:
      'Amazon Web Services’in Avrupa’daki Stockholm (eu-north-1) bölgesinde. Veriler şifreli olarak saklanır, bağlantılar şifrelidir, her site yalnızca kendi verisine erişir ve borç bilgisini yalnızca dairenin kendi sakinleri ile yetkili yönetim görür. Platform ekibi bir siteye yalnızca gerekçeli, en fazla 60 dakikalık, salt okunur ve kayıt altındaki destek oturumuyla bakabilir.',
  },
  {
    question: 'Mobil uygulama var mı?',
    answer:
      'Sakinler, bina görevlileri ve güvenlik için iOS ve Android uygulaması mağaza yayınına hazırlanıyor; yakında App Store ve Google Play’de. O zamana kadar sakin ekranı telefonun tarayıcısında çalışır ve ana ekrana eklenebilir.',
  },
  {
    question: 'Kullanmadığımız özellikleri kapatabilir miyiz?',
    answer:
      'Evet. Özellikler talebiniz üzerine site bazında açılıp kapatılır; sade kurulumda yalnızca ihtiyacınız olan ekranlar görünür. Kapatılan bir özellik silinmez, istendiğinde yeniden açılır.',
  },
];

export const CONTACT = {
  title: 'Demo talep edin',
  lead: 'Formu doldurun; sitenizi, pilot sürecini ve kurulumu birlikte konuşalım.',
  steps: [
    'Talebiniz bize ulaşır.',
    'Sizinle e-posta veya telefonla iletişime geçip sitenizin ihtiyaçlarını konuşuruz.',
    'Örnek verilerle sistemi birlikte inceler, pilot kurulumu planlarız.',
  ],
} as const;
