import {
  getTenantItem,
  putNewItem,
  putVersionedItem,
  queryTenantAll,
  skKey,
  tenantPk,
} from '../../config/dynamodb.js';
import type { TableKeys } from '../core/types.js';
import type { Announcement } from '../portal/types.js';

/** Duyurular: PK = `APT#<apartmentId>`, SK = `ANN#<announcementId>`. */
export const announcementKeys = {
  announcement: (apartmentId: string, announcementId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('ANN', announcementId),
  }),
};

export type AnnouncementRepository = {
  get(apartmentId: string, announcementId: string): Promise<Announcement | undefined>;
  list(apartmentId: string): Promise<Announcement[]>;
  create(announcement: Announcement): Promise<void>;
  update(announcement: Announcement, expectedVersion: number): Promise<void>;
};

function assertKeys(a: Announcement): void {
  const expected = announcementKeys.announcement(a.apartmentId, a.announcementId);
  if (a.PK !== expected.PK || a.SK !== expected.SK) {
    throw new Error(`Duyuru anahtari tutarsiz: ${a.PK}/${a.SK}`);
  }
}

export function createAnnouncementRepository(): AnnouncementRepository {
  return {
    get: (apartmentId, id) => getTenantItem<Announcement>(announcementKeys.announcement(apartmentId, id)),
    list: (apartmentId) => queryTenantAll<Announcement>(apartmentId, 'ANN#', { ConsistentRead: true }),
    async create(a) {
      assertKeys(a);
      await putNewItem(a);
    },
    async update(a, expectedVersion) {
      assertKeys(a);
      await putVersionedItem(a, expectedVersion);
    },
  };
}

export const announcementRepository: AnnouncementRepository = createAnnouncementRepository();
