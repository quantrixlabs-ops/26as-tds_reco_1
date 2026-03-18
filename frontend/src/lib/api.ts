/**
 * Axios API client — JWT-authenticated, auto-refresh on 401
 */
import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';

export const BASE_URL = 'http://localhost:8000';

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 120_000,
});

// ── Token helpers ─────────────────────────────────────────────────────────────

export const tokenStorage = {
  getAccess: () => localStorage.getItem('tds_access_token'),
  getRefresh: () => localStorage.getItem('tds_refresh_token'),
  setAccess: (t: string) => localStorage.setItem('tds_access_token', t),
  setRefresh: (t: string) => localStorage.setItem('tds_refresh_token', t),
  clear: () => {
    localStorage.removeItem('tds_access_token');
    localStorage.removeItem('tds_refresh_token');
  },
};

// ── Request interceptor — attach JWT ──────────────────────────────────────────

apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStorage.getAccess();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor — refresh on 401 ────────────────────────────────────

let _refreshing = false;
let _refreshQueue: Array<(token: string | null) => void> = [];

const drainQueue = (token: string | null) => {
  _refreshQueue.forEach((cb) => cb(token));
  _refreshQueue = [];
};

apiClient.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (error.response?.status !== 401 || original._retry) {
      return Promise.reject(error);
    }
    original._retry = true;

    if (_refreshing) {
      return new Promise((resolve, reject) => {
        _refreshQueue.push((token) => {
          if (token) {
            original.headers['Authorization'] = `Bearer ${token}`;
            resolve(apiClient(original));
          } else {
            reject(error);
          }
        });
      });
    }

    _refreshing = true;
    const refreshToken = tokenStorage.getRefresh();
    if (!refreshToken) {
      _refreshing = false;
      drainQueue(null);
      tokenStorage.clear();
      window.location.href = '/login';
      return Promise.reject(error);
    }

    try {
      const { data } = await axios.post(`${BASE_URL}/api/auth/refresh`, {
        refresh_token: refreshToken,
      });
      const newAccess: string = data.access_token;
      tokenStorage.setAccess(newAccess);
      apiClient.defaults.headers.common['Authorization'] = `Bearer ${newAccess}`;
      drainQueue(newAccess);
      original.headers['Authorization'] = `Bearer ${newAccess}`;
      return apiClient(original);
    } catch {
      drainQueue(null);
      tokenStorage.clear();
      window.location.href = '/login';
      return Promise.reject(error);
    } finally {
      _refreshing = false;
    }
  },
);

// ── Types ─────────────────────────────────────────────────────────────────────

export type Role = 'ADMIN' | 'REVIEWER' | 'PREPARER';
export type RunStatus =
  | 'PROCESSING'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'FAILED';
export type ConfidenceTier = 'HIGH' | 'MEDIUM' | 'LOW';
export type ExceptionSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type MatchType =
  | 'EXACT'
  | 'SINGLE'
  | 'COMBO_2'
  | 'COMBO_3'
  | 'COMBO_4'
  | 'COMBO_5'
  | 'CLR_GROUP'
  | 'FORCE_SINGLE'
  | 'FORCE_COMBO'
  | 'PRIOR_EXACT'
  | 'PRIOR_SINGLE'
  | 'PRIOR_COMBO_2'
  | 'PRIOR_COMBO_3'
  | 'PRIOR_COMBO_4'
  | 'PRIOR_COMBO_5';

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  user_id: string;
  role: Role;
  full_name: string;
}

export interface RunSummary {
  id: string;
  run_number: number;
  financial_year: string;
  deductor_name: string;
  tan: string;
  status: RunStatus;
  match_rate_pct: number;
  matched_count: number;
  total_26as_entries: number;
  unmatched_26as_count: number;
  high_confidence_count: number;
  medium_confidence_count: number;
  low_confidence_count: number;
  constraint_violations: number;
  control_total_balanced: boolean;
  has_pan_issues: boolean;
  has_rate_mismatches: boolean;
  algorithm_version: string;
  sap_file_hash: string;
  as26_file_hash: string;
  created_at: string;
  completed_at: string | null;
  created_by?: string;
}

export interface MatchedPair {
  id: string;
  as26_index: number;
  as26_date: string | null;
  as26_amount: number;
  section: string;
  books_sum: number;
  variance_amt: number;
  variance_pct: number;
  match_type: MatchType;
  confidence: ConfidenceTier;
  invoice_count: number;
  invoice_refs: string[];
  invoice_dates: (string | null)[];
  invoice_amounts: number[];
  sgl_flags: string[];
}

export interface Unmatched26AS {
  index: number;
  deductor_name: string;
  tan: string;
  section: string;
  date: string | null;
  amount: number;
  reason_code: string;
  reason_label: string;
}

export interface UnmatchedBook {
  invoice_ref: string;
  clearing_doc: string;
  doc_date: string | null;
  amount: number;
  doc_type: string;
  sgl_flag: string | null;
}

