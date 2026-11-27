import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { navItemsFor } from '@/layouts/adminNav';
import {
  type Poll,
  type PollResults,
  formatFraction,
  myVoteText,
  optionBasisBps,
  outcomeText,
  pollResultsSchema,
  pollSchema,
  portalPollSchema,
} from '@/lib/api/pollModel';
import { closeReasonSchema, formDefaults, makePollSchema, toCreateInput, toUpdateInput } from './schemas';

// 2026-11-09 12:00 Istanbul
const NOW = new Date('2026-11-09T09:00:00.000Z');
const schema = makePollSchema(() => NOW);

const valid = {
  title: ' Asansör yenilensin mi? ',
  description: '',
  options: [' Evet ', 'Hayır'],
  audience: 'owners' as const,
  weighting: 'per_unit' as const,
  secret: true,
  resultsVisibleBeforeClose: false,
  timing: 'now' as const,
  opensAt: '',
  closesAt: '2026-11-16T18:00',
};

const poll = (over: Partial<Poll> = {}): Poll => ({
  pollId: 'p1',
  title: 'Başlık',
  options: [
    { optionId: 'o1', label: 'Evet' },
    { optionId: 'o2', label: 'Hayır' },
  ],
  audience: 'owners',
  weighting: 'per_unit',
  secret: true,
  resultsVisibleBeforeClose: false,
  opensAt: '2026-11-09T08:00:00.000Z',
  closesAt: '2026-11-16T15:00:00.000Z',
  rollDate: '2026-11-09',
  status: 'draft',
  phase: 'draft',
  createdAt: '2026-11-09T08:00:00.000Z',
  updatedAt: '2026-11-09T08:00:00.000Z',
  version: 4,
  ...over,
});

