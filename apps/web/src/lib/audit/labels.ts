import { ROLE_LABELS, isRole } from '@/types/roles';

/** Islem kategorileri (filtre: API `action` on eki). */
export const AUDIT_CATEGORIES = [
  { prefix: 'ledger.', label: 'Defter (tahakkuk, tahsilat, gider, ters kayıt)' },
  { prefix: 'closure.', label: 'Taşınma / cari kapama' },
  { prefix: 'finance.', label: 'Avans mahsubu ve borç yapılandırma' },
  { prefix: 'payment.', label: 'Online ödeme ve iade' },
  { prefix: 'membership.', label: 'Daire üyelikleri' },
  { prefix: 'ownership.', label: 'Mülkiyet sicili ve hisse devri' },
  { prefix: 'apartment_role.', label: 'Görev ve yönetici rolleri' },
  { prefix: 'person.', label: 'Kişiler ve davetler' },
  { prefix: 'site.', label: 'Site ayarları' },
  { prefix: 'import.', label: 'Toplu aktarım' },
  { prefix: 'bank.', label: 'Banka ekstresi ve eşleştirme' },
  { prefix: 'support.', label: 'Platform destek erişimi' },
  { prefix: 'mfa.', label: 'İki adımlı doğrulama' },
  { prefix: 'notification_preferences.', label: 'Bildirim tercihleri' },
  { prefix: 'ticket.', label: 'Arıza talepleri' },
  { prefix: 'maintenance.', label: 'Periyodik bakım' },
  { prefix: 'reservation.', label: 'Ortak alan rezervasyonu' },
  { prefix: 'tender.', label: 'İhale / teklif toplama' },
  { prefix: 'meters.', label: 'Sayaç ve endeks dağıtımı' },
  { prefix: 'poll.', label: 'Anket / oylama' },
  { prefix: 'assembly.', label: 'Genel kurul' },
  { prefix: 'gate.', label: 'Güvenlik kapısı (araç, misafir geçişi)' },
  { prefix: 'equipment.', label: 'Ekipman ve sözleşmeler' },
  { prefix: 'push_device.', label: 'Mobil bildirim cihazları' },
  { prefix: 'notification_suppression.', label: 'E-posta engelleri (platform)' },
] as const;

