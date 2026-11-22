import { describe, expect, it } from 'vitest';
import { buildTransferInput, draftForKind, enteringUsers, fillRecipient, initialDraft } from './ownershipWizard';

const half = { numerator: 1, denominator: 2 };
const owners = [
  { userId: 'a', share: half, bps: 5000 },
  { userId: 'b', share: half, bps: 5000 },
];
const TODAY = '2026-11-22';

describe('devir sihirbazi mantigi', () => {
  it('tur secimi: tam satista tum paydaslar, mirasta tek muris on doldurulur', () => {
    const d0 = initialDraft(TODAY);
    expect(d0).toMatchObject({ kind: 'share_partial', effectiveDate: TODAY, debtTo: 'former', moves: [{ fromUserId: '', toUserId: '', share: '' }] });
    const sale = draftForKind(d0, 'sale_full', owners);
    expect(sale.moves).toEqual([
      { fromUserId: 'a', toUserId: '', share: '1/2' },
      { fromUserId: 'b', toUserId: '', share: '1/2' },
    ]);
    expect(fillRecipient(sale, 'n').moves.map((m) => m.toUserId)).toEqual(['n', 'n']);
    expect(draftForKind(d0, 'inheritance', owners).moves).toEqual([{ fromUserId: 'a', toUserId: '', share: '1/2' }]);
  });

  it('API girdisi: gecerli taslak, gelecek tarih ve eksik devralan', () => {
    const sale = fillRecipient(draftForKind(initialDraft(TODAY), 'sale_full', owners), 'n');
    const ok = buildTransferInput({ ...sale, residents: ['n', 'a'] }, owners, TODAY);
    expect(ok).toEqual({
      input: {
        kind: 'sale_full',
        effectiveDate: TODAY,
        moves: [
          { fromUserId: 'a', toUserId: 'n', share: half },
          { fromUserId: 'b', toUserId: 'n', share: half },
        ],
        debtTo: 'former',
        residents: ['n'],
      },
      after: [{ userId: 'n', share: { numerator: 1, denominator: 1 } }],
    });
    expect(buildTransferInput({ ...sale, effectiveDate: '2026-12-01' }, owners, TODAY)).toEqual({ error: 'Devir tarihi bugünden sonra olamaz.' });
    expect(buildTransferInput(draftForKind(initialDraft(TODAY), 'sale_full', owners), owners, TODAY)).toMatchObject({ error: expect.stringContaining('seçilmeli') });
  });

  it('yeni malikler (oturma kutusu icin)', () => {
    const d = { ...initialDraft(TODAY), moves: [{ fromUserId: 'a', toUserId: 'c', share: '1/4' }, { fromUserId: 'a', toUserId: 'b', share: '1/4' }] };
    expect(enteringUsers(d, owners)).toEqual(['c']);
  });
});
