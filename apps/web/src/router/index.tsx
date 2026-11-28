import { createBrowserRouter } from 'react-router';
import { AdminLayout } from '@/layouts/AdminLayout';
import { AuthLayout } from '@/layouts/AuthLayout';
import { ResidentLayout } from '@/layouts/ResidentLayout';
import { LoginPage } from '@/pages/auth/LoginPage';
import { ForbiddenPage, NotFoundPage, RouteErrorPage } from '@/pages/errors/ErrorPages';
import { ADMIN_ROLES, APARTMENT_ADMIN_ROLES, AUDIT_ROLES, EQUIPMENT_ROLES, GATE_ROLES, METER_READING_ROLES, METER_ROLES, MY_TASKS_ROLES, OFFICE_ROLES, PLATFORM_ROLES, PORTFOLIO_ROLES, RESIDENT_ROLES, SECURITY_ROLES, TEAM_ROLES, TICKET_ROLES } from '@/types/roles';
import { RedirectIfAuthenticated, RequireRole, RequireSession, RootRedirect } from './guards';
import { PageSuspense, lazyPage } from './lazyPage';
import { RequireFeature } from './RequireFeature';

// Sayfalar ayri parcalardir (giris ekrani ve hata sayfalari haric): rota acilinca indirilir.
const AnnouncementsPage = lazyPage(() => import('@/pages/admin/announcements/AnnouncementsPage'), 'AnnouncementsPage');
const PollsPage = lazyPage(() => import('@/pages/admin/polls/PollsPage'), 'PollsPage');
const AssembliesPage = lazyPage(() => import('@/pages/admin/assemblies/AssembliesPage'), 'AssembliesPage');
const DashboardPage = lazyPage(() => import('@/pages/admin/DashboardPage'), 'DashboardPage');
const PortfolioPage = lazyPage(() => import('@/pages/admin/portfolio/PortfolioPage'), 'PortfolioPage');
const FinancePage = lazyPage(() => import('@/pages/admin/finance/FinancePage'), 'FinancePage');
const MetersPage = lazyPage(() => import('@/pages/admin/meters/MetersPage'), 'MetersPage');
const MyTasksPage = lazyPage(() => import('@/pages/admin/staff/MyTasksPage'), 'MyTasksPage');
const TicketsPage = lazyPage(() => import('@/pages/admin/tickets/TicketsPage'), 'TicketsPage');
const EquipmentPage = lazyPage(() => import('@/pages/admin/equipment/EquipmentPage'), 'EquipmentPage');
const GatePage = lazyPage(() => import('@/pages/admin/gate/GatePage'), 'GatePage');
const MyGatePage = lazyPage(() => import('@/pages/resident/gate/MyGatePage'), 'MyGatePage');
const GuestPassPage = lazyPage(() => import('@/pages/public/GuestPassPage'), 'GuestPassPage');
const ReservationsPage = lazyPage(() => import('@/pages/admin/reservations/ReservationsPage'), 'ReservationsPage');
const TendersPage = lazyPage(() => import('@/pages/admin/tenders/TendersPage'), 'TendersPage');
const TenderDetailPage = lazyPage(() => import('@/pages/admin/tenders/TenderDetailPage'), 'TenderDetailPage');
const ReadingEntryPage = lazyPage(() => import('@/pages/admin/meters/ReadingEntryPage'), 'ReadingEntryPage');
const ImportPage = lazyPage(() => import('@/pages/admin/import/ImportPage'), 'ImportPage');
const AccountPage = lazyPage(() => import('@/pages/account/AccountPage'), 'AccountPage');
const AuditPage = lazyPage(() => import('@/pages/admin/audit/AuditPage'), 'AuditPage');
const TeamPage = lazyPage(() => import('@/pages/admin/team/TeamPage'), 'TeamPage');
const SecurityPage = lazyPage(() => import('@/pages/admin/security/SecurityPage'), 'SecurityPage');
const SettingsPage = lazyPage(() => import('@/pages/admin/settings/SettingsPage'), 'SettingsPage');
const PlatformUsersPage = lazyPage(() => import('@/pages/platform/users/PlatformUsersPage'), 'PlatformUsersPage');
const PlatformEmailSuppressionsPage = lazyPage(() => import('@/pages/platform/emails/PlatformEmailSuppressionsPage'), 'PlatformEmailSuppressionsPage');
const UnitsPage = lazyPage(() => import('@/pages/admin/units/UnitsPage'), 'UnitsPage');
const ForgotPasswordPage = lazyPage(() => import('@/pages/auth/ForgotPasswordPage'), 'ForgotPasswordPage');
const MfaSetupPage = lazyPage(() => import('@/pages/auth/MfaSetupPage'), 'MfaSetupPage');
const SelectContextPage = lazyPage(() => import('@/pages/auth/SelectContextPage'), 'SelectContextPage');
const PlatformApartmentsPage = lazyPage(() => import('@/pages/platform/apartments/PlatformApartmentsPage'), 'PlatformApartmentsPage');
const PlatformInvoicesPage = lazyPage(() => import('@/pages/platform/payments/PlatformInvoicesPage'), 'PlatformInvoicesPage');
const PlatformPaymentsPage = lazyPage(() => import('@/pages/platform/payments/PlatformPaymentsPage'), 'PlatformPaymentsPage');
const PlatformPayoutsPage = lazyPage(() => import('@/pages/platform/payments/PlatformPayoutsPage'), 'PlatformPayoutsPage');
const PlatformPlansPage = lazyPage(() => import('@/pages/platform/billing/PlatformPlansPage'), 'PlatformPlansPage');
const PlatformSubscriptionsPage = lazyPage(() => import('@/pages/platform/billing/PlatformSubscriptionsPage'), 'PlatformSubscriptionsPage');
const PlatformSubscriptionInvoicesPage = lazyPage(() => import('@/pages/platform/billing/PlatformSubscriptionInvoicesPage'), 'PlatformSubscriptionInvoicesPage');
const ResidentAnnouncementsPage = lazyPage(() => import('@/pages/resident/AnnouncementsPage'), 'ResidentAnnouncementsPage');
const MyPollsPage = lazyPage(() => import('@/pages/resident/polls/MyPollsPage'), 'MyPollsPage');
const MyPollDetailPage = lazyPage(() => import('@/pages/resident/polls/MyPollDetailPage'), 'MyPollDetailPage');
const MyAssembliesPage = lazyPage(() => import('@/pages/resident/assemblies/MyAssembliesPage'), 'MyAssembliesPage');
const MyAssemblyDetailPage = lazyPage(() => import('@/pages/resident/assemblies/MyAssemblyDetailPage'), 'MyAssemblyDetailPage');
const ConsumptionPage = lazyPage(() => import('@/pages/resident/ConsumptionPage'), 'ConsumptionPage');
const DuesPage = lazyPage(() => import('@/pages/resident/DuesPage'), 'DuesPage');
const PaymentPage = lazyPage(() => import('@/pages/resident/payment/PaymentPage'), 'PaymentPage');
const PaymentResultPage = lazyPage(() => import('@/pages/resident/payment/PaymentResultPage'), 'PaymentResultPage');
const ResidentHomePage = lazyPage(() => import('@/pages/resident/ResidentHomePage'), 'ResidentHomePage');
const MyTicketDetailPage = lazyPage(() => import('@/pages/resident/tickets/MyTicketDetailPage'), 'MyTicketDetailPage');
const MyTicketsPage = lazyPage(() => import('@/pages/resident/tickets/MyTicketsPage'), 'MyTicketsPage');
const NewTicketWizard = lazyPage(() => import('@/pages/resident/tickets/NewTicketWizard'), 'NewTicketWizard');
const MyReservationsPage = lazyPage(() => import('@/pages/resident/reservations/MyReservationsPage'), 'MyReservationsPage');
const MyTendersPage = lazyPage(() => import('@/pages/resident/tenders/MyTendersPage'), 'MyTendersPage');
const MyTenderDetailPage = lazyPage(() => import('@/pages/resident/tenders/MyTenderDetailPage'), 'MyTenderDetailPage');