const EXACT: Record<string, string> = {
  'closure.create': 'Cari kapama',
  'closure.reverse': 'Cari kapama geri alındı',
  'finance.offset': 'Avans mahsubu',
  'finance.offset_reverse': 'Avans mahsubu geri alındı',
  'finance.offset_request': 'Sakin avans mahsubu talebi',
  'finance.offset_request_reject': 'Avans mahsubu talebi reddedildi',
  'finance.plan_create': 'Borç yapılandırma (taksit planı) oluşturuldu',
  'finance.plan_accelerate': 'Taksit planı muaccel kılındı',
  'finance.plan_pull_forward': 'Taksit planı erken kapatıldı',
  'finance.plan_cancel': 'Taksit planı iptal edildi',
  'finance.plan_default': 'Taksit planında temerrüt tespit edildi',
  'finance.plan_default_cleared': 'Taksit planı temerrüdü giderildi',
  'finance.plan_request': 'Sakin taksit (yapılandırma) talebi',
  'finance.plan_request_approve': 'Taksit talebi onaylandı (plan oluşturuldu)',
  'finance.plan_request_reject': 'Taksit talebi reddedildi',
  'finance.plan_request_withdraw': 'Taksit talebi sakin tarafından geri çekildi',
  'finance.plan_request_settings': 'Taksit talebi sınırları değişti',
  'finance.supplier_advance': 'Tedarikçiye avans verildi',
  'finance.supplier_advance_reverse': 'Tedarikçi avansı iptal edildi',
  'finance.supplier_advance_offset': 'Tedarikçi avansı faturaya mahsup edildi',
  'finance.supplier_advance_offset_reverse': 'Tedarikçi avans mahsubu geri alındı',
  'ownership.backfill': 'Mülkiyet sicili oluşturuldu (ilk geçiş)',
  'ownership.register': 'Mülkiyet sicili / hisseler düzeltildi',
  'ownership.billing': 'Malik faturalama modu değişti',
  'ownership.representative': 'Paydaş temsilcisi değişti',
  'ownership.transfer': 'Mülk / hisse devri',
  'ownership.transfer_reverse': 'Mülk / hisse devri geri alındı',
  'membership.create': 'Üyelik eklendi',
  'membership.update': 'Üyelik güncellendi',
  'apartment_role.create': 'Rol atandı',
  'apartment_role.update': 'Rol güncellendi',
  'apartment_role.invite': 'Ekibe yeniden davet edildi',
  'apartment_role.end': 'Rol sona erdirildi',
  'person.create': 'Kişi eklendi / davet edildi',
  'person.update': 'Kişi güncellendi',
  'site.create': 'Site oluşturuldu',
  'site.update': 'Site ayarları güncellendi',
  'site.features.update': 'Site özellikleri değişti',
  'site.features.enable_request': 'Özellik açma talebi gönderildi',
  'site.features.request_close': 'Özellik açma talebi kapandı',
  'import.create': 'Toplu aktarım başlatıldı',
  'payment.intent.create': 'Online ödeme başlatıldı',
  'payment.account.create': 'Ödeme hesabı oluşturuldu',
  'payment.account.update': 'Ödeme hesabı güncellendi',
  'payment.settings.update': 'Ödeme sağlayıcısı tercihi değişti',
  'payment.payout.sent': 'Apartmana aktarım talimatı gönderildi',
  'payment.payout.settled': 'Apartmana aktarım tamamlandı',
  'payment.payout.returned': 'Apartmana aktarım geri döndü',
  'payment.payout.resend_pending': 'Geri dönen aktarım yeniden gönderime alındı',
  'payment.payout.resend_sent': 'Geri dönen aktarım yeniden gönderildi',
  'payment.payout.resent': 'Geri dönen aktarım tamamlandı',
  'payment.payout.resend_failed': 'Geri dönen aktarımın yeniden gönderimi başarısız',
  'payment.invoice.draft': 'Platform komisyon faturası taslağı',
  'payment.invoice.needs_recipient': 'Platform faturası muhatabı eksik',
  'payment.invoice.issued': 'Platform komisyon faturası kesildi',
  'payment.invoice.cancelled': 'Platform faturası taslağı iptal edildi',
  'support.session.start': 'Destek oturumu açıldı',
  'support.session.end': 'Destek oturumu kapatıldı',
  'support.request': 'Destek oturumunda erişim',
  'mfa.totp.enable': 'İki adımlı doğrulama etkinleştirildi',
  'mfa.reset': 'İki adımlı doğrulama sıfırlandı',
  'mfa.reset.failed': 'MFA sıfırlama başarısız',
  'notification_preferences.update': 'Bildirim tercihi değişti',
  'bank.statement.preview': 'Banka ekstresi önizlendi',
  'bank.statement.commit': 'Banka ekstresi aktarıldı',
  'bank.format.save': 'Banka sütun eşlemesi kaydedildi',
  'bank.account.profile': 'Banka hesabı bilgileri güncellendi',
  'bank.line.match': 'Banka satırı eşleştirildi',
  'bank.line.unmatch': 'Banka eşleştirmesi geri alındı',
  'bank.line.ignore': 'Banka satırı yoksayıldı',
  'bank.line.restore': 'Yoksayılan banka satırı geri açıldı',
  'bank.line.expense': 'Banka satırından gider oluşturuldu',
  'bank.statement.auto_match': 'Banka satırları toplu onaylandı',
  'bank.line.payable': 'Banka satırından tedarikçi ödemesi yapıldı',
  'finance.period_close': 'Mali dönem kapatıldı',
  'finance.period_reopen': 'Mali dönem yeniden açıldı',
  'finance.budget_create': 'Bütçe / işletme projesi oluşturuldu',
  'finance.budget_approve': 'Bütçe / işletme projesi onaylandı',
  'finance.budget_delete': 'Bütçe taslağı silindi',
  // O1 arıza talepleri (apps/api/src/modules/tickets: create / update / assign / TRANSITIONS)
  'ticket.create': 'Arıza talebi oluşturuldu',
  'ticket.update': 'Arıza talebi güncellendi',
  'ticket.assign': 'Arıza talebi atandı',
  'ticket.start': 'Arıza talebinde çalışma başlatıldı',
  'ticket.hold': 'Arıza talebi beklemeye alındı',
  'ticket.resume': 'Arıza talebinde çalışmaya devam edildi',
  'ticket.resolve': 'Arıza talebi çözüldü',
  'ticket.confirm': 'Arıza çözümü sakin tarafından onaylandı',
  'ticket.close': 'Arıza talebi kapatıldı',
  'ticket.reopen': 'Arıza talebi yeniden açıldı',
  'ticket.cancel': 'Arıza talebi iptal edildi',
  'ticket.cost_link': 'Arıza talebine gider bağlandı',
  'ticket.cost_unlink': 'Arıza talebinden gider bağı kaldırıldı',
  // O1 periyodik bakım
  'maintenance.template_create': 'Bakım planı oluşturuldu',
  'maintenance.template_update': 'Bakım planı güncellendi',
  'maintenance.template_archive': 'Bakım planı arşivlendi',
  'maintenance.task_assign': 'Bakım görevi atandı',
  'maintenance.task_start': 'Bakım görevi başlatıldı',
  'maintenance.task_complete': 'Bakım görevi tamamlandı',
  'maintenance.task_skip': 'Bakım görevi atlandı',
  'maintenance.cost_link': 'Bakım görevine gider bağlandı',
  'maintenance.cost_unlink': 'Bakım görevinden gider bağı kaldırıldı',
  // Ortak alan rezervasyonu
  'reservation.facility_create': 'Ortak alan tanımlandı',
  'reservation.facility_update': 'Ortak alan güncellendi',
  'reservation.facility_deactivate': 'Ortak alan pasife alındı',
  'reservation.facility_activate': 'Ortak alan yeniden açıldı',
  'reservation.book': 'Rezervasyon yapıldı',
  'reservation.approve': 'Rezervasyon onaylandı',
  'reservation.reject': 'Rezervasyon reddedildi',
  'reservation.cancel': 'Rezervasyon iptal edildi',
  // Ihale / teklif toplama
  'tender.create': 'İhale oluşturuldu',
  'tender.update': 'İhale bilgileri güncellendi',
  'tender.collect': 'İhale teklif toplamaya açıldı',
  'tender.quote_add': 'İhaleye teklif eklendi',
  'tender.quote_update': 'İhale teklifi düzeltildi',
  'tender.quote_withdraw': 'İhale teklifi geri çekildi',
  'tender.publish': 'İhale sakinlerle paylaşıldı',
  'tender.decide': 'İhale karara bağlandı',
  'tender.cancel': 'İhale iptal edildi',
  'tender.comment': 'İhaleye yönetim yanıtı yazıldı',
  // Finans 2.3 sayaç / endeks
  'meters.meter_create': 'Sayaç eklendi',
  'meters.meter_update': 'Sayaç güncellendi',
  'meters.meter_retire': 'Sayaç kullanımdan kaldırıldı',
  'meters.swap_create': 'Sayaç değişimi kaydedildi',
  'meters.swap_reverse': 'Sayaç değişimi geri alındı',
  'meters.template_create': 'Dağıtım şablonu oluşturuldu',
  'meters.template_update': 'Dağıtım şablonu güncellendi',
  'meters.template_archive': 'Dağıtım şablonu arşivlendi',
  'meters.template_default': 'Varsayılan dağıtım şablonu değişti',
  'meters.readings_save': 'Sayaç okumaları kaydedildi',
  'meters.readings_import': 'Sayaç okumaları toplu içe aktarıldı',
  'meters.period_create': 'Sayaç dönemi oluşturuldu',
  'meters.period_update': 'Sayaç dönemi güncellendi',
  'meters.period_cancel': 'Sayaç dönemi iptal edildi',
  'meters.period_approve': 'Sayaç dönemi onaylandı',
  'meters.period_posted': 'Sayaç dönemi tahakkukları işlendi',
  'meters.period_reverse': 'Sayaç dönemi geri alma başlatıldı',
  'meters.period_reversed': 'Sayaç dönemi geri alındı',
  'meters.period_correction': 'Düzeltme dönemi açıldı',
  // Y1 anket / oylama
  'poll.publish': 'Oylama yayınlandı',
  'poll.close': 'Oylama erken kapatıldı',
  'poll.cancel': 'Oylama taslağı iptal edildi',
  'assembly.attendance': 'Genel kurul katılımı kaydedildi',
  'assembly.tally': 'Genel kurul gündem sayımı kaydedildi',
  'assembly.cancel': 'Genel kurul toplantısı iptal edildi',
  'assembly.tally_correction': 'Genel kurul kararı düzeltildi (yeni kayıt)',
  'assembly.call': 'Genel kurul çağrısı gönderildi',
  'assembly.call_resend': 'Genel kurul çağrısı yeniden gönderildi',
  'assembly.minutes': 'Genel kurul tutanağı güncellendi',
  'assembly.finalize': 'Genel kurul tutanağı kesinleştirildi',
  'assembly.create': 'Genel kurul toplantısı oluşturuldu',
  'assembly.update': 'Genel kurul toplantısı güncellendi',
  'assembly.quorum': 'Genel kurul toplantı yeter sayısı kaydedildi',
  'assembly.roll_freeze': 'Genel kurul hazirun listesi donduruldu',
  'poll.roll_freeze': 'Oylama oy listesi donduruldu',
  // Guvenlik kapisi (apps/api/src/modules/gate: service.ts, throttle.ts, departures.ts)
  'gate.vehicle.create': 'Araç kaydedildi',
  'gate.vehicle.update': 'Araç kaydı güncellendi (not / aktif-pasif)',
  'gate.pass.revoke': 'Misafir geçişi yönetimce iptal edildi',
  'gate.lockout': 'Kapı doğrulama deneme sınırı aşıldı',
  'gate.departure_release': 'Taşınma: geçişler iptal edildi, araçlar pasife alındı',
  // Ekipman, mobil cihaz ve diger etiketsiz kalanlar
  'equipment.create': 'Ekipman eklendi',
  'equipment.update': 'Ekipman güncellendi',
  'equipment.status': 'Ekipman durumu değişti',
  'equipment.document_add': 'Ekipmana belge eklendi',
  'equipment.document_archive': 'Ekipman belgesi arşivlendi',
  'push_device.register': 'Mobil cihaz bildirimlere kaydedildi',
  'push_device.remove': 'Mobil cihaz bildirim kaydı kaldırıldı',
  'reservation.auto_confirm': 'Rezervasyon otomatik onaylandı',
  'reservation.fee_manual_resolve': 'Rezervasyon ücret iadesi elle sonuçlandırıldı',
  'ticket.estimate': 'Arıza talebine maliyet tahmini girildi',
  'maintenance.task_estimate': 'Bakım görevine maliyet tahmini girildi',
  'ledger.document': 'Finans belgesi güncellendi',
  'import.in_progress': 'Toplu aktarım işleniyor',
  'import.completed': 'Toplu aktarım tamamlandı',
  'import.rolled_back': 'Toplu aktarım geri alındı',
  'payment.intent.pending': 'Online ödeme bekliyor',
  'payment.intent.succeeded': 'Online ödeme başarılı',
  'payment.intent.failed': 'Online ödeme başarısız',
  'payment.intent.needs_review': 'Online ödeme incelemeye alındı',
  'payment.intent.refund_pending': 'Online ödeme iadesi sürüyor',
  'payment.intent.refunded': 'Online ödeme iade edildi',
  'notification_suppression.clear': 'E-posta engeli kaldırıldı',
};

