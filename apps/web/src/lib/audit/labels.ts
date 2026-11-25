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
};

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
  return action;
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
