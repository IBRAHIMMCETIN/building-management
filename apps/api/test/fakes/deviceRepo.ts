import type { AuditDraft } from '../../src/modules/audit/log.js';
import { type DeviceRepository, DeviceWriteConflict, MAX_ACTIVE_DEVICES, type PushDevice } from '../../src/modules/notifications/devices.js';

type Stored = PushDevice & { token?: string };

/**
 * Bellek ici cihaz deposu: DynamoDB kosullarini taklit eder (sahiplik kaydi beklenen degerde degilse
 * ya da pasife alinacak cihaz artik aktif degilse tum yazim iptal: `DeviceWriteConflict`).
 */
export function createFakeDeviceRepo() {
  const devices = new Map<string, Stored>();
  const owners = new Map<string, string>();
  const audits: AuditDraft[] = [];
  const key = (userId: string, deviceId: string) => `${userId}|${deviceId}`;
  const strip = (d: Stored): PushDevice => {
    const { token: _t, ...rest } = d;
    return structuredClone(rest);
  };
  /** Test kancasi: `save` cagrisindan hemen once (es zamanli yazim taklidi). */
  const hooks: { beforeSave?: () => void } = {};

  const repository: DeviceRepository = {
    async listByUser(userId) {
      return [...devices.values()].filter((d) => d.userId === userId).map(strip);
    },
    async get(userId, deviceId) {
      const d = devices.get(key(userId, deviceId));
      return d ? strip(d) : undefined;
    },
    async getOwner(deviceId) {
      return owners.get(deviceId);
    },
    async save(write) {
      hooks.beforeSave?.();
      hooks.beforeSave = undefined;
      const d = write.device;
      if (write.owner && (owners.get(d.deviceId) ?? null) !== write.owner.expected) throw new DeviceWriteConflict();
      for (const id of write.evict) if (devices.get(key(d.userId, id))?.status !== 'active') throw new DeviceWriteConflict();
      if (write.moveFrom && !devices.has(key(write.moveFrom, d.deviceId))) throw new DeviceWriteConflict();
      const off = (userId: string, id: string, reason: PushDevice['deactivationReason']) => {
        const cur = devices.get(key(userId, id));
        if (!cur) return;
        const { token: _t, ...rest } = cur;
        devices.set(key(userId, id), { ...rest, status: 'inactive', deactivatedAt: d.lastSeenAt, ...(reason ? { deactivationReason: reason } : {}) });
      };
      devices.set(key(d.userId, d.deviceId), structuredClone(d));
      if (write.owner) owners.set(d.deviceId, d.userId);
      if (write.moveFrom) off(write.moveFrom, d.deviceId, 'moved');
      for (const id of write.evict) off(d.userId, id, 'limit');
      if (write.audit) audits.push(write.audit);
    },
    async deactivate(userId, deviceId, reason, at, audit) {
      const cur = devices.get(key(userId, deviceId));
      if (!cur || cur.status !== 'active') return false;
      const { token: _t, ...rest } = cur;
      devices.set(key(userId, deviceId), { ...rest, status: 'inactive', deactivatedAt: at, deactivationReason: reason });
      if (audit) audits.push(audit);
      return true;
    },
    async listActiveForPush(userId) {
      return [...devices.values()]
        .filter((d) => d.userId === userId && d.status === 'active' && d.token)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .slice(0, MAX_ACTIVE_DEVICES)
        .map((d) => ({ deviceId: d.deviceId, userId: d.userId, platform: d.platform, lastSeenAt: d.lastSeenAt, token: d.token as string }));
    },
  };
  return { repository, devices, owners, audits, hooks };
}
