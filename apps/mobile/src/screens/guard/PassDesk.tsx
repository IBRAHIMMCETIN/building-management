import { errorMessage } from '@bm/shared/api/errors';
import { type DeskPass, rateLimitSeconds } from '@bm/shared/api/gate';
import { formatDateTime } from '@bm/shared/dates';
import { UNKNOWN_CODE_MESSAGE, parseScan, validityText } from '@bm/shared/gate/plate';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { CircleCheck, CircleX, LogIn, LogOut, QrCode } from '@/components/icons';
import { Alert, AppText, Button, Card, TextField } from '@/components/ui';
import { useDeskActions } from '@/hooks/useGate';
import { useIdempotencyKey } from '@/lib/idempotency';
import { space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { RateLimitNotice, VerdictBadge, useCountdown } from './GateUi';
import { QrScanner } from './QrScanner';

/**
 * Misafir gecisi (web: pages/admin/gate/PassDesk.tsx): QR okut veya kisa kodu yaz -> gecis karti
 * (misafir, ev sahibi bolum, gecerlilik, karar) -> giris / cikis kaydi. Reddedilen gecis kirmizi.
 * Deneme siniri (429) asilinca okutma ve sorgu sure dolana kadar kapali, geri sayim gosterilir.
 */
export function PassDesk({ active = true, wide = false }: { active?: boolean; wide?: boolean }) {
  const a = useDeskActions();
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [pass, setPass] = useState<DeskPass>();
  const [done, setDone] = useState<string>();
  const [key, renewKey] = useIdempotencyKey();
  const [lock, setLock] = useState<{ until: number; message: string } | null>(null);
  const remaining = useCountdown(lock?.until ?? null);
  const locked = remaining > 0;

  const lookup = (text: string) => {
    setScanning(false);
    setDone(undefined);
    const parsed = parseScan(text);
    if (!parsed) {
      setPass(undefined);
      setInputError(UNKNOWN_CODE_MESSAGE);
      return;
    }
    setInputError(undefined);
    a.verify.mutate(parsed, {
      onSuccess: (r) => setPass(r.pass),
      onError: (err) => {
        setPass(undefined);
        const wait = rateLimitSeconds(err);
        if (wait) setLock({ until: Date.now() + wait * 1000, message: errorMessage(err) });
      },
    });
  };

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
    // Yanit kaybolsa bile sonraki misafir ayni anahtari kullanmaz.
    renewKey();
    a.verify.reset();
    a.passEntry.reset();
    a.passExit.reset();
  };

  if (pass) return <PassCard pass={pass} done={done} onMove={move} onReset={reset} entering={a.passEntry.isPending} exiting={a.passExit.isPending} moveError={a.passEntry.error ?? a.passExit.error} wide={wide} />;

  const verifyError = a.verify.error && !rateLimitSeconds(a.verify.error) ? errorMessage(a.verify.error) : null;

  return (
    <Card>
      <View style={wide ? styles.columns : styles.gap4}>
        <View style={wide ? styles.column : undefined}>
          {scanning && active && !locked ? (
            <QrScanner onResult={lookup} onClose={() => setScanning(false)} />
          ) : (
            <Button size="large" block icon={QrCode} label="QR okut" disabled={locked} onPress={() => setScanning(true)} />
          )}
        </View>
        <View style={[styles.gap2, wide && styles.column]}>
          <TextField
            label="veya kısa kodu yazın"
            value={code}
            onChangeText={(t) => {
              setCode(t.toUpperCase());
              setInputError(undefined);
            }}
            code
            placeholder="K7M2-PQ4X"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect={false}
            maxLength={12}
            error={inputError}
            returnKeyType="search"
            onSubmitEditing={() => {
              if (code.trim() && !locked) lookup(code);
            }}
          />
          <Button size="large" block label="Sorgula" loading={a.verify.isPending} disabled={!code.trim() || locked} onPress={() => lookup(code)} />
        </View>
      </View>
      {lock && <RateLimitNotice message={lock.message} seconds={remaining} />}
      {verifyError && <Alert tone="danger">{verifyError}</Alert>}
    </Card>
  );
}

