"""
Admin Settings API — CRUD for algorithm configuration.
Singleton-with-history: each update creates a new row, deactivates the old one.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from core.deps import get_db, get_current_user, require_admin
from core.audit import log_event
from db.models import AdminSettings, User, CustomExceptionRule

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ── Schemas ──────────────────────────────────────────────────────────────────

class AdminSettingsSchema(BaseModel):
    """Response schema for admin settings."""
    id: str
    doc_types_include: list[str]
    doc_types_exclude: list[str]
    date_hard_cutoff_days: int
    date_soft_preference_days: int
    enforce_books_before_26as: bool
    variance_normal_ceiling_pct: float
    variance_suggested_ceiling_pct: float
    exclude_sgl_v: bool
    max_combo_size: int
    date_clustering_preference: bool
    allow_cross_fy: bool
    cross_fy_lookback_years: int
    force_match_enabled: bool
    noise_threshold: float
    clearing_group_enabled: bool
    clearing_group_variance_pct: Optional[float] = None
    proxy_clearing_enabled: bool
    # Batch Processing (Phase 1)
    batch_concurrency_limit: int
    batch_parse_cache_enabled: bool
    batch_invoice_dedup_enabled: bool
    batch_control_total_enabled: bool
    # Batch Processing (Phase 2)
    batch_auto_retry_count: int
    batch_duplicate_detection_enabled: bool
    batch_progress_dashboard_enabled: bool
    batch_comparison_enabled: bool
    batch_variance_trend_enabled: bool
    batch_export_template: str
    batch_notification_enabled: bool
    batch_notification_webhook_url: Optional[str] = None
    batch_scheduling_enabled: bool
    # Reconciliation Intelligence (Phase 3)
    section_filter_enabled: bool
    invoice_date_proximity_enabled: bool
    max_date_gap_days: int
    as26_duplicate_check_enabled: bool
    credit_note_handling_enabled: bool
    bipartite_matching_enabled: bool
    enumerate_alternatives_enabled: bool
    amount_control_totals_enabled: bool
    match_type_distribution_enabled: bool
    pan_detection_enabled: bool
    large_batch_mode_enabled: bool
    max_sap_rows_per_run: int
    # Workflow & Compliance (Phase 4)
    approval_workflow_enabled: bool
    comment_threads_enabled: bool
    reviewer_assignment_enabled: bool
    bulk_operations_enabled: bool
    run_archival_enabled: bool
    archival_retention_days: int
    compliance_report_enabled: bool
    data_quality_precheck_enabled: bool
    custom_exception_rules_enabled: bool
    run_comparison_enabled: bool
    enhanced_webhook_enabled: bool
    webhook_retry_count: int
    webhook_secret: Optional[str] = None
    # Phase 5
    high_value_threshold: float
    auto_escalate_high_value: bool
    force_match_exception_severity: str
    score_weight_variance: float
    score_weight_date: float
    score_weight_section: float
    score_weight_clearing: float
    score_weight_historical: float
    custom_scoring_enabled: bool
    variance_ceiling_single_pct: float
    variance_ceiling_combo_pct: float
    variance_ceiling_force_single_pct: float
    variance_ceiling_force_combo_pct: float
    custom_variance_ceilings_enabled: bool
    combo_iteration_budget: int
    combo_pool_cap: int
    combo_date_window_days: int
    date_proximity_profile: str
    filing_lag_days_tolerance: int
    clearing_doc_bonus_score: float
    proxy_clearing_date_window_days: int
    rate_tolerance_pct: float
    rate_mismatch_severity: str
    parser_lenient_mode: bool
    cleaner_duplicate_strategy: str
    export_show_score_breakdown: bool
    export_template_active: str
    dashboard_match_rate_target_pct: float
    dashboard_variance_warning_pct: float
    dashboard_exclude_failed_from_trends: bool
    # Phase 6
    confidence_high_variance_threshold: float
    confidence_medium_variance_threshold: float
    confidence_score_boost_threshold: float
    exact_tolerance_rupees: float
    auto_approval_enabled: bool
    auto_approval_min_match_rate: float
    auto_approval_max_exceptions: int
    high_confidence_sections: str
    section_confidence_boost_pct: float
    unmatched_alerting_enabled: bool
    unmatched_critical_amount_threshold: float
    unmatched_critical_count_threshold: int
    force_match_alert_enabled: bool
    force_match_alert_pct_threshold: float
    audit_log_retention_enabled: bool
    audit_log_retention_days: int
    audit_log_redact_amounts: bool
    excel_include_match_distribution: bool
    excel_include_control_totals: bool
    excel_include_variance_analysis: bool
    run_detail_default_sort: str
    run_detail_items_per_page: int
    run_detail_show_score_columns: bool
    batch_hide_zero_match_parties: bool
    batch_summary_sort_by: str
    batch_trend_window_days: int
    # Phase 7
    session_inactivity_timeout_min: int
    max_concurrent_sessions: int
    force_reauth_on_approve: bool
    password_min_length: int
    password_require_mixed_case: bool
    password_require_number: bool
    password_expiry_days: int
    max_failed_login_attempts: int
    login_lockout_duration_min: int
    notify_admin_on_lockout: bool
    run_retention_days: int
    auto_archive_after_days: int
    purge_exports_after_days: int
    export_watermark_enabled: bool
    export_watermark_text: str
    export_require_approval: bool
    redact_tan_in_logs: bool
    redact_pan_in_exports: bool
    mask_amounts_in_preview: bool
    max_upload_size_mb: int
    max_rows_per_file: int
    reject_empty_columns: bool
    anomaly_detection_enabled: bool
    amount_outlier_stddev: float
    match_rate_drop_alert_pct: float
    batch_retry_backoff_seconds: int
    batch_stop_on_failure_count: int
    batch_partial_resume_enabled: bool
    system_alerts_enabled: bool
    slow_run_threshold_seconds: int
    high_exception_rate_pct: float
    updated_at: Optional[str] = None

    class Config:
        from_attributes = True


class AdminSettingsUpdate(BaseModel):
    """Update schema — all fields optional (partial update) with validation."""
    doc_types_include: Optional[list[str]] = None
    doc_types_exclude: Optional[list[str]] = None
    date_hard_cutoff_days: Optional[int] = None
    date_soft_preference_days: Optional[int] = None
    enforce_books_before_26as: Optional[bool] = None
    variance_normal_ceiling_pct: Optional[float] = None
    variance_suggested_ceiling_pct: Optional[float] = None
    exclude_sgl_v: Optional[bool] = None
    max_combo_size: Optional[int] = None
    date_clustering_preference: Optional[bool] = None
    allow_cross_fy: Optional[bool] = None
    cross_fy_lookback_years: Optional[int] = None
    force_match_enabled: Optional[bool] = None
    noise_threshold: Optional[float] = None
    clearing_group_enabled: Optional[bool] = None
    clearing_group_variance_pct: Optional[float] = None
    proxy_clearing_enabled: Optional[bool] = None
    # Batch Processing (Phase 1)
    batch_concurrency_limit: Optional[int] = None
    batch_parse_cache_enabled: Optional[bool] = None
    batch_invoice_dedup_enabled: Optional[bool] = None
    batch_control_total_enabled: Optional[bool] = None
    # Batch Processing (Phase 2)
    batch_auto_retry_count: Optional[int] = None
    batch_duplicate_detection_enabled: Optional[bool] = None
    batch_progress_dashboard_enabled: Optional[bool] = None
    batch_comparison_enabled: Optional[bool] = None
    batch_variance_trend_enabled: Optional[bool] = None
    batch_export_template: Optional[str] = None
    batch_notification_enabled: Optional[bool] = None
    batch_notification_webhook_url: Optional[str] = None
    batch_scheduling_enabled: Optional[bool] = None
    # Reconciliation Intelligence (Phase 3)
    section_filter_enabled: Optional[bool] = None
    invoice_date_proximity_enabled: Optional[bool] = None
    max_date_gap_days: Optional[int] = None
    as26_duplicate_check_enabled: Optional[bool] = None
    credit_note_handling_enabled: Optional[bool] = None
    bipartite_matching_enabled: Optional[bool] = None
    enumerate_alternatives_enabled: Optional[bool] = None
    amount_control_totals_enabled: Optional[bool] = None
    match_type_distribution_enabled: Optional[bool] = None
    pan_detection_enabled: Optional[bool] = None
    large_batch_mode_enabled: Optional[bool] = None
    max_sap_rows_per_run: Optional[int] = None
    # Workflow & Compliance (Phase 4)
    approval_workflow_enabled: Optional[bool] = None
    comment_threads_enabled: Optional[bool] = None
    reviewer_assignment_enabled: Optional[bool] = None
    bulk_operations_enabled: Optional[bool] = None
    run_archival_enabled: Optional[bool] = None
    archival_retention_days: Optional[int] = None
    compliance_report_enabled: Optional[bool] = None
    data_quality_precheck_enabled: Optional[bool] = None
    custom_exception_rules_enabled: Optional[bool] = None
    run_comparison_enabled: Optional[bool] = None
    enhanced_webhook_enabled: Optional[bool] = None
    webhook_retry_count: Optional[int] = None
    webhook_secret: Optional[str] = None
    # Phase 5
    high_value_threshold: Optional[float] = None
    auto_escalate_high_value: Optional[bool] = None
    force_match_exception_severity: Optional[str] = None
    score_weight_variance: Optional[float] = None
    score_weight_date: Optional[float] = None
    score_weight_section: Optional[float] = None
    score_weight_clearing: Optional[float] = None
    score_weight_historical: Optional[float] = None
    custom_scoring_enabled: Optional[bool] = None
    variance_ceiling_single_pct: Optional[float] = None
    variance_ceiling_combo_pct: Optional[float] = None
    variance_ceiling_force_single_pct: Optional[float] = None
    variance_ceiling_force_combo_pct: Optional[float] = None
    custom_variance_ceilings_enabled: Optional[bool] = None
    combo_iteration_budget: Optional[int] = None
    combo_pool_cap: Optional[int] = None
    combo_date_window_days: Optional[int] = None
    date_proximity_profile: Optional[str] = None
    filing_lag_days_tolerance: Optional[int] = None
    clearing_doc_bonus_score: Optional[float] = None
    proxy_clearing_date_window_days: Optional[int] = None
    rate_tolerance_pct: Optional[float] = None
    rate_mismatch_severity: Optional[str] = None
    parser_lenient_mode: Optional[bool] = None
    cleaner_duplicate_strategy: Optional[str] = None
    export_show_score_breakdown: Optional[bool] = None
    export_template_active: Optional[str] = None
    dashboard_match_rate_target_pct: Optional[float] = None
    dashboard_variance_warning_pct: Optional[float] = None
    dashboard_exclude_failed_from_trends: Optional[bool] = None
    # Phase 6
    confidence_high_variance_threshold: Optional[float] = None
    confidence_medium_variance_threshold: Optional[float] = None
    confidence_score_boost_threshold: Optional[float] = None
    exact_tolerance_rupees: Optional[float] = None
    auto_approval_enabled: Optional[bool] = None
    auto_approval_min_match_rate: Optional[float] = None
    auto_approval_max_exceptions: Optional[int] = None
    high_confidence_sections: Optional[str] = None
    section_confidence_boost_pct: Optional[float] = None
    unmatched_alerting_enabled: Optional[bool] = None
    unmatched_critical_amount_threshold: Optional[float] = None
    unmatched_critical_count_threshold: Optional[int] = None
    force_match_alert_enabled: Optional[bool] = None
    force_match_alert_pct_threshold: Optional[float] = None
    audit_log_retention_enabled: Optional[bool] = None
    audit_log_retention_days: Optional[int] = None
    audit_log_redact_amounts: Optional[bool] = None
    excel_include_match_distribution: Optional[bool] = None
    excel_include_control_totals: Optional[bool] = None
    excel_include_variance_analysis: Optional[bool] = None
    run_detail_default_sort: Optional[str] = None
    run_detail_items_per_page: Optional[int] = None
    run_detail_show_score_columns: Optional[bool] = None
    batch_hide_zero_match_parties: Optional[bool] = None
    batch_summary_sort_by: Optional[str] = None
    batch_trend_window_days: Optional[int] = None
    # Phase 7
    session_inactivity_timeout_min: Optional[int] = None
    max_concurrent_sessions: Optional[int] = None
    force_reauth_on_approve: Optional[bool] = None
    password_min_length: Optional[int] = None
    password_require_mixed_case: Optional[bool] = None
    password_require_number: Optional[bool] = None
    password_expiry_days: Optional[int] = None
    max_failed_login_attempts: Optional[int] = None
    login_lockout_duration_min: Optional[int] = None
    notify_admin_on_lockout: Optional[bool] = None
    run_retention_days: Optional[int] = None
    auto_archive_after_days: Optional[int] = None
    purge_exports_after_days: Optional[int] = None
    export_watermark_enabled: Optional[bool] = None
    export_watermark_text: Optional[str] = None
    export_require_approval: Optional[bool] = None
    redact_tan_in_logs: Optional[bool] = None
    redact_pan_in_exports: Optional[bool] = None
    mask_amounts_in_preview: Optional[bool] = None
    max_upload_size_mb: Optional[int] = None
    max_rows_per_file: Optional[int] = None
    reject_empty_columns: Optional[bool] = None
    anomaly_detection_enabled: Optional[bool] = None
    amount_outlier_stddev: Optional[float] = None
    match_rate_drop_alert_pct: Optional[float] = None
    batch_retry_backoff_seconds: Optional[int] = None
    batch_stop_on_failure_count: Optional[int] = None
    batch_partial_resume_enabled: Optional[bool] = None
    system_alerts_enabled: Optional[bool] = None
    slow_run_threshold_seconds: Optional[int] = None
    high_exception_rate_pct: Optional[float] = None

    from pydantic import field_validator

    @field_validator(
        "date_hard_cutoff_days", "date_soft_preference_days",
        "max_combo_size", "cross_fy_lookback_years", "batch_concurrency_limit",
        "batch_auto_retry_count", "max_date_gap_days", "max_sap_rows_per_run",
        "archival_retention_days", "webhook_retry_count",
        "combo_iteration_budget", "combo_pool_cap", "combo_date_window_days",
        "filing_lag_days_tolerance", "proxy_clearing_date_window_days",
        "auto_approval_max_exceptions", "unmatched_critical_count_threshold",
        "audit_log_retention_days", "run_detail_items_per_page", "batch_trend_window_days",
        "session_inactivity_timeout_min", "max_concurrent_sessions", "password_min_length",
        "password_expiry_days", "max_failed_login_attempts", "login_lockout_duration_min",
        "run_retention_days", "auto_archive_after_days", "purge_exports_after_days",
        "max_upload_size_mb", "max_rows_per_file",
        "batch_retry_backoff_seconds", "batch_stop_on_failure_count",
        "slow_run_threshold_seconds",
        mode="before",
    )
    @classmethod
    def _non_negative_int(cls, v):
        if v is not None and v < 0:
            raise ValueError("Value must be non-negative")
        return v

    @field_validator(
        "variance_normal_ceiling_pct", "variance_suggested_ceiling_pct",
        "noise_threshold", "clearing_group_variance_pct",
        "high_value_threshold", "score_weight_variance", "score_weight_date",
        "score_weight_section", "score_weight_clearing", "score_weight_historical",
        "variance_ceiling_single_pct", "variance_ceiling_combo_pct",
        "variance_ceiling_force_single_pct", "variance_ceiling_force_combo_pct",
        "clearing_doc_bonus_score", "rate_tolerance_pct",
        "dashboard_match_rate_target_pct", "dashboard_variance_warning_pct",
        "confidence_high_variance_threshold", "confidence_medium_variance_threshold",
        "confidence_score_boost_threshold", "exact_tolerance_rupees",
        "auto_approval_min_match_rate", "section_confidence_boost_pct",
        "unmatched_critical_amount_threshold", "force_match_alert_pct_threshold",
        "amount_outlier_stddev", "match_rate_drop_alert_pct", "high_exception_rate_pct",
        mode="before",
    )
    @classmethod
    def _non_negative_float(cls, v):
        if v is not None and v < 0:
            raise ValueError("Value must be non-negative")
        return v

    @field_validator("variance_normal_ceiling_pct", "variance_suggested_ceiling_pct", "clearing_group_variance_pct", mode="before")
    @classmethod
    def _pct_max_100(cls, v):
        if v is not None and v > 100:
            raise ValueError("Percentage cannot exceed 100")
        return v

    @field_validator("cross_fy_lookback_years", mode="before")
    @classmethod
    def _lookback_range(cls, v):
        if v is not None and v > 5:
            raise ValueError("Lookback years cannot exceed 5")
        return v

    @field_validator("batch_auto_retry_count", mode="before")
    @classmethod
    def _retry_max(cls, v):
        if v is not None and v > 5:
            raise ValueError("Auto-retry count cannot exceed 5")
        return v

    @field_validator("max_date_gap_days", mode="before")
    @classmethod
    def _date_gap_range(cls, v):
        if v is not None and v > 365:
            raise ValueError("Max date gap cannot exceed 365 days")
        return v

    @field_validator("max_sap_rows_per_run", mode="before")
    @classmethod
    def _sap_rows_range(cls, v):
        if v is not None and v > 500000:
            raise ValueError("Max SAP rows per run cannot exceed 500,000")
        return v

    @field_validator("archival_retention_days", mode="before")
    @classmethod
    def _retention_range(cls, v):
        if v is not None and v > 3650:
            raise ValueError("Retention days cannot exceed 10 years (3650)")
        return v

    @field_validator("webhook_retry_count", mode="before")
    @classmethod
    def _webhook_retry_range(cls, v):
        if v is not None and v > 10:
            raise ValueError("Webhook retry count cannot exceed 10")
        return v

    @field_validator("batch_export_template", mode="before")
    @classmethod
    def _valid_template(cls, v):
        allowed = {"standard", "detailed", "summary", "custom"}
        if v is not None and v not in allowed:
            raise ValueError(f"Export template must be one of: {', '.join(sorted(allowed))}")
        return v

    # Phase 5 validators
    @field_validator("force_match_exception_severity", "rate_mismatch_severity", mode="before")
    @classmethod
    def _valid_severity(cls, v):
        allowed = {"CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"}
        if v is not None and v not in allowed:
            raise ValueError(f"Severity must be one of: {', '.join(sorted(allowed))}")
        return v

    @field_validator("date_proximity_profile", mode="before")
    @classmethod
    def _valid_profile(cls, v):
        allowed = {"STRICT", "STANDARD", "LENIENT", "CUSTOM"}
        if v is not None and v not in allowed:
            raise ValueError(f"Profile must be one of: {', '.join(sorted(allowed))}")
        return v

    @field_validator("cleaner_duplicate_strategy", mode="before")
    @classmethod
    def _valid_dup_strategy(cls, v):
        allowed = {"FIRST_OCCURRENCE", "LAST_OCCURRENCE", "SUM_AMOUNTS"}
        if v is not None and v not in allowed:
            raise ValueError(f"Strategy must be one of: {', '.join(sorted(allowed))}")
        return v

    @field_validator("export_template_active", mode="before")
    @classmethod
    def _valid_export_template(cls, v):
        allowed = {"standard", "ca_review", "itr_filing", "management"}
        if v is not None and v not in allowed:
            raise ValueError(f"Export template must be one of: {', '.join(sorted(allowed))}")
        return v

    @field_validator("combo_iteration_budget", mode="before")
    @classmethod
    def _combo_budget_range(cls, v):
        if v is not None and v > 500000:
            raise ValueError("Combo iteration budget cannot exceed 500,000")
        return v

    # Phase 6 validators
    @field_validator("run_detail_default_sort", mode="before")
    @classmethod
    def _valid_sort(cls, v):
        allowed = {"variance", "amount", "date", "score", "match_type"}
        if v is not None and v not in allowed:
            raise ValueError(f"Sort must be one of: {', '.join(sorted(allowed))}")
        return v

    @field_validator("batch_summary_sort_by", mode="before")
    @classmethod
    def _valid_batch_sort(cls, v):
        allowed = {"match_rate", "name", "amount", "status", "run_number"}
        if v is not None and v not in allowed:
            raise ValueError(f"Batch sort must be one of: {', '.join(sorted(allowed))}")
        return v

    @field_validator("audit_log_retention_days", mode="before")
    @classmethod
    def _audit_retention_range(cls, v):
        if v is not None and v > 3650:
            raise ValueError("Audit log retention cannot exceed 10 years (3650)")
        return v

    @field_validator("run_detail_items_per_page", mode="before")
    @classmethod
    def _items_per_page_range(cls, v):
        if v is not None and (v < 10 or v > 500):
            raise ValueError("Items per page must be between 10 and 500")
        return v

    # Phase 7 validators
    @field_validator("password_min_length", mode="before")
    @classmethod
    def _password_min_range(cls, v):
        if v is not None and (v < 6 or v > 128):
            raise ValueError("Password min length must be between 6 and 128")
        return v

    @field_validator("max_upload_size_mb", mode="before")
    @classmethod
    def _upload_size_range(cls, v):
        if v is not None and (v < 1 or v > 500):
            raise ValueError("Max upload size must be between 1 and 500 MB")
        return v

    @field_validator("max_rows_per_file", mode="before")
    @classmethod
    def _max_rows_range(cls, v):
        if v is not None and v > 1000000:
            raise ValueError("Max rows per file cannot exceed 1,000,000")
        return v

    @field_validator("run_retention_days", "auto_archive_after_days", "purge_exports_after_days", mode="before")
    @classmethod
    def _retention_days_range(cls, v):
        if v is not None and v > 3650:
            raise ValueError("Retention/archive days cannot exceed 10 years (3650)")
        return v

    @field_validator("export_watermark_text", mode="before")
    @classmethod
    def _watermark_text_length(cls, v):
        if v is not None and len(str(v)) > 100:
            raise ValueError("Watermark text cannot exceed 100 characters")
        return v


# ── Helpers ──────────────────────────────────────────────────────────────────

_SETTINGS_FIELDS = [
    "doc_types_include", "doc_types_exclude", "date_hard_cutoff_days",
    "date_soft_preference_days", "enforce_books_before_26as",
    "variance_normal_ceiling_pct", "variance_suggested_ceiling_pct",
    "exclude_sgl_v", "max_combo_size", "date_clustering_preference",
    "allow_cross_fy", "cross_fy_lookback_years", "force_match_enabled",
    "noise_threshold",
    "clearing_group_enabled", "clearing_group_variance_pct", "proxy_clearing_enabled",
    "batch_concurrency_limit", "batch_parse_cache_enabled",
    "batch_invoice_dedup_enabled", "batch_control_total_enabled",
    # Phase 2
    "batch_auto_retry_count", "batch_duplicate_detection_enabled",
    "batch_progress_dashboard_enabled", "batch_comparison_enabled",
    "batch_variance_trend_enabled", "batch_export_template",
    "batch_notification_enabled", "batch_notification_webhook_url",
    "batch_scheduling_enabled",
    # Phase 3
    "section_filter_enabled", "invoice_date_proximity_enabled", "max_date_gap_days",
    "as26_duplicate_check_enabled", "credit_note_handling_enabled",
    "bipartite_matching_enabled", "enumerate_alternatives_enabled",
    "amount_control_totals_enabled", "match_type_distribution_enabled",
    "pan_detection_enabled", "large_batch_mode_enabled", "max_sap_rows_per_run",
    # Phase 4
    "approval_workflow_enabled", "comment_threads_enabled", "reviewer_assignment_enabled",
    "bulk_operations_enabled", "run_archival_enabled", "archival_retention_days",
    "compliance_report_enabled", "data_quality_precheck_enabled",
    "custom_exception_rules_enabled", "run_comparison_enabled",
    "enhanced_webhook_enabled", "webhook_retry_count", "webhook_secret",
    # Phase 5
    "high_value_threshold", "auto_escalate_high_value", "force_match_exception_severity",
    "score_weight_variance", "score_weight_date", "score_weight_section",
    "score_weight_clearing", "score_weight_historical", "custom_scoring_enabled",
    "variance_ceiling_single_pct", "variance_ceiling_combo_pct",
    "variance_ceiling_force_single_pct", "variance_ceiling_force_combo_pct",
    "custom_variance_ceilings_enabled",
    "combo_iteration_budget", "combo_pool_cap", "combo_date_window_days",
    "date_proximity_profile", "filing_lag_days_tolerance",
    "clearing_doc_bonus_score", "proxy_clearing_date_window_days",
    "rate_tolerance_pct", "rate_mismatch_severity",
    "parser_lenient_mode", "cleaner_duplicate_strategy",
    "export_show_score_breakdown", "export_template_active",
    "dashboard_match_rate_target_pct", "dashboard_variance_warning_pct",
    "dashboard_exclude_failed_from_trends",
    # Phase 6
    "confidence_high_variance_threshold", "confidence_medium_variance_threshold",
    "confidence_score_boost_threshold", "exact_tolerance_rupees",
    "auto_approval_enabled", "auto_approval_min_match_rate", "auto_approval_max_exceptions",
    "high_confidence_sections", "section_confidence_boost_pct",
    "unmatched_alerting_enabled", "unmatched_critical_amount_threshold",
    "unmatched_critical_count_threshold",
    "force_match_alert_enabled", "force_match_alert_pct_threshold",
    "audit_log_retention_enabled", "audit_log_retention_days", "audit_log_redact_amounts",
    "excel_include_match_distribution", "excel_include_control_totals",
    "excel_include_variance_analysis",
    "run_detail_default_sort", "run_detail_items_per_page", "run_detail_show_score_columns",
    "batch_hide_zero_match_parties", "batch_summary_sort_by", "batch_trend_window_days",
    # Phase 7
    "session_inactivity_timeout_min", "max_concurrent_sessions", "force_reauth_on_approve",
    "password_min_length", "password_require_mixed_case", "password_require_number",
    "password_expiry_days",
    "max_failed_login_attempts", "login_lockout_duration_min", "notify_admin_on_lockout",
    "run_retention_days", "auto_archive_after_days", "purge_exports_after_days",
    "export_watermark_enabled", "export_watermark_text", "export_require_approval",
    "redact_tan_in_logs", "redact_pan_in_exports", "mask_amounts_in_preview",
    "max_upload_size_mb", "max_rows_per_file", "reject_empty_columns",
    "anomaly_detection_enabled", "amount_outlier_stddev", "match_rate_drop_alert_pct",
    "batch_retry_backoff_seconds", "batch_stop_on_failure_count", "batch_partial_resume_enabled",
    "system_alerts_enabled", "slow_run_threshold_seconds", "high_exception_rate_pct",
]


async def _get_or_create_active(db: AsyncSession) -> AdminSettings:
    """Get the active settings row, or create one with defaults."""
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    settings = result.scalar_one_or_none()
    if not settings:
        settings = AdminSettings(
            doc_types_include=["RV", "DR"],
            doc_types_exclude=["CC", "BR"],
        )
        db.add(settings)
        await db.flush()
    return settings


def _to_schema(s: AdminSettings) -> dict:
    """Convert an AdminSettings ORM instance to a response dict."""
    return {
        "id": s.id,
        "doc_types_include": s.doc_types_include or ["RV", "DR"],
        "doc_types_exclude": s.doc_types_exclude or ["CC", "BR"],
        "date_hard_cutoff_days": s.date_hard_cutoff_days if s.date_hard_cutoff_days is not None else 90,
        "date_soft_preference_days": s.date_soft_preference_days if s.date_soft_preference_days is not None else 180,
        "enforce_books_before_26as": s.enforce_books_before_26as if s.enforce_books_before_26as is not None else True,
        "variance_normal_ceiling_pct": s.variance_normal_ceiling_pct if s.variance_normal_ceiling_pct is not None else 3.0,
        "variance_suggested_ceiling_pct": s.variance_suggested_ceiling_pct if s.variance_suggested_ceiling_pct is not None else 20.0,
        "exclude_sgl_v": s.exclude_sgl_v if s.exclude_sgl_v is not None else True,
        "max_combo_size": s.max_combo_size if s.max_combo_size is not None else 5,
        "date_clustering_preference": s.date_clustering_preference if s.date_clustering_preference is not None else True,
        "allow_cross_fy": s.allow_cross_fy if s.allow_cross_fy is not None else False,
        "cross_fy_lookback_years": s.cross_fy_lookback_years if s.cross_fy_lookback_years is not None else 1,
        "force_match_enabled": s.force_match_enabled if s.force_match_enabled is not None else True,
        "noise_threshold": s.noise_threshold if s.noise_threshold is not None else 1.0,
        "clearing_group_enabled": s.clearing_group_enabled if s.clearing_group_enabled is not None else True,
        "clearing_group_variance_pct": s.clearing_group_variance_pct,
        "proxy_clearing_enabled": s.proxy_clearing_enabled if s.proxy_clearing_enabled is not None else True,
        # Batch Processing
        "batch_concurrency_limit": s.batch_concurrency_limit if s.batch_concurrency_limit is not None else 10,
        "batch_parse_cache_enabled": s.batch_parse_cache_enabled if s.batch_parse_cache_enabled is not None else True,
        "batch_invoice_dedup_enabled": s.batch_invoice_dedup_enabled if s.batch_invoice_dedup_enabled is not None else False,
        "batch_control_total_enabled": s.batch_control_total_enabled if s.batch_control_total_enabled is not None else False,
        # Phase 2
        "batch_auto_retry_count": s.batch_auto_retry_count if s.batch_auto_retry_count is not None else 0,
        "batch_duplicate_detection_enabled": s.batch_duplicate_detection_enabled if s.batch_duplicate_detection_enabled is not None else False,
        "batch_progress_dashboard_enabled": s.batch_progress_dashboard_enabled if s.batch_progress_dashboard_enabled is not None else True,
        "batch_comparison_enabled": s.batch_comparison_enabled if s.batch_comparison_enabled is not None else True,
        "batch_variance_trend_enabled": s.batch_variance_trend_enabled if s.batch_variance_trend_enabled is not None else True,
        "batch_export_template": s.batch_export_template if s.batch_export_template is not None else "standard",
        "batch_notification_enabled": s.batch_notification_enabled if s.batch_notification_enabled is not None else False,
        "batch_notification_webhook_url": s.batch_notification_webhook_url,
        "batch_scheduling_enabled": s.batch_scheduling_enabled if s.batch_scheduling_enabled is not None else False,
        # Phase 3
        "section_filter_enabled": s.section_filter_enabled if s.section_filter_enabled is not None else False,
        "invoice_date_proximity_enabled": s.invoice_date_proximity_enabled if s.invoice_date_proximity_enabled is not None else False,
        "max_date_gap_days": s.max_date_gap_days if s.max_date_gap_days is not None else 90,
        "as26_duplicate_check_enabled": s.as26_duplicate_check_enabled if s.as26_duplicate_check_enabled is not None else False,
        "credit_note_handling_enabled": s.credit_note_handling_enabled if s.credit_note_handling_enabled is not None else False,
        "bipartite_matching_enabled": s.bipartite_matching_enabled if s.bipartite_matching_enabled is not None else False,
        "enumerate_alternatives_enabled": s.enumerate_alternatives_enabled if s.enumerate_alternatives_enabled is not None else False,
        "amount_control_totals_enabled": s.amount_control_totals_enabled if s.amount_control_totals_enabled is not None else True,
        "match_type_distribution_enabled": s.match_type_distribution_enabled if s.match_type_distribution_enabled is not None else True,
        "pan_detection_enabled": s.pan_detection_enabled if s.pan_detection_enabled is not None else False,
        "large_batch_mode_enabled": s.large_batch_mode_enabled if s.large_batch_mode_enabled is not None else False,
        "max_sap_rows_per_run": s.max_sap_rows_per_run if s.max_sap_rows_per_run is not None else 100000,
        # Phase 4
        "approval_workflow_enabled": s.approval_workflow_enabled if s.approval_workflow_enabled is not None else True,
        "comment_threads_enabled": s.comment_threads_enabled if s.comment_threads_enabled is not None else True,
        "reviewer_assignment_enabled": s.reviewer_assignment_enabled if s.reviewer_assignment_enabled is not None else False,
        "bulk_operations_enabled": s.bulk_operations_enabled if s.bulk_operations_enabled is not None else True,
        "run_archival_enabled": s.run_archival_enabled if s.run_archival_enabled is not None else False,
        "archival_retention_days": s.archival_retention_days if s.archival_retention_days is not None else 365,
        "compliance_report_enabled": s.compliance_report_enabled if s.compliance_report_enabled is not None else False,
        "data_quality_precheck_enabled": s.data_quality_precheck_enabled if s.data_quality_precheck_enabled is not None else True,
        "custom_exception_rules_enabled": s.custom_exception_rules_enabled if s.custom_exception_rules_enabled is not None else False,
        "run_comparison_enabled": s.run_comparison_enabled if s.run_comparison_enabled is not None else True,
        "enhanced_webhook_enabled": s.enhanced_webhook_enabled if s.enhanced_webhook_enabled is not None else False,
        "webhook_retry_count": s.webhook_retry_count if s.webhook_retry_count is not None else 3,
        "webhook_secret": s.webhook_secret,
        # Phase 5
        "high_value_threshold": s.high_value_threshold if s.high_value_threshold is not None else 1000000.0,
        "auto_escalate_high_value": s.auto_escalate_high_value if s.auto_escalate_high_value is not None else True,
        "force_match_exception_severity": s.force_match_exception_severity if s.force_match_exception_severity is not None else "HIGH",
        "score_weight_variance": s.score_weight_variance if s.score_weight_variance is not None else 30.0,
        "score_weight_date": s.score_weight_date if s.score_weight_date is not None else 20.0,
        "score_weight_section": s.score_weight_section if s.score_weight_section is not None else 20.0,
        "score_weight_clearing": s.score_weight_clearing if s.score_weight_clearing is not None else 20.0,
        "score_weight_historical": s.score_weight_historical if s.score_weight_historical is not None else 10.0,
        "custom_scoring_enabled": s.custom_scoring_enabled if s.custom_scoring_enabled is not None else False,
        "variance_ceiling_single_pct": s.variance_ceiling_single_pct if s.variance_ceiling_single_pct is not None else 2.0,
        "variance_ceiling_combo_pct": s.variance_ceiling_combo_pct if s.variance_ceiling_combo_pct is not None else 3.0,
        "variance_ceiling_force_single_pct": s.variance_ceiling_force_single_pct if s.variance_ceiling_force_single_pct is not None else 5.0,
        "variance_ceiling_force_combo_pct": s.variance_ceiling_force_combo_pct if s.variance_ceiling_force_combo_pct is not None else 2.0,
        "custom_variance_ceilings_enabled": s.custom_variance_ceilings_enabled if s.custom_variance_ceilings_enabled is not None else False,
        "combo_iteration_budget": s.combo_iteration_budget if s.combo_iteration_budget is not None else 50000,
        "combo_pool_cap": s.combo_pool_cap if s.combo_pool_cap is not None else 5000,
        "combo_date_window_days": s.combo_date_window_days if s.combo_date_window_days is not None else 30,
        "date_proximity_profile": s.date_proximity_profile if s.date_proximity_profile is not None else "STANDARD",
        "filing_lag_days_tolerance": s.filing_lag_days_tolerance if s.filing_lag_days_tolerance is not None else 45,
        "clearing_doc_bonus_score": s.clearing_doc_bonus_score if s.clearing_doc_bonus_score is not None else 20.0,
        "proxy_clearing_date_window_days": s.proxy_clearing_date_window_days if s.proxy_clearing_date_window_days is not None else 30,
        "rate_tolerance_pct": s.rate_tolerance_pct if s.rate_tolerance_pct is not None else 2.0,
        "rate_mismatch_severity": s.rate_mismatch_severity if s.rate_mismatch_severity is not None else "MEDIUM",
        "parser_lenient_mode": s.parser_lenient_mode if s.parser_lenient_mode is not None else True,
        "cleaner_duplicate_strategy": s.cleaner_duplicate_strategy if s.cleaner_duplicate_strategy is not None else "FIRST_OCCURRENCE",
        "export_show_score_breakdown": s.export_show_score_breakdown if s.export_show_score_breakdown is not None else True,
        "export_template_active": s.export_template_active if s.export_template_active is not None else "standard",
        "dashboard_match_rate_target_pct": s.dashboard_match_rate_target_pct if s.dashboard_match_rate_target_pct is not None else 75.0,
        "dashboard_variance_warning_pct": s.dashboard_variance_warning_pct if s.dashboard_variance_warning_pct is not None else 5.0,
        "dashboard_exclude_failed_from_trends": s.dashboard_exclude_failed_from_trends if s.dashboard_exclude_failed_from_trends is not None else True,
        # Phase 6
        "confidence_high_variance_threshold": s.confidence_high_variance_threshold if s.confidence_high_variance_threshold is not None else 1.0,
        "confidence_medium_variance_threshold": s.confidence_medium_variance_threshold if s.confidence_medium_variance_threshold is not None else 5.0,
        "confidence_score_boost_threshold": s.confidence_score_boost_threshold if s.confidence_score_boost_threshold is not None else 70.0,
        "exact_tolerance_rupees": s.exact_tolerance_rupees if s.exact_tolerance_rupees is not None else 0.01,
        "auto_approval_enabled": s.auto_approval_enabled if s.auto_approval_enabled is not None else False,
        "auto_approval_min_match_rate": s.auto_approval_min_match_rate if s.auto_approval_min_match_rate is not None else 75.0,
        "auto_approval_max_exceptions": s.auto_approval_max_exceptions if s.auto_approval_max_exceptions is not None else 10,
        "high_confidence_sections": s.high_confidence_sections if s.high_confidence_sections is not None else "194C,194J,194H,194I,194A",
        "section_confidence_boost_pct": s.section_confidence_boost_pct if s.section_confidence_boost_pct is not None else 60.0,
        "unmatched_alerting_enabled": s.unmatched_alerting_enabled if s.unmatched_alerting_enabled is not None else True,
        "unmatched_critical_amount_threshold": s.unmatched_critical_amount_threshold if s.unmatched_critical_amount_threshold is not None else 500000.0,
        "unmatched_critical_count_threshold": s.unmatched_critical_count_threshold if s.unmatched_critical_count_threshold is not None else 50,
        "force_match_alert_enabled": s.force_match_alert_enabled if s.force_match_alert_enabled is not None else True,
        "force_match_alert_pct_threshold": s.force_match_alert_pct_threshold if s.force_match_alert_pct_threshold is not None else 10.0,
        "audit_log_retention_enabled": s.audit_log_retention_enabled if s.audit_log_retention_enabled is not None else False,
        "audit_log_retention_days": s.audit_log_retention_days if s.audit_log_retention_days is not None else 1095,
        "audit_log_redact_amounts": s.audit_log_redact_amounts if s.audit_log_redact_amounts is not None else False,
        "excel_include_match_distribution": s.excel_include_match_distribution if s.excel_include_match_distribution is not None else True,
        "excel_include_control_totals": s.excel_include_control_totals if s.excel_include_control_totals is not None else True,
        "excel_include_variance_analysis": s.excel_include_variance_analysis if s.excel_include_variance_analysis is not None else True,
        "run_detail_default_sort": s.run_detail_default_sort if s.run_detail_default_sort is not None else "variance",
        "run_detail_items_per_page": s.run_detail_items_per_page if s.run_detail_items_per_page is not None else 50,
        "run_detail_show_score_columns": s.run_detail_show_score_columns if s.run_detail_show_score_columns is not None else True,
        "batch_hide_zero_match_parties": s.batch_hide_zero_match_parties if s.batch_hide_zero_match_parties is not None else False,
        "batch_summary_sort_by": s.batch_summary_sort_by if s.batch_summary_sort_by is not None else "match_rate",
        "batch_trend_window_days": s.batch_trend_window_days if s.batch_trend_window_days is not None else 90,
        # Phase 7
        "session_inactivity_timeout_min": s.session_inactivity_timeout_min if s.session_inactivity_timeout_min is not None else 30,
        "max_concurrent_sessions": s.max_concurrent_sessions if s.max_concurrent_sessions is not None else 3,
        "force_reauth_on_approve": s.force_reauth_on_approve if s.force_reauth_on_approve is not None else False,
        "password_min_length": s.password_min_length if s.password_min_length is not None else 8,
        "password_require_mixed_case": s.password_require_mixed_case if s.password_require_mixed_case is not None else True,
        "password_require_number": s.password_require_number if s.password_require_number is not None else True,
        "password_expiry_days": s.password_expiry_days if s.password_expiry_days is not None else 0,
        "max_failed_login_attempts": s.max_failed_login_attempts if s.max_failed_login_attempts is not None else 5,
        "login_lockout_duration_min": s.login_lockout_duration_min if s.login_lockout_duration_min is not None else 15,
        "notify_admin_on_lockout": s.notify_admin_on_lockout if s.notify_admin_on_lockout is not None else False,
        "run_retention_days": s.run_retention_days if s.run_retention_days is not None else 365,
        "auto_archive_after_days": s.auto_archive_after_days if s.auto_archive_after_days is not None else 90,
        "purge_exports_after_days": s.purge_exports_after_days if s.purge_exports_after_days is not None else 30,
        "export_watermark_enabled": s.export_watermark_enabled if s.export_watermark_enabled is not None else False,
        "export_watermark_text": s.export_watermark_text if s.export_watermark_text is not None else "CONFIDENTIAL",
        "export_require_approval": s.export_require_approval if s.export_require_approval is not None else False,
        "redact_tan_in_logs": s.redact_tan_in_logs if s.redact_tan_in_logs is not None else False,
        "redact_pan_in_exports": s.redact_pan_in_exports if s.redact_pan_in_exports is not None else False,
        "mask_amounts_in_preview": s.mask_amounts_in_preview if s.mask_amounts_in_preview is not None else False,
        "max_upload_size_mb": s.max_upload_size_mb if s.max_upload_size_mb is not None else 50,
        "max_rows_per_file": s.max_rows_per_file if s.max_rows_per_file is not None else 100000,
        "reject_empty_columns": s.reject_empty_columns if s.reject_empty_columns is not None else False,
        "anomaly_detection_enabled": s.anomaly_detection_enabled if s.anomaly_detection_enabled is not None else False,
        "amount_outlier_stddev": s.amount_outlier_stddev if s.amount_outlier_stddev is not None else 3.0,
        "match_rate_drop_alert_pct": s.match_rate_drop_alert_pct if s.match_rate_drop_alert_pct is not None else 20.0,
        "batch_retry_backoff_seconds": s.batch_retry_backoff_seconds if s.batch_retry_backoff_seconds is not None else 2,
        "batch_stop_on_failure_count": s.batch_stop_on_failure_count if s.batch_stop_on_failure_count is not None else 0,
        "batch_partial_resume_enabled": s.batch_partial_resume_enabled if s.batch_partial_resume_enabled is not None else False,
        "system_alerts_enabled": s.system_alerts_enabled if s.system_alerts_enabled is not None else False,
        "slow_run_threshold_seconds": s.slow_run_threshold_seconds if s.slow_run_threshold_seconds is not None else 300,
        "high_exception_rate_pct": s.high_exception_rate_pct if s.high_exception_rate_pct is not None else 50.0,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("", response_model=AdminSettingsSchema)
async def get_settings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get current active admin settings. Any authenticated user can read."""
    settings = await _get_or_create_active(db)
    return _to_schema(settings)


