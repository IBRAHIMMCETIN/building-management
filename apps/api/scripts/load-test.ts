/**
 * Adim 2-4: yuk testi senaryosu (300-500 daireli sentetik site, `seed:scale-test` sonrasi).
 *
 * Calisan API'ye (yerel `npm run dev:api` AUTH_MODE=mock veya dev yigini) es zamanli istek atar,
 * uc basina p50 / p95 / p99 ve hata oranini olcer ve p95 HEDEFLERIYLE karsilastirir. Hedef asimi
 * veya %1'den fazla hata -> cikis kodu 2. Varsayilan senaryo SALT OKUNURDUR (defter yazmaz);
 * `--writes` yalnizca onizleme (yazmayan POST) uclarini ekler.
 *
 *   # yerel (mock kimlik): API AUTH_MODE=mock ile calisirken
 *   npm run load:test -w @bm/api -- --base http://localhost:3000 --site scale-diyarbakir-400 --duration 60 --concurrency 20
 *   # dev yigini (gercek token): yonetici ve sakin icin Cognito ID token'lari
 *   $env:LOAD_MANAGER_TOKEN = "..." ; $env:LOAD_RESIDENT_TOKENS = "tok1,tok2"
 *   npm run load:test -w @bm/api -- --base https://<api-id>.execute-api.eu-north-1.amazonaws.com --site <apartmentId>
 *
 * Senaryolar ve p95 hedefleri (ms) asagidaki SCENARIOS tablosunda; raporu `--out rapor.json` ile
 * dosyaya yazar. Hedefler README "Yuk testi" bolumunde ve `claude/adim2-olcek-ve-dayaniklilik.md`'de.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export type Scenario = {
  name: string;
  /** Akis grubu (rapor): portal | raporlar | tahakkuk | sayac | banka */
  group: 'portal' | 'raporlar' | 'tahakkuk' | 'sayac' | 'banka';
  role: 'manager' | 'resident';
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Toplam isteklerdeki agirlik (gercek kullanim karisimi). */
  weight: number;
  /** p95 hedefi (ms). */
  p95: number;
  /** Yazma onizlemesi (yalnizca --writes ile). */
  write?: boolean;
};

/** Gercek kullanim karisimi: sakin portali agir basar, yonetici raporlari ve banka ekrani izler. */
export function scenarios(month: string): Scenario[] {
  return [
    { name: 'portal ozet (borcum)', group: 'portal', role: 'resident', method: 'GET', path: '/api/portal/my-summary', weight: 30, p95: 800 },
    { name: 'portal borclar', group: 'portal', role: 'resident', method: 'GET', path: '/api/portal/my-dues', weight: 15, p95: 800 },
    { name: 'portal makbuzlar', group: 'portal', role: 'resident', method: 'GET', path: '/api/portal/my-receipts', weight: 10, p95: 600 },
    { name: 'portal ekstre', group: 'portal', role: 'resident', method: 'GET', path: '/api/portal/my-statement', weight: 5, p95: 1000 },
    { name: 'genel bakis', group: 'raporlar', role: 'manager', method: 'GET', path: '/api/finance/dashboard', weight: 6, p95: 2500 },
    { name: 'finans ozeti', group: 'raporlar', role: 'manager', method: 'GET', path: '/api/finance/summary', weight: 5, p95: 2500 },
    { name: 'aidat durumu', group: 'raporlar', role: 'manager', method: 'GET', path: '/api/finance/dues-status', weight: 5, p95: 3000 },
    { name: 'hareketler (sayfa)', group: 'raporlar', role: 'manager', method: 'GET', path: '/api/finance/transactions?limit=50', weight: 5, p95: 1200 },
    { name: 'tedarikciler', group: 'raporlar', role: 'manager', method: 'GET', path: '/api/finance/payables', weight: 3, p95: 1500 },
    { name: 'sayac donemleri', group: 'sayac', role: 'manager', method: 'GET', path: '/api/metering/periods', weight: 3, p95: 1500 },
    { name: 'sayac sicili', group: 'sayac', role: 'manager', method: 'GET', path: '/api/metering/meters', weight: 2, p95: 1500 },
    { name: 'banka kuyrugu', group: 'banka', role: 'manager', method: 'GET', path: '/api/bank/queue?bankAccountId=bank&limit=50', weight: 4, p95: 3000 },
    { name: 'banka mutabakati', group: 'banka', role: 'manager', method: 'GET', path: '/api/bank/reconciliation?bankAccountId=bank', weight: 2, p95: 2500 },
    { name: 'banka hedefleri', group: 'banka', role: 'manager', method: 'GET', path: '/api/bank/targets', weight: 2, p95: 3000 },
    {
      name: 'toplu tahakkuk onizleme',
      group: 'tahakkuk',
      role: 'manager',
      method: 'POST',
      path: '/api/finance/dues/preview',
      body: { liableParty: 'occupant', totalAmount: 30_000_000, distributionKey: 'area', date: `${month}-01`, dueDate: `${month}-10`, description: 'Yuk testi onizleme' },
      weight: 3,
      p95: 4000,
      write: true,
    },
  ];
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] as number;
}

