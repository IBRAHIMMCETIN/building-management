/**
 * Ihale olaylarindan alici cozumleme (saf; notification worker kullanir).
 *
 *  TENDER_PUBLISHED  -> apartmanin bugun gecerli uyeligi olan tum kullanicilari (portalda ihaleyi
 *                       gorebilen herkes: bkz. service.ts `residentOf`). Ihale artik `published`
 *                       degilse (bu arada karara baglandi / iptal edildi) gonderilmez: o gecisin kendi
 *                       e-postasi gider, eski "paylasildi" e-postasi gitmez.
 *  TENDER_DECIDED    -> ayni alicilar; ihale `decided` degilse gonderilmez.
 *  TENDER_CANCELLED  -> ayni alicilar; yalnizca yayindan sonra iptal edilen ihale (`cancelledFrom =
 *                       published`). Taslak / teklif toplama asamasinda iptal sakinlere hic gorunmez.
 *  TENDER_REPLIED    -> yonetim yaniti: yanitin `answers` listesindeki (yazildigi anda yanitlanmamis)
 *                       sorularin sahipleri, hala apartman uyesiyse. Her soru yalnizca sonrasindaki ILK
 *                       yonetim yanitinda listelenir: soru sahibi bir kez e-posta alir; art arda yanitlar
 *                       ayni kisiye tekrar gitmez, yanitla es zamanli yazilan soru bir sonraki yanitta
 *                       kapsanir. Listesiz (eski) yanitta onceki yonetim yanitindan bu yana sorulanlar.
 *                       Yanit kaydi yoksa veya yonetim yaniti degilse kimse.
 *
 * Payload yalnizca kimlik tasir; baslik, firma, tutar, gerekce ve yanit metni worker'in okudugu
 * GUNCEL kayittan gelir (sakinlerin portalda gordugu bilgiyle ayni). Yazar kimligi e-postaya girmez.
 */
import type { DomainEvent } from '../../events/publisher.js';
import type { IsoDate } from '../core/types.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';
import type { UnitMembership } from '../portal/types.js';
import { compareQuotes } from './model.js';
import type { Tender, TenderComment } from './types.js';

export type TenderRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

type TenderDomainEvent = Extract<DomainEvent, { type: 'TENDER_PUBLISHED' | 'TENDER_DECIDED' | 'TENDER_CANCELLED' | 'TENDER_REPLIED' }>;

export const isTenderEvent = (e: DomainEvent): e is TenderDomainEvent =>
  e.type === 'TENDER_PUBLISHED' || e.type === 'TENDER_DECIDED' || e.type === 'TENDER_CANCELLED' || e.type === 'TENDER_REPLIED';

/** Worker'in okudugu guncel ihale (+ yanit olayinda yorumlar). `null`: kayit yok. */
export type TenderSnapshot = {
  tender: Pick<Tender, 'tenderId' | 'apartmentId' | 'title' | 'status' | 'quotes' | 'decision' | 'cancelReason' | 'cancelledFrom' | 'shortfallReason'>;
  comments?: readonly Pick<TenderComment, 'commentId' | 'authorId' | 'authorKind' | 'createdAt' | 'body' | 'answers'>[];
} | null;

/** E-postadaki yanit alintisi (tam metin portalda). */
export const REPLY_EXCERPT_MAX = 300;

const current = (m: UnitMembership, day: IsoDate) => m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);

export function tenderRecipients(event: TenderDomainEvent, memberships: readonly UnitMembership[], day: IsoDate, snapshot?: TenderSnapshot): TenderRecipient[] {
  const t = snapshot?.tender;
  if (!t || t.apartmentId !== event.apartmentId || t.tenderId !== event.payload.tenderId) return [];
  const members = new Set(memberships.filter((m) => m.apartmentId === event.apartmentId && current(m, day)).map((m) => m.userId));
  const to = (userIds: Iterable<string>, template: NotificationTemplate, data: NotificationData) =>
    [...new Set(userIds)].filter((u) => members.has(u)).map((userId) => ({ userId, template, data }));
  const base = { tenderId: t.tenderId, title: t.title };

  switch (event.type) {
    case 'TENDER_PUBLISHED': {
      if (t.status !== 'published') return [];
      const c = compareQuotes(t.quotes);
      return to(members, 'tender_published', {
        ...base,
        quoteCount: c.rows.length,
        ...(c.lowestTotalKurus !== undefined ? { lowestTotalKurus: c.lowestTotalKurus } : {}),
        ...(t.shortfallReason ? { shortfall: 'true' } : {}),
      });
    }
    case 'TENDER_DECIDED': {
      const d = t.decision;
      if (t.status !== 'decided' || !d) return [];
      return to(members, 'tender_decided', { ...base, supplierName: d.supplierName, totalKurus: d.totalKurus, reason: d.reason, ...(d.reference ? { reference: d.reference } : {}) });
    }
    case 'TENDER_CANCELLED': {
      if (t.status !== 'cancelled' || t.cancelledFrom !== 'published') return [];
      return to(members, 'tender_cancelled', { ...base, ...(t.cancelReason ? { reason: t.cancelReason } : {}) });
    }
    case 'TENDER_REPLIED': {
      const comments = [...(snapshot?.comments ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commentId.localeCompare(b.commentId));
      const at = comments.findIndex((c) => c.commentId === event.payload.commentId);
      const reply = comments[at];
      if (!reply || reply.authorKind !== 'management') return [];
      let askers: string[];
      if (reply.answers) {
        const ids = new Set(reply.answers);
        askers = comments.filter((c) => c.authorKind === 'resident' && ids.has(c.commentId)).map((c) => c.authorId);
      } else {
        // Eski yanit (liste yok): bir onceki yonetim yanitindan sonra yazilan sakin sorulari.
        let from = at - 1;
        while (from >= 0 && comments[from]?.authorKind !== 'management') from--;
        askers = comments.slice(from + 1, at).filter((c) => c.authorKind === 'resident').map((c) => c.authorId);
      }
      const excerpt = reply.body.length > REPLY_EXCERPT_MAX ? `${reply.body.slice(0, REPLY_EXCERPT_MAX - 1).trimEnd()}…` : reply.body;
      return to(askers, 'tender_replied', { ...base, reply: excerpt, repliedAt: reply.createdAt });
    }
  }
}
