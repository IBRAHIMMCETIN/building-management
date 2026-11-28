import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', () => ({ apiClient: {} }));

import { accountStatusLabel } from '@/components/security/MfaResetDialog';
import { formatRemaining } from '@/components/support/SupportBanner';
import { actionLabel, roleLabel, shortHash } from '@/lib/audit/labels';
import { dayRangeToFilters } from '@/pages/admin/audit/AuditPage';
import { mergePeople } from '@/pages/admin/security/SecurityPage';

describe('denetim etiketleri', () => {
  it('islem kodlari Turkce; defter turleri birlesik; bilinmeyen kod oldugu gibi', () => {
    expect(actionLabel('mfa.reset')).toBe('İki adımlı doğrulama sıfırlandı');
    expect(actionLabel('ledger.dues_charge')).toBe('Defter: tahakkuk');
    expect(actionLabel('ledger.payment+late_fee')).toBe('Defter: tahsilat + gecikme tazminatı');
    expect(actionLabel('payment.intent.needs_review')).toBe('Online ödeme incelemeye alındı');
    expect(actionLabel('import.completed')).toBe('Toplu aktarım tamamlandı');
    // Tanimsiz durum: yedek yine on ekten okunur.
    expect(actionLabel('payment.intent.expired')).toBe('Online ödeme: expired');
    expect(actionLabel('yeni.islem')).toBe('yeni.islem');
    expect(actionLabel('ticket.create')).toBe('Arıza talebi oluşturuldu');
    expect(actionLabel('ticket.resolve')).toBe('Arıza talebi çözüldü');
    expect(actionLabel('maintenance.task_complete')).toBe('Bakım görevi tamamlandı');
    expect(actionLabel('maintenance.task_start')).toBe('Bakım görevi başlatıldı');
    // Tanımsız ama bilinen alan: okunabilir yedek.
    expect(actionLabel('ticket.photo_add')).toBe('Arıza talebi: photo add');
  });

  it('guvenlik kapisi eylemleri etiketli; bilinmeyen gate eylemi alan adiyla', () => {
    expect(actionLabel('gate.vehicle.create')).toBe('Araç kaydedildi');
    expect(actionLabel('gate.vehicle.update')).toBe('Araç kaydı güncellendi (not / aktif-pasif)');
    expect(actionLabel('gate.pass.revoke')).toBe('Misafir geçişi yönetimce iptal edildi');
    expect(actionLabel('gate.lockout')).toBe('Kapı doğrulama deneme sınırı aşıldı');
    expect(actionLabel('gate.departure_release')).toBe('Taşınma: geçişler iptal edildi, araçlar pasife alındı');
    expect(actionLabel('gate.courier_new')).toBe('Güvenlik kapısı: courier new');
    expect(actionLabel('equipment.status')).toBe('Ekipman durumu değişti');
    expect(actionLabel('notification_suppression.clear')).toBe('E-posta engeli kaldırıldı');
  });

  it('rol ve hash gosterimi', () => {
    expect(roleLabel('apartment_manager')).toBe('Apartman Yöneticisi');
    expect(roleLabel('system')).toBe('Sistem');
    expect(roleLabel('baska')).toBe('baska');
    expect(shortHash('a'.repeat(64))).toBe('aaaaaaaa…aaaaaa');
  });

  it('gun araligi Istanbul gun basi/sonu ISO filtresine cevrilir; bos alanlar gonderilmez', () => {
    expect(dayRangeToFilters({ fromDay: '2026-11-01', toDay: '2026-11-21', action: 'mfa.', actorId: ' u1 ' })).toEqual({
      from: '2026-11-01T00:00:00+03:00',
      to: '2026-11-21T23:59:59+03:00',
      action: 'mfa.',
      actorId: 'u1',
    });
    expect(dayRangeToFilters({ fromDay: '', toDay: '', action: '', actorId: '  ' })).toEqual({});
  });
});

describe('guvenlik ekrani', () => {
  it('kisiler ve gorev rolleri kullanici basina tek satirda, ada gore sirali', () => {
    const merged = mergePeople(
      [
        { userId: 'u2', fullName: 'Zeynep Kaya', email: 'z@o.com' },
        { userId: 'u1', fullName: 'Ahmet Çelik', email: 'a@o.com' },
      ],
      [
        { userId: 'u1', role: 'apartment_manager' },
        { userId: 'u3', role: 'building_staff', displayName: 'Mehmet (Kapıcı)' },
      ],
    );
    expect(merged).toEqual([
      { userId: 'u1', name: 'Ahmet Çelik', email: 'a@o.com', roles: ['resident', 'apartment_manager'] },
      { userId: 'u3', name: 'Mehmet (Kapıcı)', roles: ['building_staff'] },
      { userId: 'u2', name: 'Zeynep Kaya', email: 'z@o.com', roles: ['resident'] },
    ]);
  });

  it('hesap durumu metinleri', () => {
    expect(accountStatusLabel({ accountEnabled: false })).toBe('Hesap devre dışı');
    expect(accountStatusLabel({ accountEnabled: true, status: 'FORCE_CHANGE_PASSWORD' })).toBe('Davet edildi, ilk giriş yapılmadı');
    expect(accountStatusLabel({ accountEnabled: true, status: 'CONFIRMED' })).toBe('Aktif');
  });

  it('destek oturumu geri sayimi', () => {
    const now = Date.parse('2026-11-21T10:00:00.000Z');
    expect(formatRemaining('2026-11-21T10:12:05.000Z', now)).toBe('12:05');
    expect(formatRemaining('2026-11-21T09:00:00.000Z', now)).toBe('00:00');
  });
});
