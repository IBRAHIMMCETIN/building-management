import { CornerDownRight, EyeOff, Reply, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Badge, Button, FormField, Textarea } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { errorMessage } from '@/lib/api/errors';
import type { TenderComment } from '@/lib/api/tenders';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/dates';

type Props = {
  comments: readonly TenderComment[];
  canComment: boolean;
  /** Yonetim yaniti mi, sakin sorusu mu (metinler). */
  as: 'management' | 'resident';
  onSubmit: (v: { idempotencyKey: string; body: string; replyTo?: string }) => Promise<unknown>;
  pending: boolean;
  /** Yonetim gorunumu: yazar etiketi (ad yoksa rol). */
  authorLabel?: (c: TenderComment) => string | undefined;
  /** Yonetim: sakin sorusunu gerekceyle gizleme (moderasyon); verilirse soruda "Gizle" gorunur. */
  onHide?: (c: TenderComment) => void;
};

const MAX = 500;
const QUOTE_MAX = 80;

/** Yanitlanan sorunun kisa alintisi. */
export const quoteOf = (body: string) => (body.length > QUOTE_MAX ? `${body.slice(0, QUOTE_MAX - 1).trimEnd()}…` : body);

/**
 * Ihale sorulari: sakin yayindaki ihaleye kisa soru yazar, yonetim yanitlar. Sakinler birbirinin
 * kimligini gormez ("Sakin" / "Siz"); karar verildikten sonra yeni mesaj yazilamaz.
 */
export function TenderComments({ comments, canComment, as, onSubmit, pending, authorLabel, onHide }: Props) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key, renewKey] = useIdempotencyKey();
  /** Yonetim: belirli soruya yanit (bildirim yalnizca o sorunun yazarina). */
  const [replyTo, setReplyTo] = useState<TenderComment | null>(null);
  const text = body.trim();
  const byId = new Map(comments.map((c) => [c.commentId, c]));
  const manage = as === 'management';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.length < 3) {
      setError('Mesaj en az 3 karakter olmalı.');
      return;
    }
    setError(null);
    try {
      await onSubmit({ idempotencyKey: key, body: text, ...(replyTo ? { replyTo: replyTo.commentId } : {}) });
      setBody('');
      setReplyTo(null);
      renewKey();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold">Sorular ve yanıtlar</h2>
      {comments.length ? (
        <ol className="flex flex-col gap-2">
          {comments.map((c) => {
            const question = c.replyTo ? byId.get(c.replyTo) : undefined;
            return (
              <li
                key={c.commentId}
                className={cn('rounded-lg border px-3 py-2 text-small', c.authorKind === 'management' ? 'border-accent/30 bg-accent/5' : 'border-border bg-surface/40', c.hidden && 'opacity-70')}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={c.authorKind === 'management' ? 'accent' : 'neutral'}>{c.mine ? 'Siz' : c.authorKind === 'management' ? 'Yönetim' : 'Sakin'}</Badge>
                  {authorLabel?.(c) && <span className="text-xs text-muted">{authorLabel(c)}</span>}
                  {c.hidden && <Badge tone="warning">Gizlendi</Badge>}
                  <span className="ml-auto text-xs text-muted">{formatDateTime(c.createdAt)}</span>
                </div>
                {question && (
                  <p className="mt-1 flex items-start gap-1 text-xs text-muted">
                    <CornerDownRight className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <span className="break-words">Yanıtlanan soru: “{quoteOf(question.body)}”</span>
                  </p>
                )}
                <p className="mt-1 whitespace-pre-line break-words">{c.body}</p>
                {c.hidden && <p className="mt-1 text-xs text-warning">Sakinlere gösterilmiyor. Gerekçe: {c.hidden.reason}</p>}
                {manage && c.authorKind === 'resident' && !c.hidden && (canComment || onHide) && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {canComment && (
                      <Button size="xs" variant="subtle" onClick={() => setReplyTo(c)}>
                        <Reply className="size-3.5" aria-hidden="true" />
                        Yanıtla
                      </Button>
                    )}
                    {onHide && (
                      <Button size="xs" variant="subtle" onClick={() => onHide(c)}>
                        <EyeOff className="size-3.5" aria-hidden="true" />
                        Gizle
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-small text-muted">Henüz soru yok.</p>
      )}
      {canComment ? (
        <form className="flex flex-col gap-2" noValidate onSubmit={(e) => void submit(e)}>
          {replyTo && (
            <div className="flex items-start justify-between gap-2 rounded-md bg-surface-muted/50 px-2.5 py-1.5 text-xs text-muted">
              <span className="break-words">Bu soruya yanıt (yalnızca soran sakine bildirim gider): “{quoteOf(replyTo.body)}”</span>
              <button type="button" aria-label="Soruya yanıtı kaldır" className="shrink-0 hover:text-text" onClick={() => setReplyTo(null)}>
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
          <FormField label={as === 'resident' ? 'Sorunuz' : 'Yönetim yanıtı'} error={error ?? undefined} hint={as === 'resident' ? 'Diğer sakinler sorunuzu adınız olmadan görür.' : 'Tüm sakinler görür.'}>
            <Textarea rows={3} maxLength={MAX} value={body} onChange={(e) => setBody(e.target.value)} />
          </FormField>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted tabular-nums">
              {text.length}/{MAX}
            </span>
            <Button type="submit" size="sm" loading={pending} disabled={!text}>
              {as === 'resident' ? 'Soruyu gönder' : 'Yanıtla'}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-muted">Sorular yalnızca ihale sakinlerle paylaşıldıktan sonra ve karar verilene kadar yazılabilir.</p>
      )}
    </section>
  );
}
