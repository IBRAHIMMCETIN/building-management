import { portalAssemblySchema } from '@bm/shared/api/assemblies';
import { consumptionSchema } from '@bm/shared/api/meters';
import { portalPollSchema } from '@bm/shared/api/polls';
import { tenderResponseSchema, tenderSummarySchema, tenderWriteSchema } from '@bm/shared/api/tenders';
import { issueMockToken } from '@bm/shared/auth/mockScenarios';
import { z } from 'zod';
import { createDemoFetch } from './demoApi';

/*
 * Web onizlemesi (npm run web:demo) demo verisiyle calisir: oylama, genel kurul, tuketim ve ihale
 * yanitlari API sozlesmesine (ortak zod semalari) uyar; oy ve soru demo oturumunda hatirlanir.
 */

const now = () => new Date('2026-11-28T09:00:00.000Z');
const auth = { authorization: `Bearer ${issueMockToken('resident@dev.local')}` };

async function call(fetchImpl: typeof fetch, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetchImpl(path, { method: init.method ?? 'GET', headers: auth, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return { status: res.status, body: JSON.parse((await res.text()) || 'null') as unknown };
}

describe('demo verisi (M2b alanlari)', () => {
  it('oylamalar: liste ve ayrinti semaya uyar; oy hatirlanir; bitmis oylamaya oy 409', async () => {
    const demo = createDemoFetch({ now });
    const list = z.object({ unitId: z.string(), items: z.array(portalPollSchema) }).parse((await call(demo, '/api/portal/polls')).body);
    expect(list.items.map((p) => p.phase)).toEqual(['open', 'open', 'closed']);

    const voted = await call(demo, '/api/portal/polls/p-2/vote', { method: 'POST', body: { optionId: 'o-2b' } });
    const poll = portalPollSchema.parse(voted.body);
    expect(poll.myVote).toMatchObject({ castByMe: true, optionId: 'o-2b' });
    // Ara sonuc acik oylama: oy verince sonuc gorunur.
    expect(poll.results?.options?.find((o) => o.optionId === 'o-2b')?.units).toBe(7);

    expect(await call(demo, '/api/portal/polls/p-3/vote', { method: 'POST', body: { optionId: 'o-3a' } })).toMatchObject({ status: 409, body: { error: 'poll_closed' } });
  });

  it('genel kurul, tuketim ve ihaleler semaya uyar; soru eklenir, ayni anahtar tekrar etmez', async () => {
    const demo = createDemoFetch({ now });
    const assemblies = z.object({ items: z.array(portalAssemblySchema) }).parse((await call(demo, '/api/portal/assemblies')).body);
    expect(assemblies.items.map((a) => a.phase)).toEqual(['upcoming', 'held']);
    expect(portalAssemblySchema.parse((await call(demo, '/api/portal/assemblies/as-1')).body).minutesAvailable).toBe(true);

    const consumption = consumptionSchema.parse((await call(demo, '/api/portal/meters/consumption?unitId=u-demo-7')).body);
    expect(new Set(consumption.periods.map((p) => p.category))).toEqual(new Set(['heating', 'hot_water']));

    const tenders = z.object({ items: z.array(tenderSummarySchema) }).parse((await call(demo, '/api/portal/tenders')).body);
    expect(tenders.items.map((t) => t.status)).toEqual(['published', 'decided']);
    const t1 = tenderResponseSchema.parse((await call(demo, '/api/portal/tenders/t-1')).body).tender;
    expect(t1.comparison.rows.map((r) => r.rank)).toEqual([1, 2, 3]);

    const ask = { idempotencyKey: '00000000-0000-4000-8000-000000000001', body: 'Demo sorusu' };
    tenderWriteSchema.parse((await call(demo, '/api/portal/tenders/t-1/comments', { method: 'POST', body: ask })).body);
    const again = tenderWriteSchema.parse((await call(demo, '/api/portal/tenders/t-1/comments', { method: 'POST', body: ask })).body);
    expect(again.replayed).toBe(true);
    expect(again.tender.comments.filter((c) => c.body === 'Demo sorusu')).toHaveLength(1);
  });
});
