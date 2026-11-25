import {
  BadRequestException,
  MessageRejected,
  SESv2Client,
  SendEmailCommand,
} from '@aws-sdk/client-sesv2';
import { DataAccessError, getTenantItem, putNewItem, skKey, tenantPk } from '../../config/dynamodb.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { type PersonRepository, personRepository } from '../residents/repository.js';
import { type DeliveryResult, type Notification, type Notifier, createLogNotifier } from './notifier.js';
import { type PreferencesRepository, createDynamoPreferencesRepository } from './preferences.js';
import { type EmailContext, renderEmail } from './templates.js';

/**
 * E-posta kanali (Amazon SES v2).
 *
 * Alici basina akis:
 *  1. Alici bazli tekrar korumasi: `NOTIFSENT#<eventId>#<userId>` varsa atlanir. (Olay, baska
 *     bir alicinin gecici hatasi yuzunden yeniden islendiginde onceki alicilara ikinci e-posta
 *     gitmez.)
 *  2. Kullanici tercihi: e-posta kapaliysa `skipped: opted_out`.
 *  3. Adres: apartmanin `PERSON#<userId>` kaydi. Yoksa / gecersizse `no_email`, `emailVerified
 *     === false` ise `email_unverified` (guvenli atlama, hata degil).
 *  4. Sablon (HTML + duz metin) ve SES gonderimi. Kalici alici hatasi (MessageRejected /
 *     BadRequest: gecersiz adres, sandbox'ta dogrulanmamis alici) `skipped: rejected` olarak
 *     kaydedilir ve tekrar denenmez; gecici/yapilandirma hatalari (kisitlama, hesap duraklatma,
 *     yapilandirma seti yok) FIRLATILIR -> SQS tekrar dener, sonunda DLQ + alarm.
 *  5. Basarida gonderim kaydi (30 gun TTL).
 *
 * Gonderen adresi `SES_FROM_ADDRESS`; gorunen adda ASCII disi karakter varsa (YÖNESİST) MIME
 * encoded-word ile kodlanir (SES gereksinimi).
 */

export const DEFAULT_FROM_ADDRESS = 'YÖNESİST <bildirim@yonetimsistemim.com>';
const SENT_TTL_SECONDS = 30 * 24 * 3600;
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** SES mesaj etiketleri (yalnizca [A-Za-z0-9_-]). */
  tags: Record<string, string>;
};

export type EmailSender = { send(message: EmailMessage): Promise<{ messageId?: string }> };

/** Alici kaynakli, tekrar denemekle duzelmeyecek gonderim hatasi. */
export class PermanentEmailError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentEmailError';
  }
}

/** "Ad <adres>" -> SES'in kabul ettigi bicim; gorunen ad ASCII disiysa RFC 2047 (UTF-8, B). */
export function encodeFromAddress(from: string): { header: string; address: string } {
  const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(from);
  const address = (m ? m[2] : from.trim()) as string;
  if (!EMAIL.test(address)) throw new Error(`Gecersiz gonderen adresi: ${from}`);
  const name = m?.[1]?.replace(/^"|"$/g, '').trim();
  if (!name) return { header: address, address };
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x20-\x7e]*$/.test(name);
  const display = ascii ? `"${name.replace(/["\\]/g, '')}"` : `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`;
  return { header: `${display} <${address}>`, address };
}

const tagValue = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || 'none';

type Sender<C> = { send(command: C): Promise<unknown> };

