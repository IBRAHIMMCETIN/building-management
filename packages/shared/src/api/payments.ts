import { z } from 'zod';

/*
 * Online odeme - sakin teklifi (apps/api/src/modules/payments). Tum tutarlar kurus cinsinden tam sayidir.
 *   GET /api/portal/payments/quote?unitId
 * Kart verisi uygulamalara hic gelmez: odeme saglayicinin (iyzico / PayTR) sayfasinda yapilir.
 * Diger odeme semalari ve uclar: apps/web/src/lib/api/payments.ts.
 */

const kurus = z.number().int();
const party = z.enum(['owner', 'occupant']);

const openDue = z.object({
  transactionId: z.string(),
  liableParty: party,
  description: z.string(),
  date: z.string(),
  dueDate: z.string(),
  amount: kurus,
  paid: kurus,
  remaining: kurus,
  overdue: z.boolean(),
  daysOverdue: z.number().int(),
  lateFee: z.boolean().optional(),
});
export type OpenDue = z.infer<typeof openDue>;

const partyQuote = z.object({
  liableParty: party,
  balance: kurus,
  debt: kurus,
  advance: kurus,
  accruedLateFee: kurus,
  totalDue: kurus,
  /** Secilebilir anapara kalemleri, en eski vade once (yalnizca bastan kesintisiz secilir). */
  items: z.array(openDue),
  /** Deftere yazilmis acik tazminat kalemleri: yalnizca toplam odemede kapanir. */
  postedLateFees: z.array(openDue),
});
export type PartyQuote = z.infer<typeof partyQuote>;

export const quoteSchema = z.object({
  unitId: z.string(),
  currency: z.literal('TRY'),
  onlinePaymentEnabled: z.boolean(),
  requiresGsmNumber: z.boolean().default(false),
  asOf: z.string(),
  lateFeeMonthlyBasisPoints: z.number().int(),
  parties: z.array(partyQuote),
  totalDue: kurus,
});
export type PaymentQuote = z.infer<typeof quoteSchema>;

/** "Online öde" yalnizca apartmanda online odeme aciksa ve odenecek tutar varsa gosterilir. */
export const canPayOnline = (quote: PaymentQuote | undefined): boolean => !!quote?.onlinePaymentEnabled && quote.totalDue >= 1;
