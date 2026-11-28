import type { DemoHandler } from './demoApi';

/*
 * DEMO tuketim (/api/portal/meters): son dort ayin isinma donemleri (pay olcer) ve iki sicak su
 * donemi; bina / blok ortalamasi, onceki doneme gore degisim, bir tahmini okuma. Sayac Dagitim
 * Dokumu PDF'i demo modunda yoktur. Gercek veri DEGILDIR.
 */

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const iso = (d: Date) => d.toISOString().slice(0, 10);

type Spec = { category: 'heating' | 'hot_water'; consumption: number; building: number; block: number; amount: number; common: number; estimated?: boolean };

function periods(now: Date) {
  const month = (ago: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ago, 1));
  const heating: Spec[] = [
    { category: 'heating', consumption: 182.4, building: 160.2, block: 171.8, amount: 214_050, common: 64_215 },
    { category: 'heating', consumption: 121.7, building: 118.9, block: 115.3, amount: 151_300, common: 45_390, estimated: true },
    { category: 'heating', consumption: 64.2, building: 71.5, block: 69.9, amount: 88_420, common: 26_526 },
    { category: 'heating', consumption: 20.1, building: 24.6, block: 23.2, amount: 31_870, common: 9_561 },
  ];
  const water: Spec[] = [
    { category: 'hot_water', consumption: 3.42, building: 3.1, block: 3.05, amount: 41_200, common: 8_240 },
    { category: 'hot_water', consumption: 3.05, building: 3.2, block: 3.15, amount: 37_900, common: 7_580 },
  ];
  const build = (s: Spec, ago: number, list: Spec[], i: number) => {
    const start = month(ago + 1);
    const end = new Date(month(ago).getTime() - 86_400_000);
    const prev = list[i + 1];
    const label = `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
    const heat = s.category === 'heating';
    return {
      periodId: `${heat ? 'mp-h' : 'mp-w'}-${ago}`,
      name: `${label} ${heat ? 'ısınma' : 'sıcak su'}`,
      meterKind: heat ? 'heat_allocator' : 'hot_water',
      category: s.category,
      startDate: iso(start),
      endDate: iso(end),
      dueDate: iso(new Date(month(ago).getTime() + 9 * 86_400_000)),
      hasMeter: true,
      estimated: !!s.estimated,
      consumption: s.consumption,
      consumptionText: String(s.consumption),
      commonAmount: s.common,
      consumptionAmount: s.amount - s.common,
      amount: s.amount,
      meters: heat
        ? [
            { meterId: `m-salon-${ago}`, label: 'Salon pay ölçer', delta: String(Math.round(s.consumption * 0.6 * 10) / 10) },
            { meterId: `m-oda-${ago}`, label: 'Yatak odası pay ölçer', delta: String(Math.round(s.consumption * 0.4 * 10) / 10) },
          ]
        : [{ meterId: `m-su-${ago}`, label: 'Sıcak su sayacı', delta: String(s.consumption) }],
      buildingAverage: s.building,
      blockAverage: s.block,
      meteredUnits: 22,
      ...(prev
        ? {
            previous: {
              periodId: `${heat ? 'mp-h' : 'mp-w'}-${ago + 1}`,
              consumption: prev.consumption,
              diff: Math.round((s.consumption - prev.consumption) * 100) / 100,
              percent: Math.round(((s.consumption - prev.consumption) / prev.consumption) * 1000) / 10,
            },
          }
        : {}),
    };
  };
  return [...heating.map((s, i) => build(s, i, heating, i)), ...water.map((s, i) => build(s, i, water, i))];
}

export function createConsumptionDemo(): DemoHandler {
  return ({ method, path, query, now }) => {
    if (!path.startsWith('/api/portal/meters/') || method !== 'GET') return undefined;
    if (!query.unitId) return { status: 400, body: { error: 'validation', message: 'unitId zorunludur', field: 'unitId' } };
    if (path === '/api/portal/meters/consumption') return { status: 200, body: { unitId: query.unitId, unitNumber: '7', periods: periods(now) } };
    if (path.startsWith('/api/portal/meters/statement/')) {
      return { status: 404, body: { error: 'not_found', message: 'Demo modunda Sayaç Dağıtım Dökümü PDF’i yok; gerçek API’de döküm burada açılır.' } };
    }
    return undefined;
  };
}
