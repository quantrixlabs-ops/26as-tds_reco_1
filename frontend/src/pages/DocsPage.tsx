/**
 * DocsPage — Admin Panel Reference
 * Accessible via /docs in the sidebar (all authenticated users)
 */
import { useState, useEffect } from 'react';
import {
  Search,
  Users,
  Settings,
  AlertTriangle,
  History,
  ChevronDown,
  ChevronRight,
  Shield,
  Info,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { cn } from '../lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ParamRow {
  key: string;
  default: string;
  description: string;
}

interface ParamGroup {
  id: string;
  title: string;
  subLabel?: string;
  description?: string;
  rows: ParamRow[];
}

// ── Parameter data ─────────────────────────────────────────────────────────────

const PARAM_GROUPS: ParamGroup[] = [
  {
    id: 'doc-filters',
    title: 'Document Filters',
    description: 'Control which SAP document types are eligible for matching.',
    rows: [
      { key: 'doc_types_include', default: 'RV, DR, DC', description: 'SAP document types to include. Only rows with these types are considered for matching. Add or remove types based on your ERP configuration.' },
      { key: 'doc_types_exclude', default: 'CC, BR', description: 'Document types to always exclude (CC = credit memos, BR = bank receipts). These override the include list.' },
    ],
  },
  {
    id: 'date-rules',
    title: 'Date Rules',
    description: 'Validate and score invoice dates against 26AS transaction dates.',
    rows: [
      { key: 'date_hard_cutoff_days', default: '90 days', description: 'Hard maximum gap (days) between SAP invoice date and 26AS date. Entries outside this window are excluded from matching entirely.' },
      { key: 'date_soft_preference_days', default: '180 days', description: 'Entries within this window get a positive scoring bonus. Should be ≥ hard cutoff to allow soft preference.' },
      { key: 'enforce_books_before_26as', default: 'Off', description: 'When on, SAP entries dated after the 26AS transaction date are rejected — prevents matching future-dated invoices against already-filed TDS.' },
    ],
  },
  {
    id: 'variance-thresholds',
    title: 'Variance Thresholds',
    description: 'Maximum acceptable % difference between the 26AS amount and matched SAP amount.',
    rows: [
      { key: 'variance_normal_ceiling_pct', default: '3%', description: 'Maximum variance % for a normal (non-force) match to be accepted. Matches above this are rejected and retried in Phase C.' },
      { key: 'variance_suggested_ceiling_pct', default: '20%', description: 'Upper bound for "suggested" matches — entries that appear in results but require manual CA review before acceptance.' },
    ],
  },
  {
    id: 'matching-behavior',
    title: 'Matching Behavior',
    description: 'Core tuning for individual matching phases (Phase B & C).',
    rows: [
      { key: 'max_combo_size', default: '5', description: 'Maximum invoices that can be combined to match a single 26AS entry (COMBO_2 to COMBO_5). Hard compliance cap is always 5.' },
      { key: 'noise_threshold', default: '₹1', description: 'SAP rows with amounts below this are excluded before matching. Removes near-zero noise entries.' },
      { key: 'date_clustering_preference', default: 'Off', description: 'When on, combo matching prefers invoice combinations clustered within the same date window, reducing false positives.' },
      { key: 'force_match_enabled', default: 'On', description: "Enable Phase C force-matching. When off, entries that don't match in Phase A/B remain unmatched — no FORCE_SINGLE or FORCE_COMBO." },
    ],
  },
  {
    id: 'clearing-groups',
    title: 'Clearing Group Matching',
    description: 'Phase A uses SAP clearing document numbers to group related invoices before individual matching.',
    rows: [
      { key: 'clearing_group_enabled', default: 'On', description: 'Enable Phase A clearing group matching. Disable only when SAP clearing document values are unreliable or mostly absent.' },
      { key: 'clearing_group_variance_pct', default: '3%', description: 'Dedicated variance ceiling for CLR_GROUP matches. Groups where the sum deviates beyond this % are rejected from Phase A.' },
      { key: 'proxy_clearing_enabled', default: 'On', description: 'When clearing doc coverage is low (<10% of rows), use invoice date proximity to form proxy clearing groups as a fallback.' },
    ],
  },
  {
    id: 'cross-fy',
    title: 'Cross-FY & Advances',
    description: 'Control matching across financial year boundaries and handling of advance payments.',
    rows: [
      { key: 'exclude_sgl_v', default: 'Off', description: 'Exclude SAP rows with SGL indicator = V (advance/down payments) from matching. Enable when advances should not be credited against 26AS TDS.' },
      { key: 'allow_cross_fy', default: 'Off', description: 'When off (default): only current-FY books are used in Phases A/B/C. Prior-FY entries are reserved for Phase E and tagged PRIOR_YEAR_EXCEPTION. When on: all FYs in the lookback window are treated equally.' },
      { key: 'cross_fy_lookback_years', default: '1 year', description: 'Number of prior financial years to load into the SAP pool when allow_cross_fy is on, or for Phase E prior-year exceptions.' },
    ],
  },
  {
    id: 'batch-processing',
    title: 'Batch Processing',
    description: 'Control how multi-party batch reconciliations are executed.',
    rows: [
      { key: 'batch_concurrency_limit', default: '10', description: 'Maximum simultaneous party reconciliations in a batch. Higher values speed up large batches but increase memory/CPU usage. Range: 1–50.' },
      { key: 'batch_parse_cache_enabled', default: 'On', description: 'Parse the 26AS file once and cache per-party slices by SHA-256 hash. Significantly speeds up batches with many parties against the same 26AS file.' },
      { key: 'batch_invoice_dedup_enabled', default: 'Off', description: 'Prevent the same SAP invoice from being matched to different parties within a batch. Off by default since parties should each have their own invoice pool.' },
      { key: 'batch_control_total_enabled', default: 'Off', description: 'Assert that the sum of per-party 26AS slices equals the total of the master 26AS file. Flags data integrity issues during multi-party extraction.' },
    ],
  },
  {
    id: 'batch-advanced',
    title: 'Batch Processing — Advanced',
    description: 'Retry logic, notifications, scheduling, comparisons, and analytics.',
    rows: [
      { key: 'batch_auto_retry_count', default: '0 (disabled)', description: 'Times to auto-retry a failed party run within a batch. 0 = disabled. Use 1–3 for transient failure resilience.' },
      { key: 'batch_duplicate_detection_enabled', default: 'Off', description: 'Detect when the same SAP file (by SHA-256 hash) has been processed in a prior batch and warn before reprocessing.' },
      { key: 'batch_progress_dashboard_enabled', default: 'On', description: 'Show an aggregate real-time progress view in Run History while a batch is running.' },
      { key: 'batch_comparison_enabled', default: 'On', description: 'Side-by-side comparison between original batch run and any rerun, showing match rate deltas per party.' },
      { key: 'batch_variance_trend_enabled', default: 'On', description: 'Track and display historical match rate trends across batch runs on the Dashboard.' },
      { key: 'batch_export_template', default: 'standard', description: 'Excel output template for batch downloads. Options: standard, detailed (all columns), summary (aggregate only), custom.' },
      { key: 'batch_notification_enabled', default: 'Off', description: 'Send a POST webhook notification when a batch completes or fails.' },
      { key: 'batch_notification_webhook_url', default: '—', description: 'POST endpoint to receive batch status notifications. Visible and configurable only when batch_notification_enabled is on.' },
      { key: 'batch_scheduling_enabled', default: 'Off', description: 'Allow scheduling batch reruns at configured times (e.g. nightly reprocessing).' },
    ],
  },
  {
    id: 'reco-intelligence',
    title: 'Reconciliation Intelligence',
    description: 'Advanced matching intelligence — most are Off by default; enable after baseline validation.',
    rows: [
      { key: 'section_filter_enabled', default: 'Off', description: 'Only match 26AS entries against SAP entries with the same TDS section (e.g. 194C with 194C). Reduces false positives for multi-section deductors.' },
      { key: 'invoice_date_proximity_enabled', default: 'Off', description: 'Penalize matches where invoice date is far from 26AS transaction date. Controlled by max_date_gap_days.' },
      { key: 'max_date_gap_days', default: '90 days', description: 'Active when invoice_date_proximity_enabled is on. Max gap (days) between invoice and 26AS dates before scoring penalty applies.' },
      { key: 'as26_duplicate_check_enabled', default: 'Off', description: 'Flag duplicate Status=F entries in the uploaded 26AS file — may indicate revision rows or data entry errors.' },
      { key: 'credit_note_handling_enabled', default: 'Off', description: 'Parse negative SAP amounts as credit note adjustments and net them against positive invoices before matching.' },
      { key: 'bipartite_matching_enabled', default: 'Off', description: 'Use scipy global bipartite assignment (linear_sum_assignment) instead of greedy local matching. Finds the globally optimal 1:1 assignment but increases processing time.' },
      { key: 'enumerate_alternatives_enabled', default: 'Off', description: 'Compute and display top 3 alternative matches per suggested match to help CAs compare options.' },
      { key: 'amount_control_totals_enabled', default: 'On', description: 'Include control total verification rows in Excel output to confirm amounts balance.' },
      { key: 'match_type_distribution_enabled', default: 'On', description: 'Track and display EXACT / SINGLE / COMBO / FORCE breakdown in results and Excel export.' },
      { key: 'pan_detection_enabled', default: 'Off', description: 'Analyse effective TDS rates and flag entries that may indicate PAN non-furnishing (Section 206AA — higher TDS rate applied).' },
      { key: 'large_batch_mode_enabled', default: 'Off', description: 'Enable memory limits and performance tuning for very large batches (many parties or files > 50,000 rows).' },
      { key: 'max_sap_rows_per_run', default: '1,00,000', description: 'Active only when large_batch_mode_enabled is on. Cap per-run SAP row count to prevent memory issues.' },
    ],
  },
  {
    id: 'workflow-compliance',
    title: 'Workflow & Compliance',
    description: 'Reviewer approval workflow, collaboration, archival, and compliance features.',
    rows: [
      { key: 'approval_workflow_enabled', default: 'On', description: 'Enable maker-checker approve/reject workflow. Completed runs require REVIEWER sign-off before results are final.' },
      { key: 'comment_threads_enabled', default: 'On', description: 'Allow threaded comments on run results for preparer-reviewer communication.' },
      { key: 'reviewer_assignment_enabled', default: 'Off', description: 'Assign specific reviewers to runs. Only the assigned reviewer can approve/reject that run.' },
      { key: 'bulk_operations_enabled', default: 'On', description: 'Bulk approve / reject / export across multiple selected runs at once in Run History.' },
      { key: 'run_archival_enabled', default: 'Off', description: 'Automatically archive runs older than archival_retention_days.' },
      { key: 'archival_retention_days', default: '365 days', description: 'Runs older than this are auto-archived when run_archival_enabled is on. Range: 30–3650 days.' },
      { key: 'compliance_report_enabled', default: 'Off', description: 'Generate audit-ready compliance Excel reports with regulatory formatting suitable for CA file submissions.' },
      { key: 'data_quality_precheck_enabled', default: 'On', description: 'Profile uploaded SAP and 26AS files before matching begins, flagging data issues (missing columns, suspicious values) early.' },
      { key: 'custom_exception_rules_enabled', default: 'Off', description: 'Enable custom rule-based exception generation. Requires configuring rules in the Custom Exception Rules section.' },
      { key: 'run_comparison_enabled', default: 'On', description: 'Compare two runs side-by-side to see how match outcomes changed.' },
      { key: 'enhanced_webhook_enabled', default: 'Off', description: 'Retry logic, HMAC-SHA256 payload signing, and configurable content for webhook notifications.' },
      { key: 'webhook_retry_count', default: '3', description: 'Retry attempts on webhook delivery failure (0–10). Active only when enhanced_webhook_enabled is on.' },
      { key: 'webhook_secret', default: '—', description: 'Shared secret for HMAC-SHA256 signing of webhook payloads. Receivers verify authenticity using this key.' },
    ],
  },
  {
    id: 'advanced-tuning',
    title: 'Advanced Tuning & Profiles',
    subLabel: 'Phases 5A–5J',
    description: 'Exception severity, scoring weights, per-type variance ceilings, combo heuristics, date profiles, clearing rules, rate validation, parser settings, export config, and dashboard metrics.',
    rows: [
      { key: 'high_value_threshold', default: '₹10,00,000', description: '[5A] 26AS entries above this amount are flagged HIGH-VALUE exceptions, requiring explicit CA review.' },
      { key: 'auto_escalate_high_value', default: 'On', description: '[5A] Automatically raise exception severity to CRITICAL for unmatched entries above the high-value threshold.' },
      { key: 'force_match_exception_severity', default: 'HIGH', description: '[5A] Default severity for all FORCE_SINGLE and FORCE_COMBO matches. Options: CRITICAL / HIGH / MEDIUM / LOW / INFO.' },
      { key: 'custom_scoring_enabled', default: 'Off', description: '[5B] Override default scoring weights. When off, defaults (Variance 30 / Date 20 / Section 20 / Clearing 20 / Historical 10) are used.' },
      { key: 'score_weight_variance', default: '30%', description: '[5B] Weight for the amount variance factor in composite score.' },
      { key: 'score_weight_date', default: '20%', description: '[5B] Weight for the date proximity factor.' },
      { key: 'score_weight_section', default: '20%', description: '[5B] Weight for matching TDS section (e.g. 194C vs 194J).' },
      { key: 'score_weight_clearing', default: '20%', description: '[5B] Weight for shared clearing document between 26AS and SAP.' },
      { key: 'score_weight_historical', default: '10%', description: '[5B] Weight for historical pattern matching from prior runs.' },
      { key: 'custom_variance_ceilings_enabled', default: 'Off', description: '[5C] Override per-match-type variance ceilings. When off, defaults (SINGLE 2% / COMBO 3% / FORCE_SINGLE 5% / FORCE_COMBO 2%) are used.' },
      { key: 'variance_ceiling_single_pct', default: '2%', description: '[5C] Maximum variance % for a SINGLE match (1 invoice vs 1 26AS entry).' },
      { key: 'variance_ceiling_combo_pct', default: '3%', description: '[5C] Maximum variance % for a COMBO match (2–5 invoices combined).' },
      { key: 'variance_ceiling_force_single_pct', default: '5%', description: '[5C] Maximum variance % for FORCE_SINGLE (Phase C last resort). CA review required.' },
      { key: 'variance_ceiling_force_combo_pct', default: '2%', description: '[5C] Maximum variance % for FORCE_COMBO. Kept tight to prevent statistical abuse.' },
      { key: 'combo_iteration_budget', default: '50,000', description: '[5D] Maximum iterations per (26AS entry × combo size) during Phase B. Prevents runaway loops on large books.' },
      { key: 'combo_pool_cap', default: '5,000', description: '[5D] Maximum candidate SAP entries in the combo search pool per 26AS entry.' },
      { key: 'combo_date_window_days', default: '30 days', description: '[5D] When date clustering is on, combo candidates must fall within this date window.' },
      { key: 'date_proximity_profile', default: 'STANDARD (45 days)', description: '[5E] Date scoring strictness. STRICT = 15-day window, STANDARD = 45-day, LENIENT = 90-day, CUSTOM = manual.' },
      { key: 'filing_lag_days_tolerance', default: '45 days', description: '[5E] Allowed lag between invoice date and 26AS filing date. Prevents valid entries from being penalised for TDS filing delays.' },
      { key: 'clearing_doc_bonus_score', default: '20', description: '[5F] Score bonus when a 26AS entry and SAP entry share the same clearing document number — strong signal of correct match.' },
      { key: 'proxy_clearing_date_window_days', default: '30 days', description: '[5F] Date window used to form proxy clearing groups when clearing doc coverage is low.' },
      { key: 'rate_tolerance_pct', default: '2%', description: '[5G] Allowed deviation in effective TDS rate before flagging a rate mismatch exception.' },
      { key: 'rate_mismatch_severity', default: 'MEDIUM', description: '[5G] Severity for exceptions from TDS rate mismatches. Options: CRITICAL / HIGH / MEDIUM / LOW / INFO.' },
      { key: 'parser_lenient_mode', default: 'On', description: '[5H] Accept minor formatting issues (extra whitespace, mixed date formats). Disable for strict input validation.' },
      { key: 'cleaner_duplicate_strategy', default: 'FIRST_OCCURRENCE', description: '[5H] How to handle duplicate SAP invoice rows. FIRST_OCCURRENCE = keep earliest, LAST_OCCURRENCE = keep latest, SUM_AMOUNTS = consolidate.' },
      { key: 'export_show_score_breakdown', default: 'On', description: '[5I] Include per-factor score columns in the Matched Pairs Excel sheet.' },
      { key: 'export_template_active', default: 'standard', description: '[5I] Excel template preset for single-run downloads. Options: standard, ca_review, itr_filing, management.' },
      { key: 'dashboard_match_rate_target_pct', default: '75%', description: '[5J] Target match rate shown as KPI on Dashboard. Runs below this appear flagged in red.' },
      { key: 'dashboard_variance_warning_pct', default: '5%', description: '[5J] Variance % that triggers warning indicators on the Dashboard.' },
      { key: 'dashboard_exclude_failed_from_trends', default: 'On', description: '[5J] Skip FAILED runs when computing match rate trend charts.' },
    ],
  },
  {
    id: 'reporting-safety',
    title: 'Reporting, Intelligence & Safety',
    subLabel: 'Phases 6A–6J',
    description: 'Confidence tiers, auto-approval, section boosts, alerting, audit retention, Excel sheet selection, and display preferences.',
    rows: [
      { key: 'confidence_high_variance_threshold', default: '1%', description: '[6A] Variance % at or below which a non-FORCE match is classified HIGH confidence.' },
      { key: 'confidence_medium_variance_threshold', default: '5%', description: '[6A] Variance % at or below which a non-FORCE match is MEDIUM confidence. Above this = LOW.' },
      { key: 'confidence_score_boost_threshold', default: '70', description: '[6A] Composite score (0–100) above which a 1–2% variance match is boosted to HIGH confidence.' },
      { key: 'exact_tolerance_rupees', default: '₹0.01 (1 paisa)', description: '[6B] Amount difference below this is treated as EXACT match. Default handles floating-point rounding.' },
      { key: 'auto_approval_enabled', default: 'Off', description: '[6C] Automatically approve runs meeting match rate and exception count thresholds — no reviewer action required.' },
      { key: 'auto_approval_min_match_rate', default: '75%', description: '[6C] Minimum match rate required for auto-approval.' },
      { key: 'auto_approval_max_exceptions', default: '10', description: '[6C] Maximum exceptions allowed for auto-approval to apply.' },
      { key: 'high_confidence_sections', default: '194C, 194J, 194H, 194I, 194A', description: '[6D] Comma-separated TDS sections that receive a base confidence boost due to consistent data patterns.' },
      { key: 'section_confidence_boost_pct', default: '60', description: '[6D] Base confidence score (0–100) assigned to entries in high-confidence sections before variance adjustment.' },
      { key: 'unmatched_alerting_enabled', default: 'On', description: '[6E] Generate alerts when unmatched amounts or counts exceed thresholds at end of run.' },
      { key: 'unmatched_critical_amount_threshold', default: '₹5,00,000', description: '[6E] Alert if any single unmatched 26AS entry exceeds this amount (potential TDS credit loss).' },
      { key: 'unmatched_critical_count_threshold', default: '50', description: '[6E] Alert if total unmatched 26AS entries exceed this count.' },
      { key: 'force_match_alert_enabled', default: 'On', description: '[6F] Alert when force-matched entries exceed a % of total matches — may indicate data quality issues.' },
      { key: 'force_match_alert_pct_threshold', default: '10%', description: '[6F] Force match % above which an alert is generated.' },
      { key: 'audit_log_retention_enabled', default: 'Off', description: '[6G] Automatically purge audit logs older than the retention period.' },
      { key: 'audit_log_retention_days', default: '1,095 (3 years)', description: '[6G] Days to retain audit logs before purging. Range: 90–3650.' },
      { key: 'audit_log_redact_amounts', default: 'Off', description: '[6G] Replace exact rupee amounts in audit logs with ranges for data privacy.' },
      { key: 'excel_include_match_distribution', default: 'On', description: '[6H] Include the Match Distribution sheet in Excel exports.' },
      { key: 'excel_include_control_totals', default: 'On', description: '[6H] Include the Control Totals sheet in Excel exports.' },
      { key: 'excel_include_variance_analysis', default: 'On', description: '[6H] Include the Variance Analysis sheet in Excel exports.' },
      { key: 'run_detail_default_sort', default: 'Variance %', description: '[6I] Default sort column when opening a run detail page. Options: Variance %, Amount, Date, Composite Score, Match Type.' },
      { key: 'run_detail_items_per_page', default: '50', description: '[6I] Rows per page in run detail matched pairs table. Range: 10–500.' },
      { key: 'run_detail_show_score_columns', default: 'On', description: '[6I] Show per-factor score breakdown columns in the run detail view.' },
      { key: 'batch_hide_zero_match_parties', default: 'Off', description: '[6J] Hide parties with 0% match rate from batch summary view.' },
      { key: 'batch_summary_sort_by', default: 'Match Rate', description: '[6J] Default sort column for batch summary. Options: Match Rate, Deductor Name, 26AS Amount, Status, Run Number.' },
      { key: 'batch_trend_window_days', default: '90 days', description: '[6J] Days to display in match rate trend charts on batch analytics.' },
    ],
  },
  {
    id: 'security-governance',
    title: 'Security, Governance & Data Controls',
    subLabel: 'Phases 7A–7J',
    description: 'Session policy, password rules, login protection, data retention, export security, PII redaction, import validation, anomaly detection, batch recovery, and health alerts.',
    rows: [
      { key: 'session_inactivity_timeout_min', default: '30 min', description: '[7A] Auto-logout after this many minutes of inactivity. 0 = disabled.' },
      { key: 'max_concurrent_sessions', default: '3', description: '[7A] Maximum active sessions per user. 0 = unlimited. Prevents credential sharing.' },
      { key: 'force_reauth_on_approve', default: 'Off', description: '[7A] Require reviewer to re-enter password before approving/rejecting. Adds second-factor for high-stakes actions.' },
      { key: 'password_min_length', default: '8', description: '[7B] Minimum number of characters required for user passwords.' },
      { key: 'password_require_mixed_case', default: 'On', description: '[7B] Passwords must contain at least one uppercase and one lowercase letter.' },
      { key: 'password_require_number', default: 'On', description: '[7B] Passwords must contain at least one digit.' },
      { key: 'password_expiry_days', default: '0 (never)', description: '[7B] Force password change after N days. 0 = passwords never expire.' },
      { key: 'max_failed_login_attempts', default: '5', description: '[7C] Consecutive failures before account is temporarily locked.' },
      { key: 'login_lockout_duration_min', default: '15 min', description: '[7C] Minutes before a locked account auto-unlocks.' },
      { key: 'notify_admin_on_lockout', default: 'Off', description: '[7C] Notify admin users when any account is locked due to failed login attempts.' },
      { key: 'run_retention_days', default: '365 days', description: '[7D] Auto-purge run data older than this. 0 = keep forever.' },
      { key: 'auto_archive_after_days', default: '90 days', description: '[7D] Move completed/approved runs to archive after this many days. 0 = disabled.' },
      { key: 'purge_exports_after_days', default: '30 days', description: '[7D] Delete cached Excel export files after this many days. 0 = keep forever.' },
      { key: 'export_watermark_enabled', default: 'Off', description: '[7E] Add a text watermark to all downloaded Excel files.' },
      { key: 'export_watermark_text', default: 'CONFIDENTIAL', description: '[7E] Watermark text displayed in exported Excel files.' },
      { key: 'export_require_approval', default: 'Off', description: '[7E] Require REVIEWER approval before PREPARER role users can download exports.' },
      { key: 'redact_tan_in_logs', default: 'Off', description: '[7F] Replace TAN numbers with masked values (e.g. AAAA****01) in audit logs.' },
      { key: 'redact_pan_in_exports', default: 'Off', description: '[7F] Replace PAN numbers with masked values in downloaded Excel exports.' },
      { key: 'mask_amounts_in_preview', default: 'Off', description: '[7F] Hide exact rupee amounts in the UI for PREPARER role users.' },
      { key: 'max_upload_size_mb', default: '50 MB', description: '[7G] Maximum allowed file size for SAP or 26AS uploads. Files above this are rejected.' },
      { key: 'max_rows_per_file', default: '1,00,000', description: '[7G] Maximum rows per uploaded sheet. Files with more rows are rejected.' },
      { key: 'reject_empty_columns', default: 'Off', description: '[7G] Reject uploaded files with empty values in critical positional columns (Amount, Invoice Ref).' },
      { key: 'anomaly_detection_enabled', default: 'Off', description: '[7H] Run statistical anomaly detection on match results after each run.' },
      { key: 'amount_outlier_stddev', default: '3 stddev', description: '[7H] Flag matched amounts more than N standard deviations from the mean (potential data errors).' },
      { key: 'match_rate_drop_alert_pct', default: '20%', description: "[7H] Alert if a party's match rate drops by more than this % compared to their prior run." },
      { key: 'batch_retry_backoff_seconds', default: '2 sec', description: '[7I] Base backoff interval between auto-retry attempts for failed party runs. Increases exponentially.' },
      { key: 'batch_stop_on_failure_count', default: '0 (disabled)', description: '[7I] Halt batch if more than N parties fail. 0 = continue despite failures.' },
      { key: 'batch_partial_resume_enabled', default: 'Off', description: '[7I] Resume a partially failed batch from the last successful party.' },
      { key: 'system_alerts_enabled', default: 'Off', description: '[7J] Enable health monitoring alerts for slow runs and high exception rates.' },
      { key: 'slow_run_threshold_seconds', default: '300 sec', description: '[7J] Flag any run taking longer than this as potentially stalled.' },
      { key: 'high_exception_rate_pct', default: '50%', description: '[7J] Alert when exception count exceeds this % of total 26AS entries in a run.' },
    ],
  },
];

