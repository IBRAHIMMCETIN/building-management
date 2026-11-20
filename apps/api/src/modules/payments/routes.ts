import { type Context, Hono } from 'hono';
import type { Authenticator } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { FakePaymentProvider } from './fakeProvider.js';
import { PAYMENT_ADMIN_ROLES, PAYMENT_MANAGER_ROLES, PAYMENT_ROLES, type PaymentsContext, type PaymentsService } from './service.js';

/**
 * Sakin: `/api/portal/payments/*` (JWT + `resident` rolu; apartman yalnizca JWT claim'inden)
 *   GET  /quote?unitId=          odenebilir kalemler, toplam borc ve islemis tazminat
 *   POST /                       odeme niyeti olustur -> saglayici odeme sayfasi (paymentPageUrl)
 *   GET  /:intentId?refresh=1    niyet durumu (refresh: saglayicidan sorgulayip sonuclandir)
 */
export function paymentPortalRoutes({ authenticate, service }: { authenticate: Authenticator; service: PaymentsService }) {
  const r = new Hono<Env>();
  r.onError(handleError);

  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(PAYMENT_ROLES));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const ctx = (c: Context<Env>): PaymentsContext => {
    const { apartmentId, userId, role } = c.get('claims');
    return { apartmentId: apartmentId as string, userId, role };
  };

  r.get('/quote', async (c) => c.json(await service.quote(ctx(c), c.req.query('unitId'))));

  r.post('/', async (c) => {
    const view = await service.createIntent(ctx(c), await readJson(c), { ip: clientIp(c) });
    return c.json(view, 'replayed' in view ? 200 : 201);
  });

  r.get('/:intentId', async (c) =>
    c.json(await service.getIntent(ctx(c), c.req.param('intentId'), { refresh: c.req.query('refresh') === '1' })),
  );

  return r;
}

/** API Gateway gercek istemci adresini X-Forwarded-For'un ilk elemanina yazar. */
function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded && forwarded.length <= 64 ? forwarded : '127.0.0.1';
}

/**
 * Kimliksiz uclar: `/api/payments/*` (API Gateway'de yalnizca bu tam yollar JWT'siz acilir).
 *   POST /:provider/callback?ref=<apartmentId>:<intentId>   saglayici -> tarayici POST (token)
 *   POST /:provider/webhook        saglayici -> sunucu bildirimi (imzali; X-IYZ-SIGNATURE-V3)
 *   GET  /fake/checkout?token=     (yalnizca sahte saglayici) test odeme sayfasi
 *   POST /fake/complete            (yalnizca sahte saglayici) sayfadaki secim
 */
export function paymentCallbackRoutes({ service, fake }: { service: PaymentsService; fake?: FakePaymentProvider }) {
  const r = new Hono();
  r.onError(handleError);

  r.post('/:provider/callback', async (c) => {
    const token = await readToken(c);
    const result = await service.handleCallback(c.req.param('provider'), { ref: c.req.query('ref'), token });
    c.header('Cache-Control', 'no-store');
    return c.redirect(result.redirectUrl, 303);
  });

  r.post('/:provider/webhook', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const { status } = await service.handleWebhook(c.req.param('provider'), { headers, body });
    return c.json(status === 200 ? { ok: true } : { error: status === 401 ? 'invalid_signature' : 'unavailable' }, status);
  });

  if (fake) {
    r.get('/fake/checkout', (c) => {
      const token = c.req.query('token') ?? '';
      const session = fake.sessions.get(token);
      if (!session) return c.html(page('Ödeme oturumu bulunamadı', '<p>Oturum bulunamadı.</p>'), 404);
      const amount = (session.request.amount / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2 });
      const form = (outcome: string, label: string) =>
        `<form method="post" action="/api/payments/fake/complete"><input type="hidden" name="token" value="${esc(token)}">` +
        `<input type="hidden" name="outcome" value="${outcome}"><button type="submit">${label}</button></form>`;
      return c.html(
        page(
          'Sahte ödeme sayfası',
          `<p>Yerel geliştirme için sahte ödeme sağlayıcısı. Gerçek kart bilgisi istenmez.</p>` +
            `<p><strong>Tutar:</strong> ${esc(amount)} TL</p>` +
            form('success', 'Başarılı öde') +
            form('failure', 'Başarısız (kart reddedildi)'),
        ),
      );
    });

    r.post('/fake/complete', async (c) => {
      const body = await c.req.parseBody();
      const token = typeof body.token === 'string' ? body.token : '';
      const outcome = body.outcome === 'success' ? 'success' : 'failure';
      const session = fake.sessions.get(token);
      if (!session) return c.html(page('Ödeme oturumu bulunamadı', '<p>Oturum bulunamadı.</p>'), 404);
      fake.complete(token, outcome);
      // iyzico gibi: tarayici callbackUrl'e token ile POST eder.
      return c.html(
        page(
          'Yönlendiriliyor',
          `<form id="f" method="post" action="${esc(session.request.callbackUrl)}">` +
            `<input type="hidden" name="token" value="${esc(token)}"><noscript><button>Devam</button></noscript></form>` +
            `<script>document.getElementById('f').submit()</script>`,
        ),
      );
    });
  }

  return r;
}

