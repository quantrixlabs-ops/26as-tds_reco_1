/**
 * ErrorBoundary — catches unhandled JS errors and shows a friendly fallback UI.
 * Wrap around route-level or page-level components to prevent full-app crashes.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Optional custom fallback — receives error + reset callback */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Where to redirect on "Go Home" — defaults to "/" */
  homePath?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleGoHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = this.props.homePath ?? '/';
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset);
      }

      return (
        <div className="flex items-center justify-center min-h-[400px] p-6">
          <div className="max-w-md w-full text-center space-y-4">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-red-50 mx-auto">
              <AlertTriangle className="h-7 w-7 text-red-500" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Something went wrong</h2>
              <p className="text-sm text-gray-500 mt-1">
                An unexpected error occurred. You can try again or return to the dashboard.
              </p>
            </div>
            {import.meta.env.DEV && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-left">
                <p className="text-xs font-mono text-red-600 break-all">
                  {this.state.error.message}
                </p>
              </div>
            )}
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.handleReset}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 transition-colors"
              >
                <RefreshCw className="h-4 w-4" />
                Try again
              </button>
              <button
                onClick={this.handleGoHome}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-[#1B3A5C] text-white hover:bg-[#15304d] transition-colors"
              >
                <Home className="h-4 w-4" />
                Go to Dashboard
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
