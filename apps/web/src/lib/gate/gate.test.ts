import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { courierSchema, deskPassSchema, gateLogPageSchema, managerPassSchema, myPassSchema, plateLookupSchema } from '@/lib/api/gate';
import { cameraErrorMessage, scannerSupport } from './camera';
import { passFormError } from './pass';
import { COURIER_TEXT, VERDICT_TEXT, courierState, formatPlate, formatShortCode, isTurkishPlate, normalizePlate, normalizeShortCode, parseScan, passLink, plateError, validityText } from './plate';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv_-';

describe('plaka (API kurallariyla ayni)', () => {
  it('normalizasyon ve bicim', () => {
    expect(normalizePlate('34 abc 123')).toBe('34ABC123');
    expect(normalizePlate('06-ab.1234')).toBe('06AB1234');
    expect(normalizePlate('35 ı 4567')).toBe('35I4567');
    expect(formatPlate('34ABC123')).toBe('34 ABC 123');
    expect(formatPlate('35A12345')).toBe('35 A 12345');
    for (const ok of ['34ABC123', '34ABC12', '06AB1234', '35A1234', '81ZZ999']) expect(isTurkishPlate(ok)).toBe(true);
    for (const bad of ['00ABC123', '82AB123', '34ABCD12', '34A123', '34AB12', '34QA123', '34ÇA123']) expect(isTurkishPlate(bad)).toBe(false);
  });

  it('form hata metni', () => {
    expect(plateError('34 abc 123')).toBeUndefined();
    expect(plateError('')).toBe('Plaka girin');
    expect(plateError('34 X 12')).toMatch(/Türkiye plaka biçiminde/);
  });
});

describe('QR / kisa kod', () => {
  it('kisa kod normalize ve gosterim', () => {
    expect(normalizeShortCode('k7m2-pq4x')).toBe('K7M2PQ4X');
    expect(normalizeShortCode('K7M2PQ40')).toBeUndefined();
    expect(normalizeShortCode('K7M2PQ4')).toBeUndefined();
    expect(formatShortCode('K7M2PQ4X')).toBe('K7M2-PQ4X');
  });

  it('paylasim baglantisi kisisel veri tasimaz; kod # icinde', () => {
    expect(passLink('https://site.example/', TOKEN, 'K7M2PQ4X')).toBe(`https://site.example/gecis/${TOKEN}#K7M2PQ4X`);
    expect(passLink('https://site.example', TOKEN)).toBe(`https://site.example/gecis/${TOKEN}`);
  });

  it('okutulan / yazilan metin: baglanti, ham jeton, kisa kod; digerleri tanimsiz', () => {
    expect(parseScan(`https://site.example/gecis/${TOKEN}#K7M2PQ4X`)).toEqual({ token: TOKEN });
    expect(parseScan(`  ${TOKEN} `)).toEqual({ token: TOKEN });
    expect(parseScan('k7m2 pq4x')).toEqual({ code: 'K7M2PQ4X' });
    expect(parseScan('https://example.com/baska')).toBeUndefined();
    expect(parseScan('BEGIN:VCARD')).toBeUndefined();
    expect(parseScan('')).toBeUndefined();
  });
});

describe('kamera', () => {
  it('destek: guvenli baglanti, kamera, BarcodeDetector', () => {
    const cam = { mediaDevices: { getUserMedia: () => undefined } };
    expect(scannerSupport({ isSecureContext: false, navigator: cam, BarcodeDetector: class {} })).toBe('insecure');
    expect(scannerSupport({ isSecureContext: true, navigator: {} })).toBe('no_camera');
    expect(scannerSupport({ isSecureContext: true, navigator: cam })).toBe('no_detector');
    expect(scannerSupport({ isSecureContext: true, navigator: cam, BarcodeDetector: class {} })).toBe('ok');
  });

  it('izin reddi ve diger hatalar elle kod girisine yonlendirir', () => {
    expect(cameraErrorMessage({ name: 'NotAllowedError' })).toMatch(/izni verilmedi.*kısa kodu/);
    expect(cameraErrorMessage({ name: 'NotFoundError' })).toMatch(/bulunamadı/);
    expect(cameraErrorMessage({ name: 'NotReadableError' })).toMatch(/başka bir uygulama/);
    expect(cameraErrorMessage(new Error('x'))).toMatch(/açılamadı/);
  });
});