function Field({ label, value, large, mono }: { label: string; value: string; large?: boolean; mono?: boolean }) {
  return (
    <View style={styles.field} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="small" tone="muted">
        {label}
      </AppText>
      <AppText variant={large ? 'heading' : 'body'} weight="semibold" style={mono ? styles.mono : undefined}>
        {value}
      </AppText>
    </View>
  );
}

function PassCard({
  pass,
  done,
  onMove,
  onReset,
  entering,
  exiting,
  moveError,
  wide,
}: {
  pass: DeskPass;
  done?: string;
  onMove: (d: 'entry' | 'exit') => void;
  onReset: () => void;
  entering: boolean;
  exiting: boolean;
  moveError: unknown;
  wide: boolean;
}) {
  const { colors } = useTheme();
  const valid = pass.verdict === 'valid';
  const ok = valid || pass.canExit;
  const tone = ok ? colors.success : colors.danger;
  const Icon = valid ? CircleCheck : CircleX;

  return (
    <Card style={{ borderWidth: 2, borderColor: withAlpha(tone, 0.5) }}>
      <View style={styles.verdict} accessibilityRole="alert" accessibilityLiveRegion="polite">
        <Icon size={40} color={valid ? colors.success : colors.danger} aria-hidden />
        <View style={styles.flex}>
          <AppText variant="heading" weight="bold" tone={valid ? 'success' : 'danger'} accessibilityRole="header">
            {valid ? 'Geçiş geçerli' : 'Geçiş reddedildi'}
          </AppText>
          {pass.message && (
            <AppText weight="medium" tone="danger">
              {pass.message}
            </AppText>
          )}
        </View>
      </View>
      <View style={[styles.grid, wide && styles.gridWide]}>
        <View style={[styles.cell, wide && styles.cellWide]}>
          <Field label="Misafir" value={pass.guestName} large />
        </View>
        <View style={[styles.cell, wide && styles.cellWide]}>
          <Field label="Ev sahibi" value={pass.unitLabel} />
        </View>
        <View style={[styles.cell, wide && styles.cellWide]}>
          <Field label="Geçerlilik" value={validityText(pass.validFrom, pass.validUntil)} />
        </View>
        <View style={[styles.cell, wide && styles.cellWide, styles.gap1]}>
          <Field label="Giriş hakkı" value={pass.entryMode === 'single' ? 'Tek giriş' : 'Çoklu giriş'} />
          <VerdictBadge verdict={pass.verdict} />
        </View>
        {pass.plateDisplay && (
          <View style={[styles.cell, wide && styles.cellWide]}>
            <Field label="Araç plakası" value={pass.plateDisplay} mono />
          </View>
        )}
        {pass.lastEntryAt && (
          <View style={[styles.cell, wide && styles.cellWide]}>
            <Field label="Son giriş" value={formatDateTime(pass.lastEntryAt)} />
          </View>
        )}
        {pass.note && (
          <View style={styles.cell}>
            <Field label="Daire sakininin notu" value={pass.note} />
          </View>
        )}
      </View>
      {done && <Alert tone="success">{done}</Alert>}
      {!!moveError && <Alert tone="danger">{errorMessage(moveError)}</Alert>}
      <View style={[styles.gap2, wide && styles.actionsWide]}>
        {pass.canEnter && (
          <View style={wide ? styles.flex : undefined}>
            <Button size="large" block icon={LogIn} label="Giriş kaydet" loading={entering} onPress={() => onMove('entry')} />
          </View>
        )}
        {pass.canExit && (
          <View style={wide ? styles.flex : undefined}>
            <Button size="large" block variant={pass.canEnter ? 'secondary' : 'primary'} icon={LogOut} label="Çıkış kaydet" loading={exiting} onPress={() => onMove('exit')} />
          </View>
        )}
      </View>
      <Button size="large" block variant="secondary" icon={QrCode} label="Yeni geçiş okut" onPress={onReset} />
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap1: { gap: space(1) },
  gap2: { gap: space(2) },
  gap4: { gap: space(4) },
  columns: { flexDirection: 'row', gap: space(4), alignItems: 'flex-start' },
  column: { flex: 1 },
  verdict: { flexDirection: 'row', alignItems: 'flex-start', gap: space(3) },
  grid: { gap: space(3) },
  gridWide: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {},
  cellWide: { flexBasis: '47%', flexGrow: 1 },
  field: { gap: 2 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  actionsWide: { flexDirection: 'row' },
});