export type ScenarioResult = { name: string; group: string; count: number; errors: number; p50: number; p95: number; p99: number; max: number; target: number; ok: boolean };

export function summarize(list: readonly Scenario[], samples: Map<string, { ms: number[]; errors: number }>, maxErrorRate = 0.01): { results: ScenarioResult[]; ok: boolean } {
  const results = list
    .filter((s) => samples.has(s.name))
    .map((s) => {
      const { ms, errors } = samples.get(s.name) as { ms: number[]; errors: number };
      const sorted = [...ms].sort((a, b) => a - b);
      const count = sorted.length + errors;
      const p95 = percentile(sorted, 95);
      return {
        name: s.name,
        group: s.group,
        count,
        errors,
        p50: percentile(sorted, 50),
        p95,
        p99: percentile(sorted, 99),
        max: sorted.at(-1) ?? 0,
        target: s.p95,
        ok: p95 <= s.p95 && (count === 0 || errors / count <= maxErrorRate),
      };
    });
  return { results, ok: results.every((r) => r.ok) };
}

/** Agirliga gore senaryo secimi (deterministik tohumla). */
export function picker(list: readonly Scenario[], random: () => number) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  return () => {
    let r = random() * total;
    for (const s of list) {
      r -= s.weight;
      if (r <= 0) return s;
    }
    return list[list.length - 1] as Scenario;
  };
}

/** Yerel mock kimlik (`AUTH_MODE=mock`): `mock.<base64url(JSON)>`. */
export const mockToken = (claims: Record<string, unknown>) => `mock.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://localhost:3000' },
      site: { type: 'string', default: 'scale-diyarbakir-400' },
      duration: { type: 'string', default: '60' },
      concurrency: { type: 'string', default: '20' },
      units: { type: 'string', default: '400' },
      blocks: { type: 'string', default: '5' },
      writes: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const durationMs = Number(values.duration) * 1000;
  const concurrency = Number(values.concurrency);
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const list = scenarios(month).filter((s) => values.writes || !s.write);

  const managerToken = process.env.LOAD_MANAGER_TOKEN ?? mockToken({ sub: 'scale-manager', role: 'apartment_manager', apartmentId: values.site });
  const residentTokens = process.env.LOAD_RESIDENT_TOKENS?.split(',').filter(Boolean) ?? (() => {
    // Tohumlama betigiyle ayni kimlikler: her daire icin kat maliki.
    const units = Number(values.units);
    const blocks = Number(values.blocks);
    const per = Math.ceil(units / blocks);
    const out: string[] = [];
    for (let i = 0; i < units; i++) out.push(mockToken({ sub: `scale-owner-${'abcdefgh'[Math.floor(i / per)]}${(i % per) + 1}`, role: 'resident', apartmentId: values.site }));
    return out;
  })();

  let seed = 12345;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const next = picker(list, random);
  const samples = new Map<string, { ms: number[]; errors: number }>();
  const errorsByStatus = new Map<string, number>();
  const deadline = Date.now() + durationMs;

  async function worker() {
    while (Date.now() < deadline) {
      const s = next();
      const token = s.role === 'manager' ? managerToken : (residentTokens[Math.floor(random() * residentTokens.length)] as string);
      const bucket = samples.get(s.name) ?? { ms: [], errors: 0 };
      samples.set(s.name, bucket);
      const started = performance.now();
      try {
        const res = await fetch(`${values.base}${s.path}`, {
          method: s.method,
          headers: { authorization: `Bearer ${token}`, ...(s.body ? { 'content-type': 'application/json' } : {}) },
          ...(s.body ? { body: JSON.stringify(s.body) } : {}),
        });
        await res.arrayBuffer();
        const ms = performance.now() - started;
        if (res.ok) bucket.ms.push(ms);
        else {
          bucket.errors++;
          errorsByStatus.set(`${s.name} ${res.status}`, (errorsByStatus.get(`${s.name} ${res.status}`) ?? 0) + 1);
        }
      } catch {
        bucket.errors++;
        errorsByStatus.set(`${s.name} network`, (errorsByStatus.get(`${s.name} network`) ?? 0) + 1);
      }
    }
  }

  console.info(`Yuk testi: ${values.base}, site ${values.site}, ${concurrency} es zamanli, ${values.duration} sn, ${list.length} senaryo`);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const { results, ok } = summarize(list, samples);
  console.table(results.map((r) => ({ senaryo: r.name, grup: r.group, istek: r.count, hata: r.errors, p50: Math.round(r.p50), p95: Math.round(r.p95), p99: Math.round(r.p99), hedef_p95: r.target, durum: r.ok ? 'OK' : 'ASIM' })));
  if (errorsByStatus.size) console.info('Hatalar:', Object.fromEntries(errorsByStatus));
  const total = results.reduce((s, r) => s + r.count, 0);
  console.info(`Toplam ${total} istek, ${(total / (durationMs / 1000)).toFixed(1)} istek/sn. Sonuc: ${ok ? 'TUM HEDEFLER KARSILANDI' : 'HEDEF ASIMI'}`);
  if (values.out) writeFileSync(values.out, JSON.stringify({ base: values.base, site: values.site, concurrency, durationSeconds: Number(values.duration), results, ok }, null, 2));
  if (!ok) process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
