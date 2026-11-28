import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { QuoteComparison } from '@/components/tenders/QuoteComparison';
import { TenderComments } from '@/components/tenders/TenderComments';
import { Alert, Badge, Card, CardTitle, Skeleton } from '@/components/ui';
import { useAskTenderQuestion, useMyTender } from '@/hooks/useTenders';
import { errorMessage } from '@/lib/api/errors';
import { type Tender, portalTendersApi } from '@/lib/api/tenders';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { TENDER_CATEGORY_LABELS, TENDER_STATUS_LABELS, TENDER_STATUS_TONES } from '@/lib/tenders/model';

/** Sakin ihale ayrintisi: teklifler yan yana (KDV dahil), belgeler 5 dk imzali linkle, karar, sorular. */
export function MyTenderDetailPage() {
  const { tenderId } = useParams();
  const detail = useMyTender(tenderId);
  return (
    <div className="flex flex-col gap-4">
      <Link to="/app/ihale" className="inline-flex items-center gap-1 self-start text-small text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden="true" />
        İhaleler
      </Link>
      {detail.isPending ? <Skeleton className="h-64" /> : detail.isError ? <Alert tone="danger">{errorMessage(detail.error)}</Alert> : <Detail tender={detail.data} />}
    </div>
  );
}

function Detail({ tender: t }: { tender: Tender }) {
  const ask = useAskTenderQuestion();
  const d = t.decision;
  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">
          {TENDER_CATEGORY_LABELS[t.category]}
          {t.publishedAt ? ` · Paylaşıldı: ${formatDateTime(t.publishedAt)}` : ''}
        </span>
        <h1 className="text-title font-bold break-words">{t.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={TENDER_STATUS_TONES[t.status]}>{TENDER_STATUS_LABELS[t.status]}</Badge>
          <span className="text-small text-muted">
            {t.quoteCount} teklif{t.lowestTotalKurus !== undefined ? ` · en düşük ${formatTRY(t.lowestTotalKurus)}` : ''}
          </span>
        </div>
      </div>

      {d && (
        <Card className="flex items-start gap-3 border-success/30">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>
              Yönetimin kararı: {d.supplierName} · <span className="tabular-nums">{formatTRY(d.totalKurus)}</span>
            </CardTitle>
            <p className="text-xs text-muted">
              {formatDateTime(d.decidedAt)}
              {t.comparison.lowestQuoteIds.includes(d.quoteId) ? ' · En düşük teklif' : ' · En düşük teklif seçilmedi'}
            </p>
            <p className="whitespace-pre-line break-words text-small">{d.reason}</p>
            {t.assemblyDecision && (
              <p className="text-small text-muted">
                Dayandığı genel kurul kararı:{' '}
                {t.assemblyDecision.portalLink ? (
                  <Link to={`/app/genel-kurul/${encodeURIComponent(t.assemblyDecision.assemblyId)}`} className="text-accent underline-offset-4 hover:underline">
                    {formatDate(t.assemblyDecision.meetingAt)} · {t.assemblyDecision.itemTitle}
                  </Link>
                ) : (
                  <span>
                    {formatDate(t.assemblyDecision.meetingAt)} · {t.assemblyDecision.itemTitle}
                  </span>
                )}
                {t.assemblyDecision.corrected ? ' (karar sonradan düzeltildi)' : ''}
              </p>
            )}
            {d.reference && <p className="text-small text-muted">Karar referansı: {d.reference}</p>}
          </div>
        </Card>
      )}
      {t.shortfallReason && (
        <Alert>
          {t.minQuotes} teklif hedeflenmişti, {t.quoteCount} teklif alındı. Yönetimin açıklaması: {t.shortfallReason}
        </Alert>
      )}
      {t.status === 'cancelled' && <Alert tone="danger">İhale iptal edildi. Gerekçe: {t.cancelReason}</Alert>}

      <p className="whitespace-pre-line break-words rounded-lg bg-surface-muted/40 p-3 text-small">{t.description}</p>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">Teklifler yan yana</h2>
          <p className="text-xs text-muted">KDV dahil / hariç verilen teklifler aynı ölçüye (KDV dahil toplam) çevrildi. Belgeler kısa süreli bağlantıyla açılır.</p>
        </div>
        <QuoteComparison tender={t} loadDocument={(quoteId) => portalTendersApi.document(t.tenderId, quoteId)} />
      </section>

      <TenderComments comments={t.comments} canComment={t.canComment} as="resident" pending={ask.isPending} onSubmit={(v) => ask.mutateAsync({ id: t.tenderId, ...v })} />
    </>
  );
}
