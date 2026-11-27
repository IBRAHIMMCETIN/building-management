import { CircleCheck, CircleX, LogIn, LogOut, QrCode } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Alert, Button, Card, Input } from '@/components/ui';
import { useDeskActions } from '@/hooks/useGate';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import type { DeskPass } from '@/lib/api/gate';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';
import { parseScan, validityText } from '@/lib/gate/plate';
import { cn } from '@/lib/cn';
import { QrScanner } from './QrScanner';
import { VerdictBadge } from '@/components/gate/GateUi';

/**
 * Gorevli: misafir QR'ini okut veya kisa kodu yaz -> gecis karti (misafir, ev sahibi bolum,
 * gecerlilik) -> giris / cikis kaydi. Reddedilen gecis (suresi dolmus, kullanilmis, iptal) acikca
 * kirmizi gosterilir.
 */
export function PassDesk() {
  const a = useDeskActions();
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [pass, setPass] = useState<DeskPass>();
  const [done, setDone] = useState<string>();
  const [key, renewKey] = useIdempotencyKey();

  const lookup = useCallback(
    (text: string) => {
      setScanning(false);
      setDone(undefined);
      const parsed = parseScan(text);
      if (!parsed) {
        setPass(undefined);
        setInputError('Kod tanınmadı. 8 karakterlik kısa kodu (örnek: K7M2-PQ4X) yazın.');
        return;
      }
      setInputError(undefined);
      a.verify.mutate(parsed, { onSuccess: (r) => setPass(r.pass), onError: () => setPass(undefined) });
    },
    [a.verify],
  );

  const move = (direction: 'entry' | 'exit') => {
    if (!pass) return;
    const m = direction === 'entry' ? a.passEntry : a.passExit;
    m.mutate(
      { id: pass.passId, key },
      {
        onSuccess: (r) => {
          setPass(r.pass);
          setDone(direction === 'entry' ? `${r.pass.guestName} için giriş kaydedildi.` : `${r.pass.guestName} için çıkış kaydedildi.`);
          renewKey();
        },
      },
    );
  };

  const reset = () => {
    setPass(undefined);
    setDone(undefined);
    setCode('');
    a.verify.reset();
    a.passEntry.reset();
    a.passExit.reset();
  };

  const moveError = a.passEntry.error ?? a.passExit.error;

  return (
    <div className="flex flex-col gap-4">
      {!pass && (
        <Card className="flex flex-col gap-4">
          {scanning ? (
            <QrScanner onResult={lookup} onClose={() => setScanning(false)} />
          ) : (
            <Button className="h-14 text-body" onClick={() => setScanning(true)}>
              <QrCode className="size-5" aria-hidden="true" />
              QR okut
            </Button>
          )}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              lookup(code);
            }}
          >
            <label htmlFor="gate-code" className="text-small font-medium">
              veya kısa kodu yazın
            </label>
            <div className="flex gap-2">
              <Input
                id="gate-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="K7M2-PQ4X"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                maxLength={12}
                invalid={!!inputError}
                aria-describedby={inputError ? 'gate-code-msg' : undefined}
                className="h-14 font-mono text-heading tracking-widest"
              />
              <Button type="submit" className="h-14 px-6 text-body" loading={a.verify.isPending} disabled={!code.trim()}>
                Sorgula
              </Button>
            </div>
            {inputError && (
              <p id="gate-code-msg" className="text-small text-danger">
                {inputError}
              </p>
            )}
          </form>
          {a.verify.error && <Alert tone="danger">{errorMessage(a.verify.error)}</Alert>}
        </Card>
      )}

      {pass && (
        <Card className={cn('flex flex-col gap-4 border-2', pass.verdict === 'valid' || pass.canExit ? 'border-success/50' : 'border-danger/50')} aria-live="polite">
          <div className="flex items-start gap-3">
            {pass.verdict === 'valid' ? <CircleCheck className="size-10 shrink-0 text-success" aria-hidden="true" /> : <CircleX className="size-10 shrink-0 text-danger" aria-hidden="true" />}
            <div className="flex min-w-0 flex-col gap-1">
              <p className={cn('text-heading font-bold', pass.verdict === 'valid' ? 'text-success' : 'text-danger')}>{pass.verdict === 'valid' ? 'Geçiş geçerli' : 'Geçiş reddedildi'}</p>
              {pass.message && <p className="text-body font-medium text-danger">{pass.message}</p>}
            </div>
          </div>
          <dl className="grid grid-cols-1 gap-3 text-body sm:grid-cols-2">
            <div>
              <dt className="text-small text-muted">Misafir</dt>
              <dd className="text-heading font-semibold">{pass.guestName}</dd>
            </div>
            <div>
              <dt className="text-small text-muted">Ev sahibi</dt>
              <dd className="font-semibold">{pass.unitLabel}</dd>
            </div>
            <div>
              <dt className="text-small text-muted">Geçerlilik</dt>
              <dd>{validityText(pass.validFrom, pass.validUntil)}</dd>
            </div>
            <div>
              <dt className="text-small text-muted">Giriş hakkı</dt>
              <dd className="flex items-center gap-2">
                {pass.entryMode === 'single' ? 'Tek giriş' : 'Çoklu giriş'} <VerdictBadge verdict={pass.verdict} />
              </dd>
            </div>
            {pass.plateDisplay && (
              <div>
                <dt className="text-small text-muted">Araç plakası</dt>
                <dd className="font-mono font-semibold">{pass.plateDisplay}</dd>
              </div>
            )}
            {pass.lastEntryAt && (
              <div>
                <dt className="text-small text-muted">Son giriş</dt>
                <dd>{formatDateTime(pass.lastEntryAt)}</dd>
              </div>
            )}
            {pass.note && (
              <div className="sm:col-span-2">
                <dt className="text-small text-muted">Daire sakininin notu</dt>
                <dd>{pass.note}</dd>
              </div>
            )}
          </dl>
          {done && <Alert tone="success">{done}</Alert>}
          {moveError && <Alert tone="danger">{errorMessage(moveError)}</Alert>}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {pass.canEnter && (
              <Button className="h-14 text-body" loading={a.passEntry.isPending} onClick={() => move('entry')}>
                <LogIn className="size-5" aria-hidden="true" />
                Giriş kaydet
              </Button>
            )}
            {pass.canExit && (
              <Button variant={pass.canEnter ? 'secondary' : 'primary'} className="h-14 text-body" loading={a.passExit.isPending} onClick={() => move('exit')}>
                <LogOut className="size-5" aria-hidden="true" />
                Çıkış kaydet
              </Button>
            )}
            <Button variant="secondary" className="h-14 text-body sm:col-span-2" onClick={reset}>
              Yeni geçiş okut
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
