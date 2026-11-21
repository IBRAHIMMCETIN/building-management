import { describe, expect, it } from 'vitest';
import { canonicalJson, computeHash, verifyPage } from './chain';
import { AUDIT_FIXTURE } from './fixture';

describe('denetim zinciri (tarayici)', () => {
  it('kanonik JSON API ile ayni: sirali anahtar, undefined atilir', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 'ş'] } })).toBe('{"a":{"c":[2,"ş"]},"b":1}');
  });

  it('API\'nin urettigi kayitlarin hash\'i tarayicida birebir yeniden hesaplanir; zincir bagi dogrulanir', async () => {
    expect(await computeHash(AUDIT_FIXTURE[1]!)).toBe(AUDIT_FIXTURE[1]!.hash);
    const check = await verifyPage(AUDIT_FIXTURE);
    expect(check).toMatchObject({ ok: true, checked: 2, failures: 0 });
    expect(check.bySeq.get(1)).toEqual({ hashOk: true, linkOk: true });
    expect(check.bySeq.get(2)).toEqual({ hashOk: true, linkOk: true });
  });

  it('icerik degisikligi ve kopuk bag yakalanir; onceki kayit sayfada yoksa bag bilinmez', async () => {
    const tampered = structuredClone(AUDIT_FIXTURE);
    (tampered[1]!.details as Record<string, unknown>).total = 999;
    const t = await verifyPage(tampered);
    expect(t.ok).toBe(false);
    expect(t.bySeq.get(1)).toEqual({ hashOk: false, linkOk: true });

    const relinked = structuredClone(AUDIT_FIXTURE);
    relinked[0]!.prevHash = 'f'.repeat(64);
    relinked[0]!.hash = await computeHash(relinked[0]!);
    expect((await verifyPage(relinked)).bySeq.get(2)).toEqual({ hashOk: true, linkOk: false });

    expect((await verifyPage([AUDIT_FIXTURE[0]!])).bySeq.get(2)).toEqual({ hashOk: true });
  });
});