export const router = createBrowserRouter([
  {
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <RootRedirect /> },
      {
        element: <RedirectIfAuthenticated />,
        children: [
          {
            element: <AuthLayout />,
            children: [
              { path: 'login', element: <LoginPage /> },
              { path: 'forgot-password', element: <ForgotPasswordPage /> },
            ],
          },
        ],
      },
      {
        element: <RequireSession />,
        children: [
          {
            element: <AuthLayout wide />,
            children: [
              { path: 'select-context', element: <SelectContextPage /> },
              // Zorunlu MFA kurulumu: rol kontrolu yok (MFA_REQUIRED kullanicisi buraya yonlenir).
              { path: 'mfa-setup', element: <MfaSetupPage /> },
            ],
          },
        ],
      },
      {
        path: 'admin',
        element: <RequireRole roles={ADMIN_ROLES} />,
        children: [
          {
            element: <AdminLayout />,
            children: [
              // Hesabim: tum panel rolleri (platform yoneticisi dahil).
              { path: 'account', element: <AccountPage /> },
              {
                // Apartmana ozel ekranlar; platform yoneticisi kendi acilis sayfasina yonlenir.
                element: <RequireRole roles={APARTMENT_ADMIN_ROLES} redirectHome />,
                children: [{ index: true, element: <DashboardPage /> }],
              },
              {
                // Yonetim firmasi portfoyu: yonetici / yonetim firmasi / denetci (apartmanlar API'den).
                element: <RequireRole roles={PORTFOLIO_ROLES} redirectHome />,
                children: [{ path: 'portfolio', element: <PortfolioPage /> }],
              },
              {
                // Ofis ekranlari: bina gorevlisi / guvenlik dogrudan URL ile girerse Genel Bakis'a doner.
                element: <RequireRole roles={OFFICE_ROLES} redirectHome />,
                children: [
                  { path: 'units', element: <UnitsPage /> },
                  { path: 'finance', element: <FinancePage /> },
                  { path: 'announcements', element: <AnnouncementsPage /> },
                  // Ortak alan rezervasyonu (denetci salt okur).
                  { path: 'reservations', element: <ReservationsPage /> },
                  // Ihale / teklif toplama (denetci yalnizca paylasilanlari salt okur).
                  { path: 'tenders', element: <TendersPage /> },
                  { path: 'tenders/:tenderId', element: <TenderDetailPage /> },
                  // Y1: anket / oylama (yonetici + yonetim firmasi yazar, denetci salt okur).
                  { path: 'polls', element: <PollsPage /> },
                  { path: 'assemblies', element: <AssembliesPage /> },
                  { path: 'import', element: <ImportPage /> },
                  { path: 'settings', element: <SettingsPage /> },
                ],
              },
              {
                // Sayac dagitimi (Finans 2.3): yonetici + denetci; hizli okuma: yonetici + bina gorevlisi.
                element: <RequireRole roles={METER_ROLES} redirectHome />,
                children: [{ path: 'meters', element: <MetersPage /> }],
              },
              {
                // Faz 3 (O1): ariza & bakim; gorevlinin mobil is listesi.
                element: <RequireRole roles={TICKET_ROLES} redirectHome />,
                children: [{ path: 'tickets', element: <TicketsPage /> }],
              },
              {
                // Ariza & bakim v2: ekipman sicili (yonetim yazar; denetci ve bina gorevlisi okur).
                element: <RequireRole roles={EQUIPMENT_ROLES} redirectHome />,
                children: [{ path: 'equipment', element: <EquipmentPage /> }],
              },
              {
                // Guvenlik kapisi: gorevli kapi ekrani + yonetimin arac / gecis / gunluk ekranlari.
                element: <RequireRole roles={GATE_ROLES} redirectHome />,
                children: [{ path: 'gate', element: <GatePage /> }],
              },
              {
                element: <RequireRole roles={MY_TASKS_ROLES} redirectHome />,
                children: [{ path: 'my-tasks', element: <MyTasksPage /> }],
              },
              {
                element: <RequireRole roles={METER_READING_ROLES} redirectHome />,
                children: [{ path: 'meter-readings', element: <ReadingEntryPage /> }],
              },
              {
                // Ekip (Faz 1): yonetici + yonetim firmasi yazar, denetci salt okur.
                element: <RequireRole roles={TEAM_ROLES} redirectHome />,
                children: [{ path: 'team', element: <TeamPage /> }],
              },
              {
                // Denetim gunlugu: apartman rolleri kendi zinciri, platform yoneticisi platform zinciri.
                element: <RequireRole roles={AUDIT_ROLES} redirectHome />,
                children: [{ path: 'audit', element: <AuditPage /> }],
              },
              {
                element: <RequireRole roles={SECURITY_ROLES} redirectHome />,
                children: [{ path: 'security', element: <SecurityPage /> }],
              },
              {
                // Platform geneli ekranlar; apartman rolleri kendi panellerine yonlenir.
                element: <RequireRole roles={PLATFORM_ROLES} redirectHome />,
                children: [
                  { path: 'apartments', element: <PlatformApartmentsPage /> },
                  { path: 'payments', element: <PlatformPaymentsPage /> },
                  { path: 'payments/transfers', element: <PlatformPayoutsPage /> },
                  { path: 'payments/invoices', element: <PlatformInvoicesPage /> },
                  { path: 'billing/subscriptions', element: <PlatformSubscriptionsPage /> },
                  { path: 'billing/plans', element: <PlatformPlansPage /> },
                  { path: 'billing/invoices', element: <PlatformSubscriptionInvoicesPage /> },
                  { path: 'users', element: <PlatformUsersPage /> },
                  { path: 'email-suppressions', element: <PlatformEmailSuppressionsPage /> },
                ],
              },
            ],
          },
        ],
      },
      {
        path: 'app',
        element: <RequireRole roles={RESIDENT_ROLES} />,
        children: [
          {
            element: <ResidentLayout />,
            children: [
              { index: true, element: <ResidentHomePage /> },
              { path: 'dues', element: <DuesPage /> },
              { path: 'tuketim', element: <ConsumptionPage /> },
              { path: 'ziyaretci', element: <MyGatePage /> },
              // Faz 3 (O1-6): ariza / talep.
              { path: 'talepler', element: <MyTicketsPage /> },
              { path: 'talepler/yeni', element: <NewTicketWizard /> },
              { path: 'talepler/:ticketId', element: <MyTicketDetailPage /> },
              { path: 'rezervasyon', element: <MyReservationsPage /> },
              { path: 'ihale', element: <MyTendersPage /> },
              { path: 'ihale/:tenderId', element: <MyTenderDetailPage /> },
              // Adim 1: online odeme baslatma `payments.online` ozelligine bagli; sonuc sayfasi her zaman acik.
              { element: <RequireFeature feature="payments.online" title="Online ödeme" />, children: [{ path: 'odeme', element: <PaymentPage /> }] },
              { path: 'odeme/sonuc', element: <PaymentResultPage /> },
              { path: 'announcements', element: <ResidentAnnouncementsPage /> },
              // Y1: anket / oylama.
              { path: 'oylamalar', element: <MyPollsPage /> },
              { path: 'oylamalar/:pollId', element: <MyPollDetailPage /> },
              // Genel kurul devami: kat maliklerine toplantilar, kararlar ve tutanak.
              { path: 'genel-kurul', element: <MyAssembliesPage /> },
              { path: 'genel-kurul/:assemblyId', element: <MyAssemblyDetailPage /> },
              { path: 'account', element: <AccountPage /> },
            ],
          },
        ],
      },
      // Misafire gonderilen gecis baglantisi: oturum gerektirmez, sunucuya istek atmaz (QR tarayicida).
      {
        path: 'gecis/:token',
        element: (
          <PageSuspense>
            <GuestPassPage />
          </PageSuspense>
        ),
      },
      { path: '403', element: <ForbiddenPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