// ── TOC structure ──────────────────────────────────────────────────────────────

const TOC_ITEMS = [
  { id: 'user-management', label: 'User Management', level: 1 },
  { id: 'algo-heading', label: 'Algorithm Settings', level: 1, isHeading: true },
  { id: 'doc-filters', label: 'Document Filters', level: 2 },
  { id: 'date-rules', label: 'Date Rules', level: 2 },
  { id: 'variance-thresholds', label: 'Variance Thresholds', level: 2 },
  { id: 'matching-behavior', label: 'Matching Behavior', level: 2 },
  { id: 'clearing-groups', label: 'Clearing Groups', level: 2 },
  { id: 'cross-fy', label: 'Cross-FY & Advances', level: 2 },
  { id: 'batch-processing', label: 'Batch Processing', level: 2 },
  { id: 'batch-advanced', label: 'Batch Advanced', level: 2 },
  { id: 'reco-intelligence', label: 'Reco Intelligence', level: 2 },
  { id: 'workflow-compliance', label: 'Workflow & Compliance', level: 2 },
  { id: 'advanced-tuning', label: 'Advanced Tuning', level: 2 },
  { id: 'reporting-safety', label: 'Reporting & Safety', level: 2 },
  { id: 'security-governance', label: 'Security & Governance', level: 2 },
  { id: 'custom-exceptions', label: 'Custom Exception Rules', level: 1 },
  { id: 'settings-history', label: 'Settings History', level: 1 },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function matches(text: string, q: string) {
  return text.toLowerCase().includes(q.toLowerCase());
}

function filterGroup(group: ParamGroup, q: string): ParamRow[] {
  if (!q) return group.rows;
  if (matches(group.title, q) || matches(group.description ?? '', q)) return group.rows;
  return group.rows.filter((r) => matches(r.key, q) || matches(r.description, q) || matches(r.default, q));
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ParamTable({ rows }: { rows: ParamRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-[#1B3A5C] text-white text-xs">
            <th className="px-3 py-2 text-left font-medium w-52">Parameter</th>
            <th className="px-3 py-2 text-left font-medium w-36">Default</th>
            <th className="px-3 py-2 text-left font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.key} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
              <td className="px-3 py-2 font-mono text-xs text-[#1B3A5C] align-top whitespace-nowrap">{row.key}</td>
              <td className="px-3 py-2 text-xs text-gray-600 align-top whitespace-nowrap">{row.default}</td>
              <td className="px-3 py-2 text-xs text-gray-700 align-top leading-relaxed">{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionCard({ group, query }: { group: ParamGroup; query: string }) {
  const [open, setOpen] = useState(true);
  const rows = filterGroup(group, query);
  if (rows.length === 0) return null;

  return (
    <div id={group.id} data-section className="scroll-mt-4">
      <Card>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between -m-6 p-6"
        >
          <div className="text-left">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900">{group.title}</h3>
              {group.subLabel && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-[#1B3A5C]/10 text-[#1B3A5C] font-medium">
                  {group.subLabel}
                </span>
              )}
              <span className="text-xs text-gray-400 font-normal">{rows.length} parameters</span>
            </div>
            {group.description && (
              <p className="text-xs text-gray-500 mt-0.5">{group.description}</p>
            )}
          </div>
          {open
            ? <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" />
            : <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
          }
        </button>
        {open && (
          <div className="mt-5 pt-5 border-t border-gray-100">
            <ParamTable rows={rows} />
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DocsPage() {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState('user-management');

  // IntersectionObserver — update active TOC item as user scrolls
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: '-10% 0px -70% 0px', threshold: 0 },
    );
    document.querySelectorAll('[data-section]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [query]); // re-observe when search changes sections

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
  };

  // Count how many params match search across all groups
  const totalMatches = query
    ? PARAM_GROUPS.reduce((n, g) => n + filterGroup(g, query).length, 0)
    : null;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-4 justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Admin Panel Reference</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Complete guide to all 143 configurable parameters, user roles, and settings
          </p>
        </div>
        <div className="relative w-full sm:w-64 shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search parameters…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
          />
          {query && totalMatches !== null && (
            <p className="text-xs text-gray-400 mt-1">
              {totalMatches} parameter{totalMatches !== 1 ? 's' : ''} matched
            </p>
          )}
        </div>
      </div>

      <div className="flex gap-6 items-start">
        {/* Left sticky TOC */}
        <nav className="hidden lg:block w-48 xl:w-52 shrink-0 sticky top-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-2">Contents</p>
          <div className="space-y-0.5">
            {TOC_ITEMS.map((item) => {
              const isActive = activeId === item.id;
              if (item.isHeading) {
                return (
                  <p
                    key={item.id}
                    className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 pt-3 pb-1"
                  >
                    {item.label}
                  </p>
                );
              }
              return (
                <button
                  key={item.id}
                  onClick={() => scrollTo(item.id)}
                  className={cn(
                    'w-full text-left text-xs rounded-md px-2 py-1.5 transition-colors truncate',
                    item.level === 2 && 'pl-4',
                    isActive
                      ? 'bg-[#1B3A5C]/10 text-[#1B3A5C] font-medium border-l-2 border-[#1B3A5C]'
                      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100',
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* ── A: User Management ── */}
          {(!query || matches('user management roles permissions', query)) && (
            <div id="user-management" data-section className="scroll-mt-4">
              <Card>
                <div className="flex items-center gap-3 mb-5">
                  <div className="p-2 rounded-lg bg-[#1B3A5C]/10">
                    <Users className="h-4 w-4 text-[#1B3A5C]" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-gray-900">User Management</h2>
                    <p className="text-xs text-gray-500">Create users and manage role-based access</p>
                  </div>
                </div>

                {/* Roles */}
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">User Roles</h3>
                <div className="overflow-x-auto rounded-lg border border-gray-200 mb-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#1B3A5C] text-white text-xs">
                        <th className="px-3 py-2 text-left font-medium">Role</th>
                        <th className="px-3 py-2 text-left font-medium">Purpose</th>
                        <th className="px-3 py-2 text-left font-medium">Can Do</th>
                        <th className="px-3 py-2 text-left font-medium">Cannot Do</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs">
                      <tr className="bg-white border-t border-gray-100">
                        <td className="px-3 py-2 font-semibold text-[#1B3A5C] whitespace-nowrap">ADMIN</td>
                        <td className="px-3 py-2 text-gray-600">Platform administrator</td>
                        <td className="px-3 py-2 text-gray-700">All actions: create users, change settings, view all runs, approve, export</td>
                        <td className="px-3 py-2 text-gray-500">—</td>
                      </tr>
                      <tr className="bg-gray-50 border-t border-gray-100">
                        <td className="px-3 py-2 font-semibold text-[#1B3A5C] whitespace-nowrap">REVIEWER</td>
                        <td className="px-3 py-2 text-gray-600">CA or senior reviewer</td>
                        <td className="px-3 py-2 text-gray-700">View all runs, approve/reject, download exports, add comments</td>
                        <td className="px-3 py-2 text-gray-500">Cannot create users, cannot change algorithm settings</td>
                      </tr>
                      <tr className="bg-white border-t border-gray-100">
                        <td className="px-3 py-2 font-semibold text-[#1B3A5C] whitespace-nowrap">PREPARER</td>
                        <td className="px-3 py-2 text-gray-600">Data entry / junior staff</td>
                        <td className="px-3 py-2 text-gray-700">Upload files, start runs, view own runs, add comments</td>
                        <td className="px-3 py-2 text-gray-500">Cannot approve/reject, cannot change settings, limited export (needs REVIEWER approval if enforce_export is on)</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Create User fields */}
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Create User — Form Fields</h3>
                <div className="overflow-x-auto rounded-lg border border-gray-200 mb-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#1B3A5C] text-white text-xs">
                        <th className="px-3 py-2 text-left font-medium">Field</th>
                        <th className="px-3 py-2 text-left font-medium">Required</th>
                        <th className="px-3 py-2 text-left font-medium">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs">
                      {[
                        { f: 'Full name', r: 'Yes', n: 'Displayed in the top bar and audit logs' },
                        { f: 'Email address', r: 'Yes', n: 'Used as login username — must be unique' },
                        { f: 'Password', r: 'Yes', n: 'Must meet password rules configured in 7B' },
                        { f: 'Role', r: 'Yes', n: 'ADMIN / REVIEWER / PREPARER' },
                      ].map((row, i) => (
                        <tr key={row.f} className={i % 2 === 0 ? 'bg-white border-t border-gray-100' : 'bg-gray-50 border-t border-gray-100'}>
                          <td className="px-3 py-2 font-medium text-gray-800">{row.f}</td>
                          <td className="px-3 py-2 text-gray-600">{row.r}</td>
                          <td className="px-3 py-2 text-gray-600">{row.n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Maker-checker */}
                <div className="border-l-4 border-[#1B3A5C] bg-blue-50 p-3 rounded-r text-xs text-gray-700">
                  <strong className="text-[#1B3A5C]">Maker-Checker Enforcement:</strong> A PREPARER uploads files and starts a run (maker). A REVIEWER must approve or reject the result (checker). The same person cannot both prepare and approve the same run. This satisfies the dual-control requirement for TDS credit claims under Section 199 of the Income Tax Act.
                </div>
              </Card>
            </div>
          )}

          {/* ── B: Algorithm Settings heading ── */}
          {(!query) && (
            <div id="algo-heading" data-section className="scroll-mt-4 flex items-center gap-3 pt-2">
              <div className="p-2 rounded-lg bg-[#1B3A5C]/10">
                <Settings className="h-4 w-4 text-[#1B3A5C]" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Algorithm Settings</h2>
                <p className="text-xs text-gray-500">143 parameters across 13 groups — controls the reconciliation engine</p>
              </div>
            </div>
          )}

          {/* ── Parameter groups ── */}
          {PARAM_GROUPS.map((group) => (
            <SectionCard key={group.id} group={group} query={query} />
          ))}

          {/* ── C: Custom Exception Rules ── */}
          {(!query || matches('custom exception rules field operator severity', query)) && (
            <div id="custom-exceptions" data-section className="scroll-mt-4">
              <Card>
                <div className="flex items-center gap-3 mb-5">
                  <div className="p-2 rounded-lg bg-[#1B3A5C]/10">
                    <AlertTriangle className="h-4 w-4 text-[#1B3A5C]" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-gray-900">Custom Exception Rules</h2>
                    <p className="text-xs text-gray-500">Define custom conditions that auto-generate exception flags after each run</p>
                  </div>
                </div>

                <div className="border-l-4 border-[#1B3A5C] bg-blue-50 p-3 rounded-r text-xs text-gray-700 mb-5">
                  <strong className="text-[#1B3A5C]">What they are:</strong> Custom exception rules let you codify your organisation's specific compliance requirements into the engine. After each run, the engine checks every matched and unmatched entry against these rules and auto-generates REQUIRES_REVIEW flags with the configured severity.
                  Requires <code className="bg-white px-1 rounded">custom_exception_rules_enabled = On</code> in Workflow & Compliance settings.
                </div>

                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Rule Fields</h3>
                <div className="overflow-x-auto rounded-lg border border-gray-200 mb-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#1B3A5C] text-white text-xs">
                        <th className="px-3 py-2 text-left font-medium">Field</th>
                        <th className="px-3 py-2 text-left font-medium">Options / Format</th>
                        <th className="px-3 py-2 text-left font-medium">Description</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs">
                      {[
                        { f: 'Rule name', o: 'Free text', d: 'Short descriptive name shown in exceptions list' },
                        { f: 'Field', o: 'amount, variance_pct, match_type, section, confidence, deductor_name', d: 'The 26AS or match result field to evaluate' },
                        { f: 'Operator', o: '>, <, >=, <=, =, !=, contains, not_contains', d: 'Comparison operator' },
                        { f: 'Value', o: 'Numeric or string', d: 'Threshold or pattern to compare against' },
                        { f: 'Severity', o: 'CRITICAL / HIGH / MEDIUM / LOW / INFO', d: 'Exception severity level to assign when rule fires' },
                        { f: 'Active', o: 'On / Off', d: 'Toggle rule on/off without deleting it' },
                      ].map((row, i) => (
                        <tr key={row.f} className={i % 2 === 0 ? 'bg-white border-t border-gray-100' : 'bg-gray-50 border-t border-gray-100'}>
                          <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">{row.f}</td>
                          <td className="px-3 py-2 font-mono text-[#1B3A5C]">{row.o}</td>
                          <td className="px-3 py-2 text-gray-600">{row.d}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Example Rules</h3>
                <div className="bg-gray-900 text-green-400 font-mono text-xs rounded-lg p-4 overflow-x-auto whitespace-pre">{`# Flag all unmatched entries above ₹5L as CRITICAL
field: amount | operator: > | value: 500000 | severity: CRITICAL

# Alert on any force-match in section 194J
field: match_type | operator: contains | value: FORCE | severity: HIGH
(combined with) field: section | operator: = | value: 194J

# Warn when variance exceeds 4% even if under ceiling
field: variance_pct | operator: > | value: 4.0 | severity: MEDIUM

# Flag entries from a specific high-risk deductor
field: deductor_name | operator: contains | value: PENDING | severity: HIGH`}
                </div>
              </Card>
            </div>
          )}

          {/* ── D: Settings History ── */}
          {(!query || matches('settings history version revision audit changed', query)) && (
            <div id="settings-history" data-section className="scroll-mt-4">
              <Card>
                <div className="flex items-center gap-3 mb-5">
                  <div className="p-2 rounded-lg bg-[#1B3A5C]/10">
                    <History className="h-4 w-4 text-[#1B3A5C]" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-gray-900">Settings History</h2>
                    <p className="text-xs text-gray-500">Every save creates a versioned snapshot — full audit trail of what changed and when</p>
                  </div>
                </div>

                <div className="space-y-3 text-sm">
                  <div className="border-l-4 border-[#1B3A5C] bg-blue-50 p-3 rounded-r text-xs text-gray-700">
                    <strong className="text-[#1B3A5C]">How it works:</strong> Each time an ADMIN saves the Algorithm Settings, a new revision record is written to the database with a timestamp and the identity of who made the change. The current active settings are always the latest revision.
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-[#1B3A5C] text-white text-xs">
                          <th className="px-3 py-2 text-left font-medium">Revision record contains</th>
                          <th className="px-3 py-2 text-left font-medium">Purpose</th>
                        </tr>
                      </thead>
                      <tbody className="text-xs">
                        {[
                          { r: 'Revision number', p: 'Sequential ID — v1, v2, v3…' },
                          { r: 'Changed by', p: 'Email + full name of the admin who saved' },
                          { r: 'Changed at', p: 'UTC timestamp of the save' },
                          { r: 'Full settings snapshot', p: 'Complete copy of all 143 parameters at that point in time' },
                          { r: 'Diff from previous', p: 'List of parameters that changed, showing old → new value' },
                        ].map((row, i) => (
                          <tr key={row.r} className={i % 2 === 0 ? 'bg-white border-t border-gray-100' : 'bg-gray-50 border-t border-gray-100'}>
                            <td className="px-3 py-2 font-medium text-gray-800">{row.r}</td>
                            <td className="px-3 py-2 text-gray-600">{row.p}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                    <div className="border border-gray-200 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Info className="h-3.5 w-3.5 text-[#1B3A5C]" />
                        <span className="text-xs font-semibold text-gray-700">Viewing history</span>
                      </div>
                      <p className="text-xs text-gray-500">In the Admin page, expand Algorithm Settings and click "View History" to see all past revisions in a side-panel. Each revision shows the full diff.</p>
                    </div>
                    <div className="border border-gray-200 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Shield className="h-3.5 w-3.5 text-[#1B3A5C]" />
                        <span className="text-xs font-semibold text-gray-700">Compliance value</span>
                      </div>
                      <p className="text-xs text-gray-500">The settings history provides an immutable audit trail — useful for demonstrating to tax authorities that reconciliation parameters were stable during the filing period.</p>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* Empty state */}
          {query && totalMatches === 0 && (
            <div className="text-center py-12 text-gray-400">
              <Search className="h-8 w-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No parameters matched "{query}"</p>
              <button
                onClick={() => setQuery('')}
                className="text-xs text-[#1B3A5C] underline mt-1"
              >
                Clear search
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
