/**
 * App — React Router setup with auth guards + lazy-loaded routes
 */
import { lazy, Suspense, type ReactNode } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/ui/Toast';
import { AppLayout } from './components/layout/AppLayout';
import { FullPageSpinner } from './components/ui/Spinner';
import { ErrorBoundary } from './components/ui/ErrorBoundary';

// ── Lazy-loaded pages (code-split per route) ─────────────────────────────────

const LoginPage = lazy(() => import('./pages/LoginPage'));
const SetupPage = lazy(() => import('./pages/SetupPage'));
const SignUpPage = lazy(() => import('./pages/SignUpPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const NewRunPage = lazy(() => import('./pages/NewRunPage'));
const RunDetailPage = lazy(() => import('./pages/RunDetailPage'));
const RunHistoryPage = lazy(() => import('./pages/RunHistoryPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));

// ── React Query client ────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// ── Suspense wrapper ──────────────────────────────────────────────────────────

function SuspenseWrap({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<FullPageSpinner message="Loading page…" />}>
      {children}
    </Suspense>
  );
}

// ── Auth guards ───────────────────────────────────────────────────────────────

function PrivateRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <FullPageSpinner message="Authenticating…" />;
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return (
    <AppLayout>
      <ErrorBoundary>
        <SuspenseWrap>{children}</SuspenseWrap>
      </ErrorBoundary>
    </AppLayout>
  );
}

function AdminRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'ADMIN') return <Navigate to="/" replace />;
  return (
    <AppLayout>
      <ErrorBoundary>
        <SuspenseWrap>{children}</SuspenseWrap>
      </ErrorBoundary>
    </AppLayout>
  );
}

function GuestRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <SuspenseWrap>{children}</SuspenseWrap>;
}

// ── Router ────────────────────────────────────────────────────────────────────

function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route
        path="/login"
        element={
          <GuestRoute>
            <LoginPage />
          </GuestRoute>
        }
      />
      <Route
        path="/setup"
        element={
          <GuestRoute>
            <SetupPage />
          </GuestRoute>
        }
      />
      <Route
        path="/signup"
        element={
          <GuestRoute>
            <SignUpPage />
          </GuestRoute>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <GuestRoute>
            <ForgotPasswordPage />
          </GuestRoute>
        }
      />
      <Route
        path="/reset-password"
        element={
          <GuestRoute>
            <ResetPasswordPage />
          </GuestRoute>
        }
      />
      <Route
        path="/verify-email"
        element={
          <GuestRoute>
            <VerifyEmailPage />
          </GuestRoute>
        }
      />

      {/* Authenticated */}
      <Route
        path="/"
        element={
          <PrivateRoute>
            <DashboardPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/runs"
        element={
          <PrivateRoute>
            <RunHistoryPage />
          </PrivateRoute>
        }
      />
      {/* Redirect old batch URL to unified run history */}
      <Route path="/runs/batch" element={<Navigate to="/runs" replace />} />
      <Route
        path="/runs/new"
        element={
          <PrivateRoute>
            <NewRunPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/runs/:id"
        element={
          <PrivateRoute>
            <RunDetailPage />
          </PrivateRoute>
        }
      />

      {/* Admin only */}
      <Route
        path="/admin"
        element={
          <AdminRoute>
            <AdminPage />
          </AdminRoute>
        }
      />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ToastProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </ToastProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
