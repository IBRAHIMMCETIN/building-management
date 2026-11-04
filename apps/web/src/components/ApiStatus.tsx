import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHealth, type Health } from '../api/health';
import styles from './ApiStatus.module.css';

type State = { kind: 'loading' } | { kind: 'ok'; health: Health } | { kind: 'error' };

const shortVersion = (version: string) =>
  /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;

export function ApiStatus() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const requestRef = useRef<AbortController | null>(null);

  // Her kontrol bir oncekini iptal eder; bilesen kapaninca acik istek de iptal edilir.
  const check = useCallback(() => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;

    setState({ kind: 'loading' });
    fetchHealth(request.signal)
      .then((health) => {
        if (!request.signal.aborted) setState({ kind: 'ok', health });
      })
      .catch(() => {
        if (!request.signal.aborted) setState({ kind: 'error' });
      });
  }, []);

  useEffect(() => {
    check();
    return () => requestRef.current?.abort();
  }, [check]);

  return (
    <div className={styles.status}>
      <p role="status" className={styles.line}>
        <span className={styles.dot} data-state={state.kind} aria-hidden="true" />
        <span>
          {state.kind === 'loading' && 'API durumu kontrol ediliyor…'}
          {state.kind === 'ok' && (
            <>
              API durumu: çalışıyor · sürüm <code>{shortVersion(state.health.version)}</code>
            </>
          )}
          {state.kind === 'error' && 'API durumu: ulaşılamıyor'}
        </span>
      </p>
      {state.kind === 'error' && (
        <button type="button" className={styles.retry} onClick={check}>
          Tekrar dene
        </button>
      )}
    </div>
  );
}
