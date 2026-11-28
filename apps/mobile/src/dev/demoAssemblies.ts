import { mockContextsFor } from '@bm/shared/auth/mockScenarios';
import type { DemoHandler } from './demoApi';

/*
 * DEMO genel kurul (/api/portal/assemblies): yaklasan olagan toplanti (cagri gonderilmis) ve gecen
 * yilin kesinlesmis toplantisi (yeter sayi, kararlar). Yalnizca kat maliki: aktif sakin baglaminin
 * daireleri arasinda malik yoksa 403 (API ile ayni; ornek multi@dev.local ikinci apartman, kiraci).
 * Tutanak PDF'i demo modunda yoktur. Gercek veri DEGILDIR.
 */

const DAY = 86_400_000;

function seed(now: Date) {
  // Istanbul 14:00 (UTC+3) sabit saatli gunler.
  const at = (days: number, hour = 14) => `${new Date(now.getTime() + days * DAY).toISOString().slice(0, 10)}T${String(hour - 3).padStart(2, '0')}:00:00.000Z`;
  const counts = (yes: number, no: number, abstain: number) => ({ yes, no, abstain });
  return [
    {
      assemblyId: 'as-2',
      kind: 'ordinary',
      secondMeeting: false,
      scheduledAt: at(12),
      location: 'Sığınak toplantı salonu',
      rollDate: at(12).slice(0, 10),
      status: 'planned',
      phase: 'upcoming',
      calledAt: at(-3, 10),
      secondMeetingPlan: { scheduledAt: at(19), location: 'Sığınak toplantı salonu' },
      agenda: [
        { itemId: 'g1', title: 'Açılış ve divan heyeti seçimi', majority: 'attendees', decisionKind: 'general' },
        { itemId: 'g2', title: '2027 yılı işletme projesinin görüşülmesi', description: 'Aylık aidatın 1.500 TL’den 1.750 TL’ye çıkarılması önerisi.', majority: 'attendees', decisionKind: 'operating_budget' },
        { itemId: 'g3', title: 'Yönetici seçimi', majority: 'persons_and_land', decisionKind: 'manager_election' },
        { itemId: 'g4', title: 'Dış cephe ısı yalıtımı (mantolama)', description: 'Alınan üç teklif İhaleler sayfasında paylaşıldı.', majority: 'persons_and_land', decisionKind: 'beneficial_improvement' },
      ],
      minutesAvailable: false,
    },
    {
      assemblyId: 'as-1',
      kind: 'ordinary',
      secondMeeting: false,
      scheduledAt: at(-350),
      location: 'Sığınak toplantı salonu',
      rollDate: at(-350).slice(0, 10),
      status: 'held',
      phase: 'held',
      calledAt: at(-370, 10),
      heldAt: at(-340, 12),
      agenda: [
        {
          itemId: 'h1',
          title: '2026 yılı işletme projesinin kabulü',
          majority: 'attendees',
          decisionKind: 'operating_budget',
          decision: { decision: 'accepted', rule: 'attendees', votes: counts(14, 3, 1), units: null, persons: null, landShareBps: null, corrected: false, recordedAt: at(-350, 15) },
        },
        {
          itemId: 'h2',
          title: 'Otopark girişine bariyer kurulması',
          majority: 'persons_and_land',
          decisionKind: 'beneficial_improvement',
          decision: {
            decision: 'rejected',
            rule: 'persons_and_land',
            votes: counts(9, 8, 1),
            units: counts(9, 8, 1),
            persons: { ...counts(9, 8, 1), total: 24 },
            landShareBps: counts(3750, 3333, 417),
            corrected: false,
            recordedAt: at(-350, 16),
          },
        },
      ],
      quorum: { met: true, secondMeeting: false, noAttendance: false, presentOwners: 18, totalOwners: 24, presentVotes: 18, totalVotes: 24 },
      minutesAvailable: true,
    },
  ];
}

export function createAssembliesDemo(): DemoHandler {
  return ({ method, path, now, claims }) => {
    if (!path.startsWith('/api/portal/assemblies') || method !== 'GET') return undefined;
    const ctx = mockContextsFor(claims.email ?? '').contexts.find((c) => c.apartmentId === claims.apartmentId && c.role === 'resident');
    // Daire bilgisi olmayan senaryo demo dairesinin maliki sayilir (demoApi.ts DEMO_UNIT).
    const owner = !ctx?.units || ctx.units.some((u) => u.relation === 'owner');
    if (!owner) return { status: 403, body: { error: 'forbidden', message: 'Genel kurul bilgileri yalnızca kat maliklerine açıktır' } };

    const items = seed(now);
    if (path === '/api/portal/assemblies') return { status: 200, body: { items } };
    const [, id, minutes] = /^\/api\/portal\/assemblies\/([^/]+)(?:\/(minutes))?$/.exec(path) ?? [];
    const found = items.find((a) => a.assemblyId === decodeURIComponent(id ?? ''));
    if (!found) return { status: 404, body: { error: 'not_found', message: 'Toplantı bulunamadı' } };
    if (minutes) return { status: 404, body: { error: 'not_found', message: 'Demo modunda tutanak PDF’i yok; gerçek API’de tutanak burada açılır.' } };
    return { status: 200, body: found };
  };
}
