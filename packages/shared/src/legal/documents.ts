/*
 * Hukuki metinler (KVKK aydinlatma metni, gizlilik politikasi, kullanim kosullari) icin TEK kaynak.
 *
 * DURUM: TASLAK. Metinler hukuki inceleme gormemistir; avukat sureci (yol haritasi Adim 12)
 * tamamlanana kadar her ekranda "taslak" uyarisiyla gosterilir. Avukat yalnizca bu dosyadaki
 * metinleri degistirir; sayfa bilesenleri metin icermez.
 *
 * Surum: her metnin `version` + `updatedAt` alani vardir. Metin degisince `version` yukseltilir.
 * Adim 8 (surumlu "okudum" kaydi) ve tanitim sayfasindaki demo formunun KVKK onayi bu surumu
 * kaydeder (`kvkkVersion`); boylece hangi metnin onaylandigi sonradan bilinir.
 *
 * Koseli parantezli yerler ([...]) sirket kurulup bilgiler netlesince doldurulacak yer tutuculardir.
 */

export type LegalDocumentKey = 'kvkk' | 'privacy' | 'terms';

export type LegalSection = {
  heading: string;
  paragraphs?: readonly string[];
  items?: readonly string[];
};

export type LegalDocument = {
  key: LegalDocumentKey;
  /** Web adresi (`/kvkk`, `/gizlilik`, `/kullanim-kosullari`). */
  path: string;
  title: string;
  /** Metin surumu; degisince yukseltilir ve onay kayitlarina yazilir. */
  version: string;
  /** Son guncelleme (YYYY-MM-DD, Europe/Istanbul). */
  updatedAt: string;
  status: 'draft';
  summary: string;
  sections: readonly LegalSection[];
};

/** Taslak uyarisi: metinler avukat onayindan gecene kadar her sayfada gosterilir. */
export const LEGAL_DRAFT_NOTICE =
  'Bu metin taslaktır ve hukuki inceleme gerekir. Kesin metin, avukat incelemesinden sonra bu sayfada yayımlanacaktır.';

/** Veri sorumlusu / hizmet sağlayıcı bilgileri (şirket kuruluşundan sonra doldurulacak). */
export const LEGAL_PROVIDER = {
  name: '[Hizmet sağlayıcı şirketin unvanı]',
  address: '[Şirket adresi]',
  email: '[KVKK başvuru e-posta adresi]',
  kep: '[KEP adresi]',
} as const;

const RIGHTS: readonly string[] = [
  'Kişisel verilerinizin işlenip işlenmediğini öğrenme,',
  'İşlenmişse buna ilişkin bilgi talep etme,',
  'İşlenme amacını ve amacına uygun kullanılıp kullanılmadığını öğrenme,',
  'Yurt içinde veya yurt dışında aktarıldığı üçüncü kişileri bilme,',
  'Eksik veya yanlış işlenmişse düzeltilmesini isteme,',
  'KVKK m.7 çerçevesinde silinmesini veya yok edilmesini isteme,',
  'Düzeltme, silme ve yok etme işlemlerinin verilerin aktarıldığı üçüncü kişilere bildirilmesini isteme,',
  'İşlenen verilerin münhasıran otomatik sistemlerle analiz edilmesi suretiyle aleyhinize bir sonucun ortaya çıkmasına itiraz etme,',
  'Kanuna aykırı işleme sebebiyle zarara uğramanız hâlinde zararın giderilmesini talep etme.',
];

