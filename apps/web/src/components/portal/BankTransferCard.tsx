import { Check, Copy, Landmark } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, Skeleton } from '@/components/ui';
import { useMyPaymentReference } from '@/hooks/useBank';
import { groupIban } from '@/lib/bank/allocation';

/** Tek tikla kopyala: kisa sure "Kopyalandı" geri bildirimi. Pano API'si yoksa sessizce gecer. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="secondary"
      aria-label={`${label} kopyala`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      {copied ? 'Kopyalandı' : 'Kopyala'}
    </Button>
  );
}

function Row({ term, value, copyValue, mono }: { term: string; value: string; copyValue?: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-muted p-3">
      <div className="min-w-0">
        <dt className="text-small text-muted">{term}</dt>
        <dd className={mono ? 'font-mono font-semibold tracking-wide break-all' : 'font-semibold break-words'}>{value}</dd>
      </div>
      {copyValue && <CopyButton value={copyValue} label={term} />}
    </div>
  );
}

/**
 * Havale / EFT ile odeme: apartmanin tahsilat IBAN'i, hesap sahibi ve sakinin kisisel odeme referans
 * kodu. Kod aciklamaya yazilirsa banka ekstresinde odeme otomatik ve kesin eslesir.
 */
export function BankTransferCard() {
  const ref = useMyPaymentReference();

  if (ref.isPending) {
    return (
      <Card role="status" aria-label="Havale bilgileri yükleniyor" className="flex flex-col gap-3">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </Card>
    );
  }
  // Uyelik/daire secimi hatalarini ozet kart zaten gosterir.
  if (ref.isError || !ref.data.bank) return null;
  const { bank, references } = ref.data;

  return (
    <Card className="flex flex-col gap-4" aria-labelledby="bank-transfer-title">
      <div className="flex items-start gap-3">
        <Landmark className="mt-0.5 size-5 text-accent" aria-hidden="true" />
        <div>
          <h2 id="bank-transfer-title" className="text-heading font-semibold">
            Havale / EFT ile Öde
          </h2>
          <p className="text-small text-muted">
            Açıklamaya ödeme referans kodunuzu yazın; ödemeniz banka hesabına geçtiğinde otomatik olarak borcunuza işlenir.
          </p>
        </div>
      </div>
      <dl className="flex flex-col gap-2">
        <Row term="IBAN" value={groupIban(bank.iban)} copyValue={bank.iban} mono />
        <Row term="Hesap sahibi" value={bank.accountHolderName} copyValue={bank.accountHolderName} />
        {bank.bankName && <Row term="Banka" value={bank.bankName} />}
        {references.map((r) => (
          <Row key={r.liableParty} term={references.length > 1 ? `Ödeme referans kodu (${r.label})` : 'Ödeme referans kodu'} value={r.code} copyValue={r.code} mono />
        ))}
      </dl>
      {references.length > 1 && (
        <p className="text-small text-muted">Kat maliki ve sakin borçları ayrı izlenir: hangi borcu ödüyorsanız o kodu yazın.</p>
      )}
    </Card>
  );
}