const issues = (v: Record<string, unknown>) => {
  const r = schema.safeParse({ ...valid, ...v });
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('oylama formu', () => {
  it('metinleri kirpar; hemen baslayan oylamada opensAt ve bos aciklama gonderilmez; saat Istanbul', () => {
    const v = schema.parse(valid);
    expect(JSON.parse(JSON.stringify(toCreateInput(v)))).toEqual({
      title: 'Asansör yenilensin mi?',
      options: ['Evet', 'Hayır'],
      audience: 'owners',
      weighting: 'per_unit',
      secret: true,
      resultsVisibleBeforeClose: false,
      closesAt: '2026-11-16T18:00:00+03:00',
    });
  });

  it('planli baslangic ve guncelleme: bos aciklama null ile temizlenir, "hemen" -> opensAt null', () => {
    const v = schema.parse({ ...valid, timing: 'scheduled', opensAt: '2026-11-10T09:00', description: ' Teklifler ekte ' });
    expect(toCreateInput(v)).toMatchObject({ opensAt: '2026-11-10T09:00:00+03:00', description: 'Teklifler ekte' });
    const u = toUpdateInput(schema.parse(valid), 4);
    expect(u).toMatchObject({ version: 4, description: null, opensAt: null });
  });

  it('acik oylamada ara sonuc secilebilir; gizli oylamada reddedilir', () => {
    expect(issues({ secret: false, resultsVisibleBeforeClose: true })).toEqual([]);
    expect(issues({ secret: true, resultsVisibleBeforeClose: true })).toEqual(['resultsVisibleBeforeClose: Gizli oylamada sonuçlar oylama bitmeden gösterilemez']);
  });

  it.each([
    ['tek secenek', { options: ['Evet'] }, 'options: En az 2, en fazla 10 seçenek girin'],
    ['11 secenek', { options: Array.from({ length: 11 }, (_, i) => `S${i}`) }, 'options: En az 2, en fazla 10 seçenek girin'],
    ['bos secenek', { options: ['Evet', '  '] }, 'options: Boş seçenek bırakmayın'],
    ['ayni secenek (buyuk-kucuk harf, Turkce)', { options: ['İptal', 'iptal'] }, 'options: Aynı seçenek iki kez yazılmış'],
    ['bitis yok', { closesAt: '' }, 'closesAt: Bitiş zamanını seçin'],
    ['bitis gecmiste', { closesAt: '2026-11-09T11:00' }, 'closesAt: Bitiş zamanı başlangıçtan sonra olmalıdır'],
    ['planli baslangic gecmiste', { timing: 'scheduled', opensAt: '2026-11-09T10:00' }, 'opensAt: Planlı başlangıç ileri bir tarih olmalıdır'],
    ['bitis planli baslangictan once', { timing: 'scheduled', opensAt: '2026-11-20T10:00' }, 'closesAt: Bitiş zamanı başlangıçtan sonra olmalıdır'],
  ])('reddedilir: %s', (_l, v, expected) => {
    expect(issues(v)).toContain(expected);
  });

  it('varsayilanlar ve taslaktan form', () => {
    expect(formDefaults()).toMatchObject({ options: ['', ''], audience: 'owners', weighting: 'per_unit', secret: true, resultsVisibleBeforeClose: false, timing: 'now' });
    const f = formDefaults(poll({ opensAt: '2026-11-12T06:00:00.000Z', description: 'Not' }), NOW);
    expect(f).toMatchObject({ timing: 'scheduled', opensAt: '2026-11-12T09:00', closesAt: '2026-11-16T18:00', options: ['Evet', 'Hayır'], description: 'Not' });
    expect(formDefaults(poll(), NOW).timing).toBe('now');
  });

  it('erken kapatma gerekcesi en az 3 karakter', () => {
    expect(closeReasonSchema.safeParse({ reason: ' ab ' }).success).toBe(false);
    expect(closeReasonSchema.parse({ reason: ' Karar alındı ' }).reason).toBe('Karar alındı');
  });
});

const results = (over: Partial<PollResults> = {}): PollResults => ({
  pollId: 'p1',
  phase: 'closed',
  final: true,
  weighting: 'per_unit',
  rollDate: '2026-11-09',
  eligible: { units: 3, landShare: { numerator: '1200', denominator: '1200' } },
  participation: { units: 3, unitsBps: 10000, landShare: { numerator: '1200', denominator: '1200' }, landShareBps: 10000 },
  tallyHidden: false,
  options: [
    { optionId: 'o1', label: 'Evet', units: 2, unitsBps: 6667, landShare: { numerator: '360', denominator: '1200' }, landShareBps: 3000 },
    { optionId: 'o2', label: 'Hayır', units: 1, unitsBps: 3333, landShare: { numerator: '840', denominator: '1200' }, landShareBps: 7000 },
  ],
  winnerOptionId: 'o1',
  warnings: [],
  ...over,
});

describe('oylama modeli', () => {
  it('sonuc cumlesi: kazanan, salt cogunluk yok, gizli ve oysuz', () => {
    expect(outcomeText(results())).toBe('Sonuç: “Evet” kullanılan oyların salt çoğunluğunu aldı (bölüm sayısı).');
    expect(outcomeText(results({ final: false }))).toContain('Şu an önde');
    expect(outcomeText(results({ winnerOptionId: null, weighting: 'land_share' }))).toBe(
      'Hiçbir seçenek kullanılan oyların yarısından fazlasını almadı (arsa payı); salt çoğunluk sağlanamadı.',
    );
    expect(outcomeText(results({ tallyHidden: true, options: undefined }))).toContain('Gizli oylama');
    expect(outcomeText(results({ participation: { units: 0, unitsBps: 0, landShare: null, landShareBps: null } }))).toBe('Henüz oy kullanılmadı.');
  });

  it('cubuk olcutu agirliga gore; kesir ortak paydayla', () => {
    const [yes] = results().options!;
    expect(optionBasisBps(yes!, 'per_unit')).toBe(6667);
    expect(optionBasisBps(yes!, 'land_share')).toBe(3000);
    expect(formatFraction({ numerator: 1200, denominator: 12000 })).toBe('1.200/12.000');
    // BigInt metni: guvenli tam sayi sinirini asan paydalar da bicimlenir.
    expect(formatFraction({ numerator: '1', denominator: '999999562000071147' })).toBe('1/999.999.562.000.071.147');
    expect(() => pollResultsSchema.parse({ ...results(), eligible: { units: 3, landShare: { numerator: 1.5, denominator: 2 } } })).toThrow();
  });

  it('kendi oyum: hisseli bolumde baska paydasin gizli oyu secimsiz', () => {
    const p = { options: poll().options, secret: true };
    expect(myVoteText({ ...p, myVote: undefined })).toBeNull();
    expect(myVoteText({ ...p, myVote: { castByMe: true, optionId: 'o2' } })).toBe('Oyunuz: Hayır');
    expect(myVoteText({ ...p, myVote: { castByMe: false } })).toBe('Dairenizin oyu başka bir paydaş tarafından kullanıldı.');
    expect(myVoteText({ ...p, secret: false, myVote: { castByMe: false, optionId: 'o1' } })).toContain(': Evet');
  });

  it('semalar: bilinmeyen evre reddedilir; gizli surerken secenekler opsiyonel', () => {
    expect(() => pollSchema.parse({ ...poll(), phase: 'archived' })).toThrow();
    expect(pollResultsSchema.parse({ ...results({ tallyHidden: true }), options: undefined, winnerOptionId: undefined }).options).toBeUndefined();
    const portal = portalPollSchema.parse({ ...poll(), phase: 'open', unitId: 'u1', eligible: true, canVote: true, resultsAvailable: false, resultsAfterVote: false });
    expect(portal.myVote).toBeUndefined();
  });

  it('menu: Oylamalar ofis rollerine, gorevli / guvenlik / platform gormez', () => {
    for (const role of ['apartment_manager', 'management_company', 'observer'] as const) {
      const paths = navItemsFor(role).map((n) => n.to);
      expect(paths.indexOf('/admin/polls')).toBe(paths.indexOf('/admin/announcements') + 1);
    }
    for (const role of ['building_staff', 'security_guard', 'platform_admin'] as const) {
      expect(navItemsFor(role).map((n) => n.to)).not.toContain('/admin/polls');
    }
  });
});
