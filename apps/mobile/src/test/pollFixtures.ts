import { type PortalPoll, portalPollSchema } from '@bm/shared/api/polls';

/** Sakin oylama yaniti (web residentPolls.test.tsx ile ayni ornek); sema ile dogrulanir. */
export const poll = (over: Partial<PortalPoll> = {}): PortalPoll =>
  portalPollSchema.parse({
    pollId: 'p1',
    title: 'Asansör yenilensin mi?',
    options: [
      { optionId: 'o1', label: 'Evet' },
      { optionId: 'o2', label: 'Hayır' },
    ],
    audience: 'owners',
    weighting: 'land_share',
    secret: true,
    resultsVisibleBeforeClose: false,
    opensAt: '2026-11-10T07:00:00.000Z',
    closesAt: '2026-12-17T15:00:00.000Z',
    rollDate: '2026-11-10',
    phase: 'open',
    unitId: 'u-3',
    eligible: true,
    canVote: true,
    resultsAvailable: false,
    resultsAfterVote: false,
    ...over,
  });

/** Bitmis arsa payli oylamanin kesin sonucu: "Hayır" arsa payiyla kazandi. */
export const finalResults = {
  pollId: 'p1',
  phase: 'closed' as const,
  final: true,
  weighting: 'land_share' as const,
  rollDate: '2026-11-10',
  eligible: { units: 3, landShare: { numerator: '1200', denominator: '1200' } },
  participation: { units: 3, unitsBps: 10000, landShare: { numerator: '1200', denominator: '1200' }, landShareBps: 10000 },
  tallyHidden: false,
  options: [
    { optionId: 'o1', label: 'Evet', units: 2, unitsBps: 6667, landShare: { numerator: '360', denominator: '1200' }, landShareBps: 3000 },
    { optionId: 'o2', label: 'Hayır', units: 1, unitsBps: 3333, landShare: { numerator: '840', denominator: '1200' }, landShareBps: 7000 },
  ],
  winnerOptionId: 'o2',
  warnings: [],
};