async function readToken(c: Context): Promise<string | undefined> {
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const json = (await c.req.json()) as { token?: unknown };
      return typeof json.token === 'string' ? json.token : undefined;
    }
    const body = await c.req.parseBody();
    return typeof body.token === 'string' ? body.token : undefined;
  } catch {
    return undefined;
  }
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

/**
 * Platform ekibi: `/api/admin/payments/*` (JWT + `platform_admin`; apartman yoldan gelir cunku
 * platform rolunun apartman claim'i yoktur). Her yazim AUDIT logu uretir.
 *   GET   /apartments                        tum apartmanlar + alt uye isyeri durumu
 *   GET   /apartments/:apartmentId/account   alt uye isyeri kaydi
 *   POST  /apartments/:apartmentId/account   saglayicida alt uye isyeri olustur (KYC)
 *   PATCH /apartments/:apartmentId/account   durum (active/disabled) ve platform payi
 *   GET   /review                            inceleme bekleyen / iadesi suren odemeler (tum apartmanlar)
 *   GET   /apartments/:apartmentId/intents/:intentId/check     saglayicidan guncel sonuc + yapilabilecek islemler
 *   POST  /apartments/:apartmentId/intents/:intentId/resolve   { action: approve|refund|close, note, expectedVersion }
 */
export function paymentAdminRoutes({ authenticate, service }: { authenticate: Authenticator; service: PaymentsService }) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(PAYMENT_ADMIN_ROLES));
  r.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  r.get('/apartments', async (c) => c.json(await service.listApartmentAccounts()));
  r.get('/apartments/:apartmentId/account', async (c) => c.json(await service.getAccount(c.req.param('apartmentId'))));
  r.post('/apartments/:apartmentId/account', async (c) =>
    c.json(await service.onboardSubMerchant({ userId: c.get('claims').userId }, c.req.param('apartmentId'), await readJson(c)), 201),
  );
  r.patch('/apartments/:apartmentId/account', async (c) =>
    c.json(await service.updateAccount({ userId: c.get('claims').userId }, c.req.param('apartmentId'), await readJson(c))),
  );
  r.get('/review', async (c) => c.json(await service.listReviewQueue()));
  r.get('/apartments/:apartmentId/intents/:intentId/check', async (c) =>
    c.json(await service.checkReview(c.req.param('apartmentId'), c.req.param('intentId'))),
  );
  r.post('/apartments/:apartmentId/intents/:intentId/resolve', async (c) =>
    c.json(
      await service.resolveReview(
        { userId: c.get('claims').userId },
        c.req.param('apartmentId'),
        c.req.param('intentId'),
        await readJson(c),
        { ip: clientIp(c) },
      ),
    ),
  );
  return r;
}

/**
 * Yonetici (salt okunur): `/api/finance/online-payments/*` (JWT; apartman YALNIZCA claim'den).
 *   GET /?status=&limit=&cursor=   apartmanin odeme niyetleri, en yeni once
 *   GET /account                   online odeme durumu (alt uye anahtari gosterilmez)
 */
export function paymentManagerRoutes({ authenticate, service }: { authenticate: Authenticator; service: PaymentsService }) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(PAYMENT_MANAGER_ROLES));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });
  const apt = (c: Context<Env>) => c.get('claims').apartmentId as string;

  r.get('/', async (c) =>
    c.json(
      await service.listIntentsForManager(apt(c), {
        status: c.req.query('status'),
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
      }),
    ),
  );
  r.get('/account', async (c) => c.json(await service.accountSummary(apt(c))));
  return r;
}
