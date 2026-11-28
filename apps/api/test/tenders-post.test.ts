/**
 * Ihale devami: genel kurul karari gercek bagi (ayni apartmanin ASMDEC# kaydi; sakine malikse portal
 * baglantisi), soru moderasyonu (gerekceli gizleme, denetimli; sakinlere gizli, yonetime gorunur) ve
 * belirli soruya yanit (bildirim yalnizca o sorunun yazarina).
 */
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/events/publisher.js';
import type { Assembly, AssemblyDecision } from '../src/modules/assemblies/types.js';
import type { Notification } from '../src/modules/notifications/notifier.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { type TenderContext, createTenderService } from '../src/modules/tenders/service.js';
import { type SqsEvent, createNotificationWorker } from '../src/workers/notification-worker.js';
import { createFakeTenderRepo } from './fakes/tenderRepo.js';

const APT = 'apt-1';
const T0 = '2026-11-27T07:00:00.000Z';

const ctx = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  obs: { apartmentId: APT, userId: 'obs', role: 'observer' },
  a: { apartmentId: APT, userId: 'res-a', role: 'resident' },
  b: { apartmentId: APT, userId: 'res-b', role: 'resident' },
  ten: { apartmentId: APT, userId: 'ten-1', role: 'resident' },
} satisfies Record<string, TenderContext>;

const member = (userId: string, unitId: string, extra: Partial<UnitMembership> = {}) =>
  ({ userId, unitId, apartmentId: APT, relation: 'owner', residesInUnit: true, status: 'active', startDate: '2026-01-01', ...extra }) as unknown as UnitMembership;

const assembly = (id: string, status: Assembly['status'], apartmentId = APT) => ({ apartmentId, assemblyId: id, status, scheduledAt: '2026-11-10T16:00:00.000Z' }) as Assembly;
const decision = (assemblyId: string, itemId: string, seq: number, result: 'accepted' | 'rejected', apartmentId = APT) =>
  ({
    entityType: 'ASSEMBLY_DECISION',
    apartmentId,
    assemblyId,
    itemId,
    seq,
    meetingAt: '2026-11-10T16:00:00.000Z',
    meetingKind: 'ordinary',
    secondMeeting: false,
    itemTitle: `Madde ${itemId} (${seq})`,
    decisionKind: 'beneficial_improvement',
    outcome: { decision: result },
    recordedAt: T0,
    recordedBy: 'mgr',
  }) as unknown as AssemblyDecision;

function world() {
  const fake = createFakeTenderRepo();
  let now = new Date(T0);
  let n = 0;
  const memberships = [member('res-a', 'u1'), member('res-b', 'u2'), member('ten-1', 'u3', { relation: 'tenant' })];
  const assemblies: Assembly[] = [assembly('asm1', 'held'), assembly('asm2', 'planned'), assembly('asm3', 'cancelled'), assembly('asmX', 'held', 'apt-2')];
  const decisions: AssemblyDecision[] = [
    decision('asm1', 'a1', 1, 'accepted'),
    decision('asm1', 'a2', 1, 'accepted'),
    decision('asm1', 'a2', 2, 'rejected'),
    decision('asm2', 'a1', 1, 'accepted'),
    decision('asmX', 'a1', 1, 'accepted', 'apt-2'),
  ];
  const service = createTenderService({
    repo: fake.repo,
    documents: {
      promote: async (apt, upload, target) => ({ key: `apartments/${apt}/tenders/${target.tenderId}/quotes/${target.quoteId}/${upload.uploadId}.pdf`, fileName: upload.fileName, contentType: 'application/pdf', size: 1000 }),
      sign: async () => ({ url: 'https://s3.example/x', fileName: 'a.pdf', contentType: 'application/pdf', expiresAt: T0 }),
    },
    tickets: { get: async () => undefined },
    memberships: { listMemberships: async (apt, userId) => memberships.filter((m) => m.apartmentId === apt && m.userId === userId) },
    // Depo da partition'a gore okur: baska apartmanin kaydi bu apartmanin sorgusuna gelmez.
    assemblies: {
      get: async (apt, id) => assemblies.find((a) => a.apartmentId === apt && a.assemblyId === id),
      list: async (apt) => assemblies.filter((a) => a.apartmentId === apt),
      listDecisions: async (apt, id) => decisions.filter((d) => d.apartmentId === apt && (!id || d.assemblyId === id)),
    },
    now: () => now,
    newId: () => String(++n).padStart(10, '0'),
  });
  let k = 0;
  const key = () => `key-${++k}`;
  const tick = () => (now = new Date(now.getTime() + 60_000));
  async function published() {
    const created = await service.create(ctx.mgr, { idempotencyKey: key(), title: 'Isı yalıtımı', description: 'Dış cephe ısı yalıtımı işi', category: 'mantolama', deadline: '2026-12-15', minQuotes: 1 });
    let t = (await service.collect(ctx.mgr, created.tender.tenderId, { version: created.tender.version })).tender;
    t = (await service.addQuote(ctx.mgr, t.tenderId, { idempotencyKey: key(), supplierName: 'Cephe Ltd.', amountKurus: 90_000_00, vatIncluded: false, vatRate: 20, document: { uploadId: 'up-1', fileName: 'teklif.pdf' } })).tender;
    return (await service.publish(ctx.mgr, t.tenderId, { version: t.version })).tender;
  }
  const comment = async (who: TenderContext, tenderId: string, body: string, extra: Record<string, unknown> = {}) => {
    tick();
    return service.comment(who, tenderId, { idempotencyKey: key(), body, ...extra });
  };
  const sent: Notification[] = [];
  const processed = new Set<string>();
  const worker = createNotificationWorker({
    memberships: { list: async (apt) => memberships.filter((m) => m.apartmentId === apt) },
    core: { listUnits: async () => [] },
    tenders: { get: fake.repo.get, listComments: fake.repo.listComments },
    notifier: { channel: 'test', send: async (x) => void sent.push(x) },
    isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
    markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
    now: () => now,
    log: { info: () => {}, error: () => {} },
  });
  const deliver = async (e: DomainEvent) => {
    const before = sent.length;
    await worker({ Records: [{ messageId: 'm', body: JSON.stringify(e) }] } satisfies SqsEvent);
    return sent.slice(before);
  };
  const lastReply = () => [...fake.outbox].reverse().find((e) => e.type === 'TENDER_REPLIED') as DomainEvent;
  return { fake, service, published, comment, deliver, lastReply, decisions, assemblies };
}

