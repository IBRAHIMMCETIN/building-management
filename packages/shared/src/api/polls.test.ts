import { describe, expect, it } from 'vitest';
import { type PortalPoll, mergeVoteResponse, portalPollSchema } from './polls';

const poll = (over: Partial<PortalPoll> = {}): PortalPoll =>
  portalPollSchema.parse({
    pollId: 'p1',
    title: 'Asansör',
    options: [
      { optionId: 'o1', label: 'Evet' },
      { optionId: 'o2', label: 'Hayır' },
    ],
    audience: 'owners',
    weighting: 'per_unit',
    secret: false,
    resultsVisibleBeforeClose: true,
    opensAt: '2026-11-10T07:00:00.000Z',
    closesAt: '2026-12-17T15:00:00.000Z',
    rollDate: '2026-11-10',
    phase: 'open',
    unitId: 'u1',
    eligible: true,
    canVote: true,
    resultsAvailable: true,
    resultsAfterVote: false,
    ...over,
  });

const results = {
  pollId: 'p1',
  phase: 'open' as const,
  final: false,
  weighting: 'per_unit' as const,
  rollDate: '2026-11-10',
  eligible: { units: 4, landShare: null },
  participation: { units: 2, unitsBps: 5000, landShare: null, landShareBps: null },
  tallyHidden: false,
  options: [],
  warnings: [],
};

describe('mergeVoteResponse (oy yaniti sonucu icermez)', () => {
  it('sonuc gorulebiliyorsa onceki sonuc korunur', () => {
    const next = poll({ myVote: { castByMe: true, optionId: 'o2' } });
    expect(mergeVoteResponse(next, poll({ results })).results).toEqual(results);
    expect(mergeVoteResponse(next, poll({ results })).myVote).toEqual({ castByMe: true, optionId: 'o2' });
  });

  it('yanit sonuc getirirse o kullanilir; sonuc gorulemiyorsa eski sonuc tasinmaz', () => {
    const fresh = { ...results, participation: { ...results.participation, units: 3 } };
    expect(mergeVoteResponse(poll({ results: fresh }), poll({ results })).results).toEqual(fresh);
    expect(mergeVoteResponse(poll({ resultsAvailable: false }), poll({ results })).results).toBeUndefined();
    expect(mergeVoteResponse(poll(), undefined).results).toBeUndefined();
  });
});
