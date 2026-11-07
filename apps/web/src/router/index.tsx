import { createBrowserRouter } from 'react-router';
import { AdminLayout } from '@/layouts/AdminLayout';
import { AuthLayout } from '@/layouts/AuthLayout';
import { ResidentLayout } from '@/layouts/ResidentLayout';
import { DashboardPage } from '@/pages/admin/DashboardPage';
import { UnitsPage } from '@/pages/admin/units/UnitsPage';
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage';
import { LoginPage } from '@/pages/auth/LoginPage';
import { SelectContextPage } from '@/pages/auth/SelectContextPage';
import { ForbiddenPage, NotFoundPage, RouteErrorPage } from '@/pages/errors/ErrorPages';
import { PlaceholderPage } from '@/pages/PlaceholderPage';
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
              { path: 'finance', element: <PlaceholderPage title="Finans" /> },
              { path: 'announcements', element: <PlaceholderPage title="Duyurular" /> },
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
              { path: 'dues', element: <PlaceholderPage title="Borçlarım" /> },
              { path: 'announcements', element: <PlaceholderPage title="Duyurular" /> },
            ],
          },
        ],
      },
      { path: '403', element: <ForbiddenPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
