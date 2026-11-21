/**
 * Denetim gunlugu hash zincirinin TARAYICIDA dogrulanmasi. API ile birebir ayni kurallar
 * (`apps/api/src/modules/audit/log.ts`):
 *   hash = sha256_hex(prevHash + "\n" + canonicalJson(kayit - {hash, GSI1PK, GSI1SK}))
 * Bu yalnizca ekranda gorunen sayfanin tutarliligini gosterir; zincirin tamami her gece
 * sunucuda dogrulanir (`GET /api/audit/integrity`).
 */

export const GENESIS_HASH = '0'.repeat(64);

/** Anahtarlari sirali, `undefined` alanlari atilmis JSON (API `canonicalJson` ile ayni). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export type ChainedEntry = { seq: number; prevHash: string; hash: string; [key: string]: unknown };

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeHash(entry: ChainedEntry): Promise<string> {
  const { hash: _h, GSI1PK: _p, GSI1SK: _s, ...rest } = entry;
  return sha256Hex(`${entry.prevHash}\n${canonicalJson(rest)}`);
}

export type EntryCheck = {
  /** Icerik hash'i kayittaki `hash` ile ayni. */
  hashOk: boolean;
  /** Bir onceki kayit (seq - 1) bu sayfadaysa: onun hash'i = bu kaydin prevHash'i. Yoksa undefined. */
  linkOk?: boolean;
};

export type PageCheck = {
  bySeq: Map<number, EntryCheck>;
  /** Sayfadaki tum kontroller gecti. */
  ok: boolean;
  checked: number;
  failures: number;
};

/** Sayfadaki kayitlari (herhangi bir sirada) dogrular. */
export async function verifyPage(entries: readonly ChainedEntry[]): Promise<PageCheck> {
  const bySeqEntry = new Map(entries.map((e) => [e.seq, e]));
  const bySeq = new Map<number, EntryCheck>();
  let failures = 0;
  for (const e of entries) {
    const hashOk = (await computeHash(e)) === e.hash;
    const prev = e.seq === 1 ? undefined : bySeqEntry.get(e.seq - 1);
    const linkOk = e.seq === 1 ? e.prevHash === GENESIS_HASH : prev ? prev.hash === e.prevHash : undefined;
    if (!hashOk || linkOk === false) failures++;
    bySeq.set(e.seq, { hashOk, ...(linkOk === undefined ? {} : { linkOk }) });
  }
  return { bySeq, ok: failures === 0, checked: entries.length, failures };
}
