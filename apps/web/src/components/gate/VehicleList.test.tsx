// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManagerVehicle as Vehicle } from '@/lib/api/gate';
import { VehicleList, inactiveReasonText } from './VehicleList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const vehicle = (over: Partial<Vehicle>): Vehicle => ({
  vehicleId: 'v1',
  unitId: 'u1',
  unitLabel: 'A Blok · Daire 3',
  plate: '34ABC123',
  plateDisplay: '34 ABC 123',
  status: 'active',
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:00.000Z',
  createdByRole: 'resident',
  version: 1,
  ...over,
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

function render(items: Vehicle[], showReason?: boolean): string {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root?.render(<VehicleList items={items} {...(showReason ? { showReason } : {})} />));
  return el.textContent ?? '';
}

const moved = vehicle({ vehicleId: 'v2', status: 'inactive', inactiveReason: 'taşınma', plateDisplay: '06 AB 456' });

describe('VehicleList pasif nedeni', () => {
  it('yonetim: tasinmada otomatik pasife alinan arac nedeniyle gorunur', () => {
    const text = render([vehicle({}), moved], true);
    expect(text).toContain('Sahibi taşındığı için otomatik pasife alındı');
    expect(text).toContain('Pasif');
    expect(text).toContain('Aktif');
  });

  it('sakin gorunumu degismez: neden satiri yok', () => {
    const text = render([moved]);
    expect(text).toContain('Pasif');
    expect(text).not.toContain('taşındığı');
  });

  it('neden metni: yalnizca pasif arac; bilinmeyen neden oldugu gibi', () => {
    expect(inactiveReasonText({ status: 'active', inactiveReason: 'taşınma' })).toBeUndefined();
    expect(inactiveReasonText({ status: 'inactive' })).toBeUndefined();
    expect(inactiveReasonText({ status: 'inactive', inactiveReason: 'başka' })).toBe('Pasif nedeni: başka');
  });
});
