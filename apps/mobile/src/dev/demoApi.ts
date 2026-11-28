import type { NotificationPreferences } from '@bm/shared/api/notificationPreferences';
import { mockContextsFor } from '@bm/shared/auth/mockScenarios';
import { type SessionClaims, decodeClaims } from '@bm/shared/auth/session';
import { createGateDemo } from './demo/gate';
import { DEMO_UPLOAD_PREFIX } from './demo/types';
import { createWorkDemo } from './demo/work';
import { createAssembliesDemo } from './demoAssemblies';
import { createConsumptionDemo } from './demoConsumption';
import { createPollsDemo } from './demoPolls';
import { createTendersDemo } from './demoTenders';

/*
 * DEMO veri (EXPO_PUBLIC_API_MODE=demo, yalnizca mock kimlikle): API calismadan web onizlemesinde
 * ekranlar gorulebilsin diye M1 uclarinin ornek yanitlari. Gercek veri DEGILDIR; uygulama ust
 * cubugunda "Demo verisi" etiketi gorunur. Yanitlar API sozlesmesiyle ayni bicimdedir (zod
 * semalari @bm/shared'den dogrular).
 */

type Json = Record<string, unknown>;

/** Demo sakinin dairesi: ozet ve baglam listesi ayni daireyi gosterir (malik: Genel Kurul gorunur). */
export const DEMO_UNIT = { unitId: 'u-demo-7', unitNumber: '7', relation: 'owner' as const };

