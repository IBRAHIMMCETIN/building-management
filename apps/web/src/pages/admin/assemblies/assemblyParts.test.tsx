// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import type { Assembly, AssemblyUnit, Quorum } from '@/lib/api/assemblyModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mutation = () => ({ isPending: false, isError: false, isSuccess: false, error: null, data: undefined, mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})) });
const send = mutation();
const tally = mutation();
const saveMinutes = mutation();
const finalize = mutation();
const reschedule = mutation();
vi.mock('@/hooks/useAssemblies', () => ({ useSendCall: () => send, useRecordTally: () => tally, useSaveMinutes: () => saveMinutes, useFinalizeAssembly: () => finalize, useRescheduleAssembly: () => ({ ...reschedule, reset: vi.fn() }) }));

const { AssemblyCallCard } = await import('./AssemblyCallCard');
const { AgendaDecision } = await import('./AgendaDecision');
const { MinutesCard } = await import('./MinutesCard');

const base: Assembly = {
  assemblyId: 'asm1',
  kind: 'ordinary',
  secondMeeting: false,
  scheduledAt: '2026-12-15T16:00:00.000Z',
  location: 'Salon',
  rollDate: '2026-12-15',
  agenda: [{ itemId: 'a1', title: 'Yönetici seçimi', decisionKind: 'manager_election', majority: 'persons_and_land' }],
  status: 'planned',
  createdAt: '2026-11-27T09:00:00.000Z',
  version: 4,
};
const quorum = { met: true, presentVotes: 3, totalUnits: 4, decisionThreshold: 2, voteCap: 1 } as Quorum;
const unit = (unitId: string, voterKey: string): AssemblyUnit => ({
  unitId,
  blockId: 'b1',
  number: unitId.toUpperCase(),
  owners: [],
  attendance: { mode: 'present', recordedAt: '2026-12-15T16:10:00.000Z', version: 1 },
  voterKey,
  warnings: [],
});

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});
async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(node));
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('cagri karti', () => {
  it('ilk gonderim: alici sayisi ve 15 gun uyarisi gosterilir, gonderim engellenmez', async () => {
    await render(<AssemblyCallCard assembly={base} check={{ daysBefore: 10, lateNotice: true, recipients: 5, ownersWithoutAccount: 1, warnings: ['KMK m.29: çağrı toplantıdan en az 15 gün önce yapılmalıdır'] }} outdated={false} canWrite />);
    expect(container.textContent).toContain('5 kat maliki e-posta alır, 1 malikin apartmanda kullanıcısı yok');
    expect(container.textContent).toContain('en az 15 gün önce');
    expect(container.textContent).toContain('yerine geçmez');
    await act(async () => button('Çağrıyı gönder')?.click());
    expect(send.mutate).toHaveBeenCalledWith({ version: 4 });
  });

  it('yeniden gonderim gerekce ister; denetci gonderemez', async () => {
    const called = { ...base, calls: [{ seq: 1, calledAt: '2026-11-27T09:00:00.000Z', recipients: 5, ownersWithoutAccount: 0, daysBefore: 18, lateNotice: false, resend: false }] };
    await render(<AssemblyCallCard assembly={called} check={{ daysBefore: 17, lateNotice: false, recipients: 5, ownersWithoutAccount: 0, warnings: [] }} outdated canWrite />);
    expect(container.textContent).toContain('yeniden gönderin');
    expect(button('Çağrıyı gönder')).toBeUndefined();
    await act(async () => button('Çağrıyı yeniden gönder')?.click());
    expect((button('Yeniden gönder') as HTMLButtonElement).disabled).toBe(true);
    container.remove();
    await render(<AssemblyCallCard assembly={called} check={{ daysBefore: 17, lateNotice: false, recipients: 5, ownersWithoutAccount: 0, warnings: [] }} outdated={false} canWrite={false} />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('gundem karari', () => {
  it('nitelikli cogunlukta bolum bazinda oy; ayni kisinin bolumleri birlikte; bos secim gonderilmez', async () => {
    const units = [unit('u1', 'user:P'), unit('u2', 'user:P'), unit('u3', 'user:Q')];
    await render(
      <AgendaDecision index={0} item={base.agenda[0]!} assembly={base} quorum={quorum} units={units} records={[]} canTally canCorrect unitLabel={(u) => u.number} />,
    );
    expect(container.textContent).toContain('Gerekli: Bütün kat maliklerinin sayı (kişi) ve arsa payı çoğunluğu (KMK m.34)');
    expect(container.querySelector('input[type="number"]')).toBeNull();
    const select = container.querySelector('select[aria-label="U1 oyu"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'yes';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect((container.querySelector('select[aria-label="U2 oyu"]') as HTMLSelectElement).value).toBe('yes');
    await act(async () => button('Kararı kaydet')?.click());
    expect(tally.mutateAsync).toHaveBeenCalledWith({ itemId: 'a1', input: { version: 4, votes: { u1: 'yes', u2: 'yes' } } });
  });

  it('kayitli karar degismez: duzeltme gerekce ister ve yeni kayit olarak gider', async () => {
    const item = { itemId: 'a2', title: 'Bütçe', decisionKind: 'operating_budget' as const, majority: 'attendees' as const, tally: { yes: 2, no: 1, abstain: 0, presentVotes: 3, decision: 'accepted' as const, recordedAt: '2026-12-15T17:00:00.000Z', seq: 1 } };
    await render(<AgendaDecision index={1} item={item} assembly={base} quorum={quorum} units={[]} records={[]} canTally={false} canCorrect unitLabel={(u) => u.number} />);
    expect(button('Kararı kaydet')).toBeUndefined();
    await act(async () => button('Kararı düzelt')?.click());
    const inputs = container.querySelectorAll('input[type="number"]');
    // Duzeltme formu kayitli oylarla on dolu.
    expect([...inputs].map((i) => (i as HTMLInputElement).value)).toEqual(['2', '1', '0']);
    await act(async () => {
      const yes = inputs[0] as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(yes, '1');
      yes.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((button('Düzeltmeyi kaydet') as HTMLButtonElement).disabled).toBe(true);
    const reason = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reason, 'Sayım hatası');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Düzeltmeyi kaydet')?.click());
    expect(tally.mutateAsync).toHaveBeenCalledWith({ itemId: 'a2', input: { version: 4, yes: 1, no: 1, abstain: 0, correctionReason: 'Sayım hatası' } });
  });
});

describe('tutanak karti', () => {
  it('bos genel notla kaydeder (API bos metni temizler) ve kayit sonrasi onay gosterir', async () => {
    const held = { ...base, minutes: { chair: 'Ayşe Yılmaz', clerks: ['Mehmet Kaya'], voteCounters: [], notes: {}, updatedAt: '2026-12-15T17:00:00.000Z' } };
    await render(<MinutesCard assembly={held} editable />);
    await act(async () => button('Tutanağı kaydet')?.click());
    expect(saveMinutes.mutate).toHaveBeenCalledWith({ version: 4, chair: 'Ayşe Yılmaz', clerks: ['Mehmet Kaya'], voteCounters: [], notes: {}, generalNotes: '' });
    container.remove();
    saveMinutes.isSuccess = true;
    await render(<MinutesCard assembly={held} editable />);
    expect(container.textContent).toContain('Tutanak kaydedildi.');
    saveMinutes.isSuccess = false;
  });
});

describe('cok adayli secim', () => {
  const election = {
    ...base.agenda[0]!,
    candidates: [
      { candidateId: 'c1', name: 'Ali Veli' },
      { candidateId: 'c2', name: 'Ayşe Kaya' },
    ],
  };
  const pick = async (label: string, value: string) => {
    const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('bolum bazinda aday pusulasi: ayni kisinin bolumleri ayni aday; cekimser; bos gonderilmez; `ballots` gider', async () => {
    const units = [unit('u1', 'user:P'), unit('u2', 'user:P'), unit('u3', 'user:Q'), unit('u4', 'user:R')];
    await render(<AgendaDecision index={0} item={election} assembly={base} quorum={quorum} units={units} records={[]} canTally canCorrect unitLabel={(u) => u.number} />);
    expect(container.textContent).toContain('Adaylar: Ali Veli, Ayşe Kaya');
    expect(container.querySelector('select[aria-label="U1 oyu"]')).toBeNull();
    const options = [...(container.querySelector('select[aria-label="U1 aday oyu"]') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(['Oy kullanmadı', 'Ali Veli', 'Ayşe Kaya', 'Çekimser']);
    await pick('U1 aday oyu', 'c1');
    expect((container.querySelector('select[aria-label="U2 aday oyu"]') as HTMLSelectElement).value).toBe('c1');
    await pick('U3 aday oyu', 'abstain');
    await act(async () => button('Kararı kaydet')?.click());
    expect(tally.mutateAsync).toHaveBeenCalledWith({ itemId: 'a1', input: { version: 4, ballots: { u1: 'c1', u2: 'c1', u3: 'abstain' } } });
  });

  it('sonuc: "Seçim yapılamadı" aciklamasi ve aday toplamlari; duzeltme kayitli pusulayla on dolu', async () => {
    const result = {
      rule: 'persons_and_land' as const,
      candidates: [
        { candidateId: 'c1', name: 'Ali Veli', votes: 2, persons: 2, units: 2, landShare: null, landShareBps: 2000, elected: false, reasons: [] },
        { candidateId: 'c2', name: 'Ayşe Kaya', votes: 2, persons: 2, units: 2, landShare: null, landShareBps: 8000, elected: false, reasons: [] },
      ],
      winnerCandidateId: null,
      abstain: { votes: 0, persons: 0, units: 0 },
      notVoted: { votes: 0, persons: 0, units: 0 },
      absent: { persons: 0, units: 0 },
      required: { persons: 3, landShare: null },
      totalPersons: 4,
      totalLandShare: null,
      noWinner: 'Seçim yapılamadı: hiçbir aday bütün kat maliklerinin sayı ve arsa payı çoğunluğuna ulaşmadı (KMK m.34).',
      warnings: [],
    };
    const record = { itemId: 'a1', seq: 1, outcome: { reasons: [], warnings: [] } as never, unitBallots: { u1: 'c1', u2: 'c1' }, election: result, recordedAt: '2026-12-15T17:00:00.000Z' };
    const item = { ...election, tally: { yes: 2, no: 2, abstain: 0, presentVotes: 4, decision: 'rejected' as const, recordedAt: '2026-12-15T17:00:00.000Z', seq: 1, winnerCandidateId: null } };
    const units = [unit('u1', 'user:P'), unit('u2', 'user:P')];
    await render(<AgendaDecision index={0} item={item} assembly={base} quorum={quorum} units={units} records={[record]} canTally={false} canCorrect unitLabel={(u) => u.number} />);
    expect(container.textContent).toContain('Seçim yapılamadı');
    expect(container.textContent).toContain('hiçbir aday bütün kat maliklerinin sayı ve arsa payı çoğunluğuna ulaşmadı');
    expect(container.textContent).toContain('Ayşe Kaya2 oy · 2 kat maliki · 2 bölüm · arsa payı');
    await act(async () => button('Kararı düzelt')?.click());
    expect((container.querySelector('select[aria-label="U1 aday oyu"]') as HTMLSelectElement).value).toBe('c1');
  });
});

describe('erteleme / yer degisikligi', () => {
  const called = { ...base, calls: [{ seq: 1, calledAt: '2026-11-27T09:00:00.000Z', recipients: 5, ownersWithoutAccount: 0, daysBefore: 18, lateNotice: false, resend: false }] };
  const check = { daysBefore: 17, lateNotice: false, recipients: 5, ownersWithoutAccount: 0, warnings: [] };

  it('cagri gonderilmis toplantida gerekceli erteleme: yalnizca degisen alanlar gider; gecmis listelenir', async () => {
    const withHistory = { ...called, reschedules: [{ seq: 1, previousScheduledAt: '2026-12-10T16:00:00.000Z', scheduledAt: '2026-12-15T16:00:00.000Z', reason: 'Salon dolu', at: '2026-11-28T09:00:00.000Z' }] };
    await render(<AssemblyCallCard assembly={withHistory} check={check} outdated={false} canWrite />);
    expect(container.textContent).toContain('Ertelendi:');
    expect(container.textContent).toContain('Gerekçe: Salon dolu');
    await act(async () => button('Ertele / yer değiştir')?.click());
    const location = [...container.querySelectorAll('input')].find((i) => i.value === 'Salon') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(location, 'Bahçe');
      location.dispatchEvent(new Event('input', { bubbles: true }));
      const reason = container.querySelector('textarea') as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reason, 'Salon tadilatta');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Kaydet ve bildir')?.click());
    expect(reschedule.mutate).toHaveBeenCalledWith({ version: 4, reason: 'Salon tadilatta', location: 'Bahçe' }, expect.anything());
  });

  it('cagri yoksa veya oy listesi dondurulduysa erteleme sunulmaz', async () => {
    await render(<AssemblyCallCard assembly={base} check={check} outdated={false} canWrite />);
    expect(button('Ertele / yer değiştir')).toBeUndefined();
    container.remove();
    await render(<AssemblyCallCard assembly={{ ...called, roll: { frozenAt: '2026-12-15T16:10:00.000Z', units: 4 } }} check={check} outdated={false} canWrite />);
    expect(button('Ertele / yer değiştir')).toBeUndefined();
  });
});
