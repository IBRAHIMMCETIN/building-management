import type { PhotoUpload } from '@bm/shared/api/portalTickets';
import type { DemoHandler } from '../demoApi';

/*
 * DEMO: sakin talepleri (/api/portal/tickets). Bellekte tutulur; olusturma, yorum, onay, yeniden
 * acma ve geri cekme ekranda hemen gorunur. Gercek veri DEGILDIR.
 */

type Json = Record<string, unknown>;
type DemoTicket = Json & { ticketId: string; status: string; version: number; actions: string[] };

const day = 86_400_000;
const P = '/api/portal/tickets';

function ticket(id: string, number: string, title: string, status: string, createdDaysAgo: number, now: Date, over: Json = {}): DemoTicket {
  return {
    ticketId: id,
    number,
    title,
    description: `${title}. Akşam saatlerinde daha belirgin oluyor.`,
    category: 'plumbing',
    priority: 'normal',
    location: { kind: 'unit', unitId: 'u-demo-7' },
    status,
    source: 'portal',
    createdAt: new Date(now.getTime() - createdDaysAgo * day).toISOString(),
    dueAt: new Date(now.getTime() + 2 * day).toISOString(),
    assigned: status !== 'open',
    actions: [],
    version: 1,
    ...over,
  };
}

/** Demo uploadUrl'e PUT yapilmaz (demo.invalid); yukleme kimligi hemen doner. */
export async function demoPut(upload: PhotoUpload): Promise<string> {
  await new Promise((r) => setTimeout(r, 150));
  return upload.uploadId;
}

