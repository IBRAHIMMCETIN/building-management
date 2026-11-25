import { describe, expect, it } from 'vitest';
import { actorText, buildActorDirectory } from './actor';

const ID = '501c397c-a041-7026-c6f1-9df74ece66d0';

describe('denetim aktoru etiketi (UX-08)', () => {
  it('ad > e-posta > yalnizca rol; ham kimlik gosterilmez', () => {
    expect(actorText({ userId: ID, role: 'apartment_manager' }, { name: 'Ayşe Yılmaz' })).toBe('Ayşe Yılmaz · Apartman Yöneticisi');
    expect(actorText({ userId: ID, role: 'apartment_manager' }, { email: 'ibrahimcetin776+yonetici@gmail.com' })).toBe(
      'Apartman Yöneticisi (ibrahimcetin776+yonetici@gmail.com)',
    );
    const bare = actorText({ userId: ID, role: 'apartment_manager' }, undefined);
    expect(bare).toBe('Apartman Yöneticisi');
    expect(bare).not.toContain(ID);
    expect(actorText({ userId: 'system', role: 'system' }, undefined)).toBe('Sistem');
  });

  it('dizin: sakin adi, gorev rolu gorunen adi ve oturumdaki kullanicinin e-postasi birlesir', () => {
    const dir = buildActorDirectory({
      people: [{ userId: 'u1', fullName: 'Ali Sakin', email: 'ali@x.com' }],
      roles: [
        { userId: 'u1', displayName: 'Başka Ad' },
        { userId: 'u2', displayName: 'kapici@x.com' },
        { userId: 'u3', displayName: 'Veli Görevli' },
      ],
      self: { userId: ID, email: 'yonetici@x.com' },
    });
    expect(dir.get('u1')).toEqual({ name: 'Ali Sakin', email: 'ali@x.com' });
    expect(dir.get('u2')).toEqual({ name: undefined, email: 'kapici@x.com' });
    expect(dir.get('u3')?.name).toBe('Veli Görevli');
    expect(dir.get(ID)?.email).toBe('yonetici@x.com');
  });
});
