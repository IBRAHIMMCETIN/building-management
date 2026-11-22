import type { OwnerRow, TransferDebtTarget, TransferInput, TransferKind } from '@/lib/api/ownership';
import { type DraftMove, applyDraftMoves, fullShareDrafts } from '@/lib/ownership/shares';

/*
 * Mulk / hisse devri sihirbazinin saf mantigi (bilesen testlerinden bagimsiz test edilir).
 * Adimlar: tur + tarih + pay hareketleri -> onizleme (API) -> gerekce ve onay -> sonuc.
 */

export const WIZARD_STEPS = ['moves', 'preview', 'confirm'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number] | 'done';

export const STEP_LABELS: Record<(typeof WIZARD_STEPS)[number], string> = {
  moves: 'Devir',
  preview: 'Önizleme',
  confirm: 'Onay',
};

export const DEBT_TARGET_LABELS: Record<TransferDebtTarget, string> = {
  former: 'Çıkan malikin geçmiş borcu kendi (ayrılan) carisinde kalsın',
  new_owner: 'Geçmiş borç yeni malike devredilsin',
};

export const MEMBERSHIP_CHANGE_LABELS = {
  created: 'Yeni malik üyeliği açılır',
  reactivated: 'Önceki malik üyeliği yeniden etkinleşir',
  share: 'Payı güncellenir',
  ended: 'Malikliği devir tarihinden bir gün önce sona erer',
} as const;

export type WizardDraft = {
  kind: TransferKind;
  effectiveDate: string;
  moves: DraftMove[];
  debtTo: TransferDebtTarget;
  /** Dairede oturacak yeni malikler. */
  residents: string[];
};

export function initialDraft(today: string): WizardDraft {
  return { kind: 'share_partial', effectiveDate: today, moves: [{ fromUserId: '', toUserId: '', share: '' }], debtTo: 'former', residents: [] };
}

/** Tur degisince uygun baslangic hareketleri: tam satista tum paydaslar, mirasta tek muris. */
export function draftForKind(draft: WizardDraft, kind: TransferKind, owners: readonly OwnerRow[]): WizardDraft {
  if (kind === 'sale_full') return { ...draft, kind, moves: fullShareDrafts(owners, owners.map((o) => o.userId), '') };
  if (kind === 'inheritance') {
    const first = owners[0]?.userId ?? '';
    return { ...draft, kind, moves: first ? fullShareDrafts(owners, [first], '') : [{ fromUserId: '', toUserId: '', share: '' }] };
  }
  return { ...draft, kind, moves: [{ fromUserId: '', toUserId: '', share: '' }] };
}

/** Tum bos devralan alanlarini ayni kisiyle doldurur (tam satista tek alici). */
export function fillRecipient(draft: WizardDraft, toUserId: string): WizardDraft {
  return { ...draft, moves: draft.moves.map((m) => (m.toUserId ? m : { ...m, toUserId })) };
}

/**
 * Taslaktan API girdisi. Gecersizse hata metni. Devir tarihi bugunden sonra olamaz; yeni
 * malikin oturma bilgisi yalnizca yeni (giren) malikler icin gonderilir.
 */
export function buildTransferInput(
  draft: WizardDraft,
  owners: readonly OwnerRow[],
  today: string,
): { input: TransferInput; after: { userId: string; share: { numerator: number; denominator: number } }[] } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveDate)) return { error: 'Devir tarihi seçin.' };
  if (draft.effectiveDate > today) return { error: 'Devir tarihi bugünden sonra olamaz.' };
  const r = applyDraftMoves(owners, draft.moves, draft.kind);
  if ('error' in r) return r;
  const current = new Set(owners.map((o) => o.userId));
  const residents = draft.residents.filter((u) => !current.has(u) && r.after.some((o) => o.userId === u));
  return {
    input: {
      kind: draft.kind,
      effectiveDate: draft.effectiveDate,
      moves: r.moves,
      debtTo: draft.debtTo,
      ...(residents.length ? { residents } : {}),
    },
    after: r.after,
  };
}

/** Yeni (giren) malikler: oturma kutusu bunlar icin gosterilir. */
export function enteringUsers(draft: WizardDraft, owners: readonly OwnerRow[]): string[] {
  const current = new Set(owners.map((o) => o.userId));
  return [...new Set(draft.moves.map((m) => m.toUserId).filter((u) => u && !current.has(u)))];
}
