/**
 * Ekran okuyucu erisimi: iOS VoiceOver'da `accessible` bir gorunum TEK oge sayilir ve icindeki
 * ogelere ayrica ulasilamaz (Android TalkBack de birlestirir). Bir kontrolun ulasilabilir olmasi icin
 * ustlerinden hicbiri `accessible` olmamalidir. RN'de Pressable varsayilan olarak `accessible`dir.
 */
type Node = { props: Record<string, unknown>; parent: Node | null; type: unknown };

/** Elemanin ustlerindeki erisilebilir (tek oge yapan) gorunumler; ulasilabilir bir kontrolde bos olmalidir. */
export function accessibleAncestors(element: unknown): Node[] {
  const out: Node[] = [];
  for (let n = (element as Node).parent; n; n = n.parent) {
    if (n.props?.accessible === true) out.push(n);
  }
  return out;
}
