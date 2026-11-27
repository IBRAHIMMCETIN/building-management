import type { AuditDraft } from '../../src/modules/audit/log.js';
import { EquipmentConflictError, type EquipmentRepository } from '../../src/modules/equipment/repository.js';
import type { Equipment } from '../../src/modules/equipment/types.js';

/** Bellek ici ekipman deposu: anahtar `PK|SK`, surum kosulu gercek depoyla ayni; silme yok. */
export function createFakeEquipmentRepo() {
  const items = new Map<string, Equipment>();
  const audits: AuditDraft[] = [];
  const k = (o: { PK: string; SK: string }) => `${o.PK}|${o.SK}`;
  const repo: EquipmentRepository = {
    get: async (apt, id) => {
      const e = items.get(`APT#${apt}|EQUIP#${id}`);
      return e ? structuredClone(e) : undefined;
    },
    list: async (apt) => [...items.values()].filter((e) => e.PK === `APT#${apt}`).map((e) => structuredClone(e)),
    write: async (apt, w) => {
      if (w.item.apartmentId !== apt || w.item.PK !== `APT#${apt}`) throw new Error('Kiraci uyusmazligi');
      const cur = items.get(k(w.item));
      if (w.expectedVersion === 0 ? !!cur : cur?.version !== w.expectedVersion) throw new EquipmentConflictError();
      items.set(k(w.item), structuredClone(w.item));
      if (w.audit) audits.push(w.audit);
    },
  };
  return { repo, items, audits };
}
