import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { type AuditEntry, GENESIS_HASH, buildEntry, computeHash } from '../src/modules/audit/log.js';
import type { AuditReader, Checkpoint } from '../src/modules/audit/repository.js';

/**
 * `POST /api/audit/verify` - yoneticinin gece isini beklemeden zinciri dogrulatmasi.
 * Artimli dogrulama (`verifyAuditScope`) gercek hash'lerle calisir; depolar bellek ici.
 */

const APT = 'apt-1';
const SCOPE = `APT#${APT}`;
const NOW = new Date('2026-11-26T09:00:00.000Z');

function chain(n: number): AuditEntry[] {
  const out: AuditEntry[] = [];
  let tail = { seq: 0, hash: GENESIS_HASH };
  for (let i = 0; i < n; i++) {
    const e = buildEntry({ apartmentId: APT, action: `test.a${i}`, target: { type: 't', id: String(i) } }, tail, new Date(NOW.getTime() - (n - i) * 3_600_000));
    out.push(e);
    tail = { seq: e.seq, hash: e.hash };
  }
  return out;
}

function world(entries = chain(3), initial?: Checkpoint) {
  const stored = new Map<string, Checkpoint>(initial ? [[SCOPE, initial]] : []);
  let now = NOW;
  const reader: AuditReader = {
    list: async (scope, q) => ({ items: entries.filter(() => scope === SCOPE).slice().reverse().slice(0, q.limit) }),
    listAfter: async (scope, after, limit) => {
      const rows = entries.filter((e) => scope === SCOPE && e.seq > after);
      return limit ? rows.slice(0, limit) : rows;
    },
    get: async (scope, seq) => (scope === SCOPE ? entries.find((e) => e.seq === seq) : undefined),
  };
  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    auditReader: reader,
    auditCheckpoints: { get: async (s) => stored.get(s), put: async (s, cp) => void stored.set(s, cp) },
    // Denetim uclarinin saati (verifiedAt, 60 sn bekleme, bayatlik) tum testlerde NOW'a sabit.
    auditNow: () => now,
  });
  const token = (sub: string, role: string, apartmentId?: string) => `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;
  const call = async (path: string, auth: string) => {
    const res = await app.request(path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' } });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
  return { call, token, stored, entries, setNow: (d: Date) => void (now = d) };
}

describe('POST /api/audit/verify', () => {
  it('yonetici zinciri dogrular; kontrol noktasi ilerler ve durum "verified" doner', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const w = world();
    const res = await w.call('/api/audit/verify', w.token('mgr-1', 'apartment_manager', APT));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ checked: 3, findings: 0, integrity: { status: 'verified', latestSeq: 3, verifiedSeq: 3 } });
    expect(w.stored.get(SCOPE)).toMatchObject({ seq: 3, hash: w.entries[2]!.hash });
  });

  it('yonetim firmasi da dogrulatabilir; gozlemci, sakin ve gorevli 403', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const w = world();
    expect((await w.call('/api/audit/verify', w.token('org-1', 'management_company', APT))).status).toBe(200);
    expect((await w.call('/api/audit/verify', w.token('obs-1', 'observer', APT))).status).toBe(403);
    expect((await w.call('/api/audit/verify', w.token('r-1', 'resident', APT))).status).toBe(403);
    expect((await w.call('/api/audit/verify', w.token('s-1', 'building_staff', APT))).status).toBe(403);
  });

  it('bayat kontrol noktasi elle dogrulamayla tazelenir ("stale" -> "verified")', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const entries = chain(3);
    const old = { seq: 2, hash: entries[1]!.hash, verifiedAt: new Date(NOW.getTime() - 30 * 3_600_000).toISOString() };
    const w = world(entries, old);
    const res = await w.call('/api/audit/verify', w.token('mgr-1', 'apartment_manager', APT));
    expect(res.body).toMatchObject({ checked: 1, findings: 0, integrity: { status: 'verified', verifiedAt: NOW.toISOString() } });
  });

  it('bulguda kontrol noktasi ilerlemez; yanit bulgu sayisini doner, ayrinti loga yazilir', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const entries = chain(3);
    entries[2]!.reason = 'sonradan degistirildi';
    entries[2]!.hash = computeHash('0'.repeat(64), entries[2]!); // bag kopuk
    const w = world(entries);
    const res = await w.call('/api/audit/verify', w.token('mgr-1', 'apartment_manager', APT));
    expect(res.status).toBe(200);
    expect(res.body.findings).toBeGreaterThan(0);
    expect(w.stored.has(SCOPE)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('audit_chain_manual_verify'));
  });

  it('kontrol noktasi tazeyse (60 sn) zincir yeniden okunmaz', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const entries = chain(2);
    const w = world(entries, { seq: 2, hash: entries[1]!.hash, verifiedAt: new Date(NOW.getTime() - 10_000).toISOString() });
    const res = await w.call('/api/audit/verify', w.token('mgr-1', 'apartment_manager', APT));
    expect(res.body).toMatchObject({ checked: 0, skipped: 'recently_verified', integrity: { status: 'verified' } });
  });
});