describe('genel kurul karari bagi', () => {
  it('secici: ayni apartmanin madde basina guncel karari (duzeltme dahil), iptal edilmis / baska apartman yok; denetci okur, sakin okuyamaz', async () => {
    const w = world();
    const { items } = await w.service.assemblyDecisionOptions(ctx.mgr);
    // Yalnizca tutanagi kesinlesmis toplantilar (asm2 planli: listede yok).
    expect(items.map((d) => [d.assemblyId, d.itemId, d.seq, d.decision, d.assemblyStatus])).toEqual([
      ['asm1', 'a1', 1, 'accepted', 'held'],
      ['asm1', 'a2', 2, 'rejected', 'held'],
    ]);
    expect((await w.service.assemblyDecisionOptions(ctx.obs)).items).toHaveLength(2);
    await expect(w.service.assemblyDecisionOptions(ctx.a)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('kararda bag: yalnizca kabul edilmis guncel karar; iptal edilen toplanti / baska apartman / olmayan karar reddedilir; denetimli', async () => {
    const w = world();
    const t = await w.published();
    const decide = (assemblyDecision: unknown) => w.service.decide(ctx.mgr, t.tenderId, { version: t.version, quoteId: t.quotes[0]!.quoteId, reason: 'Tek teklif, kurul onaylı', assemblyDecision });
    await expect(decide({ assemblyId: 'asm1', itemId: 'a2' })).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(decide({ assemblyId: 'asm3', itemId: 'a1' })).rejects.toMatchObject({ code: 'unprocessable' });
    // Tutanagi kesinlesmemis toplanti karari baglanamaz.
    await expect(decide({ assemblyId: 'asm2', itemId: 'a1' })).rejects.toMatchObject({ code: 'unprocessable', message: expect.stringContaining('kesinleşmemiş') });
    await expect(decide({ assemblyId: 'asmX', itemId: 'a1' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(decide({ assemblyId: 'asm1', itemId: 'a9' })).rejects.toMatchObject({ code: 'not_found' });
    const r = await decide({ assemblyId: 'asm1', itemId: 'a1' });
    expect(r.tender).toMatchObject({ status: 'decided', assemblyDecision: { assemblyId: 'asm1', itemId: 'a1', seq: 1, itemTitle: 'Madde a1 (1)', decision: 'accepted', assemblyStatus: 'held', linkedBy: 'mgr' } });
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'tender.decide', details: { assemblyId: 'asm1', assemblyItemId: 'a1', assemblySeq: 1 } });
    expect((await w.service.get(ctx.obs, t.tenderId)).tender.assemblyDecision).not.toHaveProperty('linkedBy');
  });

  it('sonradan bag / kaldirma surumlu; sakin: malikse ve tutanak kesinlesmisse portal baglantisi, kiraciya baglanti yok; sonradan duzeltilen karar belirtilir', async () => {
    const w = world();
    const t = await w.published();
    await expect(w.service.linkAssemblyDecision(ctx.mgr, t.tenderId, { version: t.version + 1, assemblyDecision: { assemblyId: 'asm1', itemId: 'a1' } })).rejects.toMatchObject({ code: 'conflict' });
    await expect(w.service.linkAssemblyDecision(ctx.obs, t.tenderId, { version: t.version, assemblyDecision: { assemblyId: 'asm1', itemId: 'a1' } })).rejects.toMatchObject({ code: 'forbidden' });
    const linked = await w.service.linkAssemblyDecision(ctx.mgr, t.tenderId, { version: t.version, assemblyDecision: { assemblyId: 'asm1', itemId: 'a1' } });
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'tender.assembly_link', details: { assemblyId: 'asm1', itemId: 'a1', seq: 1 } });
    expect((await w.service.portalGet(ctx.a, t.tenderId)).tender.assemblyDecision).toEqual({ assemblyId: 'asm1', itemId: 'a1', itemTitle: 'Madde a1 (1)', meetingAt: '2026-11-10T16:00:00.000Z', decision: 'accepted', portalLink: true });
    expect((await w.service.portalGet(ctx.ten, t.tenderId)).tender.assemblyDecision).toMatchObject({ portalLink: false });
    // Karar sonradan duzeltildi (yeni sira): bag eski kaydi gosterir, ekranda belirtilir.
    w.decisions.push(decision('asm1', 'a1', 2, 'rejected'));
    expect((await w.service.portalGet(ctx.a, t.tenderId)).tender.assemblyDecision).toMatchObject({ corrected: true, currentDecision: 'rejected' });
    // Kesinlesmemis toplanti karari baglanamaz.
    await expect(w.service.linkAssemblyDecision(ctx.mgr, t.tenderId, { version: linked.tender.version, assemblyDecision: { assemblyId: 'asm2', itemId: 'a1' } })).rejects.toMatchObject({ code: 'unprocessable' });
    const un = await w.service.linkAssemblyDecision(ctx.mgr, t.tenderId, { version: linked.tender.version, assemblyDecision: null });
    expect(un.tender).not.toHaveProperty('assemblyDecision');
    expect(w.fake.audits.at(-1)).toMatchObject({ details: { removed: true, previousAssemblyId: 'asm1' } });
  });
});

describe('soru moderasyonu ve belirli soruya yanit', () => {
  it('gizleme: yalnizca yonetim, gerekceli, bir kez, yalnizca sakin sorusu; sakinlere (yazar dahil) gizli, yonetim / denetci gerekceyle gorur; denetimli', async () => {
    const w = world();
    const t = await w.published();
    const q = (await w.comment(ctx.a, t.tenderId, 'Firma sahibi kimin akrabası?')).tender.comments.at(-1)!;
    await w.comment(ctx.b, t.tenderId, 'İş ne zaman başlar?');
    const reply = (await w.comment(ctx.mgr, t.tenderId, 'Ocak ayında başlar.')).tender.comments.at(-1)!;
    await expect(w.service.hideComment(ctx.obs, t.tenderId, q.commentId, { reason: 'Kişisel iddia' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.hideComment(ctx.a, t.tenderId, q.commentId, { reason: 'Kişisel iddia' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.hideComment(ctx.mgr, t.tenderId, q.commentId, {})).rejects.toMatchObject({ field: 'reason' });
    await expect(w.service.hideComment(ctx.mgr, t.tenderId, reply.commentId, { reason: 'Hatalı yanıt' })).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(w.service.hideComment(ctx.mgr, t.tenderId, 'c-yok', { reason: 'Kişisel iddia' })).rejects.toMatchObject({ code: 'not_found' });
    const hidden = await w.service.hideComment(ctx.mgr, t.tenderId, q.commentId, { reason: 'Kişisel iddia içeriyor' });
    expect(hidden.tender.comments.find((c) => c.commentId === q.commentId)).toMatchObject({ body: 'Firma sahibi kimin akrabası?', hidden: { reason: 'Kişisel iddia içeriyor', by: 'mgr' } });
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'tender.comment_hide', reason: 'Kişisel iddia içeriyor', details: { commentId: q.commentId } });
    expect(JSON.stringify(w.fake.audits.at(-1))).not.toContain('akraba');
    await expect(w.service.hideComment(ctx.mgr, t.tenderId, q.commentId, { reason: 'Tekrar' })).rejects.toMatchObject({ code: 'conflict' });
    for (const who of [ctx.a, ctx.b]) {
      const view = (await w.service.portalGet(who, t.tenderId)).tender;
      expect(view.comments.map((c) => c.commentId)).not.toContain(q.commentId);
      expect(JSON.stringify(view)).not.toContain('akraba');
    }
    expect((await w.service.get(ctx.obs, t.tenderId)).tender.comments.find((c) => c.commentId === q.commentId)).toMatchObject({ hidden: { reason: 'Kişisel iddia içeriyor' } });
    expect((await w.service.get(ctx.obs, t.tenderId)).tender.comments.find((c) => c.commentId === q.commentId)?.hidden).not.toHaveProperty('by');
    // Metin silinmez: kayit ayni, yalnizca gizleme alanlari eklenir.
    const stored = [...w.fake.store.values()].find((d) => d.commentId === q.commentId);
    expect(stored).toMatchObject({ body: 'Firma sahibi kimin akrabası?', hiddenBy: 'mgr', hideReason: 'Kişisel iddia içeriyor', hiddenAt: expect.any(String) });
  });

  it('gizlenen soru yanit beklemez: sonraki genel yanitta e-posta yazarina gitmez', async () => {
    const w = world();
    const t = await w.published();
    const q = (await w.comment(ctx.a, t.tenderId, 'Uygunsuz soru metni burada')).tender.comments.at(-1)!;
    await w.comment(ctx.b, t.tenderId, 'Garanti kaç yıl?');
    await w.service.hideComment(ctx.mgr, t.tenderId, q.commentId, { reason: 'Uygunsuz içerik' });
    await w.comment(ctx.mgr, t.tenderId, 'Garanti 10 yıl.');
    const sent = await w.deliver(w.lastReply());
    expect(sent.map((x) => x.userId)).toEqual(['res-b']);
  });

  it('belirli soruya yanit: bildirim yalnizca o sorunun yazarina; diger acik soru acik kalir; sakin replyTo veremez; olmayan / gizlenen soru reddedilir', async () => {
    const w = world();
    const t = await w.published();
    const qa = (await w.comment(ctx.a, t.tenderId, 'Teklif KDV dahil mi?')).tender.comments.at(-1)!;
    const qb = (await w.comment(ctx.b, t.tenderId, 'İş süresi ne kadar?')).tender.comments.at(-1)!;
    await expect(w.comment(ctx.a, t.tenderId, 'Ek soru', { replyTo: qb.commentId })).rejects.toMatchObject({ field: 'replyTo' });
    await expect(w.comment(ctx.mgr, t.tenderId, 'Yanıt', { replyTo: 'c-yok' })).rejects.toMatchObject({ code: 'not_found' });
    const r = await w.comment(ctx.mgr, t.tenderId, 'Evet, KDV dahil 108.000 TL.', { replyTo: qa.commentId });
    const reply = r.tender.comments.at(-1)!;
    expect(reply).toMatchObject({ authorKind: 'management', replyTo: qa.commentId });
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'tender.comment', details: { replyTo: qa.commentId } });
    expect((await w.deliver(w.lastReply())).map((x) => x.userId)).toEqual(['res-a']);
    // qb hala acik: sonraki genel yanit yalnizca qb yazarina.
    await w.comment(ctx.mgr, t.tenderId, 'İş süresi 45 gün.');
    expect((await w.deliver(w.lastReply())).map((x) => x.userId)).toEqual(['res-b']);
    // Sakin gorunumunde yanit hangi soruya oldugunu tasir; soru sonra gizlenirse bag gosterilmez.
    expect((await w.service.portalGet(ctx.b, t.tenderId)).tender.comments.find((c) => c.commentId === reply.commentId)).toMatchObject({ replyTo: qa.commentId });
    await w.service.hideComment(ctx.mgr, t.tenderId, qa.commentId, { reason: 'Yazar isteği' });
    const after = (await w.service.portalGet(ctx.b, t.tenderId)).tender.comments.find((c) => c.commentId === reply.commentId);
    expect(after).toBeDefined();
    expect(after).not.toHaveProperty('replyTo');
    await expect(w.comment(ctx.mgr, t.tenderId, 'Yanıt', { replyTo: qa.commentId })).rejects.toMatchObject({ code: 'unprocessable' });
  });
});
