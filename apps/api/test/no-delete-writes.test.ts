/**
 * Proje kurali: API, zamanlayici ve worker Lambda'larinin `dynamodb:DeleteItem` yetkisi yoktur
 * (infra/api.tf, infra/scheduler.tf). Kaynak kodda silme yazimi (TransactWriteItems `Delete`,
 * `DeleteCommand`, `BatchWriteCommand` DeleteRequest) bulunursa AWS'te AccessDenied ile patlar;
 * bu test onu derleme asamasinda yakalar. Silme yerine durum alani kullanilir (iptal, discarded...).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('silme yazimi yok', () => {
  it('src altinda DynamoDB silme komutu kullanilmaz', () => {
    const offenders = files(join(__dirname, '..', 'src')).filter((f) => /\bDelete:\s*\{|DeleteCommand|DeleteRequest/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
