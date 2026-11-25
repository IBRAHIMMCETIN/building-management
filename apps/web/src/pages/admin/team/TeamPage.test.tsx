// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApartmentRoleView } from '@/lib/api/apartmentRoles';
import { TeamPage } from './TeamPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = () => ({ isPending: false, isError: false, error: null, data: undefined, variables: undefined, mutateAsync: vi.fn().mockResolvedValue({ result: 'sent' }), reset: () => {} });
let perms = { apartmentId: 'apt-1', userId: 'mgr-1', role: 'apartment_manager', canRead: true, canWrite: true };
let user = { sub: 'mgr-1', role: 'apartment_manager' };
let items: ApartmentRoleView[] = [];
const end = m();
const resend = m();

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user }) }));
vi.mock('@/hooks/useTeam', () => ({
  useTeamPermissions: () => perms,
  useTeam: () => ({ isPending: false, isError: false, isSuccess: true, data: items }),
  useInviteMember: () => m(),
  useEndRole: () => end,
  useResendInvite: () => resend,
}));

const rec = (userId: string, role: string, over: Partial<ApartmentRoleView> = {}): ApartmentRoleView => ({
  userId,
  role,
  status: 'active',
  startDate: '2026-01-01',
  version: 1,
  ...over,
});

let container: HTMLDivElement;
afterEach(() => container?.remove());
function render() {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<TeamPage />));
}
const buttons = (text: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes(text));

describe('Ekip sayfasi', () => {
  it('yonetici: aktif ekip listelenir, kendi kaydinda ve firma kaydinda aksiyon yok; son yonetici uyarisi', async () => {
    perms = { ...perms, role: 'apartment_manager', canWrite: true };
    user = { sub: 'mgr-1', role: 'apartment_manager' };
    items = [
      rec('mgr-1', 'apartment_manager', { fullName: 'Ben Yönetici', email: 'ben@x.com' }),
      rec('s1', 'building_staff', { fullName: 'Ali Kapıcı', email: 'ali@x.com' }),
      rec('c1', 'management_company', { fullName: 'Firma AŞ' }),
      rec('o1', 'observer', { fullName: 'Eski Denetçi', status: 'inactive', endDate: '2026-06-01' }),
    ];
    render();
    const text = container.textContent ?? '';
    expect(text).toContain('Ali Kapıcı');
    expect(text).toContain('Bina Görevlisi');
    expect(text).not.toContain('Eski Denetçi'); // varsayilan filtre: aktif
    expect(text).toContain('Siz');
    // Yalnizca Ali icin aksiyon: kendi kaydi ve yonetim firmasi kaydi yonetilemez.
    expect(buttons('Rolü bitir')).toHaveLength(1);
    expect(buttons('Daveti yeniden gönder')).toHaveLength(1);
    await act(async () => buttons('Daveti yeniden gönder')[0]!.click());
    expect(resend.mutateAsync).toHaveBeenCalledWith({ userId: 's1', role: 'building_staff' });
    expect(container.textContent).toContain('Davet e-postası yeniden gönderildi.');
  });

  it('denetci: salt okunur (davet ve aksiyon dugmesi yok)', () => {
    perms = { ...perms, role: 'observer', canWrite: false };
    user = { sub: 'o1', role: 'observer' };
    items = [rec('s1', 'building_staff', { fullName: 'Ali Kapıcı', email: 'a***@x.com' })];
    render();
    expect(container.textContent).toContain('a***@x.com');
    expect(buttons('Ekibe davet et')).toHaveLength(0);
    expect(buttons('Rolü bitir')).toHaveLength(0);
  });

  it('rol bitirme: gerekce zorunlu, surum ve tarihle gonderilir', async () => {
    perms = { ...perms, role: 'apartment_manager', canWrite: true };
    user = { sub: 'mgr-1', role: 'apartment_manager' };
    items = [rec('mgr-1', 'apartment_manager'), rec('s1', 'building_staff', { fullName: 'Ali Kapıcı', version: 3 })];
    render();
    await act(async () => buttons('Rolü bitir')[0]!.click());
    const submit = buttons('Rolü bitir').at(-1)!;
    await act(async () => submit.click());
    expect(document.body.textContent).toContain('Gerekçe en az 5 karakter');
    expect(end.mutateAsync).not.toHaveBeenCalled();
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, 'Sözleşme bitti');
    act(() => {
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => buttons('Rolü bitir').at(-1)!.click());
    expect(end.mutateAsync).toHaveBeenCalledWith({
      userId: 's1',
      role: 'building_staff',
      input: { version: 3, reason: 'Sözleşme bitti', endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    });
  });
});
