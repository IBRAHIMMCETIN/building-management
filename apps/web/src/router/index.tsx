import { createBrowserRouter } from 'react-router';
import { AdminLayout } from '@/layouts/AdminLayout';
import { AuthLayout } from '@/layouts/AuthLayout';
import { ResidentLayout } from '@/layouts/ResidentLayout';
import { AnnouncementsPage } from '@/pages/admin/announcements/AnnouncementsPage';
import { DashboardPage } from '@/pages/admin/DashboardPage';
import { FinancePage } from '@/pages/admin/finance/FinancePage';
import { SettingsPage } from '@/pages/admin/settings/SettingsPage';
import { UnitsPage } from '@/pages/admin/units/UnitsPage';
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage';
import { LoginPage } from '@/pages/auth/LoginPage';
import { SelectContextPage } from '@/pages/auth/SelectContextPage';
import { ForbiddenPage, NotFoundPage, RouteErrorPage } from '@/pages/errors/ErrorPages';
import { PlaceholderPage } from '@/pages/PlaceholderPage';
import { ResidentAnnouncementsPage } from '@/pages/resident/AnnouncementsPage';
import { DuesPage } from '@/pages/resident/DuesPage';
import { ResidentHomePage } from '@/pages/resident/ResidentHomePage';
import { ADMIN_ROLES, RESIDENT_ROLES } from '@/types/roles';
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
          { element: <AuthLayout wide />, children: [{ path: 'select-context', element: <SelectContextPage /> }] },
        ],
      },
      {
        path: 'admin',
        element: <RequireRole roles={ADMIN_ROLES} />,
        children: [
          {
            element: <AdminLayout />,
            children: [
              { index: true, element: <DashboardPage /> },
              { path: 'units', element: <UnitsPage /> },
              { path: 'finance', element: <FinancePage /> },
              { path: 'announcements', element: <AnnouncementsPage /> },
              { path: 'settings', element: <SettingsPage /> },
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
