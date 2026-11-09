import { describe, expect, it } from 'vitest';
import { type Announcement, displayStatus } from '@/lib/api/announcements';
import { isoToIstanbulLocal, istanbulLocalToIso, nowIstanbulLocal } from '@/lib/dates';
import { formDefaults, makeAnnouncementSchema, toCreateInput, toUpdateInput } from './schemas';

// 2026-11-09 12:00 Istanbul
const NOW = new Date('2026-11-09T09:00:00.000Z');
const schema = makeAnnouncementSchema(() => NOW);

const valid = { title: ' Su kesintisi ', body: ' Yarın 10:00-14:00 arası su kesilecektir. ', blockIds: [], timing: 'now' as const, publishAt: '', expiresAt: '' };

const draft = (over: Partial<Announcement> = {}): Announcement => ({
  announcementId: 'a1',
  title: 'Başlık',
  body: 'Metin',
  status: 'draft',
  publishAt: '2026-11-09T08:00:00.000Z',
  createdAt: '2026-11-09T08:00:00.000Z',
  updatedAt: '2026-11-09T08:00:00.000Z',
  version: 3,
  ...over,
});

describe('Istanbul saat donusumleri', () => {
  it('datetime-local <-> ISO, tarayici saat diliminden bagimsiz', () => {
    expect(istanbulLocalToIso('2026-11-10T09:00')).toBe('2026-11-10T09:00:00+03:00');
    expect(isoToIstanbulLocal('2026-11-10T06:00:00.000Z')).toBe('2026-11-10T09:00');
    expect(isoToIstanbulLocal('2026-12-31T22:30:00.000Z')).toBe('2027-01-01T01:30');
    expect(nowIstanbulLocal(NOW)).toBe('2026-11-09T12:00');
    expect(Date.parse(istanbulLocalToIso('2026-11-10T09:00'))).toBe(Date.parse('2026-11-10T06:00:00Z'));
  });
});

describe('duyuru formu', () => {
  it('metinleri kirpar; hemen yayin + bos alanlar API govdesine girmez', () => {
    const v = schema.parse(valid);
    expect(toCreateInput(v)).toEqual({ title: 'Su kesintisi', body: 'Yarın 10:00-14:00 arası su kesilecektir.' });
    expect(JSON.parse(JSON.stringify(toCreateInput(v)))).toEqual({ title: 'Su kesintisi', body: 'Yarın 10:00-14:00 arası su kesilecektir.' });
  });

  it('bos baslik ve metin reddedilir', () => {
    const r = schema.safeParse({ ...valid, title: '  ', body: '' });
    expect(r.error?.issues.map((i) => i.path[0])).toEqual(['title', 'body']);
  });

  it('planli yayin: zaman zorunlu ve ileri tarihli olmali', () => {
    expect(schema.safeParse({ ...valid, timing: 'scheduled' }).error?.issues[0]).toMatchObject({ path: ['publishAt'], message: 'Yayın zamanını seçin' });
    expect(schema.safeParse({ ...valid, timing: 'scheduled', publishAt: '2026-11-09T11:59' }).error?.issues[0]?.path).toEqual(['publishAt']);
    const v = schema.parse({ ...valid, timing: 'scheduled', publishAt: '2026-11-10T09:00', blockIds: ['b2', 'b1'] });
    expect(toCreateInput(v)).toMatchObject({ publishAt: '2026-11-10T09:00:00+03:00', blockIds: ['b2', 'b1'] });
  });

  it('bitis yayin zamanindan (hemen ise simdiden) sonra olmali', () => {
    expect(schema.safeParse({ ...valid, expiresAt: '2026-11-09T11:00' }).error?.issues[0]?.path).toEqual(['expiresAt']);
    expect(schema.safeParse({ ...valid, timing: 'scheduled', publishAt: '2026-11-12T09:00', expiresAt: '2026-11-11T09:00' }).success).toBe(false);
    expect(toCreateInput(schema.parse({ ...valid, expiresAt: '2026-11-20T18:00' })).expiresAt).toBe('2026-11-20T18:00:00+03:00');
  });

  it('guncelleme bos alanlari null ile temizler, hemen -> simdi', () => {
    const v = schema.parse(valid);
    expect(toUpdateInput(v, 3, NOW)).toEqual({
      version: 3,
      title: 'Su kesintisi',
      body: 'Yarın 10:00-14:00 arası su kesilecektir.',
      blockIds: null,
      publishAt: NOW.toISOString(),
      expiresAt: null,
    });
  });

  it('taslaktan form: gecmis yayin zamani "hemen", ileri tarih "planli" olur', () => {
    expect(formDefaults(draft(), NOW)).toMatchObject({ timing: 'now', publishAt: '', blockIds: [] });
    expect(formDefaults(draft({ publishAt: '2026-11-10T06:00:00.000Z', expiresAt: '2026-11-11T06:00:00.000Z', blockIds: ['b1'] }), NOW)).toMatchObject({
      timing: 'scheduled',
      publishAt: '2026-11-10T09:00',
      expiresAt: '2026-11-11T09:00',
      blockIds: ['b1'],
    });
  });
});

describe('gosterim durumu', () => {
  it('yayindaki duyurunun zamanlamasina gore', () => {
    expect(displayStatus(draft(), NOW)).toBe('draft');
    expect(displayStatus(draft({ status: 'archived' }), NOW)).toBe('archived');
    expect(displayStatus(draft({ status: 'published' }), NOW)).toBe('published');
    expect(displayStatus(draft({ status: 'published', publishAt: '2026-11-10T06:00:00.000Z' }), NOW)).toBe('scheduled');
    expect(displayStatus(draft({ status: 'published', expiresAt: '2026-11-09T09:00:00.000Z' }), NOW)).toBe('expired');
  });
});
