/**
 * Yonetim firmasi portfoyu (coklu apartman paneli).
 *
 * Portfoy ayri bir kayit DEGILDIR: kullanicinin bugun `apartment_manager`, `management_company`
 * veya `observer` (salt okur) yetkisi tasidigi apartmanlarin kumesidir. Kaynak, Pre Token
 * Lambda'sinin ve `GET /api/me/contexts`'in kullandigi GSI1 yetki kayitlaridir (`USER#<sub>`);
 * her istekte taban tablodaki `APT#<apt>` / `ROLE#<user>#<role>` kaydi tutarli okumayla yeniden
 * dogrulanir. Yeni DynamoDB anahtari yoktur; tum okumalar Query / GetItem / BatchGet'tir.
 *
 * Kartlar yalnizca toplamlar tasir (sayi ve tutar): sakin adi, daire numarasi, talep basligi vb.
 * kisisel veri yoktur.
 */
import type { Role } from '../../auth/claims.js';
import type { TicketPriority } from '../tickets/types.js';

/** Portfoye giren roller (en yetkili once; ayni apartmanda birden cok rol varsa ilki secilir). */
export const PORTFOLIO_ROLES = ['apartment_manager', 'management_company', 'observer'] as const satisfies readonly Role[];
export type PortfolioRole = (typeof PORTFOLIO_ROLES)[number];

export const PORTFOLIO_SECTIONS = [
  'units',
  'finance',
  'collection',
  'tickets',
  'maintenance',
  'equipment',
  'polls',
  'assemblies',
  'tenders',
] as const;
export type PortfolioSection = (typeof PORTFOLIO_SECTIONS)[number];

/**
 * Hangi rol hangi bolumu gorur: kaynak uclarin okuma rol listeleriyle aynidir (portfoy, rolun
 * apartman icinde goremeyecegi bir sayiyi gostermez). Denetci tum kaynak uclari salt okur
 * (`/api/sites`, `/api/finance/summary` + `dashboard`, `/api/tickets/board`, `/api/maintenance/calendar`,
 * `/api/equipment/expiring`, `/api/polls`, `/api/assemblies`, `/api/tenders`); ihalede yalnizca
 * paylasilanlari gorur - bu kural ihale servisinin kendi `audience` suzgecinden gelir.
 */
export const SECTION_ROLES: Readonly<Record<PortfolioSection, readonly PortfolioRole[]>> = {
  units: PORTFOLIO_ROLES,
  finance: PORTFOLIO_ROLES,
  collection: PORTFOLIO_ROLES,
  tickets: PORTFOLIO_ROLES,
  maintenance: PORTFOLIO_ROLES,
  equipment: PORTFOLIO_ROLES,
  polls: PORTFOLIO_ROLES,
  assemblies: PORTFOLIO_ROLES,
  tenders: PORTFOLIO_ROLES,
};

export const sectionsFor = (role: PortfolioRole): PortfolioSection[] =>
  PORTFOLIO_SECTIONS.filter((s) => SECTION_ROLES[s].includes(role));

/** Istek basina en fazla apartman (varsayilan / ust sinir) ve es zamanli apartman okumasi. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 40;
export const APARTMENT_CONCURRENCY = 4;
/** Tek apartmanin bolumleri icin sure; asilirsa bolum `failed` olur (sayfa yine doner). */
export const APARTMENT_TIMEOUT_MS = 8_000;
/** Tum istek icin butce (API Gateway 30 sn): sonra baslayan apartmanlar okunmaz, `failed` doner. */
export const REQUEST_BUDGET_MS = 22_000;

export type FinanceFigures = {
  cash: number;
  bank: number;
  totalFunds: number;
  /** Sakinlerin toplam borcu (pozitif cari bakiyeler). */
  receivables: number;
  /** Vadesi gecmis alacak ve gecikmedeki bagimsiz bolum sayisi. */
  overdue: number;
  overdueUnitCount: number;
  advances: number;
  payables: number;
};

export type CollectionFigures = {
  /** YYYY-MM */
  period: string;
  charged: number;
  collected: number;
  collectionRatePct?: number;
};

export type TicketFigures = {
  openCount: number;
  openByPriority: Record<TicketPriority, number>;
  /** SLA'si asilan acik talepler. */
  overdueCount: number;
};

export type MaintenanceFigures = { overdueCount: number; dueThisWeekCount: number };

export type EquipmentFigures = {
  /** 30 gun icinde dolacak (henuz dolmamis) kalemler, ture gore. */
  expiringCount: number;
  expiringByKind: { warranty: number; contract: number; inspection: number };
  /** Dolmus servis sozlesmesi / periyodik kontrol (yenilenene kadar) ve son 30 gunde dolan garanti. */
  expiredCount: number;
};

export type PollFigures = { openCount: number; scheduledCount: number };
export type AssemblyFigures = { upcomingCount: number; nextAt?: string };
export type TenderFigures = { openCount: number };

export type CardStatus = 'ok' | 'partial' | 'error';

export type PortfolioCard = {
  apartmentId: string;
  apartmentName: string;
  role: PortfolioRole;
  /** Denetci: yalnizca okur (detay ekranlari da salt okunur acilir). */
  readOnly: boolean;
  status: CardStatus;
  /** Okunamayan bolumler (yalnizca kod; hata ayrintisi istemciye donmez). */
  failed: PortfolioSection[];
  units?: { count: number };
  finance?: FinanceFigures;
  collection?: CollectionFigures;
  tickets?: TicketFigures;
  maintenance?: MaintenanceFigures;
  equipment?: EquipmentFigures;
  polls?: PollFigures;
  assemblies?: AssemblyFigures;
  tenders?: TenderFigures;
};

export type PortfolioTotals = {
  apartmentCount: number;
  /** En az bir bolumu okunamayan apartman: toplamlar eksik olabilir. */
  incompleteCount: number;
  unitCount: number;
  charged: number;
  collected: number;
  collectionRatePct?: number;
  receivables: number;
  overdue: number;
  overdueUnitCount: number;
  cash: number;
  bank: number;
  totalFunds: number;
  openTickets: number;
  urgentTickets: number;
  ticketSlaBreaches: number;
  maintenanceOverdue: number;
  maintenanceDueThisWeek: number;
  equipmentExpiring: number;
  upcomingAssemblies: number;
  openPolls: number;
  openTenders: number;
};

export type PortfolioPage = {
  /** Istanbul takvim gunu. */
  asOf: string;
  /** Bu donem (YYYY-MM): tahakkuk / tahsilat orani bu ay icindir. */
  period: string;
  /** Kullanicinin portfoyundeki toplam apartman (tum sayfalar). */
  total: number;
  limit: number;
  items: PortfolioCard[];
  /** Bu sayfadaki kartlarin toplami. */
  totals: PortfolioTotals;
  nextCursor?: string;
};
