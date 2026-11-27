import { Card } from './Card';

/**
 * Gosterge karti (Genel Bakis, Portfoy): etiket, buyuk deger, istege bagli ayrinti. `warn`: deger
 * uyari renginde (renk tek basina durumu tasimaz; ayrinti metni de soyler).
 */
export function Kpi({ label, value, detail, warn }: { label: string; value: string; detail?: string; warn?: boolean }) {
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-small text-muted">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${warn ? 'text-warning' : ''}`}>{value}</p>
      {detail && <p className="text-xs text-muted">{detail}</p>}
    </Card>
  );
}
