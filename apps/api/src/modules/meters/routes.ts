import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Authenticator } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, publicView, readJson, requireRole } from '../../http/helpers.js';
import { MANAGE_ROLES, type MeterContext, READING_READ_ROLES, READING_WRITE_ROLES, READ_ROLES } from './common.js';
import type { MeterPortalService } from './portalView.js';
import type { MeterPostingService } from './posting.js';
import type { MeterReadingService } from './readings.js';
import type { MeterReversalService } from './reversal.js';
import type { MeterService } from './service.js';

const apartmentScoped = (): MiddlewareHandler<Env> => async (c, next) => {
  if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
  await next();
  c.header('Cache-Control', 'no-store');
};

const ctxOf = (c: Context<Env>): MeterContext => {
  const { apartmentId, userId, role } = c.get('claims');
  return { apartmentId: apartmentId as string, userId, role };
};

const strip = <T extends object>(items: T[]) => items.map((i) => publicView(i));

export type MeterRoutesDeps = {
  authenticate: Authenticator;
  service: MeterService;
  posting?: MeterPostingService;
  reversal?: MeterReversalService;
  portal?: MeterPortalService;
};

/**
 * `/api/metering` - Finans 2.3 sayac yonetimi (yazma: yonetici; okuma: + denetci).
 *
 *   GET    /meters                         ?unitId=&status=active|replaced|retired|cancelled|all&kind=
 *   POST   /meters                         { unitId, kind, label, serialNo?, scale?, factor?, maxIndex?, openingIndex, installedAt }
 *   GET    /meters/:meterId                sayac + olay gecmisi
 *   PATCH  /meters/:meterId                { version, label?, serialNo?, scale?, factor?, maxIndex? }
 *   POST   /meters/:meterId/retire         { retiredAt, closingIndex, reason, photoKey? }
 *   POST   /meters/:meterId/photo-upload   { date, contentType, size } -> degisim / emeklilik kaniti
 *   POST   /swaps/preview                  { meterId, kind, swapDate, oldClosingIndex, newOpeningIndex, reason, ... }
 *   POST   /swaps                          { idempotencyKey, ...preview }
 *   GET    /swaps                          ?unitId=&meterId=
 *   GET    /swaps/:swapId
 *   GET    /swaps/:swapId/photo
 *   POST   /swaps/:swapId/reverse          { reason }
 *   GET    /templates                      ?includeArchived=true
 *   GET    /templates/presets
 *   GET    /expenses                       ?from=YYYY-MM-DD  fatura secicisi (aktif EXPDIST kilidiyle)
 *   POST   /templates                      { preset? | name, meterKind, category, commonShareBps, commonKey, ... }
 *   GET    /templates/:templateId
 *   PUT    /templates/:templateId          { version, ... }
 *   POST   /templates/:templateId/default
 *   POST   /templates/:templateId/archive  { version }
 *   GET    /periods                        ?status=open|all|draft|...&meterKind=
 *   POST   /periods                        { templateId, name, startDate, endDate, dueDate, totalAmount? }
 *   GET    /periods/:periodId
 *   PATCH  /periods/:periodId              { version, name?, startDate?, endDate?, dueDate?, totalAmount?, refreshTemplate? }
 *   POST   /periods/:periodId/cancel       { version, reason }
 *   POST   /periods/:periodId/calculate    onizleme: dagitim cetveli, borclular, calcHash
 *   POST   /periods/:periodId/approve      { calcHash } -> toplu tahakkuk (yarida kalan onay ayni komutla tamamlanir)
 *   GET    /periods/:periodId/lines        dondurulmus dagitim satirlari
 *   GET    /periods/:periodId/reverse/preview   kalemler, engeller (plan / mahsup / kapama / daha yeni donem), tazminat uyarisi
 *   POST   /periods/:periodId/reverse      { idempotencyKey, reason, notify? } -> toplu ters kayit (ayni anahtarla devam)
 *   POST   /periods/:periodId/correction   { name? } -> geri alinan donemden duzeltilmis taslak (okumalar kopyalanir)
 *   GET    /periods/:periodId/lines/:unitId/statement   daire Sayac Dagitim Dokumu PDF (imzali link)
 */
