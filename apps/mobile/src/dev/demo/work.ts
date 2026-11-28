import { addDays, istanbulDay } from '@bm/shared/gate/plate';
import { type DemoHandler, demoUploadUrl, fail, ok } from './types';

/*
 * DEMO: bina gorevlisi (building_staff) İşlerim + sayac okuma. Atanan iki talep (biri acil), havuzda bir
 * talep ve bir bakim; bugun ve bu hafta bakimlari (kontrol listeli); bir acik okuma donemi. Durum
 * gecisleri, yorum, tahmin notu, fotograf yukleme ve endeks kaydi bellekte tutulur.
 */

type Json = Record<string, unknown>;
const STAFF_ID = 'mock-building_staff';
const day = 86_400_000;

const TRANSITIONS: Record<string, { to: string; next: string[] }> = {
  start: { to: 'in_progress', next: ['hold', 'resolve'] },
  hold: { to: 'on_hold', next: ['resume'] },
  resume: { to: 'in_progress', next: ['hold', 'resolve'] },
  resolve: { to: 'resolved', next: [] },
};

function seedTickets(now: Date): Json[] {
  const at = (h: number) => new Date(now.getTime() + h * 3600_000).toISOString();
  const base = { source: 'portal', reopenCount: 0, photoCount: 0, canAssign: false, canEdit: false, canEstimate: true, actions: ['start'], overdue: false, version: 1 };
  return [
    { ...base, ticketId: 'tk-41', number: 'T-0041', title: 'B Blok asansörü katlar arasında duruyor', description: 'Asansör 3. katta 10 sn bekleyip devam ediyor. Sakinler şikâyetçi.', category: 'elevator', priority: 'urgent', location: { kind: 'common', area: 'B Blok asansörü', blockId: 'blk-b' }, status: 'assigned', createdAt: at(-5), dueAt: at(-1), overdue: true, assigneeId: STAFF_ID, mine: true },
    { ...base, ticketId: 'tk-45', number: 'T-0045', title: 'Kombi basıncı düşüyor', description: 'Daire 7 kombisinin basıncı her sabah 0,5 bara düşüyor.', category: 'heating', priority: 'normal', location: { kind: 'unit', unitId: 'u-demo-7', blockId: 'blk-a' }, status: 'assigned', createdAt: at(-26), dueAt: at(20), assigneeId: STAFF_ID, mine: true },
    { ...base, ticketId: 'tk-47', number: 'T-0047', title: 'Otopark lambası yanmıyor', description: '-2 kat C bölümündeki iki armatür yanmıyor.', category: 'electrical', priority: 'low', location: { kind: 'common', area: 'Otopark -2' }, status: 'open', createdAt: at(-3), dueAt: at(45), actions: [], canAssign: true, mine: false, canEstimate: false },
  ];
}

function seedTasks(now: Date): Json[] {
  const today = istanbulDay(now);
  const base = { kind: 'periodic', ticketIds: [], overdue: false, version: 1 };
  return [
    {
      ...base, taskId: `${today}_tpl-hydro`, templateId: 'tpl-hydro', dueDate: today, name: 'Hidrofor aylık kontrol', category: 'water_pump', asset: 'Hidrofor odası', status: 'scheduled', assigneeId: STAFF_ID,
      checklist: [{ id: 'c1', text: 'Basınç değerleri normal aralıkta', required: true }, { id: 'c2', text: 'Kaçak / sızıntı yok', required: true }, { id: 'c3', text: 'Pano temizliği', required: false }],
      actions: ['start', 'complete', 'skip', 'estimate'],
    },
    { ...base, taskId: `${addDays(today, 3)}_tpl-gen`, templateId: 'tpl-gen', dueDate: addDays(today, 3), name: 'Jeneratör yük testi', category: 'generator', status: 'scheduled', assigneeId: STAFF_ID, checklist: [{ id: 'g1', text: 'Yakıt seviyesi', required: true }], actions: ['start', 'complete', 'skip', 'estimate'] },
    { ...base, taskId: `${addDays(today, 2)}_tpl-garden`, templateId: 'tpl-garden', dueDate: addDays(today, 2), name: 'Bahçe sulama sistemi', category: 'garden', status: 'scheduled', checklist: [], actions: ['assign'] },
  ];
}

