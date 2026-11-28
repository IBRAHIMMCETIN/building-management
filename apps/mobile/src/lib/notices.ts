/*
 * Uygulama geneli kisa bilgi notu (ust bant; NoticeBanner). Ornek: bildirime dokunuldu ama apartman
 * artik kullanicinin baglamlarinda yok. Ekrana bagli olmayan olaylar icin; ekran ici hatalar Alert ile.
 */
export type Notice = { id: number; message: string; tone: 'info' | 'warning' };

export function createNoticeStore() {
  let current: Notice | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    show(message: string, tone: Notice['tone'] = 'info') {
      current = { id: ++seq, message, tone };
      emit();
    },
    dismiss() {
      current = null;
      emit();
    },
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type NoticeStore = ReturnType<typeof createNoticeStore>;