export const KVKK_NOTICE: LegalDocument = {
  key: 'kvkk',
  path: '/kvkk',
  title: 'KVKK Aydınlatma Metni',
  version: '2026-11-28-taslak-2',
  updatedAt: '2026-11-28',
  status: 'draft',
  summary:
    '6698 sayılı Kişisel Verilerin Korunması Kanunu (KVKK) m.10 uyarınca, YÖNESİST bina ve site yönetim sistemi kapsamında işlenen kişisel veriler hakkında bilgilendirme.',
  sections: [
    {
      heading: 'Veri sorumlusu ve veri işleyen',
      paragraphs: [
        'YÖNESİST, apartman, site ve toplu konut yönetimlerine sunulan bir yazılım hizmetidir. Bir sitenin sakinlerine, kat maliklerine, kiracılarına ve çalışanlarına ait veriler bakımından veri sorumlusu, o sitenin yönetimidir (yönetici, yönetim kurulu veya yetkilendirdiği profesyonel yönetim firması). Hizmet sağlayıcı, bu veriler bakımından yönetimin talimatıyla hareket eden veri işleyendir.',
        `Tanıtım sitesindeki demo talep formu, yönetim firması ve site yöneticisi hesapları ile platformun işletilmesine ilişkin veriler bakımından veri sorumlusu hizmet sağlayıcıdır: ${LEGAL_PROVIDER.name}, ${LEGAL_PROVIDER.address}.`,
      ],
    },
    {
      heading: 'İşlenen kişisel veriler',
      items: [
        'Kimlik ve iletişim: ad soyad, e-posta adresi, telefon numarası.',
        'Bağımsız bölüm ilişkisi: blok ve daire bilgisi, malik veya kiracı sıfatı, hisse oranı, taşınma tarihleri.',
        'Finansal: aidat ve diğer tahakkuklar, ödemeler, makbuzlar, gecikme tazminatı, banka ekstresi satırları (karşı taraf IBAN’ı yalnızca özet değeri olarak).',
        'Talep ve bakım: arıza ve talep kayıtları, açıklamalar, yüklenen fotoğraflar.',
        'Güvenlik kapısı: misafir adı, araç plakası, kurye ve ziyaretçi giriş-çıkış kayıtları.',
        'Yönetişim: anket ve oylama katılımı, genel kurul hazirun ve vekâlet bilgisi.',
        'İşlem güvenliği: oturum bilgileri, iki adımlı doğrulama durumu, kısaltılmış IP adresi (IPv4 için son bölüm sıfırlanır) ve tarayıcı bilgisi içeren denetim kayıtları.',
        'Demo talep formu: ad soyad, e-posta, telefon (isteğe bağlı), site veya firma adı, bağımsız bölüm sayısı aralığı, mesajınız ve kısaltılmış IP adresi (IPv4 için son bölüm sıfırlanır). Tarayıcı bilgisi saklanmaz. Kötüye kullanımı önlemek için IP adresinin gizli anahtarla üretilmiş, geri döndürülemeyen bir özeti en fazla 2 saat, günlük toplam sayaç en fazla 25 saat tutulur.',
      ],
    },
    {
      heading: 'İşleme amaçları',
      items: [
        'Aidat, gider ve tahsilatların Kat Mülkiyeti Kanunu’na uygun olarak hesaplanması, kaydedilmesi ve raporlanması,',
        'Sakinlere borç durumu, makbuz, duyuru ve bildirimlerin iletilmesi,',
        'Arıza, bakım, rezervasyon, ziyaretçi ve güvenlik kapısı işlemlerinin yürütülmesi,',
        'Anket, oylama ve kat malikleri kurulu işlemlerinin hazırlanması ve kayıt altına alınması,',
        'Hesap ve işlem güvenliğinin sağlanması, kötüye kullanımın önlenmesi, denetim kayıtlarının tutulması,',
        'Demo talebinize dönüş yapılması ve teklif hazırlanması.',
      ],
    },
    {
      heading: 'Hukuki sebepler',
      paragraphs: [
        'Kişisel verileriniz KVKK m.5/2 kapsamında; bir sözleşmenin kurulması veya ifasıyla doğrudan ilgili olması (c), veri sorumlusunun hukuki yükümlülüğünü yerine getirmesi (ç; özellikle 634 sayılı Kat Mülkiyeti Kanunu ve vergi mevzuatı), bir hakkın tesisi, kullanılması veya korunması (e) ve temel hak ve özgürlüklerinize zarar vermemek kaydıyla veri sorumlusunun meşru menfaati (f) hukuki sebeplerine dayanılarak işlenir. Açık rıza gerektiren hâllerde ayrıca rızanız alınır.',
      ],
    },
    {
      heading: 'Aktarım ve saklama yeri',
      paragraphs: [
        'Veriler, hizmetin barındırıldığı Amazon Web Services altyapısında Avrupa Birliği’nde (Stockholm, eu-north-1 bölgesi) saklanır. Bu durum KVKK m.9 kapsamında yurt dışına aktarım niteliğindedir; aktarımın dayanağı ve gerekli bildirimler hukuki inceleme sonucunda netleştirilecektir.',
        'Veriler; ilgili site yönetimi, yönetimin yetkilendirdiği çalışanlar (bina görevlisi, güvenlik), barındırma ve e-posta altyapısı sağlayıcıları ve kanunen yetkili kurumlarla, amaçla sınırlı olarak paylaşılabilir. Borçlu kişilerin adları herkese açık bir listede veya panoda yayımlanmaz.',
      ],
    },
    {
      heading: 'Saklama süreleri',
      items: [
        'Finansal kayıtlar ve makbuzlar: ilgili mevzuatın öngördüğü süre boyunca (en az 10 yıl).',
        'Denetim kayıtları: 10 yıl.',
        'Demo talep formu kayıtları: talepten itibaren 2 yıl; sonra otomatik olarak silinir. Silme talebinizde kişisel alanlar hemen kaldırılır.',
        'Diğer kayıtlar: işleme amacının gerektirdiği süre; süre dolunca silinir, yok edilir veya anonim hâle getirilir.',
      ],
    },
    {
      heading: 'KVKK m.11 kapsamındaki haklarınız',
      items: RIGHTS,
    },
    {
      heading: 'Başvuru',
      paragraphs: [
        `Haklarınıza ilişkin taleplerinizi, bir site sakini iseniz öncelikle sitenizin yönetimine; diğer hâllerde ${LEGAL_PROVIDER.email} adresine veya ${LEGAL_PROVIDER.kep} KEP adresine iletebilirsiniz. Başvurular en geç 30 gün içinde ücretsiz olarak sonuçlandırılır.`,
      ],
    },
  ],
};

