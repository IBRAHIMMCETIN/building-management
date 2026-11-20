/**
 * Odeme sonuc ekrani metinleri (saf). Saglayici donusunde URL ya `?intent=<id>` ya da callback
 * dogrulanamadiysa `?error=invalid|not_found` tasir (API: payments/service.ts handleCallback).
 */
import type { IntentStatus, PaymentIntent } from '@/lib/api/payments';

export type ResultTone = 'success' | 'danger' | 'warning' | 'info';

export type ResultView = {
  tone: ResultTone;
  title: string;
  body: string;
  /** Durum kesinlesti mi (sorgulama durur). */
  terminal: boolean;
  /** "Tekrar dene" gosterilsin mi. */
  canRetry: boolean;
};

export const TERMINAL_STATUSES: readonly IntentStatus[] = ['SUCCEEDED', 'FAILED', 'NEEDS_REVIEW'];

/** Sonuc sayfasi bu sure boyunca durumu sorgular; sonra "isleniyor" mesajinda kalir. */
export const RESULT_POLL_MS = 3_000;
export const RESULT_POLL_LIMIT_MS = 60_000;

export function callbackErrorView(code: string): ResultView {
  if (code === 'not_found') {
    return {
      tone: 'danger',
      title: 'Ödeme kaydı bulunamadı',
      body: 'Ödeme sağlayıcısından dönen bilgi bir ödeme kaydıyla eşleşmedi. Kartınızdan çekim yapıldıysa borcunuz birkaç dakika içinde güncellenir; güncellenmezse yönetiminizle iletişime geçin.',
      terminal: true,
      canRetry: false,
    };
  }
  return {
    tone: 'danger',
    title: 'Ödeme sonucu doğrulanamadı',
    body: 'Ödeme sağlayıcısından dönüş eksik veya geçersiz. Kartınızdan çekim yapıldıysa ödemeniz otomatik olarak sonuçlandırılır; Borçlarım sayfasından kontrol edebilirsiniz.',
    terminal: true,
    canRetry: false,
  };
}

export function intentResultView(intent: Pick<PaymentIntent, 'status' | 'failureMessage'>, timedOut = false): ResultView {
  switch (intent.status) {
    case 'SUCCEEDED':
      return {
        tone: 'success',
        title: 'Ödemeniz alındı',
        body: 'Borcunuzdan düşüldü ve makbuzunuz düzenlendi.',
        terminal: true,
        canRetry: false,
      };
    case 'FAILED':
      return {
        tone: 'danger',
        title: 'Ödeme tamamlanamadı',
        body: `${intent.failureMessage ?? 'Ödeme sağlayıcısı işlemi onaylamadı.'} Kartınızdan çekim yapılmadı; tekrar deneyebilirsiniz.`,
        terminal: true,
        canRetry: true,
      };
    case 'NEEDS_REVIEW':
      return {
        tone: 'warning',
        title: 'Ödemeniz kontrol ediliyor',
        body:
          intent.failureMessage ??
          'Ödemeniz alındı ancak kontrol edilmesi gerekiyor; yönetim sizinle iletişime geçecek. Lütfen tekrar ödeme yapmayın.',
        terminal: true,
        canRetry: false,
      };
    case 'PENDING':
      return timedOut
        ? {
            tone: 'info',
            title: 'Ödemeniz işleniyor',
            body: 'Sonuç henüz kesinleşmedi. Birkaç dakika içinde Borçlarım sayfasına yansır; bu sürede tekrar ödeme yapmayın.',
            terminal: true,
            canRetry: false,
          }
        : {
            tone: 'info',
            title: 'Ödeme sonucu bekleniyor',
            body: 'Ödeme sağlayıcısından sonuç alınıyor, lütfen sayfayı kapatmayın.',
            terminal: false,
            canRetry: false,
          };
  }
}

const PARTY_LABEL = { owner: 'Kat maliki', occupant: 'Sakin (kiracı)' } as const;
export const partyLabel = (p: keyof typeof PARTY_LABEL) => PARTY_LABEL[p];