export function createSesEmailSender(options: {
  from: string;
  configurationSet?: string;
  region?: string;
  client?: Sender<SendEmailCommand>;
}): EmailSender {
  const from = encodeFromAddress(options.from);
  const client = options.client ?? new SESv2Client(options.region ? { region: options.region } : {});
  return {
    async send(message) {
      if (!EMAIL.test(message.to)) throw new PermanentEmailError('Gecersiz alici adresi');
      try {
        const out = (await client.send(
          new SendEmailCommand({
            FromEmailAddress: from.header,
            Destination: { ToAddresses: [message.to] },
            Content: {
              Simple: {
                Subject: { Data: message.subject, Charset: 'UTF-8' },
                Body: { Html: { Data: message.html, Charset: 'UTF-8' }, Text: { Data: message.text, Charset: 'UTF-8' } },
              },
            },
            ...(options.configurationSet ? { ConfigurationSetName: options.configurationSet } : {}),
            EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name: tagValue(Name), Value: tagValue(Value) })),
          }),
        )) as { MessageId?: string };
        return { messageId: out?.MessageId };
      } catch (err) {
        if (err instanceof MessageRejected || err instanceof BadRequestException) {
          throw new PermanentEmailError(`SES alici/ileti reddi: ${err.name}`, { cause: err });
        }
        throw err; // kisitlama, hesap duraklatma, yapilandirma: tekrar denenir
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Gonderim kaydi (alici bazli idempotency)
// ---------------------------------------------------------------------------

export type SentLog = {
  has(apartmentId: string, eventId: string, userId: string): Promise<boolean>;
  record(apartmentId: string, eventId: string, userId: string, info: { status: 'sent' | 'rejected'; messageId?: string }): Promise<void>;
};

const sentKey = (apartmentId: string, eventId: string, userId: string) => ({
  PK: tenantPk(apartmentId),
  SK: skKey('NOTIFSENT', eventId, userId),
});

export function createDynamoSentLog(now: () => Date = () => new Date()): SentLog {
  return {
    has: async (apt, eventId, userId) => Boolean(await getTenantItem(sentKey(apt, eventId, userId))),
    async record(apt, eventId, userId, info) {
      try {
        await putNewItem({
          ...sentKey(apt, eventId, userId),
          entityType: 'NOTIFICATION_SENT',
          eventId,
          userId,
          channel: 'email',
          status: info.status,
          ...(info.messageId ? { messageId: info.messageId } : {}),
          at: now().toISOString(),
          ttl: Math.floor(now().getTime() / 1000) + SENT_TTL_SECONDS,
        });
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict') return; // es zamanli teslim
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// E-posta kanali
// ---------------------------------------------------------------------------

export type EmailNotifierDeps = {
  sender: EmailSender;
  preferences: Pick<PreferencesRepository, 'get'>;
  people: Pick<PersonRepository, 'get'>;
  core: Pick<CoreRepository, 'getSite' | 'listUnits' | 'listBlocks'>;
  sentLog: SentLog;
  /** Sakin portali kok adresi (WEB_APP_URL + /app). */
  portalUrl?: string;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
};

const CONTEXT_TTL_MS = 60_000;

export function createEmailNotifier(deps: EmailNotifierDeps): Notifier {
  const contexts = new Map<string, { at: number; siteName: string; labels: Map<string, string> }>();

  /** Site adi ve daire etiketleri (ayni olayin alicilari icin kisa sureli onbellek). */
  async function siteContext(apartmentId: string) {
    const cached = contexts.get(apartmentId);
    if (cached && deps.now().getTime() - cached.at < CONTEXT_TTL_MS) return cached;
    const [site, units, blocks] = await Promise.all([
      deps.core.getSite(apartmentId),
      deps.core.listUnits(apartmentId),
      deps.core.listBlocks(apartmentId),
    ]);
    const blockNames = new Map(blocks.map((b) => [b.blockId, b.name]));
    const multiBlock = blocks.length > 1;
    const labels = new Map(
      units.map((u) => {
        const block = blockNames.get(u.blockId);
        return [u.unitId, multiBlock && block ? `${block} - ${u.number}` : `Daire ${u.number}`];
      }),
    );
    const entry = { at: deps.now().getTime(), siteName: site?.name ?? 'Siteniz', labels };
    contexts.set(apartmentId, entry);
    return entry;
  }

  async function send(n: Notification): Promise<DeliveryResult> {
    if (await deps.sentLog.has(n.apartmentId, n.eventId, n.userId)) return { status: 'skipped', reason: 'already_sent' };

    const prefs = await deps.preferences.get(n.userId);
    if (!prefs.email.enabled) return { status: 'skipped', reason: 'opted_out' };
    if (n.template.startsWith('ticket_') && prefs.email.tickets === false) return { status: 'skipped', reason: 'opted_out' };

    const person = await deps.people.get(n.apartmentId, n.userId);
    const to = person?.email?.trim();
    if (!to || !EMAIL.test(to)) return { status: 'skipped', reason: 'no_email' };
    if (person?.emailVerified === false) return { status: 'skipped', reason: 'email_unverified' };

    const site = await siteContext(n.apartmentId);
    const ctx: EmailContext = {
      siteName: site.siteName,
      recipientName: person?.fullName,
      unitLabel: (unitId) => site.labels.get(unitId) ?? 'Bağımsız bölüm',
      portalUrl: deps.portalUrl,
    };
    const email = renderEmail(n, ctx);
    if (!email) return { status: 'skipped', reason: 'no_template' };

    try {
      const out = await deps.sender.send({
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        tags: { template: n.template, apartment: n.apartmentId },
      });
      await deps.sentLog.record(n.apartmentId, n.eventId, n.userId, { status: 'sent', messageId: out.messageId });
      return { status: 'sent' };
    } catch (err) {
      if (!(err instanceof PermanentEmailError)) throw err;
      // Kalici: kaydedilir ki olayin tekrar islenmesinde ayni adrese yeniden denenmesin.
      deps.log.error(JSON.stringify({ level: 'error', msg: 'email_rejected', eventId: n.eventId, userId: n.userId, apartmentId: n.apartmentId, error: err.message }));
      await deps.sentLog.record(n.apartmentId, n.eventId, n.userId, { status: 'rejected' });
      return { status: 'skipped', reason: 'rejected' };
    }
  }

  return { channel: 'email', send };
}

/**
 * NOTIFICATION_CHANNEL:
 *  - `log` (varsayilan): yapilandirilmis log, dis gonderim yok.
 *  - `ses`: SES e-posta; SES_FROM_ADDRESS (varsayilan YÖNESİST adresi), istege bagli
 *    SES_CONFIGURATION_SET, WEB_APP_URL (portal baglantilari).
 */
export function createNotifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<EmailNotifierDeps> = {},
): Notifier {
  const channel = env.NOTIFICATION_CHANNEL ?? 'log';
  if (channel === 'log') return createLogNotifier();
  if (channel !== 'ses') throw new Error(`Gecersiz NOTIFICATION_CHANNEL: ${channel} (log | ses)`);
  const now = overrides.now ?? (() => new Date());
  const webApp = env.WEB_APP_URL?.replace(/\/+$/, '');
  return createEmailNotifier({
    sender:
      overrides.sender ??
      createSesEmailSender({
        from: env.SES_FROM_ADDRESS || DEFAULT_FROM_ADDRESS,
        configurationSet: env.SES_CONFIGURATION_SET || undefined,
        region: env.AWS_REGION,
      }),
    preferences: overrides.preferences ?? createDynamoPreferencesRepository(),
    people: overrides.people ?? personRepository,
    core: overrides.core ?? coreRepository,
    sentLog: overrides.sentLog ?? createDynamoSentLog(now),
    portalUrl: overrides.portalUrl ?? (webApp ? `${webApp}/app` : undefined),
    now,
    log: overrides.log ?? console,
  });
}
