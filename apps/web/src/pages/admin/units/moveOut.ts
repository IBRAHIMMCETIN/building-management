import type { AdvanceTarget, CariClosure, ClosurePreview, CreateClosureInput, DebtTarget } from '@/lib/api/closures';
import type { LiableParty } from '@/lib/api/finance';

/*
 * Tasinma / cari kapama sihirbazinin saf mantigi (bilesenden bagimsiz, birim testli).
 * Adimlar: kim/tarih -> onizleme -> borc & avans karari -> gerekce/onay.
 */

export const WIZARD_STEPS = ['who', 'preview', 'decision', 'confirm'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export const STEP_LABELS: Record<WizardStep, string> = {
  who: 'Kim / tarih',
  preview: 'Önizleme',
  decision: 'Borç & avans',
  confirm: 'Onay',
};

export const CLOSURE_PARTY_LABELS: Record<LiableParty, string> = {
  occupant: 'Sakin (kiracı / oturan) carisi',
  owner: 'Kat maliki carisi',
};

/** Hedefin kullaniciya gorunen adi; ayni kod taraf'a gore farkli kisiyi anlatir. */
export function debtTargetLabel(party: LiableParty, t: DebtTarget): string {
  if (t === 'former') return party === 'occupant' ? 'Ayrılan sakinin carisinde kalsın' : 'Eski malikin carisinde kalsın';
  if (t === 'owner') return 'Kat maliki carisine devret';
  return 'Yeni malike devret';
}

export function advanceTargetLabel(party: LiableParty, t: AdvanceTarget): string {
  if (t === 'refund') return 'Kasadan / bankadan iade et';
  if (t === 'former') return party === 'occupant' ? 'Ayrılan sakinin carisinde avans olarak kalsın' : 'Eski malikin carisinde kalsın';
  return 'Kat maliki carisine aktar';
}

export const DEBT_TARGET_HINTS: Record<DebtTarget, string> = {
  former: 'Borç ayrı bir cariye taşınır; gecikme tazminatı orada işlemeye devam eder, tahsilat Finans > Ayrılan cariler ekranından alınır.',
  owner: 'Kat maliki borçtan sorumlu olur; kalemler vade tarihleriyle malik carisine geçer.',
  new_owner: 'Borç yeni malikin carisine geçer (satış sözleşmesinde kararlaştırıldıysa).',
};

export type Decision = {
  userIds: string[];
  debtTo: DebtTarget;
  advanceTo: AdvanceTarget;
  newOwnerUserId: string;
  refundAccountId: string;
  reason: string;
};

/** Onizlemeye gore varsayilan karar: ayrilan herkes secili, borc/avans ayrilan carisinde (karar 1). */
export function defaultDecision(p: ClosurePreview): Decision {
  return {
    userIds: p.memberships.map((m) => m.userId),
    debtTo: p.targets.debt.includes('former') ? 'former' : (p.targets.debt[0] ?? 'former'),
    advanceTo: p.targets.advance.includes('former') ? 'former' : (p.targets.advance[0] ?? 'former'),
    newOwnerUserId: p.incomingOwners.length === 1 ? (p.incomingOwners[0]?.userId ?? '') : '',
    refundAccountId: '',
    reason: '',
  };
}

export type DecisionErrors = Partial<Record<'debtTo' | 'advanceTo' | 'newOwnerUserId' | 'refundAccountId' | 'reason', string>>;

/** Karar adiminin (reason haric) hatalari. */
export function decisionErrors(p: ClosurePreview, d: Decision): DecisionErrors {
  const e: DecisionErrors = {};
  if (p.debt > 0) {
    if (!p.targets.debt.includes(d.debtTo)) e.debtTo = 'Bu taraf için geçersiz seçim.';
    else if (d.debtTo === 'new_owner' && !d.newOwnerUserId) e.newOwnerUserId = 'Yeni maliki seçin.';
  }
  if (p.advance > 0) {
    if (!p.targets.advance.includes(d.advanceTo)) e.advanceTo = 'Bu taraf için geçersiz seçim.';
    else if (d.advanceTo === 'refund' && !d.refundAccountId) e.refundAccountId = 'İadenin yapılacağı kasa/banka hesabını seçin.';
  }
  return e;
}

export function reasonError(reason: string): string | undefined {
  const r = reason.trim();
  if (r.length < 5) return 'Gerekçe en az 5 karakter olmalı.';
  if (r.length > 300) return 'En fazla 300 karakter.';
  return undefined;
}

/** Onizleme engelleyici mi? (cari bu tarihe kadar zaten kapali) */
export function blockingReason(p: ClosurePreview): string | undefined {
  if (p.closedThrough && p.moveOutDate <= p.closedThrough) return 'Bu cari seçilen tarihe kadar zaten kapatılmış; daha sonraki bir çıkış tarihi seçin.';
  return undefined;
}

/**
 * API govdesi. Ilgisiz alanlar gonderilmez: borc yoksa hedef varsayilana (former) doner ki
 * ayni istegin parmak izi gereksiz secimlerle degismesin.
 */
export function buildCreateInput(p: ClosurePreview, d: Decision, idempotencyKey: string): CreateClosureInput {
  const debtTo: DebtTarget = p.debt > 0 ? d.debtTo : 'former';
  const advanceTo: AdvanceTarget = p.advance > 0 ? d.advanceTo : 'former';
  return {
    idempotencyKey,
    party: p.party,
    moveOutDate: p.moveOutDate,
    userIds: [...d.userIds].sort(),
    debtTo,
    advanceTo,
    ...(debtTo === 'new_owner' && d.newOwnerUserId ? { newOwnerUserId: d.newOwnerUserId } : {}),
    ...(advanceTo === 'refund' && d.refundAccountId ? { refundAccountId: d.refundAccountId } : {}),
    reason: d.reason.trim(),
  };
}

/** "1.250,00 ₺ borç → Kat maliki carisine devret" gibi tek satirlik sonuc metni (TRY bicimi disaridan). */
export function outcomeText(c: Pick<CariClosure, 'party' | 'debt' | 'advance' | 'debtTo' | 'advanceTo'>, fmt: (k: number) => string): string {
  if (c.debt > 0) return `${fmt(c.debt)} borç · ${debtTargetLabel(c.party, c.debtTo)}`;
  if (c.advance > 0) return `${fmt(c.advance)} avans · ${advanceTargetLabel(c.party, c.advanceTo)}`;
  return 'Devredilecek bakiye yoktu';
}

/** Geri al dugmesi istemci tarafinda ne zaman gosterilir (son karar API'de). */
export function canOfferReverse(c: CariClosure, all: readonly CariClosure[]): boolean {
  if (c.status !== 'completed') return false;
  if (c.advance > 0 && c.advanceTo === 'refund') return false;
  // Mulk/hisse devriyle yapilan kapama devirle birlikte geri alinir (Mulkiyet penceresi).
  if (c.ownershipTransferId) return false;
  // Ayni cari icin daha sonraki tamamlanmis kapama varsa once o geri alinmali.
  return !all.some((o) => o !== c && o.status === 'completed' && o.sourceAccountId === c.sourceAccountId && o.moveOutDate > c.moveOutDate);
}

export const MEMBERSHIP_CHANGE_LABELS = {
  ended: 'Üyeliği çıkış tarihiyle sona erer; daire listesinden ve portaldan hemen düşer',
  not_resident: 'Malik olarak kalır, “oturmuyor” olarak işaretlenir',
} as const;
