/**
 * Bildirim devami: arka plan toplu isinin bitis ozeti (`BULK_JOB_FINISHED`).
 *  - Is `completed` / `completed_with_errors` / `failed` olunca is kaydiyla AYNI yazimda outbox olayi;
 *    kimlik is surumunden (Tekrar dene sonrasi ikinci bitis ikinci olay), sistem baslattiysa olay yok.
 *  - Worker: alici yalnizca isi baslatan ve o gun aktif yonetim rolu olan kullanici; kategori finance.
 *  - E-posta (sayilar + yonetim paneli baglantisi) ve push metni.
 */
import { describe, expect, it } from 'vitest';
import { type DomainEvent, buildEvent } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import { bulkJobAdminPath } from '../src/modules/bulkjobs/notifications.js';
import { createMemoryBulkJobQueue } from '../src/modules/bulkjobs/queue.js';
import { createMemoryBulkJobRepository } from '../src/modules/bulkjobs/repository.js';
import { type BulkJobDeps, createBulkJobService } from '../src/modules/bulkjobs/service.js';
import { categoryOfEvent, categoryOfTemplate } from '../src/modules/notifications/categories.js';
import type { Notification } from '../src/modules/notifications/notifier.js';
import { renderPush } from '../src/modules/notifications/push-templates.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { APT, manager, ownershipWorld } from './fakes/ownershipWorld.js';

const SILENT = { info: () => undefined, error: () => undefined };
const OPTIONS: BulkJobDeps['options'] = { batchSize: 25, concurrency: 2, attemptsPerUnit: 1 };

const duesBody = (key: string) => ({
  idempotencyKey: key,
  liableParty: 'owner',
  totalAmount: 300_000,
  distributionKey: 'equal',
  date: '2026-12-01',
  dueDate: '2026-12-15',
  description: 'Aralık 2026 aidatı',
});

function world(finance?: (f: BulkJobDeps['finance']) => BulkJobDeps['finance']) {
  const ow = ownershipWorld('2026-12-01');
  ow.addUnit('u0002', '2');
  ow.addUnit('u0003', '3');
  const jobs = createMemoryBulkJobRepository();
  const q = createMemoryBulkJobQueue();
  const service = createBulkJobService({ repository: jobs.repository, queue: q.queue, finance: finance ? finance(ow.finance) : ow.finance, now: ow.now, options: OPTIONS, log: SILENT });
  const drain = async () => {
    while (q.messages.length) await service.handle(q.messages.shift() as never);
  };
  return { ow, jobs, q, service, drain };
}

describe('BULK_JOB_FINISHED: is bitisi', () => {
  it('tamamlanan is: tek olay, sayilar ve etiket; tekrar teslim ikinci olay uretmez', async () => {
    const w = world();
    const ctx = { apartmentId: APT, userId: manager.userId };
    const { job } = await w.service.startDues(ctx, duesBody('bj-n-0001'));
    await w.drain();
    const done = await w.service.get(ctx, job.jobId);
    expect(done.status).toBe('completed');
    expect(w.jobs.outbox).toEqual([
      expect.objectContaining({
        eventId: `BULK_JOB_FINISHED:${job.jobId}:${done.version}`,
        type: 'BULK_JOB_FINISHED',
        apartmentId: APT,
        payload: { jobId: job.jobId, kind: 'dues_bulk', status: 'completed', startedBy: manager.userId, total: done.total, succeeded: done.succeeded, failed: 0, written: done.written, label: 'Aralık 2026 aidatı' },
      }),
    ]);
    await w.service.handle({ type: 'bulk_job', apartmentId: APT, jobId: job.jobId, seq: 9 });
    expect(w.jobs.outbox).toHaveLength(1);
  });

  it('hatali biten is ve Tekrar dene: her bitis kendi olayi (farkli surum)', async () => {
    let blocked = true;
    const w = world((f) => ({
      ...f,
      postBulkLine: async (c, spec, line) => {
        if (blocked && line.unitId === 'u0002') throw Object.assign(new Error('Bu cari kapatildi'), { httpStatus: 409, code: 'conflict' });
        return f.postBulkLine(c, spec, line);
      },
    }));
    const ctx = { apartmentId: APT, userId: manager.userId };
    const { job } = await w.service.startDues(ctx, duesBody('bj-n-0002'));
    await w.drain();
    expect(w.jobs.outbox.map((e) => (e as DomainEvent<'BULK_JOB_FINISHED'>).payload)).toEqual([expect.objectContaining({ status: 'completed_with_errors', failed: 1 })]);
    blocked = false;
    await w.service.retry(ctx, job.jobId);
    await w.drain();
    const payloads = w.jobs.outbox.map((e) => (e as DomainEvent<'BULK_JOB_FINISHED'>).payload);
    expect(payloads.map((p) => p.status)).toEqual(['completed_with_errors', 'completed']);
    expect(new Set(w.jobs.outbox.map((e) => e.eventId)).size).toBe(2);
  });

  it('sistemin baslattigi is (aylik otomatik aidat): olay yok', async () => {
    const w = world();
    await w.service.startDues({ apartmentId: APT, userId: 'system-scheduler' }, duesBody('bj-n-0003'));
    await w.drain();
    expect(w.jobs.outbox).toEqual([]);
  });
});

