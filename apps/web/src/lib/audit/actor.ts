import { roleLabel } from './labels';

/** Denetim kaydi aktoru icin bilinen kisi bilgisi (sakin dizini, gorev rolleri, oturumdaki kullanici). */
export type ActorInfo = { name?: string; email?: string };

/**
 * UX-08: denetim satirinin ikinci satiri ham kullanici kimligi (UUID) yerine okunabilir aktor.
 *   ad biliniyor       "Ayşe Yılmaz · Apartman Yöneticisi"
 *   yalnizca e-posta   "Apartman Yöneticisi (yonetici@ornek.com)"
 *   hicbiri            "Apartman Yöneticisi"
 * Teknik kimlik yalnizca ayrintida / tooltip'te gosterilir (hash zincirindeki deger degismez).
 */
export function actorText(actor: { userId: string; role: string }, info: ActorInfo | undefined): string {
  const role = roleLabel(actor.role);
  if (actor.role === 'system') return role;
  if (info?.name && info.name !== actor.userId) return `${info.name} · ${role}`;
  if (info?.email) return `${role} (${info.email})`;
  return role;
}

/** Kaynaklari tek dizinde birlestirir; once gelen dolu alan korunur (ad: sakin dizini > gorev rolu). */
export function buildActorDirectory(sources: {
  people?: readonly { userId: string; fullName: string; email?: string }[];
  roles?: readonly { userId: string; displayName?: string }[];
  self?: { userId: string; email?: string };
}): Map<string, ActorInfo> {
  const dir = new Map<string, ActorInfo>();
  const put = (userId: string, info: ActorInfo) => {
    const cur = dir.get(userId) ?? {};
    dir.set(userId, { name: cur.name ?? info.name, email: cur.email ?? info.email });
  };
  for (const p of sources.people ?? []) put(p.userId, { name: p.fullName || undefined, email: p.email || undefined });
  for (const r of sources.roles ?? []) {
    // Gorev rolunde gorunen ad bazen e-postadir.
    const d = r.displayName?.trim();
    if (d) put(r.userId, d.includes('@') ? { email: d } : { name: d });
  }
  if (sources.self) put(sources.self.userId, { email: sources.self.email });
  return dir;
}
