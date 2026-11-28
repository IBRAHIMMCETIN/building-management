import type { DemoHandler } from './demoApi';

/*
 * DEMO oylamalar (/api/portal/polls): acik gizli oylama (sonuc bitince), ara sonucu acik oylama
 * (oy verince gorunur) ve bitmis oylama. Oy verme demo oturumu boyunca hatirlanir; bitmis oylamaya
 * oy 409 `poll_closed` doner (API ile ayni). Gercek veri DEGILDIR.
 */

const DAY = 86_400_000;
const UNIT = 'u-demo-7';
/** Demo bolumun arsa payi ve oy listesi (24 bolum, her biri 50/1200). */
const ELIGIBLE = 24;
const SHARE = 50;
const TOTAL_SHARE = ELIGIBLE * SHARE;

type Option = { optionId: string; label: string };
type DemoPoll = {
  pollId: string;
  title: string;
  description?: string;
  options: Option[];
  audience: 'owners' | 'residents';
  weighting: 'per_unit' | 'land_share';
  secret: boolean;
  resultsVisibleBeforeClose: boolean;
  opensAt: string;
  closesAt: string;
  closedAt?: string;
  closedEarly?: boolean;
  phase: 'open' | 'closed';
  /** Diger bolumlerin oylari (secenek basina bolum sayisi). */
  others: Record<string, number>;
};

const bps = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) : 0);

function results(p: DemoPoll, myOption: string | undefined) {
  const counts = { ...p.others };
  if (myOption) counts[myOption] = (counts[myOption] ?? 0) + 1;
  const voted = Object.values(counts).reduce((a, b) => a + b, 0);
  const land = p.weighting === 'land_share';
  const options = p.options.map((o) => {
    const units = counts[o.optionId] ?? 0;
    return {
      optionId: o.optionId,
      label: o.label,
      units,
      unitsBps: bps(units, voted),
      landShare: land ? { numerator: String(units * SHARE), denominator: String(TOTAL_SHARE) } : null,
      landShareBps: land ? bps(units, voted) : null,
    };
  });
  const winner = options.find((o) => o.units * 2 > voted);
  const tallyHidden = p.secret && p.phase === 'open';
  return {
    pollId: p.pollId,
    phase: p.phase,
    final: p.phase === 'closed',
    weighting: p.weighting,
    rollDate: p.opensAt.slice(0, 10),
    eligible: { units: ELIGIBLE, landShare: land ? { numerator: String(TOTAL_SHARE), denominator: String(TOTAL_SHARE) } : null },
    participation: {
      units: voted,
      unitsBps: bps(voted, ELIGIBLE),
      landShare: land ? { numerator: String(voted * SHARE), denominator: String(TOTAL_SHARE) } : null,
      landShareBps: land ? bps(voted, ELIGIBLE) : null,
    },
    tallyHidden,
    ...(tallyHidden ? {} : { options, winnerOptionId: winner?.optionId ?? null }),
    warnings: [],
  };
}

export function createPollsDemo(): DemoHandler {
  const votes = new Map<string, string>([['p-3', 'o-3a']]);
  let polls: DemoPoll[] | null = null;

  const seed = (now: Date): DemoPoll[] => {
    const at = (days: number) => new Date(now.getTime() + days * DAY).toISOString();
    return [
      {
        pollId: 'p-1',
        title: 'Bahçeye çocuk oyun alanı yapılsın mı?',
        description: 'Ön bahçedeki boş alana kauçuk zeminli küçük bir oyun alanı yapılması öneriliyor. Tahmini maliyet işletme bütçesinden karşılanacak.',
        options: [
          { optionId: 'o-1a', label: 'Evet, yapılsın' },
          { optionId: 'o-1b', label: 'Hayır' },
          { optionId: 'o-1c', label: 'Fikrim yok' },
        ],
        audience: 'residents',
        weighting: 'per_unit',
        secret: true,
        resultsVisibleBeforeClose: false,
        opensAt: at(-3),
        closesAt: at(5),
        phase: 'open',
        others: { 'o-1a': 7, 'o-1b': 3, 'o-1c': 1 },
      },
      {
        pollId: 'p-2',
        title: 'Asansör bakım firması değişsin mi?',
        options: [
          { optionId: 'o-2a', label: 'Mevcut firmayla devam' },
          { optionId: 'o-2b', label: 'Yeni firmaya geçilsin' },
        ],
        audience: 'owners',
        weighting: 'land_share',
        secret: false,
        resultsVisibleBeforeClose: true,
        opensAt: at(-1),
        closesAt: at(9),
        phase: 'open',
        others: { 'o-2a': 4, 'o-2b': 6 },
      },
      {
        pollId: 'p-3',
        title: 'Kapıcı dairesinin kiraya verilmesi',
        options: [
          { optionId: 'o-3a', label: 'Kiraya verilsin' },
          { optionId: 'o-3b', label: 'Ortak alan olarak kalsın' },
        ],
        audience: 'owners',
        weighting: 'land_share',
        secret: true,
        resultsVisibleBeforeClose: false,
        opensAt: at(-40),
        closesAt: at(-30),
        closedAt: at(-30),
        phase: 'closed',
        others: { 'o-3a': 13, 'o-3b': 6 },
      },
    ];
  };

  const view = (p: DemoPoll) => {
    const mine = votes.get(p.pollId);
    const resultsAvailable = p.phase === 'closed' || (p.resultsVisibleBeforeClose && !!mine);
    return {
      pollId: p.pollId,
      title: p.title,
      ...(p.description ? { description: p.description } : {}),
      options: p.options,
      audience: p.audience,
      weighting: p.weighting,
      secret: p.secret,
      resultsVisibleBeforeClose: p.resultsVisibleBeforeClose,
      opensAt: p.opensAt,
      closesAt: p.closesAt,
      ...(p.closedAt ? { closedAt: p.closedAt } : {}),
      rollDate: p.opensAt.slice(0, 10),
      phase: p.phase,
      unitId: UNIT,
      eligible: true,
      canVote: p.phase === 'open',
      ...(mine ? { myVote: { castByMe: true, optionId: mine, castAt: p.opensAt } } : {}),
      resultsAvailable,
      resultsAfterVote: p.phase === 'open' && p.resultsVisibleBeforeClose && !mine,
      ...(resultsAvailable ? { results: results(p, mine) } : {}),
    };
  };

  return ({ method, path, body, now }) => {
    if (!path.startsWith('/api/portal/polls')) return undefined;
    polls ??= seed(now);
    if (path === '/api/portal/polls' && method === 'GET') return { status: 200, body: { unitId: UNIT, items: polls.map(view) } };
    const [, id, action] = /^\/api\/portal\/polls\/([^/]+)(?:\/(vote))?$/.exec(path) ?? [];
    const poll = polls.find((p) => p.pollId === decodeURIComponent(id ?? ''));
    if (!poll) return { status: 404, body: { error: 'not_found', message: 'Oylama bulunamadı' } };
    if (!action && method === 'GET') return { status: 200, body: view(poll) };
    if (action === 'vote' && method === 'POST') {
      if (poll.phase !== 'open') return { status: 409, body: { error: 'poll_closed', message: 'Oylama sona erdi; oy kabul edilmiyor' } };
      const optionId = (body as { optionId?: string } | undefined)?.optionId;
      if (!poll.options.some((o) => o.optionId === optionId)) return { status: 400, body: { error: 'validation', message: 'Geçersiz seçenek', field: 'optionId' } };
      votes.set(poll.pollId, optionId as string);
      return { status: 200, body: view(poll) };
    }
    return undefined;
  };
}