export const PRIVACY_POLICY: LegalDocument = {
  key: 'privacy',
  path: '/gizlilik',
  title: 'Gizlilik Politikası',
  version: '2026-11-28-taslak-3',
  updatedAt: '2026-11-28',
  status: 'draft',
  summary: 'YÖNESİST web sitesinde, web uygulamasında ve yayımlandığında mobil uygulamasında verilerinizin nasıl korunduğu ve kullanıldığı.',
  sections: [
    {
      heading: 'Kapsam',
      paragraphs: [
        'Bu politika; tanıtım sitesini, yönetim paneli ve sakin portalından oluşan web uygulamasını ve yayımlandığında mobil uygulamayı kapsar. Kişisel verilerin işlenmesine ilişkin ayrıntılar KVKK Aydınlatma Metni’ndedir.',
      ],
    },
    {
      heading: 'Çerezler ve tarayıcı deposu',
      paragraphs: [
        'Reklam veya izleme çerezi kullanılmaz; üçüncü taraf analitik aracı yoktur. Oturumunuzun açık kalması için gereken kimlik bilgileri tarayıcınızın yerel deposunda, mobil uygulamada ise cihazın güvenli deposunda (Keychain / Keystore) tutulur. Uygulamanın hızlı açılması için yalnızca uygulama dosyaları önbelleğe alınır; kişisel veriler önbelleğe alınmaz.',
      ],
    },
    {
      heading: 'Güvenlik önlemleri',
      items: [
        'Tüm bağlantılar şifrelidir (HTTPS).',
        'Yönetici, yönetim firması ve denetçi hesaplarında iki adımlı doğrulama (TOTP) zorunludur.',
        'Her site yalnızca kendi verisine erişir; yetki kontrolü sunucu tarafında, oturum bilgisindeki apartman ve rol üzerinden yapılır.',
        'Finansal defter yalnızca eklemeye açıktır: kayıtlar değiştirilmez veya silinmez, düzeltmeler ters kayıtla yapılır.',
        'Hassas işlemler, her kaydı bir öncekine SHA-256 özetiyle bağlanan ve değiştirilemeyen bir denetim günlüğüne yazılır.',
        'Platform ekibi bir sitenin verisine yalnızca gerekçeli, süreli (en fazla 60 dakika), salt okunur ve her isteği kaydedilen destek oturumuyla erişebilir.',
      ],
    },
    {
      heading: 'Veri en aza indirme',
      paragraphs: [
        'Kayıtlarda IP adresi kısaltılarak tutulur; deneme sınırı için yalnızca gizli anahtarlı, geri döndürülemeyen özeti birkaç saat tutulur. Banka ekstresindeki karşı taraf IBAN’ı düz metin olarak saklanmaz. Borçlu kişilerin adları herkese açık bir listede gösterilmez; sakinler başka sakinlerin borcunu, oyunu veya kişisel bilgisini göremez.',
      ],
    },
    {
      heading: 'Mobil uygulama izinleri',
      paragraphs: [
        'Mobil uygulama mağazalarda yayımlandığında, kamera yalnızca misafir QR kodunu okutmak ve arıza fotoğrafı çekmek için, fotoğraf kitaplığı yalnızca seçtiğiniz fotoğrafı yüklemek için, bildirim izni duyuru ve kapı bildirimleri için istenir. İzinleri dilediğiniz zaman cihaz ayarlarından kapatabilirsiniz.',
      ],
    },
    {
      heading: 'İletişim',
      paragraphs: [`Gizlilikle ilgili sorularınız için: ${LEGAL_PROVIDER.email}.`],
    },
  ],
};