const day = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function respond(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

function monthStart(now: Date, monthsAgo: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
}

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

/** Son 14 ayin aidat tahakkuku + tahsilatlari (son iki ay odenmemis: gecikme ornegi). */
function statement(now: Date) {
  const entries: Json[] = [];
  let balance = 0;
  for (let i = 13; i >= 0; i--) {
    const start = monthStart(now, i);
    const due = new Date(start.getTime() + 9 * day);
    const label = `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()} aidatı`;
    balance += 150000;
    entries.push({ date: isoDate(start), transactionId: `tx-acc-${i}`, entryType: 'ACCRUAL', description: label, dueDate: isoDate(due), debit: 150000, credit: 0, balance });
    if (i >= 2) {
      balance -= 150000;
      const paid = new Date(start.getTime() + 6 * day);
      entries.push({
        date: isoDate(paid),
        transactionId: `tx-col-${i}`,
        entryType: 'COLLECTION',
        description: 'Aidat ödemesi (havale)',
        receiptNumber: `MKB-${start.getUTCFullYear()}-${String(140 - i).padStart(4, '0')}`,
        paymentId: `pay-${i}`,
        debit: 0,
        credit: 150000,
        balance,
      });
    }
  }
  const from = isoDate(monthStart(now, 13));
  return {
    unitId: 'u-demo-7',
    period: { from, to: isoDate(now) },
    accounts: [{ liableParty: 'owner', label: 'Malik', openingBalance: 0, totalDebit: 14 * 150000, totalCredit: 12 * 150000, closingBalance: balance, entries }],
    closingBalance: balance,
  };
}

/** Odenmemis son iki aidat: vadesi gecen gecikmede, gecmeyen "siradaki son odeme" (API kurali gibi). */
function summary(now: Date) {
  const today = isoDate(now);
  const open = [1, 0].map((i) => {
    const start = monthStart(now, i);
    return { dueDate: isoDate(new Date(start.getTime() + 9 * day)), description: `${MONTHS[start.getUTCMonth()]} aidatı` };
  });
  const overdue = open.filter((o) => o.dueDate < today);
  const upcoming = open.find((o) => o.dueDate >= today);
  const oldestDue = overdue[0]?.dueDate;
  return {
    unitId: 'u-demo-7',
    unitLabel: 'A Blok · Daire 7',
    relationLabel: 'Malik',
    asOf: now.toISOString(),
    balance: 300000,
    debt: 300000,
    advance: 0,
    totalCharged: 14 * 150000,
    totalPaid: 12 * 150000,
    status: overdue.length ? 'overdue' : 'pending',
    overdueAmount: overdue.length * 150000,
    accruedLateFee: overdue.length ? 7350 : 0,
    ...(oldestDue ? { oldestOverdueDueDate: oldestDue } : {}),
    daysOverdue: oldestDue ? Math.max(1, Math.floor((now.getTime() - Date.parse(oldestDue)) / day)) : 0,
    openCount: 2,
    ...(upcoming ? { nextDue: { ...upcoming, amount: 150000 } } : {}),
    lastPayment: { paidAt: isoDate(new Date(monthStart(now, 2).getTime() + 6 * day)), amount: 150000, receiptNumber: 'MKB-2026-0138' },
  };
}

function announcements(now: Date) {
  const at = (daysAgo: number, hour: number) => new Date(now.getTime() - daysAgo * day).toISOString().slice(0, 11) + `${String(hour - 3).padStart(2, '0')}:00:00.000Z`;
  return {
    items: [
      { announcementId: 'an-4', title: 'Asansör bakımı', body: 'A Blok asansörü perşembe 10:00-12:00 arası periyodik bakım nedeniyle kullanılamayacaktır.\nAnlayışınız için teşekkür ederiz.', publishAt: at(1, 9) },
      { announcementId: 'an-3', title: 'Su kesintisi', body: 'Belediyenin şebeke çalışması nedeniyle cumartesi 09:00-14:00 arası su kesintisi olacaktır.', publishAt: at(4, 18) },
      { announcementId: 'an-2', title: 'Olağan genel kurul toplantısı', body: 'Kat malikleri olağan genel kurul toplantısı ayın son pazar günü saat 14:00\'te sığınak toplantı salonunda yapılacaktır.', publishAt: at(9, 11) },
      { announcementId: 'an-1', title: 'Bahçe düzenlemesi', body: 'Ortak bahçede peyzaj çalışması tamamlandı. Çocuk oyun alanı yeniden kullanıma açıldı.', publishAt: at(20, 10) },
    ],
  };
}

function ticket(id: string, number: string, title: string, status: string, createdDaysAgo: number, now: Date, actions: string[] = []) {
  return {
    ticketId: id,
    number,
    title,
    description: title,
    category: 'plumbing',
    priority: 'normal',
    location: { kind: 'unit', unitId: 'u-demo-7' },
    status,
    source: 'portal',
    createdAt: new Date(now.getTime() - createdDaysAgo * day).toISOString(),
    dueAt: new Date(now.getTime() + 2 * day).toISOString(),
    assigned: status !== 'open',
    actions,
    version: 1,
  };
}

function quote(now: Date) {
  return {
    unitId: 'u-demo-7',
    currency: 'TRY',
    onlinePaymentEnabled: true,
    requiresGsmNumber: false,
    asOf: now.toISOString(),
    lateFeeMonthlyBasisPoints: 500,
    parties: [],
    totalDue: 307350,
  };
}

export type DemoFetchOptions = { now?: () => Date };

/** Alan bazli demo yanitlayici (ayri dosyalar: demoPolls.ts ...): ucu tanimiyorsa undefined. */
export type DemoRequest = { method: string; path: string; query: Record<string, string>; body: unknown; now: Date; claims: SessionClaims };
export type DemoReply = { status: number; body?: unknown };
export type DemoHandler = (req: DemoRequest) => DemoReply | undefined;

/** `fetch` yerine gecer: M1 uclari burada, sonraki alanlar kendi dosyalarinda (`domains`); digerleri 404. */
export function createDemoFetch({ now = () => new Date() }: DemoFetchOptions = {}): typeof fetch {
  let prefs: NotificationPreferences = { email: { enabled: true }, push: { enabled: true } };
  // Alan bazli isleyiciler: sakin (M2b) ve saha rolleri (M3: src/dev/demo/gate.ts, work.ts).
  const domains: DemoHandler[] = [createPollsDemo(), createAssembliesDemo(), createConsumptionDemo(), createTendersDemo(), createGateDemo(), createWorkDemo()];

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const [path = '', qs = ''] = raw.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    const claims = decodeClaims(token);
    const t = now();
    await new Promise((r) => setTimeout(r, 250));

    // Imzali S3 linki yerine demo yukleme hedefi (yetki basligi yok).
    if (path.startsWith(DEMO_UPLOAD_PREFIX) && method === 'PUT') return respond(200);
    if (!claims) return respond(401, { error: 'unauthorized' });

    if (path.startsWith('/api/me/devices')) return respond(method === 'POST' ? 201 : 200, { device: { deviceId: 'demo-device', platform: 'android', status: 'active' } });

    if (path === '/api/me/contexts') {
      const email = claims.email ?? '';
      const { isPlatformAdmin, contexts } = mockContextsFor(email);
      return respond(200, {
        userId: claims.sub,
        email,
        isPlatformAdmin,
        // Daire bilgisi olmayan senaryo sakin baglamlari demo dairesinin maliki (ozetteki "Daire 7 · Malik").
        contexts: contexts.map((c) => (c.role === 'resident' && !c.units ? { ...c, units: [DEMO_UNIT] } : c)),
        active: claims.role ? { role: claims.role, apartmentId: claims.apartmentId } : null,
      });
    }
    if (path === '/api/me/notification-preferences') {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { email?: Record<string, boolean>; push?: Record<string, boolean> };
        prefs = { email: { ...prefs.email, ...body.email }, push: { enabled: true, ...prefs.push, ...body.push }, updatedAt: t.toISOString() };
      }
      return respond(200, prefs);
    }

    if (path.startsWith('/api/portal/') && claims.role !== 'resident') return respond(403, { error: 'forbidden', message: 'Bu işlem için yetkiniz yok.' });

    switch (path) {
      case '/api/portal/my-summary':
        return respond(200, summary(t));
      case '/api/portal/my-statement':
        return respond(200, statement(t));
      case '/api/portal/announcements':
        return respond(200, announcements(t));
      case '/api/portal/payments/quote':
        return respond(200, quote(t));
      case '/api/portal/tickets': {
        const open = new URLSearchParamsLite(qs).get('status')?.includes('open') ?? true;
        const items = open
          ? [ticket('tk-2', 'T-0042', 'Banyo lavabosu su kaçırıyor', 'resolved', 3, t, ['confirm', 'reopen']), ticket('tk-3', 'T-0045', 'Kombi basıncı düşüyor', 'assigned', 1, t)]
          : [];
        return respond(200, { items, total: items.length });
      }
    }
    if (path.startsWith('/api/documents/my-receipts/')) {
      return respond(404, { error: 'not_found', message: 'Demo modunda makbuz PDF’i yok; gerçek API’de makbuz burada açılır.' });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    for (const handle of domains) {
      const reply = handle({ method, path, query: Object.fromEntries(new URLSearchParamsLite(qs).entries()), body, now: t, claims });
      if (reply) return respond(reply.status, reply.body);
    }
    return respond(404, { error: 'not_found', message: 'Demo modunda bu veri yok.' });
  }) as typeof fetch;
}

/** RN'in URLSearchParams'i eksik oldugundan kucuk bir okuyucu. */
class URLSearchParamsLite {
  private readonly map = new Map<string, string>();
  constructor(qs: string) {
    for (const part of qs.split('&')) {
      if (!part) continue;
      const [k = '', v = ''] = part.split('=');
      this.map.set(decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, ' ')));
    }
  }
  get(key: string) {
    return this.map.get(key);
  }
  entries() {
    return this.map.entries();
  }
}
