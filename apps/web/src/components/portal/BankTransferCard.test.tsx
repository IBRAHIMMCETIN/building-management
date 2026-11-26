// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTransferCard } from './BankTransferCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let state: { isPending: boolean; isError: boolean; data?: unknown } = { isPending: true, isError: false };
vi.mock('@/hooks/useBank', () => ({ useMyPaymentReference: () => state }));

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.restoreAllMocks();
});

function render() {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<BankTransferCard />));
}

const DATA = {
  unitId: 'u12',
  unitLabel: 'A Blok · 12',
  bank: { iban: 'TR330006100519786457841326', accountHolderName: 'Örnek Site Yönetimi', bankName: 'Ziraat' },
  references: [{ liableParty: 'occupant', label: 'Sakin (kiracı / oturan)', code: 'K7M2QA' }],
};

describe('Havale / EFT karti', () => {
  it('IBAN (gruplu), hesap sahibi ve referans kodu gosterilir; kopyala panoya yazar', async () => {
    state = { isPending: false, isError: false, data: DATA };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render();
    expect(container.textContent).toContain('Havale / EFT ile Öde');
    expect(container.textContent).toContain('TR33 0006 1005 1978 6457 8413 26');
    expect(container.textContent).toContain('Örnek Site Yönetimi');
    expect(container.textContent).toContain('K7M2QA');

    const copyCode = container.querySelector('button[aria-label="Ödeme referans kodu kopyala"]') as HTMLButtonElement;
    await act(async () => copyCode.click());
    expect(writeText).toHaveBeenCalledWith('K7M2QA');
    expect(copyCode.textContent).toContain('Kopyalandı');

    const copyIban = container.querySelector('button[aria-label="IBAN kopyala"]') as HTMLButtonElement;
    await act(async () => copyIban.click());
    // Panoya bosluksuz IBAN yazilir (bankacilik uygulamalari bosluklu yapistirmayi her zaman kabul etmez).
    expect(writeText).toHaveBeenLastCalledWith('TR330006100519786457841326');
  });

  it('iki alt cari varsa her kod etiketli; yonetim IBAN girmemisse kart gosterilmez', () => {
    state = {
      isPending: false,
      isError: false,
      data: { ...DATA, references: [...DATA.references, { liableParty: 'owner', label: 'Kat maliki', code: 'B3C4DE' }] },
    };
    render();
    expect(container.textContent).toContain('Ödeme referans kodu (Kat maliki)');
    expect(container.textContent).toContain('B3C4DE');
    container.remove();

    state = { isPending: false, isError: false, data: { ...DATA, bank: null } };
    render();
    expect(container.textContent).toBe('');
  });
});
