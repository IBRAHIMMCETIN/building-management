import { MaintenanceConflictError, type MaintenanceRepository } from '../../src/modules/maintenance/repository.js';
import type { MaintenanceTask, MaintenanceTemplate } from '../../src/modules/maintenance/types.js';

/** Bellek ici bakim deposu (tek apartman); surum kosulu gercek depoyla ayni. */
export function createFakeMaintenanceRepo() {
  const items = new Map<string, MaintenanceTemplate | MaintenanceTask>();
  const writes: Parameters<MaintenanceRepository['write']>[1][] = [];
  const repo: MaintenanceRepository = {
    getTemplate: async (_a, id) => structuredClone(items.get(`MTPL#${id}`) as MaintenanceTemplate | undefined),
    listTemplates: async () => [...items.values()].filter((x): x is MaintenanceTemplate => x.entityType === 'MAINT_TEMPLATE').map((x) => structuredClone(x)),
    getTask: async (_a, d, t) => structuredClone(items.get(`MTASK#${d}#${t}`) as MaintenanceTask | undefined),
    listTasks: async (_a, from, to) =>
      [...items.values()]
        .filter((x): x is MaintenanceTask => x.entityType === 'MAINT_TASK' && x.dueDate >= from && x.dueDate <= to)
        .sort((a, b) => a.SK.localeCompare(b.SK))
        .map((x) => structuredClone(x)),
    createTaskIfAbsent: async (t) => {
      if (items.has(t.SK)) return false;
      items.set(t.SK, structuredClone(t));
      return true;
    },
    write: async (_a, w) => {
      const all = [...(w.template ? [w.template] : []), ...(w.tasks ?? [])];
      for (const { item, expectedVersion } of all) {
        const cur = items.get(item.SK);
        if (expectedVersion === 0 ? !!cur : cur?.version !== expectedVersion) throw new MaintenanceConflictError();
      }
      for (const { item } of all) items.set(item.SK, structuredClone(item));
      writes.push(w);
    },
  };
  return { repo, items, writes };
}