@router.put("", response_model=AdminSettingsSchema)
async def update_settings(
    body: AdminSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    Update admin settings. Admin only.
    Creates a new settings row (for history) and deactivates the previous one.
    """
    old = await _get_or_create_active(db)
    old.is_active = False

    # Build new settings: start with old values, overlay any provided updates.
    # Use model_fields_set to distinguish "not sent" from "explicitly set to null".
    new_data = {}
    for col in _SETTINGS_FIELDS:
        if col in body.model_fields_set:
            new_data[col] = getattr(body, col)
        else:
            new_data[col] = getattr(old, col)

    new_settings = AdminSettings(
        **new_data,
        updated_by_id=current_user.id,
    )
    db.add(new_settings)
    await db.flush()

    await log_event(
        db,
        "SETTINGS_UPDATED",
        f"Admin settings updated by {current_user.full_name}",
        user_id=current_user.id,
        metadata=body.model_dump(exclude_none=True),
    )
    await db.commit()

    return _to_schema(new_settings)


@router.get("/history")
async def get_settings_history(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Get the last 20 settings revisions (most recent first). Admin only."""
    result = await db.execute(
        select(AdminSettings).order_by(AdminSettings.created_at.desc()).limit(20)
    )
    rows = result.scalars().all()
    return [_to_schema(r) for r in rows]


# ── Custom Exception Rules (Phase 4H) ───────────────────────────────────────

from typing import List


class ExceptionRuleCreate(BaseModel):
    name: str
    description: Optional[str] = None
    field: str  # e.g. "variance_pct", "as26_amount", "match_type", "section"
    operator: str  # gt, lt, gte, lte, eq, ne, contains
    value: str
    severity: str = "MEDIUM"


class ExceptionRuleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    field: Optional[str] = None
    operator: Optional[str] = None
    value: Optional[str] = None
    severity: Optional[str] = None
    is_active: Optional[bool] = None


def _rule_to_dict(r: CustomExceptionRule) -> dict:
    return {
        "id": r.id, "name": r.name, "description": r.description,
        "field": r.field, "operator": r.operator, "value": r.value,
        "severity": r.severity, "is_active": r.is_active,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


@router.get("/exception-rules")
async def list_exception_rules(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(CustomExceptionRule).order_by(CustomExceptionRule.created_at.desc())
    )
    return [_rule_to_dict(r) for r in result.scalars().all()]


@router.post("/exception-rules", status_code=201)
async def create_exception_rule(
    body: ExceptionRuleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    # Validate field/operator
    valid_fields = {"variance_pct", "as26_amount", "match_type", "section", "confidence", "books_sum"}
    valid_operators = {"gt", "lt", "gte", "lte", "eq", "ne", "contains"}
    if body.field not in valid_fields:
        raise HTTPException(status_code=400, detail=f"Invalid field. Must be one of: {', '.join(valid_fields)}")
    if body.operator not in valid_operators:
        raise HTTPException(status_code=400, detail=f"Invalid operator. Must be one of: {', '.join(valid_operators)}")

    rule = CustomExceptionRule(
        name=body.name, description=body.description,
        field=body.field, operator=body.operator, value=body.value,
        severity=body.severity, created_by_id=current_user.id,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    await log_event(db, "EXCEPTION_RULE_CREATED", f"Custom rule '{body.name}' created by {current_user.full_name}")
    return _rule_to_dict(rule)


@router.put("/exception-rules/{rule_id}")
async def update_exception_rule(
    rule_id: str,
    body: ExceptionRuleUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    result = await db.execute(select(CustomExceptionRule).where(CustomExceptionRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")

    for field in ("name", "description", "field", "operator", "value", "severity", "is_active"):
        val = getattr(body, field, None)
        if val is not None:
            setattr(rule, field, val)

    await db.commit()
    await db.refresh(rule)
    return _rule_to_dict(rule)


@router.delete("/exception-rules/{rule_id}", status_code=204)
async def delete_exception_rule(
    rule_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    result = await db.execute(select(CustomExceptionRule).where(CustomExceptionRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.delete(rule)
    await db.commit()
