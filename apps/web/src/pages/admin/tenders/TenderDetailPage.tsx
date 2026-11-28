import { ArrowLeft, Ban, CheckCircle2, FileClock, Gavel, Landmark, Link2, Pencil, Plus, ReceiptText, Send, Undo2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { QuoteComparison } from '@/components/tenders/QuoteComparison';
import { TenderComments } from '@/components/tenders/TenderComments';
import { Alert, Badge, Button, Card, CardTitle, Skeleton } from '@/components/ui';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { useAssemblyDecisionOptions, useSupplierAccounts, useTender, useTenderActions, useTenderExpense, useTenderPermissions } from '@/hooks/useTenders';
import { errorMessage } from '@/lib/api/errors';
import { type Quote, type Tender, type TenderComment, tendersApi } from '@/lib/api/tenders';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { istanbulToday } from '@/lib/reservations/model';
import { TENDER_CATEGORY_LABELS, TENDER_STATUS_LABELS, TENDER_STATUS_TONES, allowedActions, canEditQuotes, deadlineText, publishBlockers } from '@/lib/tenders/model';
import { ROLE_LABELS, isRole } from '@/types/roles';
import { ExpenseDialog, type ExpensePreset } from '../finance/ExpenseDialog';
import { AssemblyLinkDialog, DecideDialog, PublishDialog, ReasonDialog, SupplierDialog } from './ActionDialogs';
import { QuoteDialog } from './QuoteDialog';
import { TenderDialog } from './TenderDialog';

/** Ihale ayrintisi (yonetim): teklifler yan yana, durum gecisleri, karar, sorular. Denetci salt okur. */
export function TenderDetailPage() {
  const { tenderId } = useParams();
  const detail = useTender(tenderId);
  return (
    <div className="flex flex-col gap-6">
      <Link to="/admin/tenders" className="inline-flex items-center gap-1 self-start text-small text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden="true" />
        İhaleler
      </Link>
      {detail.isPending ? <Skeleton className="h-64" /> : detail.isError ? <Alert tone="danger">{errorMessage(detail.error)}</Alert> : <Detail tender={detail.data} />}
    </div>
  );
}

type Open = null | 'edit' | 'quote' | 'publish' | 'decide' | 'cancel' | 'expense' | 'assembly' | 'supplier' | { edit: Quote } | { withdraw: Quote } | { hide: TenderComment };

function Detail({ tender: t }: { tender: Tender }) {
  const { canWrite } = useTenderPermissions();
  const actions = useTenderActions();
  const expense = useTenderExpense();
  // On dolum acilista sabitlenir: kayittan sonra ayrinti yaniti on dolumu kaldirsa da pencere
  // basari ekranini gostermeye devam eder.
  const [expensePreset, setExpensePreset] = useState<ExpensePreset>();
  const [open, setOpenState] = useState<Open>(null);
  // Diyalog acildigindaki ihale surumu: arada baska yonetici degistirirse islem 409 alir, yeni surumle
  // sessizce tekrar denenmez (kullanici guncel ekrani gorup pencereyi yeniden acar).
  const [openedVersion, setOpenedVersion] = useState(t.version);
  const setOpen = (o: Open) => {
    if (o !== null) setOpenedVersion(t.version);
    setOpenState(o);
  };
  const oldDoc = useOpenDocument();
  // Secenekler yalnizca ilgili pencere acikken yuklenir.
  const assemblyOptions = useAssemblyDecisionOptions(canWrite && (open === 'decide' || open === 'assembly'));
  const supplierOptions = useSupplierAccounts(t.tenderId, canWrite && open === 'supplier');
  const hiding = typeof open === 'object' && open !== null && 'hide' in open ? open.hide : undefined;
  const allowed = canWrite ? allowedActions(t.status) : [];
  const editable = canWrite && canEditQuotes(t.status);
  const close = () => setOpen(null);
  const blockers = publishBlockers(t);
  // Diyalog acmayan tek gecis; diger islemlerin hatasi kendi diyaloglarinda gosterilir.
  const collectError = actions.collect.isError ? actions.collect.error : null;

  return (
    <>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted">
          {TENDER_CATEGORY_LABELS[t.category]}
          {t.ticket && (
            <>
              {' · '}
              <Link to={`/admin/tickets?ticket=${encodeURIComponent(t.ticket.ticketId)}`} className="underline-offset-4 hover:text-text hover:underline">
                {t.ticket.number} · {t.ticket.title}
              </Link>
            </>
          )}
          {' · '}
          {formatDateTime(t.createdAt)}
        </span>
        <h1 className="text-title font-bold break-words">{t.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={TENDER_STATUS_TONES[t.status]}>{TENDER_STATUS_LABELS[t.status]}</Badge>
          {(t.status === 'draft' || t.status === 'collecting') && (
            <span className={t.deadlinePassed ? 'text-small text-warning' : 'text-small text-muted'}>
              Son teklif {formatDate(t.deadline)} · {deadlineText(t.deadline, istanbulToday())}
            </span>
          )}
          {t.publishedAt && <span className="text-small text-muted">Paylaşıldı: {formatDateTime(t.publishedAt)}</span>}
        </div>
      </div>

      {canWrite && (allowed.length > 0 || editable) && (
        <div className="flex flex-wrap gap-2">
          {editable && (
            <Button variant="secondary" onClick={() => setOpen('quote')}>
              <Plus className="size-4" aria-hidden="true" />
              Teklif ekle
            </Button>
          )}
          {allowed.includes('collect') && (
            <Button loading={actions.collect.isPending} onClick={() => actions.collect.mutate({ id: t.tenderId, version: t.version })}>
              <Send className="size-4" aria-hidden="true" />
              Teklif toplamaya başla
            </Button>
          )}
          {allowed.includes('publish') && (
            <Button onClick={() => setOpen('publish')}>
              <Send className="size-4" aria-hidden="true" />
              Sakinlerle paylaş
            </Button>
          )}
          {allowed.includes('decide') && (
            <Button onClick={() => setOpen('decide')}>
              <Gavel className="size-4" aria-hidden="true" />
              Karara bağla
            </Button>
          )}
          {editable && (
            <Button variant="ghost" onClick={() => setOpen('edit')}>
              <Pencil className="size-4" aria-hidden="true" />
              Bilgileri düzenle
            </Button>
          )}
          {allowed.includes('cancel') && (
            <Button variant="ghost" onClick={() => setOpen('cancel')}>
              <Ban className="size-4" aria-hidden="true" />
              İptal et
            </Button>
          )}
        </div>
      )}
      {collectError && <Alert tone="danger">{errorMessage(collectError)}</Alert>}

      {t.status === 'collecting' && canWrite && (
        <Alert tone={blockers.length || t.readiness?.shortfall ? 'info' : 'success'}>
          {t.quoteCount}/{t.minQuotes} teklif eklendi.
          {blockers.length ? ` ${blockers.join(' ')}` : t.readiness?.shortfall ? ' Asgari sayının altında paylaşmak için gerekçe istenir.' : ' Sakinlerle paylaşmaya hazır.'}
        </Alert>
      )}
      {t.status === 'draft' && canWrite && <Alert>Taslak yalnızca yönetimde görünür. Firmalardan teklif istemeye başladığınızda “Teklif toplamaya başla”yı seçin.</Alert>}

      <DecisionCard
        tender={t}
        canWrite={canWrite}
        onExpense={() => {
          if (t.expenseDraft) {
            const { amountKurus, creditAccountId, installment: _i, ...rest } = t.expenseDraft;
            setExpensePreset({
              ...rest,
              ...(amountKurus > 0 ? { amount: amountKurus } : {}),
              ...(creditAccountId ? { creditAccountId, creditAccountName: t.supplierAccount?.name } : {}),
            });
          }
          setOpen('expense');
        }}
        onLinkAssembly={() => setOpen('assembly')}
        onLinkSupplier={() => setOpen('supplier')}
      />
      {t.shortfallReason && (
        <Alert>
          Asgari {t.minQuotes} teklif yerine {t.quoteCount} teklifle paylaşıldı. Gerekçe: {t.shortfallReason}
        </Alert>
      )}
      {t.status === 'cancelled' && (
        <Alert tone="danger">
          İptal edildi{t.cancelledAt ? ` (${formatDateTime(t.cancelledAt)})` : ''}. Gerekçe: {t.cancelReason}
        </Alert>
      )}

      <Card className="flex flex-col gap-2">
        <CardTitle>İşin kapsamı</CardTitle>
        <p className="whitespace-pre-line break-words text-small text-text-secondary">{t.description}</p>
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Teklifler</h2>
          <span className="text-xs text-muted">Karşılaştırma KDV dahil toplam üzerinden yapılır.</span>
        </div>
        <QuoteComparison
          tender={t}
          loadDocument={(quoteId) => tendersApi.document(t.tenderId, quoteId)}
          actions={
            canWrite
              ? (q) => (
                  <span className="flex flex-col items-start gap-1">
                    {editable && (
                      <span className="flex flex-wrap gap-1">
                        <Button size="xs" variant="subtle" onClick={() => setOpen({ edit: q })}>
                          <Pencil className="size-3.5" aria-hidden="true" />
                          Düzenle
                        </Button>
                        <Button size="xs" variant="subtle" onClick={() => setOpen({ withdraw: q })}>
                          <Undo2 className="size-3.5" aria-hidden="true" />
                          Geri çek
                        </Button>
                      </span>
                    )}
                    {q.documentHistory?.map((d, i) => (
                      <Button
                        key={`${d.replacedAt}-${d.fileName}`}
                        size="xs"
                        variant="subtle"
                        title={`${d.fileName} · ${formatDateTime(d.replacedAt)} tarihinde değiştirildi`}
                        loading={oldDoc.pendingId === `${q.quoteId}:${i}`}
                        onClick={() => void oldDoc.open(`${q.quoteId}:${i}`, () => tendersApi.document(t.tenderId, q.quoteId, i))}
                      >
                        <FileClock className="size-3.5" aria-hidden="true" />
                        Önceki belge {i + 1}
                      </Button>
                    ))}
                  </span>
                )
              : undefined
          }
        />
        {oldDoc.error && <p className="text-small text-danger">{oldDoc.error}</p>}
      </section>

      {t.publishedAt && (
        <TenderComments
          comments={t.comments}
          canComment={canWrite && t.canComment}
          as="management"
          pending={actions.comment.isPending}
          onSubmit={(v) => actions.comment.mutateAsync({ id: t.tenderId, ...v })}
          authorLabel={(c) => (c.authorKind === 'management' && c.authorRole && isRole(c.authorRole) ? ROLE_LABELS[c.authorRole] : undefined)}
          {...(canWrite ? { onHide: (c: TenderComment) => setOpen({ hide: c }) } : {})}
        />
      )}

      {canWrite && (
        <>
          <TenderDialog open={open === 'edit'} onClose={close} tender={t} />
          <QuoteDialog open={open === 'quote' || (typeof open === 'object' && open !== null && 'edit' in open)} onClose={close} tender={t} quote={typeof open === 'object' && open !== null && 'edit' in open ? open.edit : undefined} />
          <PublishDialog
            open={open === 'publish'}
            onClose={close}
            tender={t}
            pending={actions.publish.isPending}
            onConfirm={(shortfallReason) => actions.publish.mutateAsync({ id: t.tenderId, version: openedVersion, ...(shortfallReason ? { shortfallReason } : {}) })}
          />
          <DecideDialog
            open={open === 'decide'}
            onClose={close}
            tender={t}
            pending={actions.decide.isPending}
            assemblyOptions={assemblyOptions.data ?? []}
            onConfirm={(v) => actions.decide.mutateAsync({ id: t.tenderId, version: openedVersion, ...v })}
          />
          <AssemblyLinkDialog
            open={open === 'assembly'}
            onClose={close}
            tender={t}
            options={assemblyOptions.data ?? []}
            loading={assemblyOptions.isPending}
            pending={actions.linkAssemblyDecision.isPending}
            onConfirm={(assemblyDecision) => actions.linkAssemblyDecision.mutateAsync({ id: t.tenderId, version: openedVersion, assemblyDecision })}
          />
          <SupplierDialog
            open={open === 'supplier'}
            onClose={close}
            tender={t}
            options={supplierOptions.data ?? []}
            loading={supplierOptions.isPending}
            pending={actions.linkSupplier.isPending}
            onConfirm={(accountId) => actions.linkSupplier.mutateAsync({ id: t.tenderId, version: openedVersion, accountId })}
          />
          <ReasonDialog
            open={hiding !== undefined}
            onClose={close}
            title="Soruyu gizle"
            description="Soru silinmez; sakinlere (yazarı dahil) gösterilmez, yönetim ve denetçi gerekçesiyle görür. Gerekçe denetim günlüğüne yazılır."
            label="Gizleme gerekçesi"
            minLength={5}
            maxLength={300}
            confirmLabel="Gizle"
            danger
            pending={actions.hideComment.isPending}
            onConfirm={(reason) => (hiding ? actions.hideComment.mutateAsync({ id: t.tenderId, commentId: hiding.commentId, reason }) : Promise.resolve())}
          />
          {expensePreset && (
            // Odeme kaynagi ihalede yok: Finans gider penceresi karardan on doldurulur, yonetici onaylar.
            <ExpenseDialog
              open={open === 'expense'}
              onClose={close}
              title="İhale için gider / hakediş kaydı"
              preset={expensePreset}
              onRecord={async (input) => {
                const r = await expense.mutateAsync({ id: t.tenderId, input });
                return { amount: r.tender.expenses?.find((e) => e.expenseId === r.expenseId)?.amountKurus ?? input.amount };
              }}
            />
          )}
          <ReasonDialog
            open={open === 'cancel'}
            onClose={close}
            title="İhaleyi iptal et"
            description={t.publishedAt ? 'İhale sakinlere iptal gerekçesiyle birlikte görünmeye devam eder. Kayıt silinmez.' : 'Kayıt silinmez; iptal gerekçesi denetim günlüğüne yazılır.'}
            label="İptal gerekçesi"
            minLength={10}
            confirmLabel="İptal et"
            danger
            pending={actions.cancel.isPending}
            onConfirm={(reason) => actions.cancel.mutateAsync({ id: t.tenderId, version: openedVersion, reason })}
          />
          <ReasonDialog
            open={typeof open === 'object' && open !== null && 'withdraw' in open}
            onClose={close}
            title="Teklifi geri çek"
            description="Teklif silinmez; karşılaştırmadan çıkar ve paylaşımdan sonra sakinler gerekçesiyle birlikte görür."
            label="Gerekçe"
            minLength={3}
            maxLength={300}
            confirmLabel="Geri çek"
            danger
            pending={actions.withdrawQuote.isPending}
            onConfirm={(reason) => {
              const q = typeof open === 'object' && open !== null && 'withdraw' in open ? open.withdraw : undefined;
              return q ? actions.withdrawQuote.mutateAsync({ id: t.tenderId, quoteId: q.quoteId, version: openedVersion, reason }) : Promise.resolve();
            }}
          />
        </>
      )}
    </>
  );
}

/**
 * Karar ozeti: genel kurul karar bagi, tedarikci hesabi, hakedisler ve ilerleme. Yonetim: "Hakediş /
 * gider ekle" Finans gider penceresini karardan on doldurulmus acar (kalan tutar; gider sessizce
 * olusturulmaz); ters kaydedilen gider ilerlemeye sayilmaz.
 */
function DecisionCard({ tender: t, canWrite, onExpense, onLinkAssembly, onLinkSupplier }: { tender: Tender; canWrite: boolean; onExpense: () => void; onLinkAssembly: () => void; onLinkSupplier: () => void }) {
  const d = t.decision;
  if (!d) return null;
  const lowest = t.comparison.lowestQuoteIds.includes(d.quoteId);
  const ad = t.assemblyDecision;
  const p = t.expenseProgress;
  const expenses = t.expenses ?? (t.expense ? [t.expense] : []);
  return (
    <Card className="flex flex-col gap-3 border-success/30">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>
            Seçilen teklif: {d.supplierName} · <span className="tabular-nums">{formatTRY(d.totalKurus)}</span>
          </CardTitle>
          <p className="text-xs text-muted">
            KDV hariç {formatTRY(d.netKurus)} + KDV {formatTRY(d.vatKurus)} · {formatDateTime(d.decidedAt)}
            {lowest ? ' · En düşük teklif' : ' · En düşük teklif seçilmedi'}
          </p>
          <p className="whitespace-pre-line break-words text-small">{d.reason}</p>
          {d.reference && <p className="text-small text-muted">Karar referansı: {d.reference}</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
        <Landmark className="size-4 shrink-0 text-muted" aria-hidden="true" />
        {ad ? (
          <span>
            Genel kurul kararı:{' '}
            <Link to={`/admin/assemblies?assembly=${encodeURIComponent(ad.assemblyId)}`} className="text-accent underline-offset-4 hover:underline">
              {formatDate(ad.meetingAt)} · {ad.itemTitle}
            </Link>
            {ad.corrected && <span className="text-warning"> · karar sonradan düzeltildi{ad.currentDecision === 'rejected' ? ' (güncel kayıt: reddedildi)' : ''}</span>}
          </span>
        ) : (
          <span className="text-muted">Genel kurul kararı bağlı değil.</span>
        )}
        {canWrite && t.status === 'decided' && (
          <Button size="xs" variant="subtle" onClick={onLinkAssembly}>
            <Link2 className="size-3.5" aria-hidden="true" />
            {ad ? 'Değiştir / kaldır' : 'Bağla'}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
        <Wallet className="size-4 shrink-0 text-muted" aria-hidden="true" />
        {t.supplierAccount ? <span>Tedarikçi hesabı: {t.supplierAccount.name}</span> : <span className="text-muted">Finans tedarikçi hesabı eşleştirilmedi.</span>}
        {canWrite && t.status === 'decided' && (
          <Button size="xs" variant="subtle" onClick={onLinkSupplier}>
            {t.supplierAccount ? 'Değiştir' : 'Eşleştir'}
          </Button>
        )}
      </div>

      {p && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-small">
            <span className="font-medium">Hakedişler</span>
            <span className="tabular-nums text-muted">
              {formatTRY(p.activeTotalKurus)} / {formatTRY(p.decidedTotalKurus)} · %{(p.percentBps / 100).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}
              {p.overrunKurus > 0 ? ` · aşım ${formatTRY(p.overrunKurus)}` : ` · kalan ${formatTRY(p.remainingKurus)}`}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-label="Hakediş ilerlemesi" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(p.percentBps / 100))}>
            <div className={p.overrunKurus > 0 ? 'h-full bg-warning' : 'h-full bg-success'} style={{ width: `${Math.min(100, p.percentBps / 100)}%` }} />
          </div>
        </div>
      )}
      {expenses.length > 0 && (
        <ul className="flex flex-col gap-1 text-small">
          {expenses.map((e, i) => (
            <li key={e.expenseId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={e.reversed ? 'text-muted line-through' : undefined}>
                {e.installment ?? i + 1}. {e.reversed ? 'Gider ters kaydedildi' : 'Gider kaydedildi'}: <span className="tabular-nums">{formatTRY(e.amountKurus)}</span> · {formatDate(e.date)}
              </span>
              {e.reversed && <Badge tone="neutral">Ters kayıt</Badge>}
              {e.overrunReason && <span className="text-xs text-warning">Aşım gerekçesi: {e.overrunReason}</span>}
            </li>
          ))}
          <li>
            <Link to="/admin/finance" className="text-xs text-accent underline-offset-4 hover:underline">
              Finans'ta görüntüle
            </Link>
          </li>
        </ul>
      )}
      {canWrite && t.expenseDraft && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-small text-muted">
            {expenses.some((e) => e.reversed) && !p?.activeCount
              ? 'Bağlı gider Finans’ta ters kayıtla iptal edildi; gerekiyorsa yeni gider kaydı oluşturun.'
              : `İş ilerledikçe hakedişleri veya faturaları buradan kaydedin; kalan tutar, tedarikçi (“${d.supplierName}”), açıklama ve gider kalemi karardan doldurulur.`}
            {t.supplierAccount ? ' Ödeme hesabı eşleştirilmiş tedarikçi hesabıdır (vadeli).' : ' Ödeme kaynağını siz seçersiniz.'} Karar tutarı aşılırsa gerekçe istenir.
          </p>
          <Button size="sm" variant="secondary" onClick={onExpense}>
            <ReceiptText className="size-4" aria-hidden="true" />
            Hakediş / gider ekle
          </Button>
        </div>
      )}
    </Card>
  );
}