const events = (t: Json): Json[] => [{ eventId: `${String(t.ticketId)}-e0`, kind: 'created', visibility: 'public', at: t.createdAt, byRole: 'resident' }];

export function createWorkDemo(): DemoHandler {
  let tickets: Json[] | null = null;
  let tasks: Json[] | null = null;
  const timeline: Record<string, Json[]> = {};
  const readings: Record<string, { endIndex: number; at: string; hasPhoto: boolean }> = {};
  let seq = 0;

  const init = (now: Date) => {
    tickets ??= seedTickets(now);
    tasks ??= seedTasks(now);
    for (const t of tickets) timeline[String(t.ticketId)] ??= events(t);
    return { tickets, tasks };
  };
  const push = (id: string, e: Json, now: Date) => (timeline[id] ??= []).push({ eventId: `ev-${++seq}`, visibility: 'public', at: now.toISOString(), by: STAFF_ID, byRole: 'building_staff', mine: true, ...e });

  return ({ method, path, query, body, claims, now }) => {
    const domain = path.startsWith('/api/tickets') || path.startsWith('/api/maintenance') || path.startsWith('/api/meter-readings') || path.startsWith('/api/sites/');
    if (!domain) return undefined;
    if (claims.role !== 'building_staff') return fail(403, 'forbidden', 'Bu işlem için yetkiniz yok.');
    const { tickets: ts, tasks: ks } = init(now);

    // --- Daire / blok adlari
    if (/^\/api\/sites\/[^/]+\/units$/.test(path)) {
      return ok({ items: [{ unitId: 'u-demo-7', blockId: 'blk-a', number: '7', status: 'active' }, { unitId: 'u-a-1', blockId: 'blk-a', number: '1', status: 'active' }, { unitId: 'u-b-2', blockId: 'blk-b', number: '2', status: 'active' }] });
    }
    if (/^\/api\/sites\/[^/]+\/blocks$/.test(path)) return ok({ items: [{ blockId: 'blk-a', name: 'A Blok' }, { blockId: 'blk-b', name: 'B Blok' }] });

    // --- Talepler
    if (path === '/api/tickets/assignees') return ok({ items: [{ userId: STAFF_ID, name: 'Demo Görevli' }] });
    if (path === '/api/tickets/photos/upload-url' || path === '/api/maintenance/photos/upload-url') {
      const id = `up-${++seq}_jpg`;
      return ok({ uploadId: id, uploadUrl: demoUploadUrl(id), headers: { 'Content-Type': String(body.contentType ?? 'image/jpeg') } });
    }
    if (path === '/api/tickets' && method === 'GET') {
      const assignee = query('assignee');
      const items = ts.filter((t) => ['open', 'assigned', 'in_progress', 'on_hold'].includes(String(t.status)) && (assignee === 'me' ? t.assigneeId === STAFF_ID : assignee === 'none' ? !t.assigneeId : true));
      return ok({ items, total: items.length });
    }
    const tk = /^\/api\/tickets\/([^/]+)(?:\/(status|assign|comments|estimate))?$/.exec(path);
    if (tk) {
      const t = ts.find((x) => x.ticketId === tk[1]);
      if (!t) return fail(404, 'not_found', 'Talep bulunamadı.');
      const id = String(t.ticketId);
      const sub = tk[2];
      if (!sub) return ok({ ticket: t, events: timeline[id] ?? [] });
      if (Number(body.version) !== t.version) return fail(409, 'conflict', 'Talep bu arada değişti; ekranı yenileyin.');
      if (sub === 'assign') {
        Object.assign(t, { assigneeId: STAFF_ID, mine: true, status: 'assigned', canAssign: false, canEstimate: true, actions: ['start'] });
        push(id, { kind: 'assigned', assigneeId: STAFF_ID }, now);
      } else if (sub === 'status') {
        const rule = TRANSITIONS[String(body.action)];
        if (!rule || !(t.actions as string[]).includes(String(body.action))) return fail(409, 'invalid_state', 'Bu işlem şu an yapılamaz.');
        const photos = Array.isArray(body.photos) ? (body.photos as string[]).map((p) => `apartments/demo/tickets/${id}/${p.replace('_', '.')}`) : [];
        push(id, { kind: 'status_changed', from: t.status, to: rule.to, ...(body.note ? { body: body.note } : {}), ...(photos.length ? { photoKeys: photos } : {}) }, now);
        Object.assign(t, { status: rule.to, actions: rule.next, overdue: rule.to === 'resolved' ? false : t.overdue, ...(rule.to === 'resolved' ? { resolvedAt: now.toISOString() } : {}) });
      } else if (sub === 'comments') {
        push(id, { kind: 'comment', visibility: body.visibility === 'public' ? 'public' : 'internal', body: body.body }, now);
        return { status: 201, body: { event: timeline[id]?.at(-1) } };
      } else if (sub === 'estimate') {
        if (body.amount === null) delete t.estimate;
        else t.estimate = { amount: Number(body.amount), ...(body.note ? { note: body.note } : {}), at: now.toISOString(), by: STAFF_ID, byRole: 'building_staff' };
        push(id, { kind: 'estimate_set', visibility: 'internal' }, now);
      }
      t.version = Number(t.version) + 1;
      return ok({ ticket: t });
    }
    if (/^\/api\/tickets\/[^/]+\/photos\/[^/]+$/.test(path)) return fail(404, 'not_found', 'Demo modunda fotoğraf görüntülenmez.');

    // --- Bakim
    if (path === '/api/maintenance/tasks' && method === 'GET') {
      const assignee = query('assignee');
      return ok({ items: ks.filter((k) => ['scheduled', 'in_progress'].includes(String(k.status)) && (assignee === 'me' ? k.assigneeId === STAFF_ID : assignee === 'none' ? !k.assigneeId : true)) });
    }
    const mt = /^\/api\/maintenance\/tasks\/([^/]+)(?:\/(start|complete|skip|assign|estimate|ticket))?$/.exec(path);
    if (mt) {
      const k = ks.find((x) => x.taskId === mt[1]);
      if (!k) return fail(404, 'not_found', 'Bakım görevi bulunamadı.');
      const sub = mt[2];
      if (!sub) return ok({ task: k });
      if (sub === 'ticket') {
        const t: Json = { ...(seedTickets(now)[1] as Json), ticketId: `tk-m${++seq}`, number: `T-00${50 + seq}`, title: body.title ?? `${String(k.name)} - bulgu`, source: 'maintenance', priority: body.priority ?? 'normal', status: 'assigned', actions: ['start'], version: 1, createdAt: now.toISOString(), dueAt: new Date(now.getTime() + day).toISOString() };
        ts.push(t);
        timeline[String(t.ticketId)] = events(t);
        k.ticketIds = [...(k.ticketIds as string[]), t.ticketId];
        return { status: 201, body: { ticket: t, replayed: false } };
      }
      if (Number(body.version) !== k.version) return fail(409, 'conflict', 'Görev bu arada değişti; ekranı yenileyin.');
      let failed = 0;
      if (sub === 'assign') Object.assign(k, { assigneeId: STAFF_ID, actions: ['start', 'complete', 'skip', 'estimate'] });
      if (sub === 'start') Object.assign(k, { status: 'in_progress', startedAt: now.toISOString(), actions: ['complete', 'skip', 'estimate'] });
      if (sub === 'skip') Object.assign(k, { status: 'skipped', skipReason: body.reason, actions: [] });
      if (sub === 'complete') {
        const results = (body.checklistResults as Json[] | undefined) ?? [];
        failed = results.filter((r) => r.ok === false).length;
        const photos = Array.isArray(body.photos) ? (body.photos as string[]).map((p) => `apartments/demo/maintenance/${String(k.taskId)}/${p.replace('_', '.')}`) : [];
        Object.assign(k, { status: 'done', completedAt: now.toISOString(), completedBy: STAFF_ID, checklistResults: results, ...(body.note ? { note: body.note } : {}), ...(photos.length ? { photoKeys: photos } : {}), actions: failed ? ['ticket', 'estimate'] : ['estimate'] });
      }
      if (sub === 'estimate') {
        if (body.amount === null) delete k.estimate;
        else k.estimate = { amount: Number(body.amount), ...(body.note ? { note: body.note } : {}), at: now.toISOString(), by: STAFF_ID };
      }
      k.version = Number(k.version) + 1;
      return ok(sub === 'complete' ? { task: k, failedItems: failed, suggestTicket: failed > 0 } : { task: k });
    }

    // --- Sayac okuma
    const today = istanbulDay(now);
    const period = { periodId: 'per-heat', name: 'Kasım ısınma', meterKind: 'heat_allocator', startDate: addDays(today, -27), endDate: today, status: 'draft', version: 1 };
    if (path === '/api/meter-readings/periods') return ok({ items: [period] });
    const photoUp = /^\/api\/meter-readings\/periods\/[^/]+\/meters\/([^/]+)\/photo-upload$/.exec(path);
    if (photoUp) {
      const key = `rp-${++seq}`;
      return ok({ photoKey: key, uploadUrl: demoUploadUrl(key), method: 'PUT', headers: { 'Content-Type': String(body.contentType ?? 'image/jpeg') }, maxBytes: 10485760, expiresAt: now.toISOString() });
    }
    if (path === '/api/meter-readings/periods/per-heat') {
      const meters = [
        { meterId: 'm-a7', unitId: 'u-demo-7', unitNumber: '7', blockId: 'blk-a', label: 'Salon peteği', serialNo: 'HA-10007', kind: 'heat_allocator', scale: 0, startIndex: 1520 },
        { meterId: 'm-a1', unitId: 'u-a-1', unitNumber: '1', blockId: 'blk-a', label: 'Salon peteği', serialNo: 'HA-10001', kind: 'heat_allocator', scale: 0, startIndex: 980 },
        { meterId: 'm-b2', unitId: 'u-b-2', unitNumber: '2', blockId: 'blk-b', label: 'Sıcak su', serialNo: 'SW-20002', kind: 'hot_water', scale: 3, startIndex: 45210 },
      ];
      if (method === 'PUT') {
        const items = ((body.items as Json[] | undefined) ?? []).map((it) => {
          const m = meters.find((x) => x.meterId === it.meterId);
          const end = Number(it.endIndex);
          readings[String(it.meterId)] = { endIndex: end, at: now.toISOString(), hasPhoto: !!it.photoKey };
          const delta = m ? end - m.startIndex : 0;
          return { meterId: it.meterId, unitId: m?.unitId ?? '', endIndex: end, delta, flags: m && delta > m.startIndex ? ['spike'] : [] };
        });
        return ok({ items, warnings: [] });
      }
      const rows = meters.map((m) => {
        const r = readings[m.meterId];
        return { ...m, inScope: true, startDate: period.startDate, status: r ? 'ok' : 'missing', flags: [], ...(r ? { endIndex: r.endIndex, endSource: 'reading', reading: { enteredAt: r.at, hasPhoto: r.hasPhoto } } : {}) };
      });
      const done = rows.filter((r) => r.status === 'ok').length;
      return ok({ period, rows, summary: { meters: rows.length, ok: done, auto: 0, missing: rows.length - done, errors: 0 } });
    }
    return undefined;
  };
}
