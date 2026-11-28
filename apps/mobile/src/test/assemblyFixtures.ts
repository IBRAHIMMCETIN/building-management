import { type PortalAssembly, portalAssemblySchema } from '@bm/shared/api/assemblies';

/** Sakin genel kurul yaniti (web residentAssemblies.test.tsx ile ayni bicim); sema ile dogrulanir. */
export const assembly = (over: Partial<PortalAssembly> = {}): PortalAssembly =>
  portalAssemblySchema.parse({
    assemblyId: 'as-1',
    kind: 'ordinary',
    secondMeeting: false,
    scheduledAt: '2026-12-20T11:00:00.000Z',
    location: 'Toplantı salonu',
    rollDate: '2026-12-20',
    status: 'planned',
    phase: 'upcoming',
    calledAt: '2026-11-25T07:00:00.000Z',
    agenda: [
      { itemId: 'g1', title: 'İşletme projesi', majority: 'attendees' },
      { itemId: 'g2', title: 'Yönetici seçimi', description: 'Adaylar toplantıda belirlenir.', majority: 'persons_and_land' },
    ],
    minutesAvailable: false,
    ...over,
  });

const counts = (yes: number, no: number, abstain: number) => ({ yes, no, abstain });

/** Kesinlesmis toplanti: yeter sayi saglandi, bir kabul (oy) ve bir ret (kisi + bolum + arsa payi). */
export const heldAssembly = (over: Partial<PortalAssembly> = {}) =>
  assembly({
    assemblyId: 'as-0',
    status: 'held',
    phase: 'held',
    heldAt: '2025-12-21T12:00:00.000Z',
    agenda: [
      {
        itemId: 'h1',
        title: 'İşletme projesi',
        majority: 'attendees',
        decision: { decision: 'accepted', rule: 'attendees', votes: counts(14, 3, 1), units: null, persons: null, landShareBps: null, corrected: false, recordedAt: '2025-12-20T12:00:00.000Z' },
      },
      {
        itemId: 'h2',
        title: 'Otopark bariyeri',
        majority: 'persons_and_land',
        decision: {
          decision: 'rejected',
          rule: 'persons_and_land',
          votes: counts(9, 8, 1),
          units: counts(9, 8, 1),
          persons: { ...counts(9, 8, 1), total: 24 },
          landShareBps: counts(3750, 3333, 417),
          corrected: true,
          recordedAt: '2025-12-20T13:00:00.000Z',
        },
      },
      { itemId: 'h3', title: 'Dilek ve temenniler', majority: 'attendees' },
    ],
    quorum: { met: true, secondMeeting: false, noAttendance: false, presentOwners: 18, totalOwners: 24, presentVotes: 18, totalVotes: 24 },
    minutesAvailable: true,
    ...over,
  });

/** `GET /api/me/contexts` yaniti: aktif sakin baglaminda tek daire, malik veya kiraci. */
export const residentContexts = (relation: 'owner' | 'tenant') => ({
  userId: 'mock-resident',
  email: 'resident@dev.local',
  isPlatformAdmin: false,
  active: { role: 'resident', apartmentId: 'apt-dev-1' },
  contexts: [{ apartmentId: 'apt-dev-1', apartmentName: 'Geliştirme Sitesi', role: 'resident', units: [{ unitId: 'u-7', unitNumber: '7', relation }] }],
});