export const TERMS_OF_USE: LegalDocument = {
  key: 'terms',
  path: '/kullanim-kosullari',
  title: 'Kullanım Koşulları',
  version: '2026-11-28-taslak-1',
  updatedAt: '2026-11-28',
  status: 'draft',
  summary: 'YÖNESİST hizmetini kullanan site yönetimleri, yönetim firmaları ve sakinler için kullanım koşulları.',
  sections: [
    {
      heading: 'Taraflar ve hizmet',
      paragraphs: [
        `Hizmet, ${LEGAL_PROVIDER.name} tarafından sunulur. YÖNESİST; aidat ve tahsilat takibi, muhasebe kayıtları, arıza ve bakım, güvenlik kapısı, rezervasyon, anket, genel kurul, ihale ve duyuru işlemleri için bir yazılım hizmetidir. Hizmetin kapsamı ve ücreti site yönetimiyle yapılan sözleşmede belirlenir.`,
      ],
    },
    {
      heading: 'Hesaplar ve roller',
      items: [
        'Hesaplar site yönetiminin daveti veya hizmet sağlayıcının kurulumuyla açılır; her kullanıcı kendisine tanımlanan rol (yönetici, yönetim firması, denetçi, bina görevlisi, güvenlik, sakin) kadar yetkiye sahiptir.',
        'Şifrenizi ve iki adımlı doğrulama cihazınızı başkalarıyla paylaşmamakla sorumlusunuz.',
        'Hesabınızın yetkisiz kullanıldığından şüphelenirseniz site yönetimine veya hizmet sağlayıcıya derhal bildirmelisiniz.',
      ],
    },
    {
      heading: 'Site yönetiminin sorumlulukları',
      paragraphs: [
        'Sisteme girilen bağımsız bölüm, kişi, aidat ve gider bilgilerinin doğruluğundan ve bu verilerin hukuka uygun işlenmesinden veri sorumlusu sıfatıyla site yönetimi sorumludur. Hizmet, yönetimin Kat Mülkiyeti Kanunu ve yönetim planından doğan yükümlülüklerinin yerine geçmez.',
      ],
    },
    {
      heading: 'Kullanım kuralları',
      items: [
        'Hizmet hukuka aykırı amaçlarla, başkalarının haklarını ihlal edecek şekilde veya sisteme zarar verecek biçimde kullanılamaz.',
        'Otomatik araçlarla toplu sorgu, güvenlik önlemlerini aşma veya başka bir sitenin verisine erişme girişimi yasaktır.',
      ],
    },
    {
      heading: 'Ödemeler',
      paragraphs: [
        'Aidat ödemeleri site yönetiminin banka hesabına havale veya EFT ile yapılır; ödemeler banka ekstresiyle eşleştirilerek sakin carisine işlenir. Kartla online ödeme özelliği henüz kullanıma açılmamıştır; açıldığında koşulları ayrıca duyurulur.',
      ],
    },
    {
      heading: 'Hizmetin sürekliliği ve değişiklikler',
      paragraphs: [
        'Hizmet sağlayıcı, hizmeti sürekli ve güvenli tutmak için makul özeni gösterir; bakım, güncelleme veya beklenmeyen arızalar nedeniyle kesintiler olabilir. Özellikler zaman içinde geliştirilebilir veya site bazında açılıp kapatılabilir.',
      ],
    },
    {
      heading: 'Sorumluluğun sınırı',
      paragraphs: [
        'Hizmet sağlayıcı, kullanıcıların sisteme girdiği verilerin içeriğinden ve site yönetimi ile sakinler arasındaki uyuşmazlıklardan sorumlu değildir. Sorumluluğun kapsamı ve üst sınırı sözleşmede belirlenir.',
      ],
    },
    {
      heading: 'Sözleşmenin sona ermesi',
      paragraphs: [
        'Sözleşme sona erdiğinde site yönetimi, kayıtlarının dışa aktarılmasını talep edebilir. Mevzuatın saklanmasını zorunlu kıldığı kayıtlar dışındaki veriler, süre sonunda silinir veya anonim hâle getirilir.',
      ],
    },
    {
      heading: 'Uygulanacak hukuk',
      paragraphs: ['Bu koşullar Türkiye Cumhuriyeti hukukuna tabidir. Uyuşmazlıklarda [yetkili mahkeme ve icra daireleri] yetkilidir.'],
    },
  ],
};

export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocumentKey, LegalDocument>> = {
  kvkk: KVKK_NOTICE,
  privacy: PRIVACY_POLICY,
  terms: TERMS_OF_USE,
};

export const LEGAL_DOCUMENT_ORDER: readonly LegalDocumentKey[] = ['kvkk', 'privacy', 'terms'];

/**
 * Demo formunun KVKK onayinda kabul edilen aydinlatma metni surumleri (API `KVKK_VERSIONS` ile ayni;
 * apps/api/test/demo-requests-parity.test.ts). Metin degisince yeni surum eklenir; yayinlanmis eski
 * surum, acik kalmis sekmelerden gelen talepler icin bir sure listede kalabilir.
 */
export const KVKK_ACCEPTED_VERSIONS: readonly string[] = [KVKK_NOTICE.version];
