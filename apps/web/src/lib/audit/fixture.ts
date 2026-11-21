import type { ChainedEntry } from './chain';

/**
 * API'nin (`buildEntry`) urettigi gercek kayitlar, GET /api/audit yanit bicimiyle (GSI alanlari yok).
 * Ayni sabit API tarafinda da (test/audit.test.ts) dogrulanir: iki uygulama ayni hash'i uretmeli.
 */
export const AUDIT_FIXTURE: ChainedEntry[] = [
  {
    PK: 'APT#apt-1',
    SK: 'SEQ#000000000002',
    entityType: 'AUDIT_ENTRY',
    scope: 'APT#apt-1',
    seq: 2,
    auditId: '05e142eb-5e2b-43ae-bc2e-d9a7cdb12bfa',
    at: '2026-11-21T10:05:00.000Z',
    action: 'membership.create',
    actor: { userId: 'sys', role: 'system' },
    apartmentId: 'apt-1',
    target: { type: 'membership', id: 'u9:u1' },
    prevHash: 'e5e6cfc7b7ed4d739b514900600a02c218a710ec75572c852fe70be5cba371fc',
    ttl: 2110788300,
    hash: '4b933a1b66ac0c4722749470551c4b7fb30ae9ebc125649fe5ae0077c751102e',
  },
  {
    PK: 'APT#apt-1',
    SK: 'SEQ#000000000001',
    entityType: 'AUDIT_ENTRY',
    scope: 'APT#apt-1',
    seq: 1,
    auditId: '497dd13d-a5eb-48ea-bd87-220d4df26919',
    at: '2026-11-21T10:00:00.000Z',
    action: 'ledger.payment',
    actor: { userId: 'mgr-1', role: 'apartment_manager' },
    apartmentId: 'apt-1',
    target: { type: 'transaction', id: 't-1' },
    reason: 'Tahsilat — Daire 5',
    details: { total: 150050, accounts: ['cash', 'recv-u1'], nested: { ok: true } },
    request: { requestId: 'req-1', ip: '203.0.113.0/24', userAgent: 'Mozilla/5.0 (Türkçe ğüşıöç)' },
    prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
    ttl: 2110788000,
    hash: 'e5e6cfc7b7ed4d739b514900600a02c218a710ec75572c852fe70be5cba371fc',
  },
];
