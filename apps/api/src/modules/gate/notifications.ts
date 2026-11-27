/**
 * Guvenlik kapisi olaylarindan alici cozumleme (saf; notification worker kullanir).
 *
 *  GATE_COURIER_ARRIVED -> bolumde bugun OTURAN guncel uyeler (kiraci veya dairede oturan malik;
 *                          portalda kuryeyi gorebilen herkes). Uyeligi kuryenin kaydindan SONRA
 *                          baslayan (devir gunu yeni sakin) ve tasinmis uyeler almaz. Kurye kaydi artik
 *                          beklemiyorsa (yanitlandi / iptal) veya yanit suresi dolduysa bildirim yok.
 *  GATE_GUEST_ENTERED   -> gecisi olusturan sakin; yalnizca hala bolumde oturuyorsa.
 *
 * Kurallar portaldaki gorunurlukle aynidir (bkz. gate/service.ts `residingUnits` / `residentSees`):
 * bildirim alan herkes portalda ilgili kaydi da gorur. Islemi yapan (gorevli) bildirim almaz.
 * KVKK: veride misafir adi, plaka, kuryenin adi / telefonu yoktur; yalnizca bolum, firma ve saatler.
 */
import type { IsoDate, IsoDateTime } from '../core/types.js';
import type { DomainEvent } from '../../events/publisher.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';
import type { UnitMembership } from '../portal/types.js';
import { istanbulDayStart } from './model.js';
import type { Courier } from './types.js';

export type GateRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

type GateDomainEvent = Extract<DomainEvent, { type: 'GATE_COURIER_ARRIVED' | 'GATE_GUEST_ENTERED' }>;

export const isGateEvent = (e: DomainEvent): e is GateDomainEvent => e.type === 'GATE_COURIER_ARRIVED' || e.type === 'GATE_GUEST_ENTERED';

/** Worker'in olay icin okudugu kurye kaydi (yalnizca gereken alanlar). `null`: kayit yok. */
export type CourierSnapshot = Pick<Courier, 'courierId' | 'unitId' | 'status' | 'company'> | null;

/** Bugun bolumde oturan guncel uyelik ve gorunurluk baslangici (portal kurali). */
function residingSince(m: UnitMembership, day: IsoDate): IsoDateTime | undefined {
  if (m.status !== 'active' || m.startDate > day || (m.endDate && m.endDate < day)) return undefined;
  if (m.relation !== 'tenant' && !m.residesInUnit) return undefined;
  const dayStart = istanbulDayStart(m.startDate);
  return m.createdAt && m.createdAt > dayStart ? m.createdAt : dayStart;
}

export function gateRecipients(
  event: GateDomainEvent,
  memberships: readonly UnitMembership[],
  day: IsoDate,
  opts: { now: Date; courier?: CourierSnapshot },
): GateRecipient[] {
  const unitId = event.payload.unitId;
  const residing = memberships.filter((m) => m.apartmentId === event.apartmentId && m.unitId === unitId && m.userId !== event.actorId);
  const out = new Map<string, GateRecipient>();

  if (event.type === 'GATE_COURIER_ARRIVED') {
    const p = event.payload;
    const courier = opts.courier;
    // Kayit okunduysa hala yanit bekliyor olmali; yanit suresi gectiyse (gec islenen olay) gonderilmez.
    if (courier === null || (courier && (courier.status !== 'waiting' || courier.unitId !== unitId))) return [];
    if (opts.now.toISOString() > p.respondBy) return [];
    for (const m of residing) {
      const since = residingSince(m, day);
      // Devir gunu: uyeligi kuryeden sonra baslayan yeni sakin kaydi portalda da gormez.
      if (!since || since > event.occurredAt || out.has(m.userId)) continue;
      out.set(m.userId, {
        userId: m.userId,
        template: 'gate_courier_arrived',
        data: { courierId: p.courierId, unitId, respondBy: p.respondBy, ...(courier?.company ? { company: courier.company } : {}) },
      });
    }
    return [...out.values()];
  }

  const p = event.payload;
  if (residing.some((m) => m.userId === p.hostUserId && residingSince(m, day))) {
    out.set(p.hostUserId, {
      userId: p.hostUserId,
      template: 'gate_guest_entered',
      data: { passId: p.passId, unitId, entryMode: p.entryMode, entryCount: p.entryCount, enteredAt: p.enteredAt, validUntil: p.validUntil },
    });
  }
  return [...out.values()];
}
