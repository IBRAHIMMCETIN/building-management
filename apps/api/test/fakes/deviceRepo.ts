import type { AuditDraft } from '../../src/modules/audit/log.js';
import {
  type DeviceRepository,
  DeviceRateLimitError,
  DeviceWriteConflict,
  MAX_ACTIVE_DEVICES,
  MAX_REGISTRATIONS_PER_DAY,
  type PushDevice,
} from '../../src/modules/notifications/devices.js';

type Stored = PushDevice & { token?: string; ttl?: number };

/**
 * Bellek ici cihaz deposu: DynamoDB kosullarini taklit eder (sahiplik kaydi beklenen degerde degilse,
 * tazelenen cihaz artik aktif degilse ya da pasife alinacak cihaz artik aktif degilse tum yazim iptal:
 * `DeviceWriteConflict`). Worker okumasi sahiplik kaydi aliciyi gostermeyen cihazi atlar.
 */
export function createFakeDeviceRepo() {
  const devices = new Map<string, Stored>();
  const owners = new Map<string, string>();
  const ownerTtl = new Map<string, number>();
  const rate = new Map<string, number>();
  const audits: AuditDraft[] = [];
  const key = (userId: string, deviceId: string) => `${userId}|${deviceId}`;
  const strip = (d: Stored): PushDevice => {
    const { token: _t, ttl: _ttl, ...rest } = d;
    return structuredClone(rest);
  };
  /** Test kancasi: `save` cagrisindan hemen once (es zamanli yazim taklidi). */
  const hooks: { beforeSave?: () => void } = {};
  const off = (userId: string, id: string, reason: PushDevice['deactivationReason'], at: string) => {
    const cur = devices.get(key(userId, id));
    if (!cur) return;
    const { token: _t, ...rest } = cur;
    devices.set(key(userId, id), { ...rest, status: 'inactive', deactivatedAt: at, ...(reason ? { deactivationReason: reason } : {}), ttl: 1 });
    if (owners.get(id) === userId) ownerTtl.set(id, 1);
  };

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
      if ((owners.get(d.deviceId) ?? null) !== write.owner.expected) throw new DeviceWriteConflict();
      if (write.refresh && devices.get(key(d.userId, d.deviceId))?.status !== 'active') throw new DeviceWriteConflict();
      for (const id of write.evict) if (devices.get(key(d.userId, id))?.status !== 'active') throw new DeviceWriteConflict();
      if (write.moveFrom && !devices.has(key(write.moveFrom, d.deviceId))) throw new DeviceWriteConflict();
      devices.set(key(d.userId, d.deviceId), structuredClone(d));
      owners.set(d.deviceId, d.userId);
      ownerTtl.delete(d.deviceId);
      if (write.moveFrom) {
        const prev = devices.get(key(write.moveFrom, d.deviceId));
        if (prev) {
          const { token: _t, ...rest } = prev;
          devices.set(key(write.moveFrom, d.deviceId), { ...rest, status: 'inactive', deactivatedAt: d.lastSeenAt, deactivationReason: 'moved', ttl: 1 });
        }
      }
      for (const id of write.evict) off(d.userId, id, 'limit', d.lastSeenAt);
      if (write.audit) audits.push(write.audit);
    },
    async deactivate(userId, deviceId, reason, at, options = {}) {
      const cur = devices.get(key(userId, deviceId));
      if (!cur || cur.status !== 'active') return false;
      if (options.seenBefore && !(cur.lastSeenAt < options.seenBefore)) return false;
      off(userId, deviceId, reason, at);
      if (options.audit) audits.push(options.audit);
      return true;
    },
    async listActiveForPush(userId) {
      return [...devices.values()]
        .filter((d) => d.userId === userId && d.status === 'active' && d.token)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .slice(0, MAX_ACTIVE_DEVICES)
        .filter((d) => owners.get(d.deviceId) === userId)
        .map((d) => ({ deviceId: d.deviceId, userId: d.userId, platform: d.platform, lastSeenAt: d.lastSeenAt, token: d.token as string }));
    },
    async countRegistration(userId, day) {
      const k = `${userId}|${day}`;
      const n = rate.get(k) ?? 0;
      if (n >= MAX_REGISTRATIONS_PER_DAY) throw new DeviceRateLimitError(3600);
      rate.set(k, n + 1);
      return n + 1;
    },
  };

  /** Teste dogrudan cihaz ekler (sahiplik kaydi dahil). */
  const seed = (d: Stored) => {
    devices.set(key(d.userId, d.deviceId), d);
    owners.set(d.deviceId, d.userId);
  };
  return { repository, devices, owners, ownerTtl, rate, audits, hooks, seed };
}
