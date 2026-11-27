/**
 * Genel kurul devami - toplanti tutanagi ve karar defteri PDF icerigi (SAF; `renderReportPdf`
 * sablonuna veri). Ayni girdi ayni icerik: S3'te veri ozetiyle onbelleklenir.
 *
 * Tutanak: toplanti bilgisi, cagri, divan, KMK m.30 yeter sayi (TUTANAGA GECIRILEN anlik goruntuden;
 * canli katilimla karistirilmaz), her gundem maddesi icin karar turu, gerekli cogunluk, kabul / ret /
 * cekimser (oy, kat maliki, bolum, arsa payi), sonuc ve duzeltmeler, gorusme notlari ve imza
 * satirlari. Y1'den kalan (karar kaydi olmayan) sayimlar "Y1 sayimi" olarak gosterilir. Bolum bazinda
 * katilim / oy listesi TUTANAKTA YOKTUR (hazirun cetveli ayri belgedir).
 */
import type { ReportPdfData, ReportRow, ReportSection } from '../documents/reportPdf.js';
import { formatDate, formatDateTime } from '../notifications/templates.js';
import { istanbulDate } from '../polls/results.js';
import type { Fraction } from '../polls/types.js';
import { DECISION_PRESETS, type DecisionKind, type DecisionOutcome, MAJORITY_LABELS, type MajorityRule, kindLabel } from './majority.js';
import type { Quorum } from './quorum.js';
import type { AgendaItem, AgendaTally, Assembly, AssemblyDecision, QuorumRecord } from './types.js';

export type ReportContent = Omit<ReportPdfData, 'generatedAt' | 'dataHash'>;

export const MEETING_KIND_LABELS = { ordinary: 'Olağan', extraordinary: 'Olağanüstü' } as const;

export const itemRule = (i: Pick<AgendaItem, 'majority'>): MajorityRule => i.majority ?? 'attendees';
export const itemKind = (i: Pick<AgendaItem, 'decisionKind'>): DecisionKind => i.decisionKind ?? 'general';

/** Kanun maddesi (hazir turde) veya "yönetim planı / özel". */
export const legalBasis = (k: DecisionKind) => (k === 'custom' ? 'yönetim planı / özel' : DECISION_PRESETS[k].legal);

// Gomulu font alt kumesi: ASCII, Latin-1, Turkce harfler, tire / tirnak / madde isareti, uc nokta, euro, TL, eksi.
const PDF_CHARS = /[^ -~ -ÿĞğİıŞş–—‘-„•…€₺−\n]/gu;

/** Kullanici metnini PDF fontunda bulunan karakterlere indirger (bulunmayan karakter "?"). */
export const pdfSafe = (s: string) => s.replace(/\t/g, ' ').replace(PDF_CHARS, '?');

const shareText = (f: Fraction) => `${f.numerator}/${f.denominator}`;
const pct = (bps: number) => `%${(bps / 100).toFixed(2).replace('.', ',')}`;

export function placeText(a: Pick<Assembly, 'location' | 'onlineUrl'>): string {
  return [a.location, a.onlineUrl ? `Çevrim içi: ${a.onlineUrl}` : undefined].filter(Boolean).join(' · ');
}

/** "Kabul ... oy" satiri icin: oy, (varsa) kisi, bolum ve arsa payi. */
function choiceRow(label: string, o: DecisionOutcome, k: 'yes' | 'no' | 'abstain' | 'notVoted'): ReportRow {
  const persons = o.persons ? String(o.persons[k]) : '—';
  const units = o.units ? String(o.units[k]) : '—';
  const land = k !== 'notVoted' && o.landShare && o.landShareBps ? `${shareText(o.landShare[k])} (${pct(o.landShareBps[k])})` : '—';
  return { cells: [label, String(o.votes[k]), persons, units, land] };
}

/** Gerekli cogunlugun sayisal ifadesi. */
export function requiredText(o: DecisionOutcome): string {
  const parts: string[] = [];
  if (o.rule === 'unanimous') parts.push(`${o.required.units ?? 0} bölümün tamamı`);
  if (o.required.votes !== null && o.rule !== 'unanimous') parts.push(`en az ${o.required.votes} oy`);
  if (o.required.persons !== null) parts.push(`en az ${o.required.persons} kat maliki (kişi)`);
  if (o.required.landShare) parts.push(`en az ${shareText(o.required.landShare)} arsa payı`);
  const base =
    o.rule === 'attendees'
      ? `katılan ${o.presentVotes} oy`
      : o.required.persons !== null
        ? `bütün kat malikleri ${o.persons?.total ?? '?'} kişi${o.totalLandShare ? `, toplam arsa payı ${shareText(o.totalLandShare)}` : ''}`
        : `bütün kat maliklerinin ${o.allVotes} oyu`;
  return `${parts.join(' ve ')} (${base})`;
}

