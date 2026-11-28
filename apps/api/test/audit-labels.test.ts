import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Denetim ekrani (apps/web/src/lib/audit/labels.ts) her eylem kodunu Turkce etiketle gosterir;
 * sozlukte olmayan kod alan adiyla yedek etikete ("Arıza talebi: foo bar") veya ham koda duser.
 * Bu test API kaynagindaki denetim eylemi sabitlerini (kategori on ekleriyle baslayan tirnakli
 * metinler, yorumlar haric) toplar ve her birinin sozlukte birebir etiketi oldugunu dogrular.
 * Yeni eylem eklenince etiket de eklenmeli. Calisma aninda uretilen kodlar (`ticket.${action}`,
 * `ledger.<turler>`, `payment.payout.<durum>` ...) web tarafinda ayrica karsilanir.
 */
const root = fileURLToPath(new URL('../../..', import.meta.url));
const labels = readFileSync(join(root, 'apps/web/src/lib/audit/labels.ts'), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

function categoryPrefixes(): string[] {
  const block = /AUDIT_CATEGORIES = \[([\s\S]*?)\] as const/.exec(labels)?.[1] ?? '';
  return [...block.matchAll(/prefix: '([a-z_.]+)'/g)].map((m) => m[1] as string);
}

function exactLabels(): Set<string> {
  const block = /const EXACT: Record<string, string> = \{([\s\S]*?)\n\};/.exec(labels)?.[1] ?? '';
  return new Set([...block.matchAll(/^\s*'([a-z_.]+)':/gm)].map((m) => m[1] as string));
}

function apiActions(prefixes: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  const literal = /'([a-z_]+\.[a-z_.]*[a-z_])'/g;
  for (const file of sourceFiles(join(root, 'apps/api/src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue;
      for (const m of code.matchAll(literal)) {
        const action = m[1] as string;
        if (prefixes.some((p) => action.startsWith(p)) && !found.has(action)) found.set(action, file.slice(root.length));
      }
    }
  }
  return found;
}

/**
 * Denetim eylemi oldugu kesin olan tum sabitler (on ekten bagimsiz): `action: '<kod>'` ve denetim
 * yardimcilarina (`vehicleAudit(.., 'gate.vehicle.create')`, `audit(ctx, x, 'assembly.create')`,
 * `membershipAudit(m, 'membership.update')` ...) verilen ilk sabit.
 */
function auditActionLiterals(): Map<string, string> {
  const found = new Map<string, string>();
  const patterns = [/\baction:\s*'([a-z_]+(?:\.[a-z_]+)+)'/g, /\b\w*[aA]udit\w*\(\s*(?:[^()';]*?,\s*)?'([a-z_]+(?:\.[a-z_]+)+)'/g];
  for (const file of sourceFiles(join(root, 'apps/api/src'))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue;
      for (const re of patterns) for (const m of code.matchAll(re)) if (!found.has(m[1] as string)) found.set(m[1] as string, file.slice(root.length));
    }
  }
  return found;
}

describe('denetim eylemi etiketleri (web sozlugu)', () => {
  it('her denetim eylemi sabiti bilinen bir kategori on ekiyle baslar ve etiketlidir (yeni on ek de yakalanir)', () => {
    const prefixes = categoryPrefixes();
    const exact = exactLabels();
    const actions = auditActionLiterals();
    expect(actions.has('gate.vehicle.create')).toBe(true);
    expect(actions.has('membership.update')).toBe(true);
    expect(actions.has('assembly.create')).toBe(true);
    expect(actions.has('apartment_role.end')).toBe(true);
    expect(actions.size).toBeGreaterThan(100);
    const unknownPrefix = [...actions].filter(([a]) => !prefixes.some((p) => a.startsWith(p))).map(([a, file]) => `${a} (${file})`);
    expect(unknownPrefix).toEqual([]);
    const unlabeled = [...actions].filter(([a]) => !exact.has(a)).map(([a, file]) => `${a} (${file})`);
    expect(unlabeled).toEqual([]);
  });

  it('API kaynagindaki her denetim eylemi sabitinin Turkce etiketi var', () => {
    const prefixes = categoryPrefixes();
    expect(prefixes).toContain('gate.');
    const exact = exactLabels();
    const actions = apiActions(prefixes);
    // Ornek: kapi eylemlerinin tamami bulunur (tarayici kendini denetler).
    for (const a of ['gate.vehicle.create', 'gate.vehicle.update', 'gate.pass.revoke', 'gate.lockout', 'gate.departure_release']) expect(actions.has(a)).toBe(true);
    const missing = [...actions].filter(([a]) => !exact.has(a)).map(([a, file]) => `${a} (${file})`);
    expect(missing).toEqual([]);
  });
});
