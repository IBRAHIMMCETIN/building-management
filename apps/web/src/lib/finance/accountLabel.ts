import type { FinanceAccount, LiableParty } from '@/lib/api/finance';

/**
 * Ortak cari etiketi (UX-01): ham 36 karakterlik kimlik yerine `Blok · Daire Kişi/Taraf`.
 *
 *   ana cari (malik)        "A · 1 Kat Maliki"
 *   ana cari (sakin)        "A · 1 Kiracı / Sakin"
 *   paydas alt carisi       "A · 2 Ayşe Yılmaz (paydaş)"   (ad bilinmiyorsa "Kat Maliki (paydaş)")
 *   ayrilan cari            "A · 3 Ayrılan sakin (31.10.2026)"
 *
 * Etiket hesabin `name` alanina GUVENMEZ: eski kayitlarin adi `Daire <unitId> - Kat Maliki`
 * bicimindedir (apps/api finance/service.ts). Daireye bagli olmayan hesaplarda (kasa, banka,
 * gider) ad aynen kullanilir; yine de icindeki kimlikler cozumlenir.
 */
export type AccountLabelContext = {
  /** unitId -> "A · 1" */
  unitLabel: (unitId: string) => string | undefined;
  /** userId -> "Ayşe Yılmaz" */
  personName: (userId: string) => string | undefined;
};

export const PARTY_LABELS: Record<LiableParty, string> = { owner: 'Kat Maliki', occupant: 'Kiracı / Sakin' };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE = new RegExp(UUID, 'g');
/** "Daire <uuid> - " veya "Daire <uuid> " oneki (API'nin eski hesap adlari). */
const UNIT_PREFIX_RE = new RegExp(`Daire (${UUID})(?: -)? ?`, 'g');
const FORMER_RE = /Ayrılan (malik|sakin)(?: \(([^)]+)\))?/;

export function looksLikeId(value: string): boolean {
  return new RegExp(`^${UUID}$`).test(value);
}

/** Daire etiketi; cozulemezse "Daire" (kimlik asla gosterilmez). */
function unitText(unitId: string | undefined, ctx: AccountLabelContext): string {
  if (!unitId) return '';
  return ctx.unitLabel(unitId) ?? 'Daire';
}

/** Cari etiketi. `account` yoksa (silinmis / listede olmayan hesap) yalnizca "Cari". */
export function formatLedgerAccountLabel(
  account: Pick<FinanceAccount, 'accountId' | 'name' | 'unitId' | 'liableParty' | 'coOwner'> | undefined,
  ctx: AccountLabelContext,
): string {
  if (!account) return 'Cari';
  if (!account.unitId) return sanitizeLedgerText(account.name, ctx);
  const unit = unitText(account.unitId, ctx);
  if (account.coOwner) {
    const name = ctx.personName(account.coOwner.userId);
    return `${unit} ${name ?? PARTY_LABELS.owner} (paydaş)`;
  }
  const former = FORMER_RE.exec(account.name);
  if (former) return `${unit} Ayrılan ${former[1]}${former[2] ? ` (${former[2]})` : ''}`;
  return `${unit} ${account.liableParty ? PARTY_LABELS[account.liableParty] : 'Cari'}`;
}

/**
 * Serbest metindeki (islem aciklamasi, kalem aciklamasi) daire / kisi kimliklerini cozer:
 * "Avans mahsubu: Daire <uuid> - Kat Maliki → Daire <uuid> - Kat Maliki (paydaş)"
 *   -> "Avans mahsubu: A · 1 Kat Maliki → A · 2 Kat Maliki (paydaş)".
 * Kalan tanimsiz kimlikler "…" ile kisaltilir (36 karakterlik ham deger gosterilmez).
 */
export function sanitizeLedgerText(text: string, ctx: AccountLabelContext): string {
  return text
    .replace(UNIT_PREFIX_RE, (_m, unitId: string) => `${unitText(unitId, ctx)} `)
    .replace(/Kiraci\/Sakin/g, PARTY_LABELS.occupant)
    .replace(UUID_RE, (id) => ctx.unitLabel(id) ?? ctx.personName(id) ?? '…');
}

/** Acilir listelerde bakiye ozeti: "A · 2 Ayşe (paydaş) — borç ₺2.000,00". */
export function balanceSummary(balance: number, formatMoney: (kurus: number) => string): string {
  if (balance < 0) return `avans ${formatMoney(-balance)}`;
  if (balance > 0) return `borç ${formatMoney(balance)}`;
  return 'bakiye yok';
}
