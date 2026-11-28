import { canPayOnline } from '@bm/shared/api/payments';
import { useQueryClient } from '@tanstack/react-query';
import { CreditCard } from '@/components/icons';
import { AppText } from '@/components/ui';
import { WebLinkButton } from '@/components/WebLinkButton';
import { useAuth } from '@/context/AuthProvider';
import { portalKeys, usePaymentQuote } from '@/hooks/usePortal';
import { PAYMENT_WEB_PATH } from '@/lib/nav';

/**
 * "Online öde" (web: components/portal/PayOnlineButton.tsx): yalnizca apartmanda online odeme
 * aciksa ve odenecek tutar varsa. Mobilde kart girisi YOKTUR: web odeme sayfasi uygulama ici
 * tarayicida acilir (iyzico / PayTR sayfasi). Donuste borc ve hareketler yenilenir (iOS: tarayici
 * kapaninca; Android / web: uygulama one gelince, PortalForegroundRefresh).
 * `hint`: online odeme kapaliysa elden / havale notu.
 */
export function PayOnlineButton({ hint = false }: { hint?: boolean }) {
  const quote = usePaymentQuote();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  if (canPayOnline(quote.data)) {
    return (
      <WebLinkButton
        // Web odeme sayfasi kendi daire secimini degil, mobilde gosterilen daireyi kullanir
        // (web PaymentPage `?unitId=`'yi kullanicinin dairesiyse uygular).
        path={`${PAYMENT_WEB_PATH}?unitId=${encodeURIComponent(quote.data.unitId)}`}
        label="Online öde"
        icon={CreditCard}
        onClosed={() => void queryClient.invalidateQueries({ queryKey: portalKeys.all(user?.apartmentId ?? '', user?.sub ?? '') })}
      />
    );
  }
  if (!hint || quote.isPending) return null;
  return (
    <AppText variant="small" tone="muted">
      Ödemelerinizi apartman yöneticinize elden veya banka havalesiyle yapabilirsiniz.
    </AppText>
  );
}