const decisionWord = (d: DecisionOutcome['decision']) => (d === 'accepted' ? 'KABUL EDİLDİ' : 'REDDEDİLDİ');

function decisionTable(o: DecisionOutcome): Pick<ReportSection, 'columns' | 'rows'> {
  return {
    columns: [
      { header: 'Oy', width: 1.6 },
      { header: 'Oy sayısı (KMK m.31)', width: 1.2, align: 'right' },
      { header: 'Kat maliki (kişi)', width: 1, align: 'right' },
      { header: 'Bağımsız bölüm', width: 1, align: 'right' },
      { header: 'Arsa payı', width: 1.6, align: 'right' },
    ],
    rows: [
      choiceRow('Kabul', o, 'yes'),
      choiceRow('Ret', o, 'no'),
      choiceRow('Çekimser', o, 'abstain'),
      choiceRow('Katılıp oy kullanmayan', o, 'notVoted'),
      ...(o.units ? [{ cells: ['Katılmayan', '', o.persons ? String(o.persons.absent) : '', String(o.units.absent), ''] }] : []),
      { bold: true, rule: true, cells: [`Sonuç: ${decisionWord(o.decision)}`, '', '', '', ''] },
    ],
  };
}

/** Y1'den kalan sayim (karar kaydi yok): yalnizca oy sayilari ve katilanlarin oy coklugu. */
function legacyTable(t: AgendaTally): Pick<ReportSection, 'columns' | 'rows'> {
  return {
    columns: [
      { header: 'Oy', width: 1.6 },
      { header: 'Oy sayısı (KMK m.31)', width: 1.2, align: 'right' },
    ],
    rows: [
      { cells: ['Kabul', String(t.yes)] },
      { cells: ['Ret', String(t.no)] },
      { cells: ['Çekimser', String(t.abstain)] },
      { cells: ['Katılan oy', String(t.presentVotes)] },
      { bold: true, rule: true, cells: [`Sonuç: ${decisionWord(t.decision)}`, ''] },
    ],
  };
}

const legacyText = (t: AgendaTally) => `kabul ${t.yes}, ret ${t.no}, çekimser ${t.abstain} oy; ${decisionWord(t.decision).toLocaleLowerCase('tr')}`;

/** Tutanaktaki yeter sayi: kayitli anlik goruntu; eski kayitta eksik alan icin (katilim donmus) canli deger. */
function quorumRows(a: Pick<Assembly, 'secondMeeting'>, rec: QuorumRecord | undefined, q: Quorum): ReportRow[] {
  const present = rec?.presentLandShare !== undefined ? rec.presentLandShare : q.presentLandShare;
  const total = rec?.totalLandShare !== undefined ? rec.totalLandShare : q.totalLandShare;
  const computable = rec ? rec.landShareComputable : q.landShareComputable;
  const ownersMajority = rec ? rec.ownersMajority : q.ownersMajority;
  const landMajority = rec ? rec.landShareMajority : q.landShareMajority;
  const met = rec ? rec.met : q.met;
  return [
    { cells: ['Kat maliki (kişi)', String(rec?.presentOwners ?? q.presentOwners), String(rec?.totalOwners ?? q.totalOwners), ownersMajority ? 'yarıdan fazla' : 'yarıdan fazla değil'] },
    { cells: ['Oy (bağımsız bölüm; KMK m.31 sınırlı)', String(rec?.presentVotes ?? q.presentVotes), String(rec?.totalVotes ?? q.totalVotes), `${rec?.proxyUnits ?? q.proxyUnits} bölüm vekaleten`] },
    {
      cells: ['Arsa payı', present ? shareText(present) : '—', total ? shareText(total) : 'hesaplanamıyor', computable ? (landMajority ? 'yarıdan fazla' : 'yarıdan fazla değil') : 'arsa payı eksik'],
    },
    {
      bold: true,
      rule: true,
      cells: [a.secondMeeting ? 'Sonuç: ikinci toplantı, yeter sayı aranmaz' : `Sonuç: yeter sayı ${met ? 'sağlandı' : 'sağlanmadı'}${rec?.noAttendance ? ' (kimse gelmedi)' : ''}`, '', '', ''],
    },
  ];
}