export function meterRoutes({ authenticate, service, posting, reversal, portal }: MeterRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', apartmentScoped());
  const read = requireRole(READ_ROLES);
  const manage = requireRole(MANAGE_ROLES);
  const p = (c: Context<Env>, name: string) => c.req.param(name) ?? '';

  // Sayac sicili
  r.get('/meters', read, async (c) =>
    c.json({ items: strip(await service.listMeters(ctxOf(c), { unitId: c.req.query('unitId'), status: c.req.query('status'), kind: c.req.query('kind') })) }),
  );
  r.post('/meters', manage, async (c) => c.json(publicView(await service.createMeter(ctxOf(c), await readJson(c))), 201));
  r.get('/meters/:meterId', read, async (c) => {
    const { meter, events } = await service.getMeter(ctxOf(c), p(c, 'meterId'));
    return c.json({ meter: publicView(meter), events: strip(events) });
  });
  r.patch('/meters/:meterId', manage, async (c) => c.json(publicView(await service.updateMeter(ctxOf(c), p(c, 'meterId'), await readJson(c)))));
  r.post('/meters/:meterId/retire', manage, async (c) => c.json(publicView(await service.retireMeter(ctxOf(c), p(c, 'meterId'), await readJson(c)))));
  r.post('/meters/:meterId/photo-upload', manage, async (c) => c.json(await service.createMeterPhotoUpload(ctxOf(c), p(c, 'meterId'), await readJson(c)), 201));

  // Sayac degisimi / sifirlama
  r.post('/swaps/preview', manage, async (c) => {
    const out = await service.previewSwap(ctxOf(c), await readJson(c));
    return c.json({ ...out, oldMeter: publicView(out.oldMeter) });
  });
  r.post('/swaps', manage, async (c) => {
    const out = await service.createSwap(ctxOf(c), await readJson(c));
    return c.json(
      {
        replayed: out.replayed,
        swap: publicView(out.swap),
        ...('oldMeter' in out && out.oldMeter ? { oldMeter: publicView(out.oldMeter), newMeter: publicView(out.newMeter) } : {}),
      },
      out.replayed ? 200 : 201,
    );
  });
  r.get('/swaps', read, async (c) => c.json({ items: strip(await service.listSwaps(ctxOf(c), { unitId: c.req.query('unitId'), meterId: c.req.query('meterId') })) }));
  r.get('/swaps/:swapId', read, async (c) => c.json(publicView(await service.getSwap(ctxOf(c), p(c, 'swapId')))));
  r.get('/swaps/:swapId/photo', read, async (c) => c.json(await service.swapPhoto(ctxOf(c), p(c, 'swapId'))));
  r.post('/swaps/:swapId/reverse', manage, async (c) => {
    const out = await service.reverseSwap(ctxOf(c), p(c, 'swapId'), await readJson(c));
    return c.json({ swap: publicView(out.swap), oldMeter: publicView(out.oldMeter), newMeter: publicView(out.newMeter) });
  });

  // Dagitim sablonlari
  r.get('/templates', read, async (c) => c.json({ items: strip(await service.listTemplates(ctxOf(c), { includeArchived: c.req.query('includeArchived') === 'true' })) }));
  r.get('/templates/presets', read, async (c) => c.json({ items: await service.templatePresets(ctxOf(c)) }));
  r.post('/templates', manage, async (c) => c.json(publicView(await service.createTemplate(ctxOf(c), await readJson(c))), 201));
  r.get('/templates/:templateId', read, async (c) => c.json(publicView(await service.getTemplate(ctxOf(c), p(c, 'templateId')))));
  r.put('/templates/:templateId', manage, async (c) => c.json(publicView(await service.updateTemplate(ctxOf(c), p(c, 'templateId'), await readJson(c)))));
  r.post('/templates/:templateId/default', manage, async (c) => c.json(publicView(await service.setDefaultTemplate(ctxOf(c), p(c, 'templateId')))));
  r.post('/templates/:templateId/archive', manage, async (c) =>
    c.json(publicView(await service.archiveTemplate(ctxOf(c), p(c, 'templateId'), await readJson(c)))),
  );

  // Dagitim donemleri (taslak)
  r.get('/expenses', manage, async (c) => c.json({ items: await service.listExpenseOptions(ctxOf(c), { from: c.req.query('from') }) }));
  r.get('/periods', read, async (c) => c.json({ items: strip(await service.listPeriods(ctxOf(c), { status: c.req.query('status'), meterKind: c.req.query('meterKind') })) }));
  r.post('/periods', manage, async (c) => c.json(publicView(await service.createPeriod(ctxOf(c), await readJson(c))), 201));
  r.get('/periods/:periodId', read, async (c) => c.json(publicView(await service.getPeriod(ctxOf(c), p(c, 'periodId')))));
  r.patch('/periods/:periodId', manage, async (c) => c.json(publicView(await service.updatePeriod(ctxOf(c), p(c, 'periodId'), await readJson(c)))));
  r.post('/periods/:periodId/cancel', manage, async (c) => c.json(publicView(await service.cancelPeriod(ctxOf(c), p(c, 'periodId'), await readJson(c)))));

  // Hesap, onay ve toplu tahakkuk (2.3-3)
  if (posting) {
    r.post('/periods/:periodId/calculate', manage, async (c) => {
      const out = await posting.calculate(ctxOf(c), p(c, 'periodId'));
      return c.json({ ...out, period: publicView(out.period) });
    });
    r.post('/periods/:periodId/approve', manage, async (c) => {
      const out = await posting.approve(ctxOf(c), p(c, 'periodId'), await readJson(c));
      return c.json({ ...out, period: publicView(out.period) });
    });
    r.get('/periods/:periodId/lines', read, async (c) => {
      const out = await posting.listLines(ctxOf(c), p(c, 'periodId'));
      return c.json({ period: publicView(out.period), lines: strip(out.lines), total: out.total });
    });
  }

  // Daire dokumu (2.3-5a)
  if (portal) {
    r.get('/periods/:periodId/lines/:unitId/statement', read, async (c) => c.json(await portal.unitStatement(ctxOf(c), p(c, 'periodId'), p(c, 'unitId'))));
  }

  // Geri alma ve duzeltilmis donem (2.3-4)
  if (reversal) {
    r.get('/periods/:periodId/reverse/preview', read, async (c) => {
      const out = await reversal.preview(ctxOf(c), p(c, 'periodId'));
      return c.json({ ...out, period: publicView(out.period) });
    });
    r.post('/periods/:periodId/reverse', manage, async (c) => {
      const out = await reversal.reverse(ctxOf(c), p(c, 'periodId'), await readJson(c));
      return c.json({ ...out, period: publicView(out.period) });
    });
    r.post('/periods/:periodId/correction', manage, async (c) => {
      const out = await reversal.createCorrection(ctxOf(c), p(c, 'periodId'), await readJson(c));
      return c.json({ ...out, period: publicView(out.period) }, out.replayed ? 200 : 201);
    });
  }

  return r;
}