/** Sözlükte olmayan anahtarlar için alan adı (ilk parça) karşılıkları. */
const DOMAIN_LABELS: Record<string, string> = {
  ticket: 'Arıza talebi',
  maintenance: 'Bakım',
  meters: 'Sayaç',
  finance: 'Finans',
  bank: 'Banka',
  payment: 'Online ödeme',
  membership: 'Üyelik',
  ownership: 'Mülkiyet',
  apartment_role: 'Rol',
  person: 'Kişi',
  site: 'Site',
  support: 'Destek',
  mfa: 'İki adımlı doğrulama',
  closure: 'Cari kapama',
  import: 'Toplu aktarım',
  notification_preferences: 'Bildirim tercihi',
  poll: 'Oylama',
  assembly: 'Genel kurul',
  gate: 'Güvenlik kapısı',
  equipment: 'Ekipman',
  push_device: 'Mobil cihaz',
  reservation: 'Rezervasyon',
  tender: 'İhale',
  notification_suppression: 'E-posta engeli',
};

const humanize = (s: string) => s.replace(/[._]+/g, ' ').trim();

/**
 * Tanımsız anahtar için okunabilir yedek: `ticket.foo_bar` -> "Arıza talebi: foo bar".
 * Alan adı da bilinmiyorsa anahtarın kendisi (`yeni.islem`) korunur; böylece yeni olay tipleri
 * kaybolmaz, sözlüğe eklenmesi gerektiği görünür kalır.
 */
