import { CreditCard } from 'lucide-react';
import { Link } from 'react-router';
import { usePaymentQuote } from '@/hooks/usePayments';
import { cn } from '@/lib/cn';

/**
 * "Online öde" baglantisi: yalnizca apartmanda online odeme aciksa ve odenecek tutar varsa gorunur.
 * Teklif yuklenemezse sessiz kalir (borc karti hatayi zaten gosterir).
 */
export function PayOnlineButton({ className }: { className?: string }) {
  const quote = usePaymentQuote();
  if (!quote.data?.onlinePaymentEnabled || quote.data.totalDue < 1) return null;
  return (
    <Link
      to="/app/odeme"
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-small font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-hover',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      )}
    >
      <CreditCard className="size-4" aria-hidden="true" />
      Online öde
    </Link>
  );
}