export type MeterReadingRoutesDeps = { authenticate: Authenticator; service: MeterReadingService };

/**
 * `/api/meter-readings` - donem okumalari. Yonetici + bina gorevlisi yazar; denetci okur.
 * Tahmini okuma onayi (`acceptEstimate`) ve tur atma (`rolloverConfirmed`) yalnizca yonetici.
 *
 *   GET  /periods                                          okumaya acik donemler
 *   GET  /periods/:periodId                                okuma cetveli (baslangic, okuma, fark, uyarilar, tahmin)
 *   PUT  /periods/:periodId                                { items: [{ meterId, endIndex? | acceptEstimate?, rolloverConfirmed?, note?, photoKey? }] }
 *   POST /periods/:periodId/import                         { rows: [{ row, meter, index, note? }], dryRun? }
 *   POST /periods/:periodId/meters/:meterId/photo-upload   { contentType, size }
 *   GET  /periods/:periodId/meters/:meterId/photo
 */
export function meterReadingRoutes({ authenticate, service }: MeterReadingRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', apartmentScoped());
  const read = requireRole(READING_READ_ROLES);
  const write = requireRole(READING_WRITE_ROLES);
  const p = (c: Context<Env>, name: string) => c.req.param(name) ?? '';

  r.get('/periods', read, async (c) => c.json({ items: await service.listOpenPeriods(ctxOf(c)) }));
  r.get('/periods/:periodId', read, async (c) => {
    const out = await service.getSheet(ctxOf(c), p(c, 'periodId'));
    return c.json({ ...out, period: publicView(out.period) });
  });
  r.put('/periods/:periodId', write, async (c) => {
    const out = await service.saveReadings(ctxOf(c), p(c, 'periodId'), await readJson(c));
    return c.json({ ...out, period: publicView(out.period) });
  });
  r.post('/periods/:periodId/import', write, async (c) => {
    const out = await service.importReadings(ctxOf(c), p(c, 'periodId'), await readJson(c));
    return c.json('period' in out && out.period ? { ...out, period: publicView(out.period) } : out);
  });
  r.post('/periods/:periodId/meters/:meterId/photo-upload', write, async (c) =>
    c.json(await service.createPhotoUpload(ctxOf(c), p(c, 'periodId'), p(c, 'meterId'), await readJson(c)), 201),
  );
  r.get('/periods/:periodId/meters/:meterId/photo', read, async (c) => c.json(await service.getPhoto(ctxOf(c), p(c, 'periodId'), p(c, 'meterId'))));

  return r;
}

export type MeterPortalRoutesDeps = { authenticate: Authenticator; service: MeterPortalService };

/**
 * `/api/portal/meters` - sakinin kendi dairesinin sayac tuketimi (2.3-5a).
 *
 *   GET /consumption?unitId=                 gecmis donemler, bina / blok ortalamasi, onceki doneme gore degisim
 *   GET /statement/:periodId?unitId=         Sayac Dagitim Dokumu PDF (kisa omurlu imzali link)
 */
export function meterPortalRoutes({ authenticate, service }: MeterPortalRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', apartmentScoped());
  const resident = requireRole(['resident']);
  r.get('/consumption', resident, async (c) => c.json(await service.myConsumption(ctxOf(c), c.req.query('unitId') ?? '')));
  r.get('/statement/:periodId', resident, async (c) =>
    c.json(await service.myStatement(ctxOf(c), c.req.query('unitId') ?? '', c.req.param('periodId') ?? '')),
  );
  return r;
}