const DAY = '2026-12-01';
const role = (userId: string, r: ApartmentRole['role'], over: Partial<ApartmentRole> = {}) =>
  ({ apartmentId: APT, userId, role: r, status: 'active', startDate: '2026-01-01', ...over }) as ApartmentRole;

const finished = (over: Partial<DomainEvent<'BULK_JOB_FINISHED'>['payload']> = {}) =>
  buildEvent(
    {
      eventId: 'BULK_JOB_FINISHED:mp-abc:7',
      type: 'BULK_JOB_FINISHED',
      apartmentId: APT,
      actorId: 'system-scheduler',
      payload: { jobId: 'mp-abc', kind: 'meter_posting', status: 'completed_with_errors', startedBy: 'mgr-1', total: 1200, succeeded: 1198, failed: 2, written: 1198, periodId: 'per-1', label: 'Ocak ısınma', ...over },
    },
    () => new Date('2026-12-01T09:00:00.000Z'),
  );

describe('BULK_JOB_FINISHED: alici, kategori ve metinler', () => {
  it('yalnizca baslatan ve aktif yonetim rolu varsa; diger yoneticiler ve rolu bitmis baslatan almaz', () => {
    const roles = [role('mgr-1', 'apartment_manager'), role('mgr-2', 'apartment_manager'), role('staff-1', 'building_staff')];
    const out = buildNotifications(finished(), [], new Map(), DAY, roles);
    expect(out).toEqual([
      expect.objectContaining({ userId: 'mgr-1', template: 'bulk_job_summary', data: expect.objectContaining({ total: 1200, failed: 2, adminPath: 'admin/meters?period=per-1' }) }),
    ]);
    expect(buildNotifications(finished(), [], new Map(), DAY, [role('mgr-1', 'apartment_manager', { endDate: '2026-11-30' })])).toEqual([]);
    expect(buildNotifications(finished({ startedBy: 'staff-1' }), [], new Map(), DAY, roles)).toEqual([]);
    expect(buildNotifications(finished(), [], new Map(), DAY, roles.map((r) => ({ ...r, apartmentId: 'apt-x' })))).toEqual([]);
  });

  it('kategori finance; baglanti turune gore', () => {
    expect(categoryOfEvent('BULK_JOB_FINISHED')).toBe('finance');
    expect(categoryOfTemplate('bulk_job_summary')).toBe('finance');
    expect(bulkJobAdminPath({ kind: 'dues_bulk' })).toBe('admin/finance');
    expect(bulkJobAdminPath({ kind: 'meter_reversal', periodId: 'p 1' })).toBe('admin/meters?period=p%201');
  });

  it('e-posta: durum, sayilar ve yonetim paneli baglantisi; basarisiz iste hata notu', () => {
    const [n] = buildNotifications(finished(), [], new Map(), DAY, [role('mgr-1', 'apartment_manager')]) as Notification[];
    const ctx = { siteName: 'Güneş Sitesi', unitLabel: () => 'Daire 1', portalUrl: 'https://app.example.com/app' };
    const e = renderEmail(n as Notification, ctx)!;
    expect(e.subject).toBe('Toplu işlem hatalarla bitti - Sayaç dönemi onayı (tahakkuk): Ocak ısınma - Güneş Sitesi');
    expect(e.text).toContain('Toplam bölüm: 1.200');
    expect(e.text).toContain('Hatalı: 2');
    expect(e.text).toContain('İşlemi görüntüle: https://app.example.com/admin/meters?period=per-1');
    const failed = renderEmail({ ...(n as Notification), data: { ...(n as Notification).data, status: 'failed', errorMessage: 'Gecici hata 3 kez' } }, ctx)!;
    expect(failed.subject).toMatch(/^Toplu işlem tamamlanamadı/);
    expect(failed.text).toContain('Hata: Gecici hata 3 kez');
  });

  it('push: kisa baslik ve sayilar', () => {
    const [n] = buildNotifications(finished({ status: 'completed', failed: 0, succeeded: 1200 }), [], new Map(), DAY, [role('mgr-1', 'management_company')]) as Notification[];
    expect(renderPush({ ...(n as Notification), category: 'finance' })).toMatchObject({
      title: 'Toplu işlem tamamlandı',
      body: 'Sayaç dönemi onayı (tahakkuk) (Ocak ısınma): 1.200 başarılı, 0 hatalı',
      path: '/islemler/mp-abc',
      category: 'finance',
    });
  });
});
