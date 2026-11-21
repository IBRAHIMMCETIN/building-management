import { auditedPutNew, auditedPutVersioned } from '../audit/log.js';
import { createHash } from 'node:crypto';
import { getTenantItem, putNewItem, putVersionedItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import type { ImportItem, ImportJob } from './types.js';

const itemHash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 32);

export const importKeys = {
  job: (apartmentId: string, importId: string) => ({ PK: tenantPk(apartmentId), SK: skKey('IMPORT', importId) }),
  item: (apartmentId: string, importId: string, itemKey: string) => ({
    PK: tenantPk(apartmentId),
    SK: skKey('IMPORTITEM', importId, itemHash(itemKey)),
  }),
};

export type ImportRepository = {
  getJob(apartmentId: string, importId: string): Promise<ImportJob | undefined>;
  listJobs(apartmentId: string): Promise<ImportJob[]>;
  createJob(job: ImportJob): Promise<void>;
  updateJob(job: ImportJob, expectedVersion: number): Promise<void>;
  getItem(apartmentId: string, importId: string, itemKey: string): Promise<ImportItem | undefined>;
  listItems(apartmentId: string, importId: string): Promise<ImportItem[]>;
  /** Kosullu (attribute_not_exists): ayni satir iki kez yazilmaz. */
  createItem(item: ImportItem): Promise<void>;
  updateItem(item: ImportItem, expectedVersion: number): Promise<void>;
};

function importAudit(job: ImportJob, action: string) {
  const j = job as ImportJob & { createdBy?: string; updatedBy?: string; version?: number };
  return {
    apartmentId: job.apartmentId,
    action,
    target: { type: 'import', id: job.importId },
    actorId: j.updatedBy ?? j.createdBy,
    details: { status: job.status, counts: job.counts, version: j.version },
  };
}

export const importRepository: ImportRepository = {
  getJob: (apt, id) => getTenantItem<ImportJob>(importKeys.job(apt, id)),
  listJobs: (apt) => queryTenantAll<ImportJob>(apt, 'IMPORT#'),
  // Aktarim yasam dongusu denetlenir; olusan kisi, uyelik ve defter kayitlari kendi
  // depolarinda ayrica denetlenir. Satir kayitlari (IMPORTITEM) denetlenmez.
  createJob: (job) => auditedPutNew(job, importAudit(job, 'import.create')),
  updateJob: (job, v) => auditedPutVersioned(job, v, importAudit(job, `import.${job.status}`)),
  getItem: (apt, id, key) => getTenantItem<ImportItem>(importKeys.item(apt, id, key)),
  listItems: (apt, id) => queryTenantAll<ImportItem>(apt, `IMPORTITEM#${id}#`, { ConsistentRead: true }),
  createItem: (item) => putNewItem(item),
  updateItem: (item, v) => putVersionedItem(item, v),
};
