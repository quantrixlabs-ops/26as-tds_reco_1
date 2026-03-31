/**
 * Axios API client — JWT-authenticated, auto-refresh on 401
 */
import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';

// In dev: empty string uses Vite proxy (/api/* → http://localhost:8000)
// In prod: set VITE_API_URL to your backend URL (e.g. https://your-backend.railway.app)
export const BASE_URL = import.meta.env.VITE_API_URL || '';

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 300_000,
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
  is_verified?: boolean;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  user_id: string;
  role: Role;
  full_name: string;
  is_verified?: boolean;
}

export interface SecurityQuestionInput {
  question: string;
  answer: string;
}

export interface RegisterPayload {
  email: string;
  password: string;
  full_name: string;
  security_questions?: SecurityQuestionInput[];
}

export interface PasswordStrengthResult {
  strength: number;
  strength_label: string;
  valid: boolean;
  errors: string[];
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
  total_sap_entries: number;
  suggested_count: number;
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
  mode: 'SINGLE' | 'BATCH';
  batch_id: string | null;
  batch_name: string | null;
  batch_tags: string[] | null;
  parent_batch_id: string | null;
  created_by?: string;
  // Amount totals
  total_26as_amount: number;
  total_sap_amount?: number;
  matched_amount: number;
  unmatched_26as_amount: number;
  // Phase 4 fields
  assigned_reviewer_id?: string | null;
  archived?: boolean;
}

export interface ScoreBreakdown {
  variance: number;
  date_proximity: number;
  section: number;
  clearing_doc: number;
  historical: number;
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
  composite_score?: number;
  score_breakdown?: ScoreBreakdown;
  clearing_doc?: string;
  cross_fy?: boolean;
  is_prior_year?: boolean;
  ai_risk_flag?: boolean;
  ai_risk_reason?: string | null;
  remark?: string | null;
}

