import { createBrowserRouter } from 'react-router';
import { AdminLayout } from '@/layouts/AdminLayout';
import { AuthLayout } from '@/layouts/AuthLayout';
import { ResidentLayout } from '@/layouts/ResidentLayout';
import { AnnouncementsPage } from '@/pages/admin/announcements/AnnouncementsPage';
import { DashboardPage } from '@/pages/admin/DashboardPage';
import { FinancePage } from '@/pages/admin/finance/FinancePage';
import { ImportPage } from '@/pages/admin/import/ImportPage';
import { SettingsPage } from '@/pages/admin/settings/SettingsPage';
import { UnitsPage } from '@/pages/admin/units/UnitsPage';
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage';
import { LoginPage } from '@/pages/auth/LoginPage';
import { MfaSetupPage } from '@/pages/auth/MfaSetupPage';
import { SelectContextPage } from '@/pages/auth/SelectContextPage';
import { ForbiddenPage, NotFoundPage, RouteErrorPage } from '@/pages/errors/ErrorPages';
import { PlaceholderPage } from '@/pages/PlaceholderPage';
import { PlatformApartmentsPage } from '@/pages/platform/apartments/PlatformApartmentsPage';
import { PlatformPaymentsPage } from '@/pages/platform/payments/PlatformPaymentsPage';
import { ResidentAnnouncementsPage } from '@/pages/resident/AnnouncementsPage';
import { DuesPage } from '@/pages/resident/DuesPage';
import { PaymentPage } from '@/pages/resident/payment/PaymentPage';
import { PaymentResultPage } from '@/pages/resident/payment/PaymentResultPage';
import { ResidentHomePage } from '@/pages/resident/ResidentHomePage';
import { ADMIN_ROLES, APARTMENT_ADMIN_ROLES, PLATFORM_ROLES, RESIDENT_ROLES } from '@/types/roles';
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
                // Platform geneli ekranlar; apartman rolleri kendi panellerine yonlenir.
                element: <RequireRole roles={PLATFORM_ROLES} redirectHome />,
                children: [
                  { path: 'apartments', element: <PlatformApartmentsPage /> },
                  { path: 'payments', element: <PlatformPaymentsPage /> },
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
              { path: 'odeme', element: <PaymentPage /> },
              { path: 'odeme/sonuc', element: <PaymentResultPage /> },
              { path: 'announcements', element: <ResidentAnnouncementsPage /> },
            ],
          },
        ],
      },
      { path: '403', element: <ForbiddenPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