describe('misafir gecisi formu', () => {
  const base = { guestName: 'Ayşe', validFrom: '2026-11-27', validUntil: '', today: '2026-11-27', maxPassDays: 31, maxPassLeadDays: 90 };
  it('API kurallari', () => {
    expect(passFormError(base)).toBeUndefined();
    expect(passFormError({ ...base, guestName: ' A ' })).toMatch(/en az 2/);
    expect(passFormError({ ...base, validFrom: '2026-11-26' })).toMatch(/bugünden önce/);
    expect(passFormError({ ...base, validFrom: '2027-02-26' })).toMatch(/90 gün sonrası/);
    expect(passFormError({ ...base, validFrom: '2027-02-25' })).toBeUndefined();
    expect(passFormError({ ...base, validUntil: '2026-11-26' })).toMatch(/önce olamaz/);
    expect(passFormError({ ...base, validUntil: '2026-12-27' })).toBeUndefined();
    expect(passFormError({ ...base, validUntil: '2026-12-28' })).toMatch(/31 gün/);
  });
});

describe('durum metinleri ve semalar', () => {
  it('kurye durumu', () => {
    expect(courierState({ status: 'waiting', expired: false })).toBe('waiting');
    expect(courierState({ status: 'waiting', expired: true })).toBe('expired');
    expect(courierState({ status: 'approved', expired: false, enteredAt: 'x' })).toBe('inside');
    expect(courierState({ status: 'approved', expired: false, approvalExpired: true })).toBe('approval_expired');
    expect(COURIER_TEXT.approval_expired.label).toBe('Onay süresi doldu');
    expect(VERDICT_TEXT.host_left).toEqual({ label: 'Ev sahibi taşındı', tone: 'danger' });
    expect(courierState({ status: 'approved', expired: false, enteredAt: 'x', exitedAt: 'y' })).toBe('done');
    expect(COURIER_TEXT[courierState({ status: 'declined', expired: false })].label).toBe('Reddedildi');
    expect(validityText('2026-11-27', '2026-11-27')).toBe('27 Kas 2026');
    expect(validityText('2026-11-27', '2026-11-29')).toBe('27 Kas 2026 – 29 Kas 2026');
  });

  it('API yanitlari: yonetici gorunumunde jeton yok; gorevli gorunumunde sakin kimligi yok', () => {
    const resident = myPassSchema.parse({
      passId: 'p1', unitId: 'u1', unitLabel: 'A Blok · Daire 5', guestName: 'Can', validFrom: '2026-11-27', validUntil: '2026-11-27', entryMode: 'single',
      status: 'active', verdict: 'valid', token: TOKEN, shortCode: 'K7M2PQ4X', entryCount: 0, inside: false, createdAt: 'x', mine: true, canRevoke: true, canRotate: true, version: 1,
    });
    // Liste yaniti jetonsuz gelir (kayitta yalnizca ozet var).
    expect(myPassSchema.parse({ ...resident, token: undefined, shortCode: undefined }).token).toBeUndefined();
    expect(myPassSchema.parse({ ...resident, verdict: 'host_left' }).verdict).toBe('host_left');
    expect(managerPassSchema.parse(resident)).not.toHaveProperty('token');
    expect(managerPassSchema.parse(resident)).not.toHaveProperty('shortCode');
    expect(managerPassSchema.parse(resident)).not.toHaveProperty('canRotate');
    const desk = deskPassSchema.parse({ ...resident, message: 'Bu geçişin süresi doldu', verdict: 'expired', canEnter: false, canExit: true, createdBy: 'u-9' });
    expect(desk).not.toHaveProperty('createdBy');
    expect(desk).not.toHaveProperty('token');
    expect(plateLookupSchema.parse({ query: '123', queryDisplay: '123', items: [{ plate: '34ABC123', plateDisplay: '34 ABC 123', unitId: 'u1', unitLabel: 'A Blok · Daire 5', registered: true, active: true, exact: false }] }).items).toHaveLength(1);
    expect(() => courierSchema.parse({ courierId: 'c1', status: 'arrived' })).toThrow();
    expect(gateLogPageSchema.parse({ items: [{ logId: 'l1', at: 'x', direction: 'entry', kind: 'guest', visitorName: 'Can' }], from: '2026-11-21', to: '2026-11-27' }).items[0]?.recordedBy).toBeUndefined();
  });
});
