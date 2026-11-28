import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../src/events/publisher.js';
import { SCHEDULER_EVENT_TYPES } from '../src/workers/scheduler-worker.js';

/*
 * SNS aboneligi bildirim kuyruguna yalnizca filtre listesindeki olay turlerini gecirir
 * (infra/sns_sqs.tf `notification_event_types`). Listede olmayan tur SNS'te sessizce elenir:
 * yayinlanir, ama bildirim hic gitmez. Yeni bir olay turu eklenince filtre de guncellenmeli.
 * Bildirim olmayan olaylar (kapi devami: MEMBERSHIP_ENDED) zamanlanmis gorev kuyruguna gider
 * (infra/scheduler.tf `scheduler_event_types`); iki liste ayriktir ve birlesimi EVENT_TYPES'tir.
 */
function terraformList(file: string, name: string): string[] {
  const tf = readFileSync(fileURLToPath(new URL(`../../../infra/${file}`, import.meta.url)), 'utf8');
  const block = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(tf)?.[1];
  if (!block) throw new Error(`infra/${file} icinde ${name} bulunamadi`);
  return [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
}

describe('olay kuyruklari SNS filtresi', () => {
  it('yayinlanan her olay turu tam olarak bir kuyruga gider (bildirim + zamanlanmis gorev = EVENT_TYPES)', () => {
    const notification = terraformList('sns_sqs.tf', 'notification_event_types');
    const scheduler = terraformList('scheduler.tf', 'scheduler_event_types');
    expect(notification.filter((t) => scheduler.includes(t))).toEqual([]);
    expect([...notification, ...scheduler].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('zamanlanmis gorev kuyrugunun listesi worker ile ayni', () => {
    expect(terraformList('scheduler.tf', 'scheduler_event_types').sort()).toEqual([...SCHEDULER_EVENT_TYPES].sort());
  });
});