export function createTicketsDemo(now0: Date = new Date()): DemoHandler {
  const at = (msAgo: number) => new Date(now0.getTime() - msAgo).toISOString();
  const tickets: DemoTicket[] = [
    ticket('tk-2', 'T-0042', 'Banyo lavabosu su kaçırıyor', 'resolved', 3, now0, { actions: ['confirm', 'reopen'], resolvedAt: at(5 * 3_600_000), photoCount: 1 }),
    ticket('tk-3', 'T-0045', 'Kombi basıncı düşüyor', 'assigned', 1, now0, { category: 'heating' }),
    ticket('tk-1', 'T-0031', 'Koridor lambası yanmıyor', 'closed', 20, now0, {
      category: 'electrical',
      location: { kind: 'common', area: 'A Blok 3. kat koridoru' },
      closeKind: 'confirmed',
      rating: { score: 5 },
      closedAt: at(18 * day),
    }),
  ];
  const events: Record<string, Json[]> = {
    'tk-2': [
      { eventId: 'e1', kind: 'created', visibility: 'public', at: at(3 * day), mine: true, byRole: 'resident' },
      { eventId: 'e2', kind: 'assigned', visibility: 'public', at: at(3 * day - 3_600_000), byRole: 'apartment_manager', assigneeId: 'u-staff' },
      { eventId: 'e3', kind: 'status_changed', visibility: 'public', at: at(2 * day), byRole: 'building_staff', from: 'assigned', to: 'in_progress' },
      {
        eventId: 'e4',
        kind: 'status_changed',
        visibility: 'public',
        at: at(5 * 3_600_000),
        byRole: 'building_staff',
        from: 'in_progress',
        to: 'resolved',
        body: 'Lavabo sifonu ve contası değiştirildi.',
        photoKeys: ['apartments/demo/tickets/tk-2/p1.jpg'],
      },
    ],
    'tk-3': [
      { eventId: 'e5', kind: 'created', visibility: 'public', at: at(day), mine: true, byRole: 'resident' },
      { eventId: 'e6', kind: 'assigned', visibility: 'public', at: at(day - 1_800_000), byRole: 'apartment_manager', assigneeId: 'u-staff' },
    ],
    'tk-1': [
      { eventId: 'e7', kind: 'created', visibility: 'public', at: at(20 * day), mine: true, byRole: 'resident' },
      { eventId: 'e8', kind: 'status_changed', visibility: 'public', at: at(19 * day), byRole: 'building_staff', from: 'assigned', to: 'resolved', body: 'Ampul değiştirildi.' },
      { eventId: 'e9', kind: 'rated', visibility: 'public', at: at(18 * day), mine: true, byRole: 'resident', rating: 5 },
    ],
  };
  let seq = 46;
  let ev = 100;
  const push = (id: string, e: Json, now: Date) => {
    (events[id] ??= []).push({ eventId: `e${ev++}`, visibility: 'public', at: now.toISOString(), mine: true, byRole: 'resident', ...e });
  };
  const conflict = { status: 409, body: { error: 'conflict', message: 'Talep bu arada güncellendi; yenileyip tekrar deneyin.' } };

  return ({ method, path, query, body, now }) => {
    if (!path.startsWith(P)) return undefined;
    const rest = path.slice(P.length);
    const b = (body ?? {}) as Json;

    if (rest === '' && method === 'GET') {
      const wanted = (query.status ?? '').split(',').filter(Boolean);
      const items = tickets.filter((t) => !wanted.length || wanted.includes(t.status));
      return { status: 200, body: { items, total: items.length } };
    }
    if (rest === '' && method === 'POST') {
      const location = b.location as Json;
      const t = ticket(`tk-${seq}`, `T-00${seq}`, String(b.title ?? ''), 'open', 0, now, {
        description: String(b.description ?? ''),
        category: b.category,
        location,
        assigned: false,
        actions: ['cancel'],
        photoCount: Array.isArray(b.photos) ? b.photos.length : 0,
        dueAt: new Date(now.getTime() + 3 * day).toISOString(),
      });
      seq++;
      tickets.unshift(t);
      push(t.ticketId, { kind: 'created', ...(Array.isArray(b.photos) && b.photos.length ? { photoKeys: b.photos.map((p) => `demo/${String(p)}`) } : {}) }, now);
      return { status: 201, body: { ticket: t, replayed: false } };
    }
    if (rest === '/similar') {
      const items = query.category === 'elevator' ? [{ number: 'T-0039', category: 'elevator', area: 'A Blok asansörü', status: 'in_progress', createdAt: at(2 * day), mine: false }] : [];
      return { status: 200, body: { items } };
    }
    if (rest === '/photos/upload-url') {
      return { status: 200, body: { uploadId: `demo${ev++}_jpg`, uploadUrl: 'https://demo.invalid/upload', headers: { 'Content-Type': String(b.contentType ?? 'image/jpeg') } } };
    }

    const [, id = '', action, photoId] = rest.split('/').map(decodeURIComponent);
    const t = tickets.find((x) => x.ticketId === id);
    if (!t) return { status: 404, body: { error: 'not_found', message: 'Talep bulunamadı.' } };

    if (!action && method === 'GET') return { status: 200, body: { ticket: t, events: events[id] ?? [] } };
    if (action === 'photos' && photoId) return { status: 404, body: { error: 'not_found', message: 'Demo modunda fotoğraf görüntülenmez; gerçek API’de fotoğraf burada açılır.' } };
    if (action === 'comments') {
      const photos = Array.isArray(b.photos) ? b.photos.map((p) => `demo/${String(p)}`) : [];
      push(id, { kind: 'comment', body: String(b.body ?? ''), ...(photos.length ? { photoKeys: photos } : {}) }, now);
      return { status: 201, body: { event: (events[id] ?? []).at(-1) } };
    }
    if (method !== 'POST' || !action) return undefined;
    if (b.version !== t.version) return conflict;
    const next = (over: Json) => Object.assign(t, { ...over, version: t.version + 1, updatedAt: now.toISOString() });
    if (action === 'confirm' && t.actions.includes('confirm')) {
      next({ status: 'closed', closeKind: 'confirmed', closedAt: now.toISOString(), actions: [], ...(typeof b.rating === 'number' ? { rating: { score: b.rating } } : {}) });
      push(id, { kind: 'status_changed', from: 'resolved', to: 'closed', ...(typeof b.note === 'string' ? { body: b.note } : {}) }, now);
      if (typeof b.rating === 'number') push(id, { kind: 'rated', rating: b.rating }, now);
      return { status: 200, body: { ticket: t } };
    }
    if (action === 'reopen' && t.actions.includes('reopen')) {
      next({ status: 'assigned', actions: [], reopenCount: Number(t.reopenCount ?? 0) + 1 });
      push(id, { kind: 'status_changed', from: 'resolved', to: 'assigned', body: String(b.note ?? '') }, now);
      return { status: 200, body: { ticket: t } };
    }
    if (action === 'cancel' && t.actions.includes('cancel')) {
      next({ status: 'cancelled', cancelKind: 'withdrawn', actions: [] });
      push(id, { kind: 'status_changed', from: 'open', to: 'cancelled' }, now);
      return { status: 200, body: { ticket: t } };
    }
    return { status: 422, body: { error: 'unprocessable', message: 'Bu işlem bu durumda yapılamaz.' } };
  };
}
