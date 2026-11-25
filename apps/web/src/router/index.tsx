import { createBrowserRouter } from 'react-router';
import { AdminLayout } from '@/layouts/AdminLayout';
import { AuthLayout } from '@/layouts/AuthLayout';
import { ResidentLayout } from '@/layouts/ResidentLayout';
import { AnnouncementsPage } from '@/pages/admin/announcements/AnnouncementsPage';
import { DashboardPage } from '@/pages/admin/DashboardPage';
import { FinancePage } from '@/pages/admin/finance/FinancePage';
import { MetersPage } from '@/pages/admin/meters/MetersPage';
import { ReadingEntryPage } from '@/pages/admin/meters/ReadingEntryPage';
import { ImportPage } from '@/pages/admin/import/ImportPage';
import { AccountPage } from '@/pages/account/AccountPage';
import { AuditPage } from '@/pages/admin/audit/AuditPage';
import { TeamPage } from '@/pages/admin/team/TeamPage';
import { SecurityPage } from '@/pages/admin/security/SecurityPage';
import { SettingsPage } from '@/pages/admin/settings/SettingsPage';
import { PlatformUsersPage } from '@/pages/platform/users/PlatformUsersPage';
import { UnitsPage } from '@/pages/admin/units/UnitsPage';
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage';
import { LoginPage } from '@/pages/auth/LoginPage';
import { MfaSetupPage } from '@/pages/auth/MfaSetupPage';
import { SelectContextPage } from '@/pages/auth/SelectContextPage';
import { ForbiddenPage, NotFoundPage, RouteErrorPage } from '@/pages/errors/ErrorPages';
import { PlaceholderPage } from '@/pages/PlaceholderPage';
import { PlatformApartmentsPage } from '@/pages/platform/apartments/PlatformApartmentsPage';
import { PlatformInvoicesPage } from '@/pages/platform/payments/PlatformInvoicesPage';
import { PlatformPaymentsPage } from '@/pages/platform/payments/PlatformPaymentsPage';
import { PlatformPayoutsPage } from '@/pages/platform/payments/PlatformPayoutsPage';
import { ResidentAnnouncementsPage } from '@/pages/resident/AnnouncementsPage';
import { ConsumptionPage } from '@/pages/resident/ConsumptionPage';
import { DuesPage } from '@/pages/resident/DuesPage';
import { PaymentPage } from '@/pages/resident/payment/PaymentPage';
import { PaymentResultPage } from '@/pages/resident/payment/PaymentResultPage';
import { ResidentHomePage } from '@/pages/resident/ResidentHomePage';
import { ADMIN_ROLES, APARTMENT_ADMIN_ROLES, AUDIT_ROLES, METER_READING_ROLES, METER_ROLES, PLATFORM_ROLES, RESIDENT_ROLES, SECURITY_ROLES, TEAM_ROLES } from '@/types/roles';
import { RedirectIfAuthenticated, RequireRole, RequireSession, RootRedirect } from './guards';

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
                children: [
                  { index: true, element: <DashboardPage /> },
                  { path: 'units', element: <UnitsPage /> },
                  { path: 'finance', element: <FinancePage /> },
                  { path: 'announcements', element: <AnnouncementsPage /> },
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
                  { path: 'users', element: <PlatformUsersPage /> },
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
              { path: 'odeme', element: <PaymentPage /> },
              { path: 'odeme/sonuc', element: <PaymentResultPage /> },
              { path: 'announcements', element: <ResidentAnnouncementsPage /> },
              { path: 'account', element: <AccountPage /> },
            ],
          },
        ],
      },
      { path: '403', element: <ForbiddenPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
