import type { DemoHandler } from './demoApi';

/*
 * DEMO taksit (yapilandirma) talebi (/api/portal/plan-requests): demo sakinin iki aylik gecikmis
 * aidati (3.000 TL + islemis tazminat) icin 2-6 taksit secilebilir. Gonderilen talep demo oturumu
 * boyunca "Onay bekliyor" olarak gorunur, geri cekilebilir (ayni idempotency anahtari ayni sonuc).
 * Gecmiste reddedilmis bir ornek talep vardir. Gercek veri DEGILDIR; yalnizca __DEV__ paketinde yuklenir.
 */

type Req = Record<string, unknown> & { requestId: string; status: string; clientKey?: string };

export function createPlanRequestsDemo(): DemoHandler {
  const accountId = 'recv-u-demo-7-owner';
  const overdue = 300000;
  const accruedLateFee = 7350;
  const total = overdue + accruedLateFee;
  const settings = { enabled: true, maxInstallments: 6, minInstallmentAmount: 50000, includeLateFees: true };
  let n = 0;
  const requests: Req[] = [
    {
      requestId: 'demo-req-0',
      unitId: 'u-demo-7',
      accountId,
      liableParty: 'owner',
      installments: 12,
      estimate: { overdue: 150000, accruedLateFee: 0, total: 150000, installmentAmount: 12500 },
      status: 'rejected',
      decision: { at: '2026-06-02T09:00:00.000Z', mode: 'rejected', reason: 'Taksit sayısı yönetim planı sınırını aşıyor; en fazla 6 taksit isteyebilirsiniz.' },
      createdAt: '2026-06-01T09:00:00.000Z',
      updatedAt: '2026-06-02T09:00:00.000Z',
    },
  ];
  const view = ({ clientKey: _k, ...r }: Req) => r;
  const pending = () => requests.find((r) => r.status === 'pending');

  return ({ method, path, body, now }) => {
    if (!path.startsWith('/api/portal/plan-requests')) return undefined;
    if (method === 'GET' && path === '/api/portal/plan-requests/options') {
      const p = pending();
      return {
        status: 200,
        body: {
          unitId: 'u-demo-7',
          settings,
          minInstallments: 2,
          accounts: [
            {
              accountId,
              liableParty: 'owner',
              overdue,
              accruedLateFee,
              total,
              maxInstallments: Math.min(settings.maxInstallments, Math.floor(total / settings.minInstallmentAmount)),
              eligible: !p,
              ...(p ? { reason: 'pending_request', pendingRequest: 'mine', pendingRequestId: p.requestId } : {}),
            },
          ],
        },
      };
    }
    if (method === 'GET' && path === '/api/portal/plan-requests') return { status: 200, body: { items: [...requests].reverse().map(view) } };
    if (method === 'POST' && path === '/api/portal/plan-requests') {
      const b = (body ?? {}) as { idempotencyKey?: string; installments?: number; note?: string };
      const prior = requests.find((r) => r.clientKey === b.idempotencyKey);
      if (prior) return { status: 200, body: { replayed: true, request: view(prior) } };
      if (pending()) return { status: 409, body: { error: 'conflict', message: 'Bu cari için bekleyen bir yapılandırma talebi var' } };
      const installments = Number(b.installments ?? 0);
      const at = now.toISOString();
      const r: Req = {
        requestId: `demo-req-${++n}`,
        clientKey: b.idempotencyKey,
        unitId: 'u-demo-7',
        accountId,
        liableParty: 'owner',
        installments,
        ...(b.note ? { note: b.note } : {}),
        estimate: { overdue, accruedLateFee, total, installmentAmount: Math.floor(total / Math.max(1, installments)) },
        status: 'pending',
        createdAt: at,
        updatedAt: at,
      };
      requests.push(r);
      return { status: 201, body: { replayed: false, request: view(r) } };
    }
    const m = /^\/api\/portal\/plan-requests\/([^/]+)\/withdraw$/.exec(path);
    if (method === 'POST' && m) {
      const r = requests.find((x) => x.requestId === decodeURIComponent(m[1] ?? ''));
      if (!r) return { status: 404, body: { error: 'not_found', message: 'Yapılandırma talebi bulunamadı' } };
      if (r.status !== 'pending') return { status: 409, body: { error: 'conflict', message: 'Talep zaten sonuçlandırılmış' } };
      const at = now.toISOString();
      Object.assign(r, { status: 'withdrawn', decision: { at, mode: 'withdrawn', reason: 'Sakin talebini geri çekti' }, updatedAt: at });
      return { status: 200, body: { request: view(r) } };
    }
    return { status: 404, body: { error: 'not_found', message: 'Demo modunda bu veri yok.' } };
  };
}
