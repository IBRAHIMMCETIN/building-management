// @vitest-environment happy-dom
import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_ORDER, LEGAL_DRAFT_NOTICE } from '@bm/shared/legal/documents';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { KvkkPage, LegalPage, PrivacyPage, TermsPage } from './LegalPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(node));
}

describe('hukuki metin sayfalari (taslak)', () => {
  it.each(LEGAL_DOCUMENT_ORDER)('%s: taslak uyarisi, baslik, surum, bolumler ve diger metinlere baglanti', async (key) => {
    const doc = LEGAL_DOCUMENTS[key];
    await render(<LegalPage docKey={key} />);
    const note = container.querySelector('[role="note"]')!;
    expect(note.textContent).toContain('Taslak');
    expect(note.textContent).toContain(LEGAL_DRAFT_NOTICE);
    expect(container.querySelector('h1')!.textContent).toBe(doc.title);
    expect(container.textContent).toContain(doc.version);
    expect([...container.querySelectorAll('article h2')].map((h) => h.textContent)).toEqual(doc.sections.map((s) => s.heading));
    const others = [...container.querySelectorAll('nav[aria-label="Diğer hukuki metinler"] a')].map((a) => a.getAttribute('href'));
    expect(others).toEqual(LEGAL_DOCUMENT_ORDER.filter((k) => k !== key).map((k) => LEGAL_DOCUMENTS[k].path));
    expect(document.title).toContain(doc.title);
  });

  it('KVKK metni m.11 haklarini, saklama surelerini ve veri sorumlusu / isleyen ayrimini icerir', async () => {
    await render(<KvkkPage />);
    const text = container.textContent ?? '';
    expect(text).toContain('KVKK m.11');
    expect(text).toContain('veri sorumlusu');
    expect(text).toContain('veri işleyen');
    expect(text).toContain('2 yıl');
    expect(text).toContain('eu-north-1');
  });

  it('adresler: /kvkk, /gizlilik, /kullanim-kosullari; sayfa bilesenleri metin icermez (tek kaynak)', async () => {
    expect(LEGAL_DOCUMENT_ORDER.map((k) => LEGAL_DOCUMENTS[k].path)).toEqual(['/kvkk', '/gizlilik', '/kullanim-kosullari']);
    for (const doc of Object.values(LEGAL_DOCUMENTS)) {
      expect(doc.status).toBe('draft');
      expect(doc.version).toMatch(/^[a-z0-9][a-z0-9.-]{0,39}$/);
      expect(doc.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    await render(<PrivacyPage />);
    expect(container.querySelector('h1')!.textContent).toBe('Gizlilik Politikası');
    act(() => root.unmount());
    container.remove();
    await render(<TermsPage />);
    expect(container.querySelector('h1')!.textContent).toBe('Kullanım Koşulları');
  });
});
