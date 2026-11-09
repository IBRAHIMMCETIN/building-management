import { handle } from '@hono/aws-lambda';
import { createApp } from './app.js';
import { createAuthFromEnv } from './auth/authenticators.js';
import { createEventPublisherFromEnv } from './events/publisher.js';

/**
 * AWS Lambda giris noktasi (API Gateway HTTP API, payload v2.0).
 *
 * Ayni Hono uygulamasi EC2'daki Node sunucusuyla birebir calisir; yalnizca tasima farklidir.
 * Ortam (Terraform `infra/api.tf`):
 *  - AUTH_MODE=apigw  -> JWT'yi API Gateway Cognito authorizer'i dogrular, claim'ler
 *                         `requestContext.authorizer.jwt.claims` uzerinden okunur.
 *  - EVENTS_MODE=sns  -> EVENTS_SNS_TOPIC_ARN'a yayin.
 *  - DYNAMODB_TABLE_NAME, APP_VERSION.
 * Yanlis yapilandirma soguk baslangicta (init) hata verir; sessizce calismaz.
 * Statik React dosyalari burada sunulmaz (Cloudflare Pages).
 */
const auth = createAuthFromEnv();
const app = createApp({
  version: process.env.APP_VERSION ?? 'dev',
  authenticate: auth.authenticate,
  identify: auth.identify,
  events: createEventPublisherFromEnv(),
});

export const handler = handle(app);
