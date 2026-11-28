/**
 * Demo talep formu: web (packages/shared) ve API ayni kurallari uygular. API ortak paketi import etmez
 * (bagimsiz paket); bu test iki tarafi yan yana calistirarak kaymayi yakalar: aralik listesi, alan
 * sinirlari, bal kupu adi, kabul edilen KVKK surumleri ve ornek girdilerde ayni kabul / ret.
 */
import { describe, expect, it } from 'vitest';
import {
  DEMO_HONEYPOT_FIELD,
  DEMO_LIMITS as SHARED_LIMITS,
  DEMO_UNIT_RANGES,
  demoRequestFormSchema,
  toDemoRequestPayload,
} from '../../../packages/shared/src/api/demoRequests.js';
import { KVKK_ACCEPTED_VERSIONS, KVKK_NOTICE } from '../../../packages/shared/src/legal/documents.js';
import { DEMO_LIMITS, HONEYPOT_FIELD, KVKK_VERSIONS, UNIT_RANGES, demoRequestInputSchema } from '../src/modules/demo-requests/schema.js';

const BASE = {
  fullName: 'Ayşe Yılmaz',
  email: 'ayse@ornek.com',
  phone: '',
  organization: 'Gül Sitesi',
  unitRange: '201-500',
  message: '',
  kvkkConsent: true,
  [DEMO_HONEYPOT_FIELD]: '',
} as const;

const SAMPLES: Array<[string, Partial<Record<keyof typeof BASE, unknown>>]> = [
  ['gecerli', {}],
  ['telefon ve mesajla gecerli', { phone: '+90 (532) 123-45-67', message: 'Satır 1\nSatır 2' }],
  ['ad 1 karakter', { fullName: 'A' }],
  ['ad tam sinirda', { fullName: 'x'.repeat(SHARED_LIMITS.fullName) }],
  ['ad sinir ustu', { fullName: 'x'.repeat(SHARED_LIMITS.fullName + 1) }],
  ['ad kontrol karakteri', { fullName: 'Ayşe\u0007Yılmaz' }],
  ['ad satir sonu', { fullName: 'Ayşe\nYılmaz' }],
  ['ad bosluklarla kisa', { fullName: '  A  ' }],
  ['e-posta gecersiz', { email: 'ayse@' }],
  ['e-posta cok uzun', { email: `${'a'.repeat(250)}@x.co` }],
  ['telefon harf', { phone: '0532abc4567' }],
  ['telefon 9 rakam', { phone: '532 123 45' }],
  ['telefon 16 rakam', { phone: '1234567890123456' }],
  ['site sinir ustu', { organization: 'x'.repeat(SHARED_LIMITS.organization + 1) }],
  ['site sekme', { organization: 'Gül\tSitesi' }],
  ['mesaj sinirda', { message: 'x'.repeat(SHARED_LIMITS.message) }],
  ['mesaj sinir ustu', { message: 'x'.repeat(SHARED_LIMITS.message + 1) }],
  ['mesaj sekme', { message: 'a\tb' }],
  ['mesaj CRLF', { message: 'a\r\nb' }],
  ['mesaj zil karakteri', { message: 'a\u0007b' }],
  ['aralik gecersiz', { unitRange: '1000' }],
  ['onay yok', { kvkkConsent: false }],
];

/** Formun gonderecegi govde (bos isteğe bagli alanlar dusurulur); form reddetse de ayni kurala gore kurulur. */
function rawPayload(values: Record<string, unknown>) {
  const s = (k: string) => String(values[k] ?? '').trim();
  return {
    fullName: values.fullName,
    email: typeof values.email === 'string' ? values.email.trim().toLowerCase() : values.email,
    ...(s('phone') ? { phone: values.phone } : {}),
    organization: values.organization,
    unitRange: values.unitRange,
    ...(s('message') ? { message: values.message } : {}),
    kvkkConsent: values.kvkkConsent,
    kvkkVersion: KVKK_NOTICE.version,
  };
}

describe('demo formu: web ve API kurallari ayni', () => {
  it('aralik listesi, alan sinirlari ve bal kupu adi ayni', () => {
    expect([...UNIT_RANGES]).toEqual([...DEMO_UNIT_RANGES]);
    expect(DEMO_LIMITS).toEqual(SHARED_LIMITS);
    expect(HONEYPOT_FIELD).toBe(DEMO_HONEYPOT_FIELD);
  });

  it('API yalnizca yayinlanan KVKK metni surumlerini kabul eder; guncel surum listede', () => {
    expect([...KVKK_VERSIONS]).toEqual([...KVKK_ACCEPTED_VERSIONS]);
    expect(KVKK_VERSIONS).toContain(KVKK_NOTICE.version);
  });

  it.each(SAMPLES)('%s: form ve API ayni karari verir', (_label, patch) => {
    const values = { ...BASE, ...patch };
    const client = demoRequestFormSchema.safeParse(values);
    const server = demoRequestInputSchema.safeParse(rawPayload(values));
    expect(server.success, JSON.stringify(server.error?.issues[0])).toBe(client.success);
    if (client.success) {
      // Formun gercekte urettigi govde de API'den gecer.
      expect(demoRequestInputSchema.safeParse(toDemoRequestPayload(client.data, KVKK_NOTICE.version)).success).toBe(true);
    }
  });
});
