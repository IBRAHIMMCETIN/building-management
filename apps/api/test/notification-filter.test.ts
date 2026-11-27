import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../src/events/publisher.js';

/*
 * SNS aboneligi bildirim kuyruguna yalnizca filtre listesindeki olay turlerini gecirir
 * (infra/sns_sqs.tf `notification_event_types`). Listede olmayan tur SNS'te sessizce elenir:
 * yayinlanir, ama bildirim hic gitmez. Yeni bir olay turu eklenince filtre de guncellenmeli.
 */
function terraformFilterTypes(): string[] {
  const tf = readFileSync(fileURLToPath(new URL('../../../infra/sns_sqs.tf', import.meta.url)), 'utf8');
  const block = /notification_event_types\s*=\s*\[([^\]]*)\]/.exec(tf)?.[1];
  if (!block) throw new Error('infra/sns_sqs.tf icinde notification_event_types bulunamadi');
  return [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
}

describe('bildirim kuyrugu SNS filtresi', () => {
  it('yayinlanan her olay turu filtreden gecer (Terraform listesi = EVENT_TYPES)', () => {
    expect([...terraformFilterTypes()].sort()).toEqual([...EVENT_TYPES].sort());
  });
});