export function minutesReport(input: {
  apartmentName: string;
  assembly: Omit<Assembly, 'PK' | 'SK'>;
  quorum: Quorum;
  decisions: readonly AssemblyDecision[];
  preview: boolean;
}): ReportContent {
  const { assembly: a, quorum: q, preview } = input;
  const rec: QuorumRecord | undefined = a.quorumRecord;
  const m = a.minutes;
  const calls = a.calls ?? [];
  const firstCall = calls[0];
  const kind = `${MEETING_KIND_LABELS[a.kind]} Kat Malikleri Kurulu${a.secondMeeting ? ' (ikinci toplantı)' : ''}`;

  const info: ReportRow[] = [
    { cells: ['Toplantı', kind] },
    { cells: ['Tarih ve saat', `${formatDateTime(a.scheduledAt)} (Türkiye saati)`] },
    { cells: ['Yer / bağlantı', pdfSafe(placeText(a) || '—')] },
    { cells: ['Oy listesi (hazirun) tarihi', formatDate(a.rollDate)] },
    {
      cells: [
        'Çağrı',
        firstCall
          ? `${formatDateTime(firstCall.calledAt)} e-posta bilgilendirmesi (toplantıdan ${firstCall.daysBefore} gün önce${firstCall.lateNotice ? '; KMK m.29/2 15 gün süresinden sonra' : ''})${calls.length > 1 ? `, ${calls.length - 1} kez yeniden gönderildi` : ''}`
          : 'Sistemden çağrı gönderilmedi (yasal çağrı ayrıca yapılır)',
      ],
    },
    ...(a.secondMeetingPlan ? [{ cells: ['Bildirilen ikinci toplantı', pdfSafe(`${formatDateTime(a.secondMeetingPlan.scheduledAt)} · ${placeText(a.secondMeetingPlan) || 'aynı yer'}`)] }] : []),
    { cells: ['Toplantı başkanı', pdfSafe(m?.chair ?? '—')] },
    { cells: ['Yazman', pdfSafe(m?.clerks.length ? m.clerks.join(', ') : '—')] },
    ...(m?.voteCounters.length ? [{ cells: ['Oy toplayıcı', pdfSafe(m.voteCounters.join(', '))] }] : []),
  ];

  const met = rec ? rec.met : q.met;
  const byItem = new Map<string, AssemblyDecision[]>();
  for (const d of input.decisions) byItem.set(d.itemId, [...(byItem.get(d.itemId) ?? []), d]);

  const itemSections: ReportSection[] = a.agenda.map((item, i) => {
    const records = [...(byItem.get(item.itemId) ?? [])].sort((x, y) => x.seq - y.seq);
    const latest = records.at(-1);
    const k = itemKind(item);
    const title = pdfSafe(`${i + 1}. ${item.title}`);
    const head = [
      item.decisionKind ? `Karar türü: ${kindLabel(k)} (${legalBasis(k)}) · Gerekli çoğunluk: ${MAJORITY_LABELS[itemRule(item)]}` : 'Karar türü kaydı yok (Y1 sayımı) · Gerekli çoğunluk: katılanların oy çokluğu',
      ...(item.description ? [pdfSafe(item.description)] : []),
      ...(m?.notes[item.itemId] ? [pdfSafe(`Görüşme: ${m.notes[item.itemId]}`)] : []),
    ];
    if (!latest && item.tally) {
      return { title, paragraphs: [...head, `Y1 sayımı (${formatDateTime(item.tally.recordedAt)}); değişmez karar kaydı yok.`], ...legacyTable(item.tally) };
    }
    if (!latest) {
      return { title, paragraphs: [...head, met || a.secondMeeting ? 'Bu madde için karar kaydı yok.' : 'Yeter sayı sağlanamadığından karar alınmadı.'], columns: [], rows: [] };
    }
    const paragraphs = [
      ...head,
      `Gerekli: ${requiredText(latest.outcome)}`,
      ...latest.outcome.reasons.map((r) => `Gerekçe: ${r}`),
      ...latest.outcome.warnings,
      ...(records[0]?.legacyTally ? [`Düzeltilen Y1 sayımı (${formatDateTime(records[0].legacyTally.recordedAt)}): ${legacyText(records[0].legacyTally)}.`] : []),
      ...records
        .slice(0, -1)
        .map((old) => `Düzeltilen kayıt (${formatDateTime(old.recordedAt)}): kabul ${old.outcome.votes.yes}, ret ${old.outcome.votes.no}, çekimser ${old.outcome.votes.abstain} oy; ${decisionWord(old.outcome.decision).toLocaleLowerCase('tr')}.`),
      ...(latest.correctionReason ? [pdfSafe(`Düzeltme gerekçesi (${formatDateTime(latest.recordedAt)}): ${latest.correctionReason}`)] : []),
    ];
    return { title, paragraphs, ...decisionTable(latest.outcome) };
  });

  const signRows: ReportRow[] = [
    { cells: ['Toplantı Başkanı', pdfSafe(m?.chair ?? ''), ''] },
    ...(m?.clerks.length ? m.clerks : ['']).map((n) => ({ cells: ['Yazman', pdfSafe(n), ''] })),
    ...(m?.voteCounters ?? []).map((n) => ({ cells: ['Oy Toplayıcı', pdfSafe(n), ''] })),
  ];

  return {
    apartmentName: input.apartmentName,
    title: preview ? 'Toplantı Tutanağı (taslak)' : 'Toplantı Tutanağı',
    subtitle: pdfSafe(`${preview ? 'TASLAK - tutanak kesinleşmedi · ' : ''}${kind} · ${formatDateTime(a.scheduledAt)} · ${placeText(a)}`),
    sections: [
      { title: 'Toplantı bilgileri', columns: [{ header: 'Bilgi', width: 1.3 }, { header: 'Değer', width: 5 }], rows: info },
      {
        title: `Toplantı yeter sayısı (KMK m.30)${rec ? ` · tutanağa geçiş ${formatDateTime(rec.recordedAt)}` : ''}`,
        columns: [
          { header: 'Ölçüt', width: 2.2 },
          { header: 'Katılan', width: 1, align: 'right' },
          { header: 'Toplam', width: 1, align: 'right' },
          { header: 'Durum', width: 1.8 },
        ],
        rows: quorumRows(a, rec, q),
      },
      ...itemSections,
      ...(m?.generalNotes ? [{ title: 'Diğer görüşmeler ve notlar', paragraphs: [pdfSafe(m.generalNotes)], columns: [], rows: [] }] : []),
      {
        title: 'İmzalar',
        columns: [
          { header: 'Görev', width: 1.4 },
          { header: 'Ad soyad', width: 3 },
          { header: 'İmza', width: 2.4 },
        ],
        rowHeight: 30,
        ruled: true,
        rows: signRows,
      },
    ],
    notes: [
      'Kararlar noterce onaylı karar defterine yazılır ve toplantıda bulunan kat maliklerince imzalanır; aleyhte oy verenler gerekçelerini yazar (KMK m.32). Bu tutanak karar defterinin yerine geçmez.',
      '"Sayı ... çoğunluğu" ve "yazılı rıza" aranan kararlarda kat maliki kişi sayısı, "oyu" aranan kararlarda KMK m.31 oyu (kişi başı üçte bir sınırı) sayılır; payda bütün kat malikleridir. Hesap yorumları avukat onayı bekler.',
      ...(preview ? ['Taslak: tutanak kesinleştirilmeden önceki hal; sakinlere gösterilmez.'] : []),
    ],
  };
}

