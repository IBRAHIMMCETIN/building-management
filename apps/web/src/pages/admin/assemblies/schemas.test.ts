import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { navItemsFor } from '@/layouts/adminNav';
import { type Assembly, type Quorum, assemblyDetailSchema, quorumText } from '@/lib/api/assemblyModel';
import { actionLabel } from '@/lib/audit/labels';
import { assemblyFormSchema, formDefaults, tallyIssue, toInput } from './schemas';

const valid = { kind: 'ordinary' as const, scheduledAt: '2026-12-15T19:00', location: ' Toplantı salonu ', onlineUrl: '', secondMeeting: false, agenda: [' Açılış ', 'Bütçe'] };

const assembly = (over: Partial<Assembly> = {}): Assembly => ({
  assemblyId: 'asm1',
  kind: 'ordinary',
  secondMeeting: false,
  scheduledAt: '2026-12-15T16:00:00.000Z',
  location: 'Salon',
  rollDate: '2026-12-15',
  agenda: [{ itemId: 'a1', title: 'Bütçe', description: '2027 işletme projesi' }],
  status: 'planned',
  createdAt: '2026-11-27T09:00:00.000Z',
  version: 2,
  ...over,
});

const quorum = (over: Partial<Quorum> = {}): Quorum => ({
  totalUnits: 4,
  presentUnits: 3,
  proxyUnits: 0,
  unitsBps: 7500,
  totalLandShare: { numerator: 1000, denominator: 1000 },
  presentLandShare: { numerator: 300, denominator: 1000 },
  landShareBps: 3000,
  unitsMajority: true,
  landShareMajority: false,
  secondMeeting: false,
  met: false,
  decisionThreshold: 2,
  warnings: [],
  ...over,
});

describe('genel kurul formu', () => {
  it('metinleri kirpar, Istanbul saatini ISO ya cevirir, bos baglanti null olur', () => {
    expect(toInput(assemblyFormSchema.parse(valid))).toEqual({
      kind: 'ordinary',
      scheduledAt: '2026-12-15T19:00:00+03:00',
      location: 'Toplantı salonu',
      onlineUrl: null,
      secondMeeting: false,
      agenda: [{ title: 'Açılış' }, { title: 'Bütçe' }],
    });
  });

  it('duzenlemede ayni baslikli maddenin aciklamasi korunur', () => {
    const a = assembly();
    const form = formDefaults(a);
    expect(form).toMatchObject({ scheduledAt: '2026-12-15T19:00', agenda: ['Bütçe'] });
    expect(toInput(assemblyFormSchema.parse(form), a).agenda).toEqual([{ title: 'Bütçe', description: '2027 işletme projesi' }]);
  });

  it.each([
    ['yer ve baglanti yok', { location: '', onlineUrl: '' }, 'location'],
    ['http baglanti', { onlineUrl: 'http://x.example' }, 'onlineUrl'],
    ['bos madde', { agenda: ['Açılış', ' '] }, 'agenda'],
    ['gundem yok', { agenda: [] }, 'agenda'],
    ['tarih yok', { scheduledAt: '' }, 'scheduledAt'],
  ])('reddedilir: %s', (_l, over, field) => {
    const r = assemblyFormSchema.safeParse({ ...valid, ...over });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toContain(field);
  });

  it('sayim: toplam katilani asamaz, negatif / kesirli olamaz', () => {
    expect(tallyIssue({ yes: 2, no: 1, abstain: 0 }, 3)).toBeNull();
    expect(tallyIssue({ yes: 3, no: 1, abstain: 0 }, 3)).toContain('(3)');
    expect(tallyIssue({ yes: -1, no: 0, abstain: 0 }, 3)).not.toBeNull();
    expect(tallyIssue({ yes: 1.5, no: 0, abstain: 0 }, 3)).not.toBeNull();
  });
});

describe('genel kurul modeli', () => {
  it('yeter sayi metni: eksik olcutu adlandirir; ikinci toplanti', () => {
    expect(quorumText(quorum())).toBe('Toplantı yeter sayısı sağlanmadı: arsa payı çoğunluğu yok. Gündem sayımı kaydedilemez.');
    expect(quorumText(quorum({ unitsMajority: false, landShareMajority: false }))).toContain('bölüm sayısı ve arsa payı');
    expect(quorumText(quorum({ met: true, landShareMajority: true }))).toContain('sağlandı');
    expect(quorumText(quorum({ secondMeeting: true, met: true }))).toContain('aranmaz');
  });

  it('ayrinti semasi ve menu / denetim etiketleri', () => {
    const d = assemblyDetailSchema.parse({ assembly: assembly(), quorum: quorum(), units: [{ unitId: 'u1', blockId: 'b1', number: '1', owners: [{ userId: 'x', name: 'Ali' }], warnings: [] }] });
    expect(d.units[0]?.attendance).toBeUndefined();
    for (const role of ['apartment_manager', 'management_company', 'observer'] as const) expect(navItemsFor(role).map((n) => n.to)).toContain('/admin/assemblies');
    expect(navItemsFor('building_staff').map((n) => n.to)).not.toContain('/admin/assemblies');
    expect(actionLabel('assembly.tally')).toBe('Genel kurul gündem sayımı kaydedildi');
    expect(actionLabel('poll.close')).toBe('Oylama erken kapatıldı');
  });
});