export interface Unmatched26AS {
  id?: string;
  index: number;
  deductor_name: string;
  tan: string;
  section: string;
  date: string | null;
  transaction_date?: string | null;
  amount: number;
  reason_code: string;
  reason_label: string;
  reason_detail?: string;
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
  status: 'AUTO_CONFIRMED' | 'PENDING' | 'NO_MATCH' | 'NO_DEDUCTORS';
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
  no_deductors?: boolean;
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

// ── Admin Settings ──────────────────────────────────────────────────────

export interface AdminSettings {
  id: string;
  doc_types_include: string[];
  doc_types_exclude: string[];
  date_hard_cutoff_days: number;
  date_soft_preference_days: number;
  enforce_books_before_26as: boolean;
  variance_normal_ceiling_pct: number;
  variance_suggested_ceiling_pct: number;
  exclude_sgl_v: boolean;
  max_combo_size: number;
  date_clustering_preference: boolean;
  allow_cross_fy: boolean;
  cross_fy_lookback_years: number;
  force_match_enabled: boolean;
  noise_threshold: number;
  clearing_group_enabled: boolean;
  clearing_group_variance_pct: number | null;
  proxy_clearing_enabled: boolean;
  // Batch Processing (Phase 1)
  batch_concurrency_limit: number;
  batch_parse_cache_enabled: boolean;
  batch_invoice_dedup_enabled: boolean;
  batch_control_total_enabled: boolean;
  // Batch Processing (Phase 2)
  batch_auto_retry_count: number;
  batch_duplicate_detection_enabled: boolean;
  batch_progress_dashboard_enabled: boolean;
  batch_comparison_enabled: boolean;
  batch_variance_trend_enabled: boolean;
  batch_export_template: string;
  batch_notification_enabled: boolean;
  batch_notification_webhook_url: string | null;
  batch_scheduling_enabled: boolean;
  // Reconciliation Intelligence (Phase 3)
  section_filter_enabled: boolean;
  invoice_date_proximity_enabled: boolean;
  max_date_gap_days: number;
  as26_duplicate_check_enabled: boolean;
  credit_note_handling_enabled: boolean;
  bipartite_matching_enabled: boolean;
  enumerate_alternatives_enabled: boolean;
  amount_control_totals_enabled: boolean;
  match_type_distribution_enabled: boolean;
  pan_detection_enabled: boolean;
  large_batch_mode_enabled: boolean;
  max_sap_rows_per_run: number;
  // Workflow & Compliance (Phase 4)
  approval_workflow_enabled: boolean;
  comment_threads_enabled: boolean;
  reviewer_assignment_enabled: boolean;
  bulk_operations_enabled: boolean;
  run_archival_enabled: boolean;
  archival_retention_days: number;
  compliance_report_enabled: boolean;
  data_quality_precheck_enabled: boolean;
  custom_exception_rules_enabled: boolean;
  run_comparison_enabled: boolean;
  enhanced_webhook_enabled: boolean;
  webhook_retry_count: number;
  webhook_secret: string | null;
  // Advanced Tuning & Profiles (Phase 5)
  high_value_threshold: number;
  auto_escalate_high_value: boolean;
  force_match_exception_severity: string;
  score_weight_variance: number;
  score_weight_date: number;
  score_weight_section: number;
  score_weight_clearing: number;
  score_weight_historical: number;
  custom_scoring_enabled: boolean;
  variance_ceiling_single_pct: number;
  variance_ceiling_combo_pct: number;
  variance_ceiling_force_single_pct: number;
  variance_ceiling_force_combo_pct: number;
  custom_variance_ceilings_enabled: boolean;
  combo_iteration_budget: number;
  combo_pool_cap: number;
  combo_date_window_days: number;
  date_proximity_profile: string;
  filing_lag_days_tolerance: number;
  clearing_doc_bonus_score: number;
  proxy_clearing_date_window_days: number;
  rate_tolerance_pct: number;
  rate_mismatch_severity: string;
  parser_lenient_mode: boolean;
  cleaner_duplicate_strategy: string;
  export_show_score_breakdown: boolean;
  export_template_active: string;
  dashboard_match_rate_target_pct: number;
  dashboard_variance_warning_pct: number;
  dashboard_exclude_failed_from_trends: boolean;
  // Reporting, Intelligence & Safety (Phase 6)
  confidence_high_variance_threshold: number;
  confidence_medium_variance_threshold: number;
  confidence_score_boost_threshold: number;
  exact_tolerance_rupees: number;
  auto_approval_enabled: boolean;
  auto_approval_min_match_rate: number;
  auto_approval_max_exceptions: number;
  high_confidence_sections: string;
  section_confidence_boost_pct: number;
  unmatched_alerting_enabled: boolean;
  unmatched_critical_amount_threshold: number;
  unmatched_critical_count_threshold: number;
  force_match_alert_enabled: boolean;
  force_match_alert_pct_threshold: number;
  audit_log_retention_enabled: boolean;
  audit_log_retention_days: number;
  audit_log_redact_amounts: boolean;
  excel_include_match_distribution: boolean;
  excel_include_control_totals: boolean;
  excel_include_variance_analysis: boolean;
  run_detail_default_sort: string;
  run_detail_items_per_page: number;
  run_detail_show_score_columns: boolean;
  batch_hide_zero_match_parties: boolean;
  batch_summary_sort_by: string;
  batch_trend_window_days: number;
  // Phase 7: Security, Governance & Data Controls
  session_inactivity_timeout_min: number;
  max_concurrent_sessions: number;
  force_reauth_on_approve: boolean;
  password_min_length: number;
  password_require_mixed_case: boolean;
  password_require_number: boolean;
  password_expiry_days: number;
  max_failed_login_attempts: number;
  login_lockout_duration_min: number;
  notify_admin_on_lockout: boolean;
  run_retention_days: number;
  auto_archive_after_days: number;
  purge_exports_after_days: number;
  export_watermark_enabled: boolean;
  export_watermark_text: string;
  export_require_approval: boolean;
  redact_tan_in_logs: boolean;
  redact_pan_in_exports: boolean;
  mask_amounts_in_preview: boolean;
  max_upload_size_mb: number;
  max_rows_per_file: number;
  reject_empty_columns: boolean;
  anomaly_detection_enabled: boolean;
  amount_outlier_stddev: number;
  match_rate_drop_alert_pct: number;
  batch_retry_backoff_seconds: number;
  batch_stop_on_failure_count: number;
  batch_partial_resume_enabled: boolean;
  system_alerts_enabled: boolean;
  slow_run_threshold_seconds: number;
  high_exception_rate_pct: number;
  updated_at: string | null;
}

export type AdminSettingsUpdate = Partial<Omit<AdminSettings, 'id' | 'updated_at'>>;

// ── Suggested Matches ──────────────────────────────────────────────────

export type SuggestedCategory =
  | 'HIGH_VARIANCE_3_20'
  | 'HIGH_VARIANCE_20_PLUS'
  | 'DATE_SOFT_PREFERENCE'
  | 'ADVANCE_PAYMENT'
  | 'FORCE'
  | 'CROSS_FY'
  | 'TIER_CAP_EXCEEDED';

export interface SuggestedMatch {
  id: string;
  run_id: string;
  as26_index: number | null;
  as26_amount: number | null;
  as26_date: string | null;
  section: string | null;
  tan: string | null;
  deductor_name: string | null;
  invoice_refs: string[];
  invoice_amounts: number[];
  invoice_dates: (string | null)[];
  clearing_doc: string | null;
  books_sum: number;
  match_type: string | null;
  variance_amt: number;
  variance_pct: number;
  confidence: ConfidenceTier;
  composite_score: number;
  cross_fy: boolean;
  is_prior_year: boolean;
  category: SuggestedCategory;
  requires_remarks: boolean;
  alert_message: string | null;
  authorized: boolean;
  authorized_by_id: string | null;
  authorized_at: string | null;
  remarks: string | null;
  rejected: boolean;
  rejected_by_id: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface SuggestedSummary {
  total: number;
  by_category: Record<string, number>;
  authorized: number;
  rejected: number;
  pending: number;
}

// ── Comments (Phase 4B) ──────────────────────────────────────────────────

export interface RunComment {
  id: string;
  run_id: string;
  user_id: string;
  user_name: string;
  user_role: string | null;
  content: string;
  parent_id: string | null;
  context_type: string | null;
  context_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// ── Custom Exception Rules (Phase 4H) ────────────────────────────────────

export interface ExceptionRule {
  id: string;
  name: string;
  description: string | null;
  field: string;
  operator: string;
  value: string;
  severity: string;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

// ── Progress Tracking ──────────────────────────────────────────────────────

export type ProgressStatus =
  | 'QUEUED'
  | 'PARSING'
  | 'VALIDATING'
  | 'PHASE_A'
  | 'PHASE_B_SINGLE'
  | 'PHASE_B_COMBO'
  | 'PHASE_C'
  | 'PHASE_E'
  | 'POST_VALIDATE'
  | 'PERSISTING'
  | 'EXCEPTIONS'
  | 'FINALIZING'
  | 'COMPLETE'
  | 'FAILED'
  | 'NOT_FOUND';

export interface RunProgress {
  run_id: string;
  status: ProgressStatus;
  stage_label: string;
  overall_pct: number;
  total_26as: number;
  total_sap: number;
  matched_so_far: number;
  match_rate_so_far: number;
  current_phase_detail: string;
  elapsed_seconds: number;
  eta_seconds: number | null;
  stages_completed: string[];
  started_at: number;
  updated_at: number;
}

// ── Auth APIs ─────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string, remember_me?: boolean) =>
    apiClient.post<AuthResponse>('/api/auth/login', { email, password, remember_me }).then((r) => r.data),

