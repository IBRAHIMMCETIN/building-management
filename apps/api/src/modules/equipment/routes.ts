import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { EquipmentContext, EquipmentService } from './service.js';

/** Bakim ekraniyla ayni: yonetim yazar; denetci ve bina gorevlisi okur. */
const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'building_staff', 'observer'];
const MANAGE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type EquipmentRoutesDeps = { authenticate: Authenticator; service: EquipmentService };

/**
 * `/api/equipment` - Ariza & bakim v2 ekipman sicili.
 *
 *   GET   /                              ?q=&category=&status=active|out_of_service|retired|all&blockId=&warrantyWithin=N&expiring=true&ids=a,b&cursor=&limit=
 *   GET   /expiring                      ?days=30   garanti / servis sozlesmesi / periyodik kontrol hatirlatmalari
 *   POST  /                              { name, category, blockId?, location?, brand?, model?, serialNumber?, installDate?, warrantyEndDate?,
 *                                          serviceCompany?{ supplierAccountId?, name?, phone?, email? }, serviceContractEndDate?,
 *                                          lastInspectionDate?, nextInspectionDate?, inspectionLabel?, notes? }
 *   GET   /:id                           ekipman + belgeler + hatirlatmalar
 *   PUT   /:id                           { version, ...kismi }   (null alani temizler)
 *   POST  /:id/status                    { version, status, note? } -> { equipment, linkedTemplates, warning? }   (silme yok; `retired` gerekceli)
 *   GET   /:id/history                   ?years=5 (1-10)  bagli talepler, bakim gorevleri ve (yonetim / denetci) yil bazinda masraflar
 *   POST  /documents/upload-url          { fileName, contentType, size } -> { uploadId, uploadUrl, headers, ... }
 *   POST  /:id/documents                 { version, uploadId, fileName, kind, title?, validUntil? }
 *   POST  /:id/documents/:docId/archive  { version }
 *   GET   /:id/documents/:docId          imzali goruntuleme linki (5 dk)
 */
export function equipmentRoutes({ authenticate, service }: EquipmentRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
    // Imzali linkler ve ticari bilgiler onbelleklenmez.
    c.header('Cache-Control', 'no-store');
  });
  const ctx = (c: Context<Env>): EquipmentContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId, role: claims.role };
  };
  const id = (c: Context<Env>) => c.req.param('id') ?? '';
  const docId = (c: Context<Env>) => c.req.param('docId') ?? '';

  r.get('/', requireRole(READ_ROLES), async (c) => c.json(await service.list(ctx(c), c.req.query())));
  r.get('/expiring', requireRole(READ_ROLES), async (c) => c.json(await service.expiring(ctx(c), { days: c.req.query('days') })));
  r.post('/', requireRole(MANAGE_ROLES), async (c) => c.json(await service.create(ctx(c), await readJson(c)), 201));
  r.post('/documents/upload-url', requireRole(MANAGE_ROLES), async (c) => c.json(await service.documentUploadUrl(ctx(c), await readJson(c))));
  r.get('/:id', requireRole(READ_ROLES), async (c) => c.json(await service.get(ctx(c), id(c))));
  r.put('/:id', requireRole(MANAGE_ROLES), async (c) => c.json(await service.update(ctx(c), id(c), await readJson(c))));
  r.post('/:id/status', requireRole(MANAGE_ROLES), async (c) => c.json(await service.setStatus(ctx(c), id(c), await readJson(c))));
  r.get('/:id/history', requireRole(READ_ROLES), async (c) => c.json(await service.history(ctx(c), id(c), { years: c.req.query('years') })));
  r.post('/:id/documents', requireRole(MANAGE_ROLES), async (c) => c.json(await service.addDocument(ctx(c), id(c), await readJson(c)), 201));
  r.post('/:id/documents/:docId/archive', requireRole(MANAGE_ROLES), async (c) => c.json(await service.archiveDocument(ctx(c), id(c), docId(c), await readJson(c))));
  r.get('/:id/documents/:docId', requireRole(READ_ROLES), async (c) => c.json(await service.documentUrl(ctx(c), id(c), docId(c))));

  return r;
}
