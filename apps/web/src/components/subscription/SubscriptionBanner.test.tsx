// @vitest-environment happy-dom
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import type { SubscriptionStatusView } from '@/lib/api/subscriptions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state: { data?: SubscriptionStatusView; role: string } = { role: 'apartment_manager' };
vi.mock('@/hooks/useSubscriptions', () => ({ useSubscriptionStatus: () => ({ data: state.data }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { role: state.role } }) }));
const { SubscriptionBanner } = await import('./SubscriptionBanner');

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  Object.assign(state, { data: undefined, role: 'apartment_manager' });
});

function render(data: SubscriptionStatusView | undefined, role = 'apartment_manager') {
  Object.assign(state, { data, role });
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() =>
    root?.render(
      <MemoryRouter>
        <SubscriptionBanner />
      </MemoryRouter>,
    ),
  );
  return el;
}

describe('abonelik ust bandi', () => {
  it('legacy, aktif ve uzak deneme: bant yok', () => {
    expect(render({ status: 'legacy', legacy: true, readOnly: false }).textContent).toBe('');
    act(() => root?.unmount());
    expect(render({ status: 'active', legacy: false, readOnly: false }).textContent).toBe('');
    act(() => root?.unmount());
    expect(render({ status: 'trial', legacy: false, readOnly: false, trialEndsAt: '2027-01-30', daysLeft: 40 }).textContent).toBe('');
    act(() => root?.unmount());
    expect(render(undefined).textContent).toBe('');
  });

  it('sistem kapali: bant yok; deneme suresi dolmus (otomasyon kapali): "bugun" degil gercek durum', () => {
    expect(render({ enabled: false, status: 'suspended', legacy: false, readOnly: true }).textContent).toBe('');
    act(() => root?.unmount());
    const expired = render({ enabled: true, automation: false, status: 'trial', legacy: false, readOnly: false, trialEndsAt: '2026-11-25', daysLeft: -3 });
    expect(expired.textContent).toContain('Deneme süreniz doldu.');
    expect(expired.textContent).not.toContain('bugün');
  });

  it('deneme bitiyor (notr), gecikme (uyari), askida (salt okunur) ve baglanti', () => {
    const trial = render({ status: 'trial', legacy: false, readOnly: false, trialEndsAt: '2026-12-01', daysLeft: 3 });
    const box = trial.querySelector('[role="status"]');
    expect(box?.className).toContain('bg-surface-muted');
    expect(box?.textContent).toContain('3 gün sonra');
    expect(trial.querySelector('a')?.getAttribute('href')).toBe('/admin/settings');
    act(() => root?.unmount());

    const late = render({ status: 'past_due', legacy: false, readOnly: false, suspendOn: '2026-12-26' });
    expect(late.querySelector('[role="status"]')?.className).toContain('bg-warning/15');
    expect(late.textContent).toContain('salt okunur olur');
    act(() => root?.unmount());

    const susp = render({ status: 'suspended', legacy: false, readOnly: true }, 'building_staff');
    expect(susp.querySelector('[role="status"]')?.className).toContain('bg-danger/10');
    expect(susp.textContent).toContain('salt okunur');
    // Ayarlar'i goremeyen rol: baglanti yok.
    expect(susp.querySelector('a')).toBeNull();
  });
});