  register: (payload: RegisterPayload) =>
    apiClient.post<User>('/api/auth/register', payload).then((r) => r.data),

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

  verifyEmail: (token: string) =>
    apiClient.post<{ message: string }>('/api/auth/verify-email', { token }).then((r) => r.data),

  resendVerification: (email: string) =>
    apiClient.post<{ message: string }>('/api/auth/resend-verification', { email }).then((r) => r.data),

  forgotPassword: (email: string) =>
    apiClient.post<{ message: string }>('/api/auth/forgot-password', { email }).then((r) => r.data),

  resetPassword: (token: string, new_password: string) =>
    apiClient.post<{ message: string }>('/api/auth/reset-password', { token, new_password }).then((r) => r.data),

  checkPasswordStrength: (password: string) =>
    apiClient.post<PasswordStrengthResult>('/api/auth/password-strength', { password }).then((r) => r.data),

  getSecurityQuestions: (email: string) =>
    apiClient.get<{ questions: string[] }>(`/api/auth/security-questions?email=${encodeURIComponent(email)}`).then((r) => r.data),

  verifySecurityQuestions: (email: string, answers: SecurityQuestionInput[]) =>
    apiClient.post<{ verified: boolean }>('/api/auth/verify-security-questions', { email, answers }).then((r) => r.data),
};

// ── Runs APIs ─────────────────────────────────────────────────────────────────

export const runsApi = {
  list: () => apiClient.get<RunSummary[]>('/api/runs').then((r) => r.data),

  get: (id: string) => apiClient.get<RunSummary>(`/api/runs/${id}`).then((r) => r.data),

  create: (
    sapFile: File,
    as26File: File,
    financialYear: string,
    parties?: Array<{ deductor_name: string; tan: string }> | null,
    runConfig?: Record<string, unknown> | null,
  ) => {
    const form = new FormData();
    form.append('sap_file', sapFile);
    form.append('as26_file', as26File);
    form.append('financial_year', financialYear);
    if (parties && parties.length > 0) form.append('mappings_json', JSON.stringify(parties));
    if (runConfig) form.append('run_config_json', JSON.stringify(runConfig));
    return apiClient
      .post<{ run_id: string; run_number: number; status: RunStatus }>('/api/runs', form)
      .then((r) => r.data);
  },

  batchPreview: (sapFiles: File[], as26File: File) => {
    const form = new FormData();
    form.append('as26_file', as26File);
    // Send only filenames (not full file content) — dramatically faster for large batches
    form.append('sap_filenames_json', JSON.stringify(sapFiles.map((f) => f.name)));
    return apiClient
      .post<BatchPreviewResponse>('/api/runs/batch/preview', form)
      .then((r) => r.data);
  },

  batchRun: (
    sapFiles: File[],
    as26File: File,
    financialYear: string,
    mappings: Record<string, Array<{ deductor_name: string; tan: string }>>,
    runConfig?: Record<string, unknown> | null,
  ) => {
    const form = new FormData();
    form.append('as26_file', as26File);
    sapFiles.forEach((f) => form.append('sap_files', f));
    form.append('financial_year', financialYear);
    form.append('mappings_json', JSON.stringify(mappings));
    if (runConfig) form.append('run_config_json', JSON.stringify(runConfig));
    return apiClient
      .post<BatchRunResponse>('/api/runs/batch', form)
      .then((r) => r.data);
  },

  /** Chunked batch: Step 1 — upload 26AS only, get batch_id */
  batchInit: (
    as26File: File,
    financialYear: string,
    runConfig?: Record<string, unknown> | null,
  ) => {
    const form = new FormData();
    form.append('as26_file', as26File);
    form.append('financial_year', financialYear);
    if (runConfig) form.append('run_config_json', JSON.stringify(runConfig));
    return apiClient
      .post<{ batch_id: string; status: string }>('/api/runs/batch/init', form)
      .then((r) => r.data);
  },

  /** Chunked batch: Step 2 — upload ONE SAP file + its mapping */
  batchAddParty: (
    batchId: string,
    sapFile: File,
    parties: Array<{ deductor_name: string; tan: string }>,
  ) => {
    const form = new FormData();
    form.append('sap_file', sapFile);
    form.append('mappings_json', JSON.stringify(parties));
    return apiClient
      .post<{ batch_id: string; run: BatchRunSummary; total_so_far: number }>(
        `/api/runs/batch/${batchId}/add`,
        form,
      )
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

  download: async (id: string) => {
    const res = await apiClient.get(`/api/runs/${id}/download`, {
      responseType: 'blob',
    });
    // Extract filename from Content-Disposition header or use a default
    const disposition = res.headers['content-disposition'] || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || `TDS_Reco_RUN_${id}.xlsx`;
    // Ensure blob has correct MIME type
    const blob = new Blob([res.data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Delay cleanup so the browser has time to start the download
    setTimeout(() => {
      a.remove();
      window.URL.revokeObjectURL(url);
    }, 1000);
  },

  batchDownload: async (batchId: string) => {
    const res = await apiClient.get(`/api/runs/batch/${batchId}/download`, {
      responseType: 'blob',
    });
    const disposition = res.headers['content-disposition'] || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || `TDS_Batch_${batchId}.xlsx`;
    const blob = new Blob([res.data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      window.URL.revokeObjectURL(url);
    }, 1000);
  },

  batchRerun: (batchId: string) =>
    apiClient
      .post<{ batch_id: string; runs: Array<{ run_id: string; run_number: number; sap_filename: string; status: string }>; total: number }>(
        `/api/runs/batch/${batchId}/rerun`,
      )
      .then((r) => r.data),

  auditTrail: (id: string) =>
    apiClient.get<AuditEvent[]>(`/api/runs/${id}/audit-trail`).then((r) => r.data),

  progress: (id: string) =>
    apiClient.get<RunProgress>(`/api/runs/${id}/progress`).then((r) => r.data),

  /** Returns an EventSource URL for SSE progress streaming. */
  progressStreamUrl: (id: string) => `${BASE_URL}/api/runs/${id}/progress/stream`,

  cancel: (id: string) =>
    apiClient.post<{ status: string; run_id: string }>(`/api/runs/${id}/cancel`).then((r) => r.data),

  rerun: (id: string) =>
    apiClient.post<{ run_id: string; run_number: number; status: string }>(
      `/api/runs/${id}/rerun`,
    ).then((r) => r.data),

  delete: (id: string) =>
    apiClient.delete<{ status: string; run_id: string; run_number: number }>(`/api/runs/${id}`).then((r) => r.data),

  batchDelete: (batchId: string) =>
    apiClient.delete<{ status: string; batch_id: string; deleted_runs: number; run_numbers: number[] }>(
      `/api/runs/batch/${batchId}`,
    ).then((r) => r.data),

  suggested: (id: string) =>
    apiClient.get<SuggestedMatch[]>(`/api/runs/${id}/suggested`).then((r) => r.data),

  suggestedSummary: (id: string) =>
    apiClient.get<SuggestedSummary>(`/api/runs/${id}/suggested/summary`).then((r) => r.data),

  authorizeSuggested: (runId: string, ids: string[], remarks?: string) =>
    apiClient
      .post<{ success_count: number; promoted_count: number }>(`/api/runs/${runId}/suggested/authorize`, { ids, remarks })
      .then((r) => r.data),

  rejectSuggested: (runId: string, ids: string[], reason?: string) =>
    apiClient
      .post<{ rejected: number }>(`/api/runs/${runId}/suggested/reject`, { ids, reason })
      .then((r) => r.data),

  batchAuthorizeAllSuggested: (batchId: string, remarks?: string) =>
    apiClient
      .post<{ success_count: number; promoted_count: number; skipped_requires_remarks: number; skipped_invoice_reuse: number; runs_affected: number }>(
        `/api/runs/batch/${batchId}/suggested/authorize-all`,
        remarks ? { remarks } : {},
      )
      .then((r) => r.data),

  batchUpdateMetadata: (batchId: string, data: { batch_name?: string; batch_tags?: string[] }) =>
    apiClient.patch(`/api/runs/batch/${batchId}/metadata`, data).then((r) => r.data),

  batchProgress: (batchId: string) =>
    apiClient.get<{
      batch_id: string;
      total_runs: number;
      overall_pct: number;
      is_complete: boolean;
      statuses: Record<string, number>;
      completed: number;
      failed: number;
      processing: number;
      runs: Array<{
        run_id: string;
        run_number: number;
        deductor_name: string | null;
        sap_filename: string;
        status: string;
        stage: string;
        progress_pct: number;
        match_rate_pct: number | null;
      }>;
    }>(`/api/runs/batch/${batchId}/progress`).then((r) => r.data),

  trends: (params?: { deductor_name?: string; financial_year?: string; limit?: number }) =>
    apiClient.get<{
      data_points: Array<{
        run_id: string; run_number: number; deductor_name: string | null;
        financial_year: string; batch_id: string | null;
        match_rate_pct: number; matched_count: number; suggested_count: number;
        unmatched_26as_count: number; total_26as_entries: number;
        constraint_violations: number; created_at: string | null;
      }>;
      count: number;
      avg_match_rate: number | null;
      min_match_rate: number | null;
      max_match_rate: number | null;
      trend_direction: 'improving' | 'declining' | 'stable';
    }>('/api/runs/trends', { params }).then((r) => r.data),

  batchCompare: (batchId: string) =>
    apiClient.get<{
      batch_id: string;
      parent_batch_id: string | null;
      has_parent: boolean;
      parties: Array<{
        current: {
          run_id: string; run_number: number; deductor_name: string | null;
          match_rate_pct: number; matched_count: number; suggested_count: number;
          unmatched_26as_count: number; constraint_violations: number;
        };
        parent: {
          run_id: string; run_number: number; match_rate_pct: number;
          matched_count: number; suggested_count: number;
          unmatched_26as_count: number; constraint_violations: number;
        } | null;
        delta: {
          match_rate_pct: number; matched_count: number; suggested_count: number;
          unmatched_26as_count: number; constraint_violations: number;
        } | null;
      }>;
    }>(`/api/runs/batch/${batchId}/compare`).then((r) => r.data),

  batchAnalytics: (batchId: string) =>
    apiClient.get<{
      batch_id: string;
      total_parties: number;
      completed_parties: number;
      confidence_distribution: Record<string, number>;
      match_type_breakdown: Record<string, number>;
      section_heatmap: Record<string, number>;
      financial_waterfall: { total_26as: number; matched: number; suggested: number; unmatched: number };
      risk_matrix: Array<{
        run_id: string;
        deductor_name: string;
        match_rate_pct: number;
        violations: number;
        unmatched_count: number;
        unmatched_amount: number;
        low_confidence_count: number;
        has_pan_issues: boolean;
        control_total_balanced: boolean;
        risk_score: number;
      }>;
    }>(`/api/runs/batch/${batchId}/analytics`).then((r) => r.data),

  checkDuplicates: (sapFiles: File[]) => {
    const form = new FormData();
    sapFiles.forEach((f) => form.append('sap_files', f));
    return apiClient
      .post<{
        enabled: boolean;
        duplicates: Array<{
          sap_filename: string;
          sap_file_hash: string;
          prior_runs: Array<{
            run_id: string;
            run_number: number;
            batch_id: string | null;
            deductor_name: string | null;
            financial_year: string;
            status: string;
            match_rate_pct: number;
            created_at: string | null;
            sap_filename: string;
          }>;
        }>;
      }>('/api/runs/batch/check-duplicates', form)
      .then((r) => r.data);
  },

  batchSchedule: (batchId: string, scheduledAt: string) =>
    apiClient.post<{
      batch_id: string; scheduled_at: string; status: string; delay_seconds: number;
    }>(`/api/runs/batch/${batchId}/schedule`, { scheduled_at: scheduledAt }).then((r) => r.data),

  batchScheduleStatus: (batchId: string) =>
    apiClient.get<{
      batch_id: string; scheduled: boolean; scheduled_at?: string; status?: string; delay_seconds?: number;
    }>(`/api/runs/batch/${batchId}/schedule`).then((r) => r.data),

  batchScheduleCancel: (batchId: string) =>
    apiClient.delete<{ batch_id: string; status: string }>(`/api/runs/batch/${batchId}/schedule`).then((r) => r.data),

  configDiff: (runId: string) =>
    apiClient.get<{
      run_id: string;
      parent_id: string | null;
      has_parent: boolean;
      diff: Array<{ field: string; old_value: unknown; new_value: unknown }>;
      current_config: Record<string, unknown>;
      parent_config?: Record<string, unknown>;
    }>(`/api/runs/${runId}/config-diff`).then((r) => r.data),

  // ── Comments (Phase 4B) ──────────────────────────────────────────────────
  comments: (runId: string) =>
    apiClient.get<RunComment[]>(`/api/runs/${runId}/comments`).then((r) => r.data),

  addComment: (runId: string, content: string, parentId?: string, contextType?: string, contextId?: string) =>
    apiClient.post<RunComment>(`/api/runs/${runId}/comments`, {
      content, parent_id: parentId, context_type: contextType, context_id: contextId,
    }).then((r) => r.data),

  updateComment: (runId: string, commentId: string, content: string) =>
    apiClient.put<RunComment>(`/api/runs/${runId}/comments/${commentId}`, { content }).then((r) => r.data),

  deleteComment: (runId: string, commentId: string) =>
    apiClient.delete(`/api/runs/${runId}/comments/${commentId}`).then((r) => r.data),

  // ── Reviewer Assignment (Phase 4C) ────────────────────────────────────────
  assignReviewer: (runId: string, reviewerId: string | null) =>
    apiClient.post<{ status: string; assigned_reviewer_id: string | null }>(
      `/api/runs/${runId}/assign-reviewer`, { reviewer_id: reviewerId },
    ).then((r) => r.data),

  // ── Bulk Operations (Phase 4D) ────────────────────────────────────────────
  bulkReview: (runIds: string[], action: 'APPROVED' | 'REJECTED', notes?: string) =>
    apiClient.post<{ success: number; failed: number; errors: Array<{ run_id: string; error: string }> }>(
      '/api/runs/bulk/review', { run_ids: runIds, action, notes },
    ).then((r) => r.data),

  bulkArchive: (runIds: string[]) =>
    apiClient.post<{ archived: number }>('/api/runs/bulk/archive', { run_ids: runIds }).then((r) => r.data),

  // ── Archival (Phase 4E) ──────────────────────────────────────────────────
  archiveRun: (runId: string) =>
    apiClient.post<{ status: string; archived: boolean }>(`/api/runs/${runId}/archive`).then((r) => r.data),

  // ── Run Comparison (Phase 4I) ──────────────────────────────────────────────
  compareRuns: (runIdA: string, runIdB: string) =>
    apiClient.get<{
      run_a: Record<string, unknown>;
      run_b: Record<string, unknown>;
      diffs: Array<{ field: string; run_a_value: unknown; run_b_value: unknown; delta: number | null }>;
      same_deductor: boolean;
      same_fy: boolean;
    }>(`/api/runs/compare/${runIdA}/${runIdB}`).then((r) => r.data),

  // ── Compliance Report (Phase 4F) ─────────────────────────────────────────
  downloadComplianceReport: (runId: string) =>
    apiClient.get(`/api/runs/${runId}/compliance-report`, { responseType: 'blob' }).then((r) => {
      const url = URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `Compliance_Report_${runId}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    }),
};

// ── Misc APIs ─────────────────────────────────────────────────────────────────

export const miscApi = {
  financialYears: () =>
    apiClient.get<FinancialYearsResponse>('/api/financial-years').then((r) => r.data),

  health: () => apiClient.get('/api/health').then((r) => r.data),
};

// ── Settings APIs ────────────────────────────────────────────────────────

export const settingsApi = {
  get: () =>
    apiClient.get<AdminSettings>('/api/settings').then((r) => r.data),

  update: (data: AdminSettingsUpdate) =>
    apiClient.put<AdminSettings>('/api/settings', data).then((r) => r.data),

  history: () =>
    apiClient.get<AdminSettings[]>('/api/settings/history').then((r) => r.data),

  // ── Custom Exception Rules (Phase 4H) ────────────────────────────────────
  listExceptionRules: () =>
    apiClient.get<ExceptionRule[]>('/api/settings/exception-rules').then((r) => r.data),

  createExceptionRule: (data: { name: string; description?: string; field: string; operator: string; value: string; severity?: string }) =>
    apiClient.post<ExceptionRule>('/api/settings/exception-rules', data).then((r) => r.data),

  updateExceptionRule: (id: string, data: Partial<ExceptionRule>) =>
    apiClient.put<ExceptionRule>(`/api/settings/exception-rules/${id}`, data).then((r) => r.data),

  deleteExceptionRule: (id: string) =>
    apiClient.delete(`/api/settings/exception-rules/${id}`).then((r) => r.data),
};
