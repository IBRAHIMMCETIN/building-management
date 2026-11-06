/**
 * Faz 3 - Sakin portali veri modelleri.
 *
 * Sakinin hangi daireyi gorebilecegi JWT'den degil, DynamoDB'deki daire uyeligi
 * (`UnitMembership`) kayitlarindan cozulur: JWT yalnizca `apartmentId` + `role` tasir
 * (Pre Token Generation Lambda). Boylece ayni apartmanda birden fazla dairesi olan
 * kullanicilar desteklenir ve uyelik sonlandiginda erisim aninda kesilir.
 */
import type {
  AuditFields,
  EntityStatus,
  IsoDate,
  IsoDateTime,
  LiableParty,
  TableKeys,
} from '../core/types.js';

/** Kisinin daireyle iliskisi. */
export type UnitRelation = 'owner' | 'tenant';

/**
 * Daire-kisi uyeligi.
 *   PK = `APT#<apartmentId>`, SK = `MEMBER#<userId>#<unitId>`
 * (GSI ile userId -> tum apartmanlar sorgusu Pre Token Lambda tarafinda kullanilir.)
 */
export type UnitMembership = TableKeys &
  AuditFields & {
    entityType: 'UNIT_MEMBERSHIP';
    userId: string;
    apartmentId: string;
    unitId: string;
    relation: UnitRelation;
    /**
     * Malik dairede oturuyorsa true: kiraci yokken isletme giderleri malike yazilir
     * (`occupant` alt carisi), bu nedenle o cariyi de gorur. Kiraci icin daima true.
     */
    residesInUnit: boolean;
    /** Hisseli mulkiyette malikin payi (ornegin 1/2). */
    ownershipShare?: { numerator: number; denominator: number };
    status: EntityStatus;
    /** Uyelik baslangici: bu tarihten onceki cari hareketler gosterilmez. */
    startDate: IsoDate;
    /** Tasinma/devir tarihi; sonrasinda erisim kapanir. */
    endDate?: IsoDate;
  };

export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

/**
 * Duyuru. Sakinler yalnizca `published` ve yayin penceresindeki duyurulari gorur.
 *   PK = `APT#<apartmentId>`, SK = `ANN#<publishAt>#<announcementId>`
 */
export type Announcement = TableKeys & {
  entityType: 'ANNOUNCEMENT';
  announcementId: string;
  apartmentId: string;
  title: string;
  body: string;
  status: AnnouncementStatus;
  /** Bos/yoksa tum apartman; doluysa yalnizca bu bloklar. */
  blockIds?: string[];
  publishAt: IsoDateTime;
  expiresAt?: IsoDateTime;
  approvedBy?: string;
  approvedAt?: IsoDateTime;
  createdAt: IsoDateTime;
  createdBy: string;
};

/** Sakinin gorebilecegi alt cariler (iliski + oturma durumuna gore). */
export function visibleParties(m: Pick<UnitMembership, 'relation' | 'residesInUnit'>): LiableParty[] {
  if (m.relation === 'tenant') return ['occupant'];
  return m.residesInUnit ? ['owner', 'occupant'] : ['owner'];
}
