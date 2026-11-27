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
  onSubmit: (v: { idempotencyKey: string; body: string }) => Promise<unknown>;
  pending: boolean;
  /** Yonetim gorunumu: yazar etiketi (ad yoksa rol). */
  authorLabel?: (c: TenderComment) => string | undefined;
};

const MAX = 500;

/**
 * Ihale sorulari: sakin yayindaki ihaleye kisa soru yazar, yonetim yanitlar. Sakinler birbirinin
 * kimligini gormez ("Sakin" / "Siz"); karar verildikten sonra yeni mesaj yazilamaz.
 */
export function TenderComments({ comments, canComment, as, onSubmit, pending, authorLabel }: Props) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key, renewKey] = useIdempotencyKey();
  const text = body.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.length < 3) {
      setError('Mesaj en az 3 karakter olmalı.');
      return;
    }
    setError(null);
    try {
      await onSubmit({ idempotencyKey: key, body: text });
      setBody('');
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
          {comments.map((c) => (
            <li key={c.commentId} className={cn('rounded-lg border px-3 py-2 text-small', c.authorKind === 'management' ? 'border-accent/30 bg-accent/5' : 'border-border bg-surface/40')}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={c.authorKind === 'management' ? 'accent' : 'neutral'}>{c.mine ? 'Siz' : c.authorKind === 'management' ? 'Yönetim' : 'Sakin'}</Badge>
                {authorLabel?.(c) && <span className="text-xs text-muted">{authorLabel(c)}</span>}
                <span className="ml-auto text-xs text-muted">{formatDateTime(c.createdAt)}</span>
              </div>
              <p className="mt-1 whitespace-pre-line break-words">{c.body}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-small text-muted">Henüz soru yok.</p>
      )}
      {canComment ? (
        <form className="flex flex-col gap-2" noValidate onSubmit={(e) => void submit(e)}>
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
