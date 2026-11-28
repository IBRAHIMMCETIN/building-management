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

describe('denetim eylemi etiketleri (web sozlugu)', () => {
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
