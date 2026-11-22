import { describe, expect, it } from 'vitest';
import type { FinanceAccount } from '@/lib/api/finance';
import type { OwnershipIssue } from '@/lib/api/ownership';
import { coOwnerAccounts, sortIssues } from './OwnershipPanel';
import { validateShareRows } from './RegisterSharesDialog';

const issue = (unitId: string, number: string, code: OwnershipIssue['code']): OwnershipIssue => ({ unitId, number, blockId: 'b1', code, message: code });

describe('Paydaşlar / hisse paneli', () => {
  it('sorunlar: tamamlama gerekenler once, daire no sirasi', () => {
    const sorted = sortIssues([
      issue('u10', '10', 'no_representative'),
      issue('u2', '2', 'incomplete_shares'),
      issue('u1', '1', 'not_registered'),
      issue('u3', '3', 'register_mismatch'),
      issue('u1b', '1', 'incomplete_shares'),
    ]);
    expect(sorted.map((i) => `${i.number}:${i.code}`)).toEqual([
      '1:incomplete_shares',
      '2:incomplete_shares',
      '3:register_mismatch',
      '1:not_registered',
      '10:no_representative',
    ]);
  });

  it('paydas carileri: yalnizca coOwner alt carileri', () => {
    const acc = (over: Partial<FinanceAccount>): FinanceAccount => ({ accountId: 'x', type: 'receivable', name: 'x', status: 'active', balance: 0, ...over });
    const list = coOwnerAccounts([
      acc({ accountId: 'recv-u1-owner', unitId: 'u1', liableParty: 'owner' }),
      acc({ accountId: 'recv-u1-owner-ha', unitId: 'u1', liableParty: 'owner', coOwner: { userId: 'a' }, balance: 100 }),
      acc({ accountId: 'recv-u1-owner-hb', unitId: 'u1', liableParty: 'owner', coOwner: { userId: 'b' }, balance: 500 }),
      acc({ accountId: 'cash', type: 'cash' }),
    ]);
    expect(list.map((a) => a.accountId)).toEqual(['recv-u1-owner-hb', 'recv-u1-owner-ha']);
  });

  it('hisse tamamlama formu: gecerli kesirler ve toplam tam 1', () => {
    expect(validateShareRows([])).toMatchObject({ error: expect.stringContaining('malik yok') });
    expect(validateShareRows([{ userId: 'a', share: '1/2' }, { userId: 'b', share: '' }])).toMatchObject({ error: expect.stringContaining('geçerli bir pay') });
    expect(validateShareRows([{ userId: 'a', share: '1/2' }, { userId: 'b', share: '1/3' }])).toEqual({ error: 'Payların toplamı tam 1 olmalı (şu an 5/6).' });
    expect(validateShareRows([{ userId: 'a', share: '1/3' }, { userId: 'b', share: '4/6' }])).toEqual({
      owners: [
        { userId: 'a', share: { numerator: 1, denominator: 3 } },
        { userId: 'b', share: { numerator: 2, denominator: 3 } },
      ],
    });
  });
});
