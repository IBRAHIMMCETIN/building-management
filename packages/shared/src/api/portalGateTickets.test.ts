import { describe, expect, it } from 'vitest';
import { partySizeError } from '../reservations/model';
import { formatShortCode, normalizePlate, passFormError, passFormIssue, passLink, plateError, validityText } from './portalGate';
import { MAX_PHOTO_BYTES, newTicketTextSchema, photoError, reopenNoteSchema, ticketCommentSchema, ticketEventAuthor, ticketEventTitle } from './portalTickets';

describe('sakin kapisi yardimcilari (web lib/gate ile ayni kurallar)', () => {
  it('plaka: normallestirme ve Turkiye bicimi', () => {
    expect(normalizePlate('34 abc-123')).toBe('34ABC123');
    expect(normalizePlate('06 ıi 1234')).toBe('06II1234');
    expect(plateError('34 ABC 123')).toBeUndefined();
    expect(plateError('')).toBe('Plaka girin');
    expect(plateError('99 X 1')).toMatch(/Türkiye plaka/);
  });

  it('gecis formu: ad, tarih sirasi, en fazla ileri tarih ve sure', () => {
    const base = { guestName: 'Ayşe', validFrom: '2026-11-28', validUntil: '', today: '2026-11-28', maxPassDays: 31, maxPassLeadDays: 90 };
    expect(passFormError(base)).toBeUndefined();
    expect(passFormError({ ...base, guestName: 'A' })).toBe('Misafirin adını yazın (en az 2 karakter).');
    expect(passFormError({ ...base, validFrom: '2026-11-27' })).toBe('Geçiş bugünden önce başlayamaz.');
    expect(passFormError({ ...base, validFrom: '2027-03-01' })).toBe('Geçiş en fazla 90 gün sonrası için oluşturulabilir.');
    expect(passFormError({ ...base, validUntil: '2026-11-27' })).toBe('Son gün geliş tarihinden önce olamaz.');
    expect(passFormError({ ...base, validUntil: '2026-12-29' })).toBe('Bir geçiş en fazla 31 gün geçerli olabilir.');
    // Mobil hatayi ait oldugu alanin altinda gosterir.
    expect(passFormIssue({ ...base, guestName: '' })?.field).toBe('guestName');
    expect(passFormIssue({ ...base, validFrom: '2026-11-27' })?.field).toBe('validFrom');
    expect(passFormIssue({ ...base, validUntil: '2026-11-27' })?.field).toBe('validUntil');
  });

  it('kisi sayisi: bos gecerli, 1..kapasite tam sayi', () => {
    expect(partySizeError('', 10)).toBeUndefined();
    expect(partySizeError(' 8 ', 10)).toBeUndefined();
    expect(partySizeError('0', 10)).toBe('1–10 arasında olmalı');
    expect(partySizeError('2.5', 10)).toBe('1–10 arasında olmalı');
    expect(partySizeError('11', 10)).toBe('1–10 arasında olmalı');
  });

  it('paylasim: kisa kod, baglanti (kod # icinde), gecerlilik', () => {
    expect(formatShortCode('K7M2PQ4X')).toBe('K7M2-PQ4X');
    expect(passLink('https://web.test/', 'tok_123', 'K7M2PQ4X')).toBe('https://web.test/gecis/tok_123#K7M2PQ4X');
    expect(validityText('2026-11-28', '2026-11-28')).toBe('28 Kas 2026');
    expect(validityText('2026-11-28', '2026-11-30')).toBe('28 Kas 2026 – 30 Kas 2026');
  });
});

describe('sakin talep yardimcilari', () => {
  it('fotograf turu ve boyutu (API siniri 10 MB)', () => {
    expect(photoError({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(photoError({ type: 'image/gif', size: 1000 })).toBe('Fotoğraf JPEG, PNG, WEBP veya HEIC olmalı.');
    expect(photoError({ type: 'image/png', size: 0 })).toBe('Dosya boş.');
    expect(photoError({ type: 'image/png', size: MAX_PHOTO_BYTES + 1 })).toBe('Fotoğraf en fazla 10 MB olabilir.');
  });

  it('zaman cizelgesi basligi ve yazan', () => {
    expect(ticketEventTitle({ kind: 'status_changed', from: 'open', to: 'assigned' })).toBe('Açık → Atandı');
    expect(ticketEventTitle({ kind: 'assigned', assigneeId: 'u1' })).toBe('Görevli atandı');
    expect(ticketEventTitle({ kind: 'comment' })).toBe('Yorum');
    expect(ticketEventAuthor({ mine: true })).toBe('Siz');
    expect(ticketEventAuthor({ byRole: 'building_staff' })).toBe('Bina Görevlisi');
    expect(ticketEventAuthor({ byRole: 'nope' })).toBeUndefined();
  });

  it('form kurallari: baslik 3+, aciklama zorunlu, yeniden acma gerekcesi 3+', () => {
    expect(newTicketTextSchema.safeParse({ title: 'ab', description: 'x' }).success).toBe(false);
    expect(newTicketTextSchema.safeParse({ title: 'Su kaçağı', description: '  ' }).success).toBe(false);
    expect(newTicketTextSchema.safeParse({ title: 'Su kaçağı', description: 'Banyoda' }).success).toBe(true);
    expect(reopenNoteSchema.safeParse(' ok ').success).toBe(false);
    expect(ticketCommentSchema.safeParse('   ').success).toBe(false);
  });
});