export interface Exception {
  id: string;
  severity: ExceptionSeverity;
  category: string;
  description: string;
  affected_ref: string | null;
  amount: number | null;
  reviewed: boolean;
  review_action: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface BatchCandidate {
  deductor_name: string;
  tan: string;
  score: number;
  entry_count: number;
}

export interface BatchMapping {
  sap_filename: string;
  identity_string: string;
  status: 'AUTO_CONFIRMED' | 'PENDING' | 'NO_MATCH';
  confirmed_name: string | null;
  confirmed_tan: string | null;
  fuzzy_score: number | null;
  top_candidates: BatchCandidate[];
}

export interface BatchParty {
  deductor_name: string;
  tan: string;
  entry_count: number;
}

export interface BatchPreviewResponse {
  mappings: BatchMapping[];
  all_parties: BatchParty[];
}

export interface BatchRunSummary {
  run_id: string | null;
  run_number?: number;
  sap_filename: string;
  deductor_name: string | null;
  match_rate_pct?: number;
  status: string;
  error?: string;
}

export interface BatchRunResponse {
  batch_id: string;
  runs: BatchRunSummary[];
  total: number;
}

export interface AuditEvent {
  id: string;
  event_type: string;
  actor: string;
  actor_role: Role;
  timestamp: string;
  notes: string | null;
  metadata: Record<string, unknown> | null;
}

export interface FinancialYearsResponse {
  years: string[];
  default: string;
}

// ── Auth APIs ─────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    apiClient.post<AuthResponse>('/api/auth/login', { email, password }).then((r) => r.data),

  setupAdmin: (email: string, password: string, full_name: string) =>
    apiClient
      .post<AuthResponse>('/api/auth/setup-admin', { email, password, full_name })
      .then((r) => r.data),

  me: () => apiClient.get<User>('/api/auth/me').then((r) => r.data),

  users: () => apiClient.get<User[]>('/api/auth/users').then((r) => r.data),

  createUser: (email: string, password: string, full_name: string, role: Role) =>
    apiClient
      .post<User>('/api/auth/users', { email, password, full_name, role })
      .then((r) => r.data),
};

// ── Runs APIs ─────────────────────────────────────────────────────────────────

export const runsApi = {
  list: () => apiClient.get<RunSummary[]>('/api/runs').then((r) => r.data),

  get: (id: string) => apiClient.get<RunSummary>(`/api/runs/${id}`).then((r) => r.data),

  create: (sapFile: File, as26File: File, financialYear: string) => {
    const form = new FormData();
    form.append('sap_file', sapFile);
    form.append('as26_file', as26File);
    form.append('financial_year', financialYear);
    return apiClient
      .post<{ run_id: string; run_number: number; status: RunStatus }>('/api/runs', form)
      .then((r) => r.data);
  },

  batchPreview: (sapFiles: File[], as26File: File) => {
    const form = new FormData();
    form.append('as26_file', as26File);
    sapFiles.forEach((f) => form.append('sap_files', f));
    return apiClient
      .post<BatchPreviewResponse>('/api/runs/batch/preview', form)
      .then((r) => r.data);
  },

  batchRun: (
    sapFiles: File[],
    as26File: File,
    financialYear: string,
    mappings: Record<string, Array<{ deductor_name: string; tan: string }>>,
  ) => {
    const form = new FormData();
    form.append('as26_file', as26File);
    sapFiles.forEach((f) => form.append('sap_files', f));
    form.append('financial_year', financialYear);
    form.append('mappings_json', JSON.stringify(mappings));
    return apiClient
      .post<BatchRunResponse>('/api/runs/batch', form)
      .then((r) => r.data);
  },

  matched: (id: string, params?: { confidence?: ConfidenceTier; match_type?: MatchType }) =>
    apiClient
      .get<MatchedPair[]>(`/api/runs/${id}/matched`, { params })
      .then((r) => r.data),

  unmatched26as: (id: string) =>
    apiClient.get<Unmatched26AS[]>(`/api/runs/${id}/unmatched-26as`).then((r) => r.data),

  unmatchedBooks: (id: string) =>
    apiClient.get<UnmatchedBook[]>(`/api/runs/${id}/unmatched-books`).then((r) => r.data),

  exceptions: (
    id: string,
    params?: { severity?: ExceptionSeverity; reviewed?: boolean },
  ) =>
    apiClient
      .get<Exception[]>(`/api/runs/${id}/exceptions`, { params })
      .then((r) => r.data),

  review: (id: string, action: 'APPROVED' | 'REJECTED', notes?: string) =>
    apiClient.post(`/api/runs/${id}/review`, { action, notes }).then((r) => r.data),

  reviewException: (
    runId: string,
    exception_id: string,
    action: string,
    notes?: string,
  ) =>
    apiClient
      .post(`/api/runs/${runId}/exceptions/review`, { exception_id, action, notes })
      .then((r) => r.data),

  downloadUrl: (id: string) => `${BASE_URL}/api/runs/${id}/download`,

  auditTrail: (id: string) =>
    apiClient.get<AuditEvent[]>(`/api/runs/${id}/audit-trail`).then((r) => r.data),
};

// ── Misc APIs ─────────────────────────────────────────────────────────────────

export const miscApi = {
  financialYears: () =>
    apiClient.get<FinancialYearsResponse>('/api/financial-years').then((r) => r.data),

  health: () => apiClient.get('/api/health').then((r) => r.data),
};