/** Karar defteri satiri: degismez karar kaydi veya Y1'den kalan sayim. */
type BookRow = {
  assemblyId: string;
  itemId: string;
  seq: number;
  meetingAt: string;
  meetingKind: Assembly['kind'];
  secondMeeting: boolean;
  itemTitle: string;
  rule: MajorityRule | null;
  votes: { yes: number; no: number; abstain: number };
  decision: DecisionOutcome['decision'];
  recordedAt: string;
  correction?: string;
  legacy: boolean;
};

/** Karar defteri: apartmanin tum karar kayitlari (duzeltmeler ve Y1 sayimlari dahil), toplanti tarihi sirasiyla. */
export function decisionBookReport(input: { apartmentName: string; assemblies: readonly Omit<Assembly, 'PK' | 'SK'>[]; decisions: readonly AssemblyDecision[] }): ReportContent {
  const meeting = new Map(input.assemblies.map((a) => [a.assemblyId, a]));
  const order = (itemId: string) => Number(itemId.replace(/\D/g, '')) || 0;
  const withRecord = new Set(input.decisions.map((d) => `${d.assemblyId}|${d.itemId}`));
  const rowsData: BookRow[] = [
    ...input.decisions.flatMap((d): BookRow[] => {
      const base = { assemblyId: d.assemblyId, itemId: d.itemId, meetingAt: d.meetingAt, meetingKind: d.meetingKind, secondMeeting: d.secondMeeting, itemTitle: d.itemTitle };
      const own: BookRow = { ...base, seq: d.seq, rule: d.outcome.rule, votes: d.outcome.votes, decision: d.outcome.decision, recordedAt: d.recordedAt, legacy: false, ...(d.correctionReason ? { correction: d.correctionReason } : {}) };
      const t = d.legacyTally;
      return t ? [{ ...base, seq: 0, rule: null, votes: t, decision: t.decision, recordedAt: t.recordedAt, legacy: true }, own] : [own];
    }),
    // Y1 sayimi, karar kaydi yok (ne duzeltildi ne yeniden kaydedildi).
    ...input.assemblies.flatMap((a) =>
      a.agenda
        .filter((i) => i.tally && !withRecord.has(`${a.assemblyId}|${i.itemId}`))
        .map((i): BookRow => {
          const t = i.tally as AgendaTally;
          return { assemblyId: a.assemblyId, itemId: i.itemId, seq: 0, meetingAt: a.scheduledAt, meetingKind: a.kind, secondMeeting: a.secondMeeting, itemTitle: i.title, rule: null, votes: t, decision: t.decision, recordedAt: t.recordedAt, legacy: true };
        }),
    ),
  ];
  const records = rowsData
    .filter((d) => meeting.get(d.assemblyId)?.status !== 'cancelled')
    .sort((x, y) => x.meetingAt.localeCompare(y.meetingAt) || x.assemblyId.localeCompare(y.assemblyId) || order(x.itemId) - order(y.itemId) || x.seq - y.seq);
  const numberOf = new Map<string, number>();
  const latestSeq = new Map<string, number>();
  for (const d of records) latestSeq.set(`${d.assemblyId}|${d.itemId}`, Math.max(latestSeq.get(`${d.assemblyId}|${d.itemId}`) ?? -1, d.seq));
  let n = 0;
  const rows: ReportRow[] = records.map((d) => {
    const key = `${d.assemblyId}|${d.itemId}`;
    if (!numberOf.has(key)) numberOf.set(key, ++n);
    const a = meeting.get(d.assemblyId);
    const superseded = d.seq < (latestSeq.get(key) ?? d.seq);
    return {
      ...(superseded ? { muted: true } : {}),
      cells: [
        String(numberOf.get(key)),
        `${formatDate(a?.rollDate ?? istanbulDate(d.meetingAt))} · ${MEETING_KIND_LABELS[d.meetingKind]}${d.secondMeeting ? ' (2.)' : ''}${a && a.status !== 'held' ? ' · taslak' : ''}`,
        pdfSafe(d.itemTitle),
        d.rule ? MAJORITY_LABELS[d.rule] : 'Y1 sayımı (karar türü yok)',
        `${d.votes.yes} / ${d.votes.no} / ${d.votes.abstain}`,
        decisionWord(d.decision),
        pdfSafe(`${formatDateTime(d.recordedAt)}${d.correction ? ` · düzeltme: ${d.correction}` : ''}${superseded ? ' · düzeltildi' : ''}`),
      ],
    };
  });
  const meetings = new Set(records.map((d) => d.assemblyId)).size;
  return {
    apartmentName: input.apartmentName,
    title: 'Karar Defteri',
    subtitle: `${n} karar · ${meetings} toplantı · toplantı tarihi sırasıyla`,
    sections: [
      {
        columns: [
          { header: 'No', width: 0.4 },
          { header: 'Toplantı', width: 1.5 },
          { header: 'Gündem maddesi', width: 2.8 },
          { header: 'Gerekli çoğunluk', width: 2.4 },
          { header: 'Kabul / ret / çekimser', width: 1.3, align: 'right' },
          { header: 'Sonuç', width: 1 },
          { header: 'Kayıt', width: 2 },
        ],
        rows: rows.length ? rows : [{ muted: true, cells: ['', 'Henüz karar kaydı yok', '', '', '', '', ''] }],
      },
    ],
    notes: [
      'Oylar KMK m.31 kişi sınırı uygulanmış oy sayısıdır. Düzeltilen kayıt silinmez, soluk gösterilir; geçerli olan aynı numaralı son kayıttır. "Y1 sayımı": karar türü kaydı olmayan eski sayım.',
      'Bu döküm bilgi amaçlıdır; kararlar noterce onaylı karar defterine yazılır ve toplantıda bulunan kat maliklerince imzalanır (KMK m.32).',
    ],
  };
}