function fallbackLabel(action: string): string {
  const dot = action.indexOf('.');
  if (dot <= 0) return action;
  const domain = DOMAIN_LABELS[action.slice(0, dot)];
  return domain ? `${domain}: ${humanize(action.slice(dot + 1))}` : action;
}

const LEDGER_KINDS: Record<string, string> = {
  dues_charge: 'tahakkuk',
  payment: 'tahsilat',
  expense: 'gider',
  reversal: 'ters kayıt',
  late_fee: 'gecikme tazminatı',
  opening_balance: 'açılış bakiyesi',
  transfer: 'cari devri',
  refund: 'iade',
  payable_payment: 'tedarikçi ödemesi',
  offset: 'avans mahsubu',
  restructure: 'borç yapılandırma',
  supplier_advance: 'tedarikçi avansı',
  supplier_advance_offset: 'tedarikçi avans mahsubu',
};

/** Gece defter denetimi bulgu kodlari (apps/api/src/modules/finance/audit.ts `AUDIT_CODES`). */
export const LEDGER_FINDING_LABELS: Record<string, string> = {
  tx_unbalanced: 'Dengesiz işlem (borç ≠ alacak)',
  tx_entries_mismatch: 'İşlem satırları ile defter kayıtları uyuşmuyor',
  entry_orphan: 'İşlemi olmayan defter kaydı',
  entry_account_missing: 'Hesabı olmayan defter kaydı',
  balance_mismatch: 'Hesap bakiyesi defterle uyuşmuyor',
  closed_period_write: 'Kapatılmış döneme kayıt',
  closure_lock_missing: 'Cari kapama kilidi eksik',
  closure_lock_orphan: 'Kapaması olmayan cari kilidi',
  receipt_duplicate: 'Mükerrer makbuz numarası',
  receipt_counter_behind: 'Makbuz sayacı geride',
  online_payment_unposted: 'Deftere yazılmamış online ödeme',
  bank_match_mismatch: 'Banka eşleştirmesi defterle uyuşmuyor',
  settlement_invalid: 'Hedefli mahsup tutarsız (avans mahsubu / yapılandırma)',
  meter_period_mismatch: 'Sayaç dönemi tutar mutabakatı tutmuyor',
  meter_period_stuck: 'Sayaç dönemi yarıda kalmış (onay / geri alma)',
  fiscal_period_drift: 'Kapalı dönem özeti defterle uyuşmuyor',
  fiscal_closed_write: 'Kapanıştan sonra kapalı döneme kayıt',
  fiscal_lock_mismatch: 'Dönem kilidi tutarsız',
  ticket_cost_mismatch: 'Talep / bakım gideri özeti defterle uyuşmuyor',
  explink_orphan: 'Sahipsiz gider bağlantısı',
  supplier_advance_mismatch: 'Tedarikçi avansı kaydı defterle uyuşmuyor',
};

export function findingLabel(code: string): string {
  return LEDGER_FINDING_LABELS[code] ?? code.replace(/_/g, ' ');
}

/** `ledger.payment+late_fee` -> "Defter: tahsilat + gecikme faizi" */
export function actionLabel(action: string): string {
  const exact = EXACT[action];
  if (exact) return exact;
  if (action.startsWith('ledger.')) {
    const kinds = action.slice('ledger.'.length).split('+').filter(Boolean);
    return `Defter: ${kinds.map((k) => LEDGER_KINDS[k] ?? k.replace(/_/g, ' ')).join(' + ')}`;
  }
  if (action.startsWith('payment.intent.')) return `Online ödeme: ${action.slice('payment.intent.'.length).replace(/_/g, ' ')}`;
  if (action.startsWith('import.')) return `Toplu aktarım: ${action.slice('import.'.length).replace(/_/g, ' ')}`;
  return fallbackLabel(action);
}

export function roleLabel(role: string): string {
  if (role === 'system') return 'Sistem';
  if (role === 'user') return 'Kullanıcı';
  return isRole(role) ? ROLE_LABELS[role] : role;
}

/** Hash'i kisaltilmis gosterir: ilk 8 + son 6. */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}
