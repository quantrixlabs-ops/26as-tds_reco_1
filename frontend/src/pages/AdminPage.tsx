/**
 * AdminPage — algorithm settings + user management (ADMIN only)
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  UserPlus,
  Users,
  Shield,
  AlertCircle,
  Mail,
  Lock,
  User,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  X,
  Plus,
  Save,
  Check,
} from 'lucide-react';
import {
  authApi,
  settingsApi,
  type Role,
  type User as UserType,
  type AdminSettingsUpdate,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Table, type Column } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { PageWrapper } from '../components/ui/PageHeader';
import { TableSkeleton } from '../components/ui/Skeleton';
import { roleVariant, getErrorMessage, cn, formatDateTime } from '../lib/utils';

// ── Toggle switch (inline) ────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative w-10 h-5 rounded-full transition-colors',
          checked ? 'bg-[#1B3A5C]' : 'bg-gray-300',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </button>
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );
}

// ── Multi-tag input ───────────────────────────────────────────────────────────

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = useCallback(() => {
    const val = inputValue.trim().toUpperCase();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInputValue('');
  }, [inputValue, tags, onChange]);

  const removeTag = useCallback(
    (tag: string) => {
      onChange(tags.filter((t) => t !== tag));
    },
    [tags, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 min-h-[38px] w-full px-2.5 py-1.5 border border-gray-300 rounded-lg focus-within:border-[#1B3A5C] focus-within:ring-2 focus-within:ring-[#1B3A5C]/10 transition-colors cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-[#1B3A5C]/10 text-[#1B3A5C] rounded-md"
        >
          {tag}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              removeTag(tag);
            }}
            className="hover:text-red-600 transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <div className="flex items-center gap-1 flex-1 min-w-[60px]">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={addTag}
          placeholder={tags.length === 0 ? placeholder : ''}
          className="flex-1 text-sm outline-none bg-transparent min-w-[40px]"
        />
        {inputValue.trim() && (
          <button
            type="button"
            onClick={addTag}
            className="text-[#1B3A5C] hover:text-[#15304d]"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Number input for settings ─────────────────────────────────────────────────

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  helpText,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  helpText?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => {
            let v = parseFloat(e.target.value) || 0;
            if (min != null && v < min) v = min;
            if (max != null && v > max) v = max;
            onChange(v);
          }}
          min={min}
          max={max}
          step={step ?? 1}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
        />
        {suffix && (
          <span className="text-sm text-gray-500 shrink-0">{suffix}</span>
        )}
      </div>
      {helpText && (
        <p className="text-xs text-gray-400 mt-1">{helpText}</p>
      )}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
        {title}
      </h4>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

// ── Algorithm Settings Card ───────────────────────────────────────────────────

function AlgorithmSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const {
    data: settings,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: settingsApi.get,
  });

  // Local draft state, synced from server on load
  const [draft, setDraft] = useState<AdminSettingsUpdate | null>(null);

  // Sync draft when server data arrives
  useEffect(() => {
    if (settings && !draft) {
      setDraft({
        doc_types_include: settings.doc_types_include,
        doc_types_exclude: settings.doc_types_exclude,
        date_hard_cutoff_days: settings.date_hard_cutoff_days,
        date_soft_preference_days: settings.date_soft_preference_days,
        enforce_books_before_26as: settings.enforce_books_before_26as,
        variance_normal_ceiling_pct: settings.variance_normal_ceiling_pct,
        variance_suggested_ceiling_pct: settings.variance_suggested_ceiling_pct,
        exclude_sgl_v: settings.exclude_sgl_v,
        max_combo_size: settings.max_combo_size,
        date_clustering_preference: settings.date_clustering_preference,
        allow_cross_fy: settings.allow_cross_fy,
        cross_fy_lookback_years: settings.cross_fy_lookback_years,
        force_match_enabled: settings.force_match_enabled,
        noise_threshold: settings.noise_threshold,
        clearing_group_enabled: settings.clearing_group_enabled,
        clearing_group_variance_pct: settings.clearing_group_variance_pct,
        proxy_clearing_enabled: settings.proxy_clearing_enabled,
        batch_concurrency_limit: settings.batch_concurrency_limit,
        batch_parse_cache_enabled: settings.batch_parse_cache_enabled,
        batch_invoice_dedup_enabled: settings.batch_invoice_dedup_enabled,
        batch_control_total_enabled: settings.batch_control_total_enabled,
        batch_auto_retry_count: settings.batch_auto_retry_count,
        batch_duplicate_detection_enabled: settings.batch_duplicate_detection_enabled,
        batch_progress_dashboard_enabled: settings.batch_progress_dashboard_enabled,
        batch_comparison_enabled: settings.batch_comparison_enabled,
        batch_variance_trend_enabled: settings.batch_variance_trend_enabled,
        batch_export_template: settings.batch_export_template,
        batch_notification_enabled: settings.batch_notification_enabled,
        batch_notification_webhook_url: settings.batch_notification_webhook_url,
        batch_scheduling_enabled: settings.batch_scheduling_enabled,
        // Phase 3
        section_filter_enabled: settings.section_filter_enabled,
        invoice_date_proximity_enabled: settings.invoice_date_proximity_enabled,
        max_date_gap_days: settings.max_date_gap_days,
        as26_duplicate_check_enabled: settings.as26_duplicate_check_enabled,
        credit_note_handling_enabled: settings.credit_note_handling_enabled,
        bipartite_matching_enabled: settings.bipartite_matching_enabled,
        enumerate_alternatives_enabled: settings.enumerate_alternatives_enabled,
        amount_control_totals_enabled: settings.amount_control_totals_enabled,
        match_type_distribution_enabled: settings.match_type_distribution_enabled,
        pan_detection_enabled: settings.pan_detection_enabled,
        large_batch_mode_enabled: settings.large_batch_mode_enabled,
        max_sap_rows_per_run: settings.max_sap_rows_per_run,
        // Phase 4
        approval_workflow_enabled: settings.approval_workflow_enabled,
        comment_threads_enabled: settings.comment_threads_enabled,
        reviewer_assignment_enabled: settings.reviewer_assignment_enabled,
        bulk_operations_enabled: settings.bulk_operations_enabled,
        run_archival_enabled: settings.run_archival_enabled,
        archival_retention_days: settings.archival_retention_days,
        compliance_report_enabled: settings.compliance_report_enabled,
        data_quality_precheck_enabled: settings.data_quality_precheck_enabled,
        custom_exception_rules_enabled: settings.custom_exception_rules_enabled,
        run_comparison_enabled: settings.run_comparison_enabled,
        enhanced_webhook_enabled: settings.enhanced_webhook_enabled,
        webhook_retry_count: settings.webhook_retry_count,
        webhook_secret: settings.webhook_secret,
        // Phase 5
        high_value_threshold: settings.high_value_threshold,
        auto_escalate_high_value: settings.auto_escalate_high_value,
        force_match_exception_severity: settings.force_match_exception_severity,
        score_weight_variance: settings.score_weight_variance,
        score_weight_date: settings.score_weight_date,
        score_weight_section: settings.score_weight_section,
        score_weight_clearing: settings.score_weight_clearing,
        score_weight_historical: settings.score_weight_historical,
        custom_scoring_enabled: settings.custom_scoring_enabled,
        variance_ceiling_single_pct: settings.variance_ceiling_single_pct,
        variance_ceiling_combo_pct: settings.variance_ceiling_combo_pct,
        variance_ceiling_force_single_pct: settings.variance_ceiling_force_single_pct,
        variance_ceiling_force_combo_pct: settings.variance_ceiling_force_combo_pct,
        custom_variance_ceilings_enabled: settings.custom_variance_ceilings_enabled,
        combo_iteration_budget: settings.combo_iteration_budget,
        combo_pool_cap: settings.combo_pool_cap,
        combo_date_window_days: settings.combo_date_window_days,
        date_proximity_profile: settings.date_proximity_profile,
        filing_lag_days_tolerance: settings.filing_lag_days_tolerance,
        clearing_doc_bonus_score: settings.clearing_doc_bonus_score,
        proxy_clearing_date_window_days: settings.proxy_clearing_date_window_days,
        rate_tolerance_pct: settings.rate_tolerance_pct,
        rate_mismatch_severity: settings.rate_mismatch_severity,
        parser_lenient_mode: settings.parser_lenient_mode,
        cleaner_duplicate_strategy: settings.cleaner_duplicate_strategy,
        export_show_score_breakdown: settings.export_show_score_breakdown,
        export_template_active: settings.export_template_active,
        dashboard_match_rate_target_pct: settings.dashboard_match_rate_target_pct,
        dashboard_variance_warning_pct: settings.dashboard_variance_warning_pct,
        dashboard_exclude_failed_from_trends: settings.dashboard_exclude_failed_from_trends,
        // Phase 6
        confidence_high_variance_threshold: settings.confidence_high_variance_threshold,
        confidence_medium_variance_threshold: settings.confidence_medium_variance_threshold,
        confidence_score_boost_threshold: settings.confidence_score_boost_threshold,
        exact_tolerance_rupees: settings.exact_tolerance_rupees,
        auto_approval_enabled: settings.auto_approval_enabled,
        auto_approval_min_match_rate: settings.auto_approval_min_match_rate,
        auto_approval_max_exceptions: settings.auto_approval_max_exceptions,
        high_confidence_sections: settings.high_confidence_sections,
        section_confidence_boost_pct: settings.section_confidence_boost_pct,
        unmatched_alerting_enabled: settings.unmatched_alerting_enabled,
        unmatched_critical_amount_threshold: settings.unmatched_critical_amount_threshold,
        unmatched_critical_count_threshold: settings.unmatched_critical_count_threshold,
        force_match_alert_enabled: settings.force_match_alert_enabled,
        force_match_alert_pct_threshold: settings.force_match_alert_pct_threshold,
        audit_log_retention_enabled: settings.audit_log_retention_enabled,
        audit_log_retention_days: settings.audit_log_retention_days,
        audit_log_redact_amounts: settings.audit_log_redact_amounts,
        excel_include_match_distribution: settings.excel_include_match_distribution,
        excel_include_control_totals: settings.excel_include_control_totals,
        excel_include_variance_analysis: settings.excel_include_variance_analysis,
        run_detail_default_sort: settings.run_detail_default_sort,
        run_detail_items_per_page: settings.run_detail_items_per_page,
        run_detail_show_score_columns: settings.run_detail_show_score_columns,
        batch_hide_zero_match_parties: settings.batch_hide_zero_match_parties,
        batch_summary_sort_by: settings.batch_summary_sort_by,
        batch_trend_window_days: settings.batch_trend_window_days,
        // Phase 7
        session_inactivity_timeout_min: settings.session_inactivity_timeout_min,
        max_concurrent_sessions: settings.max_concurrent_sessions,
        force_reauth_on_approve: settings.force_reauth_on_approve,
        password_min_length: settings.password_min_length,
        password_require_mixed_case: settings.password_require_mixed_case,
        password_require_number: settings.password_require_number,
        password_expiry_days: settings.password_expiry_days,
        max_failed_login_attempts: settings.max_failed_login_attempts,
        login_lockout_duration_min: settings.login_lockout_duration_min,
        notify_admin_on_lockout: settings.notify_admin_on_lockout,
        run_retention_days: settings.run_retention_days,
        auto_archive_after_days: settings.auto_archive_after_days,
        purge_exports_after_days: settings.purge_exports_after_days,
        export_watermark_enabled: settings.export_watermark_enabled,
        export_watermark_text: settings.export_watermark_text,
        export_require_approval: settings.export_require_approval,
        redact_tan_in_logs: settings.redact_tan_in_logs,
        redact_pan_in_exports: settings.redact_pan_in_exports,
        mask_amounts_in_preview: settings.mask_amounts_in_preview,
        max_upload_size_mb: settings.max_upload_size_mb,
        max_rows_per_file: settings.max_rows_per_file,
        reject_empty_columns: settings.reject_empty_columns,
        anomaly_detection_enabled: settings.anomaly_detection_enabled,
        amount_outlier_stddev: settings.amount_outlier_stddev,
        match_rate_drop_alert_pct: settings.match_rate_drop_alert_pct,
        batch_retry_backoff_seconds: settings.batch_retry_backoff_seconds,
        batch_stop_on_failure_count: settings.batch_stop_on_failure_count,
        batch_partial_resume_enabled: settings.batch_partial_resume_enabled,
        system_alerts_enabled: settings.system_alerts_enabled,
        slow_run_threshold_seconds: settings.slow_run_threshold_seconds,
        high_exception_rate_pct: settings.high_exception_rate_pct,
      });
    }
  }, [settings, draft]);

  const saveMut = useMutation({
    mutationFn: (data: AdminSettingsUpdate) => settingsApi.update(data),
    onSuccess: (updated) => {
      queryClient.setQueryData(['admin-settings'], updated);
      toast('Settings saved', 'Algorithm parameters updated successfully', 'success');
      // Reset draft to match the saved data
      setDraft({
        doc_types_include: updated.doc_types_include,
        doc_types_exclude: updated.doc_types_exclude,
        date_hard_cutoff_days: updated.date_hard_cutoff_days,
        date_soft_preference_days: updated.date_soft_preference_days,
        enforce_books_before_26as: updated.enforce_books_before_26as,
        variance_normal_ceiling_pct: updated.variance_normal_ceiling_pct,
        variance_suggested_ceiling_pct: updated.variance_suggested_ceiling_pct,
        exclude_sgl_v: updated.exclude_sgl_v,
        max_combo_size: updated.max_combo_size,
        date_clustering_preference: updated.date_clustering_preference,
        allow_cross_fy: updated.allow_cross_fy,
        cross_fy_lookback_years: updated.cross_fy_lookback_years,
        force_match_enabled: updated.force_match_enabled,
        noise_threshold: updated.noise_threshold,
        clearing_group_enabled: updated.clearing_group_enabled,
        clearing_group_variance_pct: updated.clearing_group_variance_pct,
        proxy_clearing_enabled: updated.proxy_clearing_enabled,
        batch_concurrency_limit: updated.batch_concurrency_limit,
        batch_parse_cache_enabled: updated.batch_parse_cache_enabled,
        batch_invoice_dedup_enabled: updated.batch_invoice_dedup_enabled,
        batch_control_total_enabled: updated.batch_control_total_enabled,
        batch_auto_retry_count: updated.batch_auto_retry_count,
        batch_duplicate_detection_enabled: updated.batch_duplicate_detection_enabled,
        batch_progress_dashboard_enabled: updated.batch_progress_dashboard_enabled,
        batch_comparison_enabled: updated.batch_comparison_enabled,
        batch_variance_trend_enabled: updated.batch_variance_trend_enabled,
        batch_export_template: updated.batch_export_template,
        batch_notification_enabled: updated.batch_notification_enabled,
        batch_notification_webhook_url: updated.batch_notification_webhook_url,
        batch_scheduling_enabled: updated.batch_scheduling_enabled,
        // Phase 3
        section_filter_enabled: updated.section_filter_enabled,
        invoice_date_proximity_enabled: updated.invoice_date_proximity_enabled,
        max_date_gap_days: updated.max_date_gap_days,
        as26_duplicate_check_enabled: updated.as26_duplicate_check_enabled,
        credit_note_handling_enabled: updated.credit_note_handling_enabled,
        bipartite_matching_enabled: updated.bipartite_matching_enabled,
        enumerate_alternatives_enabled: updated.enumerate_alternatives_enabled,
        amount_control_totals_enabled: updated.amount_control_totals_enabled,
        match_type_distribution_enabled: updated.match_type_distribution_enabled,
        pan_detection_enabled: updated.pan_detection_enabled,
        large_batch_mode_enabled: updated.large_batch_mode_enabled,
        max_sap_rows_per_run: updated.max_sap_rows_per_run,
        // Phase 4
        approval_workflow_enabled: updated.approval_workflow_enabled,
        comment_threads_enabled: updated.comment_threads_enabled,
        reviewer_assignment_enabled: updated.reviewer_assignment_enabled,
        bulk_operations_enabled: updated.bulk_operations_enabled,
        run_archival_enabled: updated.run_archival_enabled,
        archival_retention_days: updated.archival_retention_days,
        compliance_report_enabled: updated.compliance_report_enabled,
        data_quality_precheck_enabled: updated.data_quality_precheck_enabled,
        custom_exception_rules_enabled: updated.custom_exception_rules_enabled,
        run_comparison_enabled: updated.run_comparison_enabled,
        enhanced_webhook_enabled: updated.enhanced_webhook_enabled,
        webhook_retry_count: updated.webhook_retry_count,
        webhook_secret: updated.webhook_secret,
        // Phase 5
        high_value_threshold: updated.high_value_threshold,
        auto_escalate_high_value: updated.auto_escalate_high_value,
        force_match_exception_severity: updated.force_match_exception_severity,
        score_weight_variance: updated.score_weight_variance,
        score_weight_date: updated.score_weight_date,
        score_weight_section: updated.score_weight_section,
        score_weight_clearing: updated.score_weight_clearing,
        score_weight_historical: updated.score_weight_historical,
        custom_scoring_enabled: updated.custom_scoring_enabled,
        variance_ceiling_single_pct: updated.variance_ceiling_single_pct,
        variance_ceiling_combo_pct: updated.variance_ceiling_combo_pct,
        variance_ceiling_force_single_pct: updated.variance_ceiling_force_single_pct,
        variance_ceiling_force_combo_pct: updated.variance_ceiling_force_combo_pct,
        custom_variance_ceilings_enabled: updated.custom_variance_ceilings_enabled,
        combo_iteration_budget: updated.combo_iteration_budget,
        combo_pool_cap: updated.combo_pool_cap,
        combo_date_window_days: updated.combo_date_window_days,
        date_proximity_profile: updated.date_proximity_profile,
        filing_lag_days_tolerance: updated.filing_lag_days_tolerance,
        clearing_doc_bonus_score: updated.clearing_doc_bonus_score,
        proxy_clearing_date_window_days: updated.proxy_clearing_date_window_days,
        rate_tolerance_pct: updated.rate_tolerance_pct,
        rate_mismatch_severity: updated.rate_mismatch_severity,
        parser_lenient_mode: updated.parser_lenient_mode,
        cleaner_duplicate_strategy: updated.cleaner_duplicate_strategy,
        export_show_score_breakdown: updated.export_show_score_breakdown,
        export_template_active: updated.export_template_active,
        dashboard_match_rate_target_pct: updated.dashboard_match_rate_target_pct,
        dashboard_variance_warning_pct: updated.dashboard_variance_warning_pct,
        dashboard_exclude_failed_from_trends: updated.dashboard_exclude_failed_from_trends,
        // Phase 6
        confidence_high_variance_threshold: updated.confidence_high_variance_threshold,
        confidence_medium_variance_threshold: updated.confidence_medium_variance_threshold,
        confidence_score_boost_threshold: updated.confidence_score_boost_threshold,
        exact_tolerance_rupees: updated.exact_tolerance_rupees,
        auto_approval_enabled: updated.auto_approval_enabled,
        auto_approval_min_match_rate: updated.auto_approval_min_match_rate,
        auto_approval_max_exceptions: updated.auto_approval_max_exceptions,
        high_confidence_sections: updated.high_confidence_sections,
        section_confidence_boost_pct: updated.section_confidence_boost_pct,
        unmatched_alerting_enabled: updated.unmatched_alerting_enabled,
        unmatched_critical_amount_threshold: updated.unmatched_critical_amount_threshold,
        unmatched_critical_count_threshold: updated.unmatched_critical_count_threshold,
        force_match_alert_enabled: updated.force_match_alert_enabled,
        force_match_alert_pct_threshold: updated.force_match_alert_pct_threshold,
        audit_log_retention_enabled: updated.audit_log_retention_enabled,
        audit_log_retention_days: updated.audit_log_retention_days,
        audit_log_redact_amounts: updated.audit_log_redact_amounts,
        excel_include_match_distribution: updated.excel_include_match_distribution,
        excel_include_control_totals: updated.excel_include_control_totals,
        excel_include_variance_analysis: updated.excel_include_variance_analysis,
        run_detail_default_sort: updated.run_detail_default_sort,
        run_detail_items_per_page: updated.run_detail_items_per_page,
        run_detail_show_score_columns: updated.run_detail_show_score_columns,
        batch_hide_zero_match_parties: updated.batch_hide_zero_match_parties,
        batch_summary_sort_by: updated.batch_summary_sort_by,
        batch_trend_window_days: updated.batch_trend_window_days,
        // Phase 7
        session_inactivity_timeout_min: updated.session_inactivity_timeout_min,
        max_concurrent_sessions: updated.max_concurrent_sessions,
        force_reauth_on_approve: updated.force_reauth_on_approve,
        password_min_length: updated.password_min_length,
        password_require_mixed_case: updated.password_require_mixed_case,
        password_require_number: updated.password_require_number,
        password_expiry_days: updated.password_expiry_days,
        max_failed_login_attempts: updated.max_failed_login_attempts,
        login_lockout_duration_min: updated.login_lockout_duration_min,
        notify_admin_on_lockout: updated.notify_admin_on_lockout,
        run_retention_days: updated.run_retention_days,
        auto_archive_after_days: updated.auto_archive_after_days,
        purge_exports_after_days: updated.purge_exports_after_days,
        export_watermark_enabled: updated.export_watermark_enabled,
        export_watermark_text: updated.export_watermark_text,
        export_require_approval: updated.export_require_approval,
        redact_tan_in_logs: updated.redact_tan_in_logs,
        redact_pan_in_exports: updated.redact_pan_in_exports,
        mask_amounts_in_preview: updated.mask_amounts_in_preview,
        max_upload_size_mb: updated.max_upload_size_mb,
        max_rows_per_file: updated.max_rows_per_file,
        reject_empty_columns: updated.reject_empty_columns,
        anomaly_detection_enabled: updated.anomaly_detection_enabled,
        amount_outlier_stddev: updated.amount_outlier_stddev,
        match_rate_drop_alert_pct: updated.match_rate_drop_alert_pct,
        batch_retry_backoff_seconds: updated.batch_retry_backoff_seconds,
        batch_stop_on_failure_count: updated.batch_stop_on_failure_count,
        batch_partial_resume_enabled: updated.batch_partial_resume_enabled,
        system_alerts_enabled: updated.system_alerts_enabled,
        slow_run_threshold_seconds: updated.slow_run_threshold_seconds,
        high_exception_rate_pct: updated.high_exception_rate_pct,
      });
    },
    onError: (err) => {
      toast('Save failed', getErrorMessage(err), 'error');
    },
  });

  const update = useCallback(
    <K extends keyof AdminSettingsUpdate>(key: K, value: AdminSettingsUpdate[K]) => {
      setDraft((prev) => (prev ? { ...prev, [key]: value } : { [key]: value }));
    },
    [],
  );

  const handleSave = () => {
    if (!draft) return;
    // Client-side validation guard
    const numericChecks: Array<[string, number | null | undefined]> = [
      ['Hard cutoff days', draft.date_hard_cutoff_days],
      ['Soft preference days', draft.date_soft_preference_days],
      ['Normal ceiling %', draft.variance_normal_ceiling_pct],
      ['Suggested ceiling %', draft.variance_suggested_ceiling_pct],
      ['Noise threshold', draft.noise_threshold],
      ['Max combo size', draft.max_combo_size],
      ['Cross-FY lookback', draft.cross_fy_lookback_years],
      ['Clearing group variance %', draft.clearing_group_variance_pct],
      ['Batch concurrency limit', draft.batch_concurrency_limit],
      ['Batch auto-retry count', draft.batch_auto_retry_count],
      ['Max date gap days', draft.max_date_gap_days],
      ['Max SAP rows per run', draft.max_sap_rows_per_run],
      ['Archival retention days', draft.archival_retention_days],
      ['Webhook retry count', draft.webhook_retry_count],
      // Phase 5
      ['High value threshold', draft.high_value_threshold],
      ['Score weight: variance', draft.score_weight_variance],
      ['Score weight: date', draft.score_weight_date],
      ['Score weight: section', draft.score_weight_section],
      ['Score weight: clearing', draft.score_weight_clearing],
      ['Score weight: historical', draft.score_weight_historical],
      ['Variance ceiling: single %', draft.variance_ceiling_single_pct],
      ['Variance ceiling: combo %', draft.variance_ceiling_combo_pct],
      ['Variance ceiling: force single %', draft.variance_ceiling_force_single_pct],
      ['Variance ceiling: force combo %', draft.variance_ceiling_force_combo_pct],
      ['Combo iteration budget', draft.combo_iteration_budget],
      ['Combo pool cap', draft.combo_pool_cap],
      ['Combo date window days', draft.combo_date_window_days],
      ['Filing lag days tolerance', draft.filing_lag_days_tolerance],
      ['Clearing doc bonus score', draft.clearing_doc_bonus_score],
      ['Proxy clearing date window', draft.proxy_clearing_date_window_days],
      ['Rate tolerance %', draft.rate_tolerance_pct],
      ['Dashboard match rate target %', draft.dashboard_match_rate_target_pct],
      ['Dashboard variance warning %', draft.dashboard_variance_warning_pct],
      // Phase 6
      ['Confidence HIGH threshold', draft.confidence_high_variance_threshold],
      ['Confidence MEDIUM threshold', draft.confidence_medium_variance_threshold],
      ['Confidence score boost', draft.confidence_score_boost_threshold],
      ['Exact tolerance (Rs.)', draft.exact_tolerance_rupees],
      ['Auto-approval min match rate', draft.auto_approval_min_match_rate],
      ['Auto-approval max exceptions', draft.auto_approval_max_exceptions],
      ['Section confidence boost %', draft.section_confidence_boost_pct],
      ['Unmatched critical amount', draft.unmatched_critical_amount_threshold],
      ['Unmatched critical count', draft.unmatched_critical_count_threshold],
      ['Force match alert %', draft.force_match_alert_pct_threshold],
      ['Audit log retention days', draft.audit_log_retention_days],
      ['Items per page', draft.run_detail_items_per_page],
      ['Batch trend window days', draft.batch_trend_window_days],
      // Phase 7
      ['Session inactivity timeout', draft.session_inactivity_timeout_min],
      ['Max concurrent sessions', draft.max_concurrent_sessions],
      ['Password min length', draft.password_min_length],
      ['Password expiry days', draft.password_expiry_days],
      ['Max failed login attempts', draft.max_failed_login_attempts],
      ['Login lockout duration', draft.login_lockout_duration_min],
      ['Run retention days', draft.run_retention_days],
      ['Auto-archive after days', draft.auto_archive_after_days],
      ['Purge exports after days', draft.purge_exports_after_days],
      ['Max upload size MB', draft.max_upload_size_mb],
      ['Max rows per file', draft.max_rows_per_file],
      ['Amount outlier stddev', draft.amount_outlier_stddev],
      ['Match rate drop alert %', draft.match_rate_drop_alert_pct],
      ['Batch retry backoff seconds', draft.batch_retry_backoff_seconds],
      ['Batch stop on failure count', draft.batch_stop_on_failure_count],
      ['Slow run threshold seconds', draft.slow_run_threshold_seconds],
      ['High exception rate %', draft.high_exception_rate_pct],
    ];
    for (const [label, val] of numericChecks) {
      if (val != null && val < 0) {
        toast('Validation error', `${label} cannot be negative`, 'error');
        return;
      }
    }
    saveMut.mutate(draft);
  };

  const paramCount = 143;

  return (
    <Card>
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between -m-6 p-6"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[#1B3A5C]/10">
            <SlidersHorizontal className="h-4 w-4 text-[#1B3A5C]" />
          </div>
          <div className="text-left">
            <h3 className="text-sm font-semibold text-gray-900">
              Algorithm Settings
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Configure reconciliation engine parameters
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="navy" size="sm">
            {paramCount} parameters
          </Badge>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-8 pt-6 border-t border-gray-100">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#1B3A5C] border-t-transparent" />
              <span className="ml-3 text-sm text-gray-500">Loading settings...</span>
            </div>
          )}

          {isError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Failed to load settings: {getErrorMessage(error)}
            </div>
          )}

          {draft && !isLoading && (
            <div className="space-y-8">
              {/* Section 1: Document Filters */}
              <SettingsSection title="Document Filters">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Doc types to include
                  </label>
                  <TagInput
                    tags={draft.doc_types_include ?? []}
                    onChange={(v) => update('doc_types_include', v)}
                    placeholder="Type and press Enter (e.g. RV, DR)"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    SAP document types to include in matching (e.g. RV, DR, DC)
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Doc types to exclude
                  </label>
                  <TagInput
                    tags={draft.doc_types_exclude ?? []}
                    onChange={(v) => update('doc_types_exclude', v)}
                    placeholder="Type and press Enter (e.g. CC, BR)"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    SAP document types to always exclude
                  </p>
                </div>
              </SettingsSection>

              {/* Section 2: Date Rules */}
              <SettingsSection title="Date Rules">
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    label="Hard cutoff days"
                    value={draft.date_hard_cutoff_days ?? 90}
                    onChange={(v) => update('date_hard_cutoff_days', v)}
                    min={0}
                    suffix="days"
                    helpText="Max days between book date and 26AS date"
                  />
                  <NumberField
                    label="Soft preference days"
                    value={draft.date_soft_preference_days ?? 180}
                    onChange={(v) => update('date_soft_preference_days', v)}
                    min={0}
                    suffix="days"
                    helpText="Preferred date window (scoring bonus)"
                  />
                </div>
                <Toggle
                  checked={draft.enforce_books_before_26as ?? false}
                  onChange={(v) => update('enforce_books_before_26as', v)}
                  label="Enforce books before 26AS date"
                />
              </SettingsSection>

              {/* Section 3: Variance Thresholds */}
              <SettingsSection title="Variance Thresholds">
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    label="Normal ceiling %"
                    value={draft.variance_normal_ceiling_pct ?? 3.0}
                    onChange={(v) => update('variance_normal_ceiling_pct', v)}
                    min={0}
                    max={100}
                    step={0.1}
                    suffix="%"
                    helpText="Max variance for normal matches"
                  />
                  <NumberField
                    label="Suggested ceiling %"
                    value={draft.variance_suggested_ceiling_pct ?? 20.0}
                    onChange={(v) => update('variance_suggested_ceiling_pct', v)}
                    min={0}
                    max={100}
                    step={0.5}
                    suffix="%"
                    helpText="Max variance for suggested matches"
                  />
                </div>
              </SettingsSection>

              {/* Section 4: Matching Behavior */}
              <SettingsSection title="Matching Behavior">
                <NumberField
                  label="Max combo size"
                  value={draft.max_combo_size ?? 5}
                  onChange={(v) => update('max_combo_size', v)}
                  min={0}
                  helpText="Max invoices per combo match (0 = use default 5)"
                />
                <NumberField
                  label="Noise threshold (Rs.)"
                  value={draft.noise_threshold ?? 1.0}
                  onChange={(v) => update('noise_threshold', v)}
                  min={0}
                  step={0.5}
                  suffix="Rs."
                  helpText="Amounts below this are excluded as noise"
                />
                <Toggle
                  checked={draft.date_clustering_preference ?? false}
                  onChange={(v) => update('date_clustering_preference', v)}
                  label="Date clustering preference"
                />
                <Toggle
                  checked={draft.force_match_enabled ?? true}
                  onChange={(v) => update('force_match_enabled', v)}
                  label="Force match enabled"
                />
              </SettingsSection>

              {/* Section 5: Clearing Group Matching */}
              <SettingsSection title="Clearing Group Matching">
                <Toggle
                  checked={draft.clearing_group_enabled ?? true}
                  onChange={(v) => update('clearing_group_enabled', v)}
                  label="Enable clearing group matching (Phase A)"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  When disabled, all entries skip directly to individual matching. Useful when SAP clearing doc values are unreliable.
                </p>
                {(draft.clearing_group_enabled ?? true) && (
                  <>
                    <NumberField
                      label="Clearing group variance ceiling %"
                      value={draft.clearing_group_variance_pct ?? draft.variance_normal_ceiling_pct ?? 3.0}
                      onChange={(v) => update('clearing_group_variance_pct', v)}
                      min={0}
                      max={100}
                      step={0.1}
                      suffix="%"
                      helpText="Dedicated variance cap for clearing group matches (separate from individual matching)"
                    />
                    <Toggle
                      checked={draft.proxy_clearing_enabled ?? true}
                      onChange={(v) => update('proxy_clearing_enabled', v)}
                      label="Enable proxy clearing fallback"
                    />
                    <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                      When clearing doc coverage is low (&lt;10%), cluster books by date as proxy groups.
                    </p>
                  </>
                )}
              </SettingsSection>

              {/* Section 6: Batch Processing */}
              <SettingsSection title="Batch Processing">
                <NumberField
                  label="Concurrency limit"
                  value={draft.batch_concurrency_limit ?? 10}
                  onChange={(v) => update('batch_concurrency_limit', v)}
                  min={1}
                  max={50}
                  helpText="Max simultaneous party reconciliations in a batch (1–50)"
                />
                <Toggle
                  checked={draft.batch_parse_cache_enabled ?? true}
                  onChange={(v) => update('batch_parse_cache_enabled', v)}
                  label="26AS parse-once cache"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Parse 26AS once and reuse per-party slices. Speeds up large batches.
                </p>
                <Toggle
                  checked={draft.batch_invoice_dedup_enabled ?? false}
                  onChange={(v) => update('batch_invoice_dedup_enabled', v)}
                  label="Cross-run invoice uniqueness"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Prevent the same invoice from being matched across different parties in a batch. Disabled by default.
                </p>
                <Toggle
                  checked={draft.batch_control_total_enabled ?? false}
                  onChange={(v) => update('batch_control_total_enabled', v)}
                  label="Control total assertion"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Assert that per-party 26AS sums equal the original file total. Disabled by default.
                </p>
              </SettingsSection>

              {/* Section 7: Batch Processing (Phase 2) */}
              <SettingsSection title="Batch Processing — Advanced">
                <NumberField
                  label="Auto-retry failed runs"
                  value={draft.batch_auto_retry_count ?? 0}
                  onChange={(v) => update('batch_auto_retry_count', v)}
                  min={0}
                  max={5}
                  helpText="How many times to auto-retry a failed party in a batch (0 = disabled)"
                />
                <Toggle
                  checked={draft.batch_duplicate_detection_enabled ?? false}
                  onChange={(v) => update('batch_duplicate_detection_enabled', v)}
                  label="Smart duplicate detection"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Detect and warn when the same SAP file has been processed in a prior batch (by file hash).
                </p>
                <Toggle
                  checked={draft.batch_progress_dashboard_enabled ?? true}
                  onChange={(v) => update('batch_progress_dashboard_enabled', v)}
                  label="Batch progress dashboard"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Show aggregate real-time progress view for running batches.
                </p>
                <Toggle
                  checked={draft.batch_comparison_enabled ?? true}
                  onChange={(v) => update('batch_comparison_enabled', v)}
                  label="Batch comparison (rerun delta)"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Enable side-by-side comparison of original vs rerun results.
                </p>
                <Toggle
                  checked={draft.batch_variance_trend_enabled ?? true}
                  onChange={(v) => update('batch_variance_trend_enabled', v)}
                  label="Variance trend analysis"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Track historical match rate trends across batch runs.
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Export template
                  </label>
                  <select
                    value={draft.batch_export_template ?? 'standard'}
                    onChange={(e) => update('batch_export_template', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                  >
                    <option value="standard">Standard</option>
                    <option value="detailed">Detailed</option>
                    <option value="summary">Summary</option>
                    <option value="custom">Custom</option>
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    Excel output template for batch downloads
                  </p>
                </div>
                <Toggle
                  checked={draft.batch_notification_enabled ?? false}
                  onChange={(v) => update('batch_notification_enabled', v)}
                  label="Batch notifications"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Send webhook notifications when a batch completes or fails.
                </p>
                {(draft.batch_notification_enabled ?? false) && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Webhook URL
                    </label>
                    <input
                      type="url"
                      value={draft.batch_notification_webhook_url ?? ''}
                      onChange={(e) => update('batch_notification_webhook_url', e.target.value || null)}
                      placeholder="https://hooks.slack.com/services/..."
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      POST endpoint to receive batch status notifications
                    </p>
                  </div>
                )}
                <Toggle
                  checked={draft.batch_scheduling_enabled ?? false}
                  onChange={(v) => update('batch_scheduling_enabled', v)}
                  label="Batch scheduling"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Allow scheduling batch reruns at configured times.
                </p>
              </SettingsSection>

              {/* Section 8: Reconciliation Intelligence (Phase 3) */}
              <SettingsSection title="Reconciliation Intelligence">
                <Toggle
                  checked={draft.section_filter_enabled ?? false}
                  onChange={(v) => update('section_filter_enabled', v)}
                  label="Tax section filter"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Only match entries within the same tax section (e.g. 194C with 194C). Reduces false positives for multi-section deductors.
                </p>
                <Toggle
                  checked={draft.invoice_date_proximity_enabled ?? false}
                  onChange={(v) => update('invoice_date_proximity_enabled', v)}
                  label="Invoice date proximity scoring"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Penalize matches where invoice date is far from the 26AS transaction date.
                </p>
                {(draft.invoice_date_proximity_enabled ?? false) && (
                  <NumberField
                    label="Max date gap (days)"
                    value={draft.max_date_gap_days ?? 90}
                    onChange={(v) => update('max_date_gap_days', v)}
                    min={1}
                    max={365}
                    suffix="days"
                    helpText="Maximum allowed gap between invoice and 26AS dates"
                  />
                )}
                <Toggle
                  checked={draft.as26_duplicate_check_enabled ?? false}
                  onChange={(v) => update('as26_duplicate_check_enabled', v)}
                  label="26AS duplicate/revision detection"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Flag duplicate Status=F entries in Form 26AS that may represent revisions or data errors.
                </p>
                <Toggle
                  checked={draft.credit_note_handling_enabled ?? false}
                  onChange={(v) => update('credit_note_handling_enabled', v)}
                  label="Credit note handling"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Parse negative SAP amounts as credit note adjustments and net them against invoices.
                </p>
                <Toggle
                  checked={draft.bipartite_matching_enabled ?? false}
                  onChange={(v) => update('bipartite_matching_enabled', v)}
                  label="Bipartite global optimization"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Use graph-based global optimization to find the optimal overall assignment (may increase processing time).
                </p>
                <Toggle
                  checked={draft.enumerate_alternatives_enabled ?? false}
                  onChange={(v) => update('enumerate_alternatives_enabled', v)}
                  label="Alternative match enumeration"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Show top 3 alternative matches for each suggested match to help CAs evaluate options.
                </p>
                <Toggle
                  checked={draft.amount_control_totals_enabled ?? true}
                  onChange={(v) => update('amount_control_totals_enabled', v)}
                  label="Amount-level control totals"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Include control total verification rows in Excel output to confirm balancing.
                </p>
                <Toggle
                  checked={draft.match_type_distribution_enabled ?? true}
                  onChange={(v) => update('match_type_distribution_enabled', v)}
                  label="Match type distribution"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Track and display EXACT/SINGLE/COMBO/FORCE breakdown in results and Excel.
                </p>
                <Toggle
                  checked={draft.pan_detection_enabled ?? false}
                  onChange={(v) => update('pan_detection_enabled', v)}
                  label="PAN & 206AA risk detection"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Analyze TDS rates to detect potential PAN non-furnishing (Section 206AA) issues.
                </p>
                <Toggle
                  checked={draft.large_batch_mode_enabled ?? false}
                  onChange={(v) => update('large_batch_mode_enabled', v)}
                  label="Large batch performance mode"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Enable memory limits and performance tuning for batches with many parties or large files.
                </p>
                {(draft.large_batch_mode_enabled ?? false) && (
                  <NumberField
                    label="Max SAP rows per run"
                    value={draft.max_sap_rows_per_run ?? 100000}
                    onChange={(v) => update('max_sap_rows_per_run', v)}
                    min={1000}
                    max={500000}
                    helpText="Cap per-run SAP row count to prevent memory issues"
                  />
                )}
              </SettingsSection>

              {/* Section 9: Workflow & Compliance (Phase 4) */}
              <SettingsSection title="Workflow & Compliance">
                <Toggle
                  checked={draft.approval_workflow_enabled ?? true}
                  onChange={(v) => update('approval_workflow_enabled', v)}
                  label="Run approval workflow"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Enable approve/reject workflow on completed runs for reviewer sign-off.
                </p>
                <Toggle
                  checked={draft.comment_threads_enabled ?? true}
                  onChange={(v) => update('comment_threads_enabled', v)}
                  label="Comment threads"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Allow threaded comments on runs for reviewer-preparer communication.
                </p>
                <Toggle
                  checked={draft.reviewer_assignment_enabled ?? false}
                  onChange={(v) => update('reviewer_assignment_enabled', v)}
                  label="Reviewer assignment"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Assign specific reviewers to runs. Only assigned reviewer can approve/reject.
                </p>
                <Toggle
                  checked={draft.bulk_operations_enabled ?? true}
                  onChange={(v) => update('bulk_operations_enabled', v)}
                  label="Bulk operations"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Enable bulk approve/reject/export actions across multiple runs at once.
                </p>
                <Toggle
                  checked={draft.run_archival_enabled ?? false}
                  onChange={(v) => update('run_archival_enabled', v)}
                  label="Run archival & retention"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Automatically archive old runs after the retention period expires.
                </p>
                {(draft.run_archival_enabled ?? false) && (
                  <NumberField
                    label="Retention period"
                    value={draft.archival_retention_days ?? 365}
                    onChange={(v) => update('archival_retention_days', v)}
                    min={30}
                    max={3650}
                    suffix="days"
                    helpText="Days to keep runs before archival (30–3650)"
                  />
                )}
                <Toggle
                  checked={draft.compliance_report_enabled ?? false}
                  onChange={(v) => update('compliance_report_enabled', v)}
                  label="Compliance report export"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Generate audit-ready compliance Excel reports with regulatory formatting.
                </p>
                <Toggle
                  checked={draft.data_quality_precheck_enabled ?? true}
                  onChange={(v) => update('data_quality_precheck_enabled', v)}
                  label="Data quality pre-check"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Profile uploaded files before matching to flag data quality issues early.
                </p>
                <Toggle
                  checked={draft.custom_exception_rules_enabled ?? false}
                  onChange={(v) => update('custom_exception_rules_enabled', v)}
                  label="Custom exception rules"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Define custom rules that auto-generate exception flags based on field conditions.
                </p>
                <Toggle
                  checked={draft.run_comparison_enabled ?? true}
                  onChange={(v) => update('run_comparison_enabled', v)}
                  label="Run comparison"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Compare two runs side-by-side to see how match results changed.
                </p>
                <Toggle
                  checked={draft.enhanced_webhook_enabled ?? false}
                  onChange={(v) => update('enhanced_webhook_enabled', v)}
                  label="Enhanced webhook delivery"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Retry logic, HMAC signatures, and configurable payloads for webhook notifications.
                </p>
                {(draft.enhanced_webhook_enabled ?? false) && (
                  <>
                    <NumberField
                      label="Webhook retry count"
                      value={draft.webhook_retry_count ?? 3}
                      onChange={(v) => update('webhook_retry_count', v)}
                      min={0}
                      max={10}
                      helpText="Number of retries on webhook delivery failure (0–10)"
                    />
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-600">Webhook HMAC secret</label>
                      <input
                        type="password"
                        value={draft.webhook_secret ?? ''}
                        onChange={(e) => update('webhook_secret', e.target.value || null)}
                        placeholder="Enter secret for HMAC-SHA256 signing"
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#1B3A5C]/20 focus:border-[#1B3A5C] outline-none"
                      />
                      <p className="text-xs text-gray-400">
                        If set, webhook payloads are signed with HMAC-SHA256 for verification.
                      </p>
                    </div>
                  </>
                )}
              </SettingsSection>

              {/* Section 10: Advanced Tuning & Profiles (Phase 5) */}
              <SettingsSection title="Advanced Tuning & Profiles">
                {/* 5A: Exception Severity Thresholds */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1">Exception Severity</h4>
                <NumberField
                  label="High value threshold (Rs.)"
                  value={draft.high_value_threshold ?? 1000000}
                  onChange={(v) => update('high_value_threshold', v)}
                  min={0}
                  step={100000}
                  suffix="Rs."
                  helpText="Amounts above this are flagged as high-value exceptions"
                />
                <Toggle
                  checked={draft.auto_escalate_high_value ?? true}
                  onChange={(v) => update('auto_escalate_high_value', v)}
                  label="Auto-escalate high-value exceptions"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Automatically raise severity for exceptions exceeding the threshold above.
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Force-match exception severity
                  </label>
                  <select
                    value={draft.force_match_exception_severity ?? 'HIGH'}
                    onChange={(e) => update('force_match_exception_severity', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                  >
                    <option value="CRITICAL">Critical</option>
                    <option value="HIGH">High</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="LOW">Low</option>
                    <option value="INFO">Info</option>
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    Default severity level for force-match exceptions
                  </p>
                </div>

                {/* 5B: Scoring Weight Configuration */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Scoring Weights</h4>
                <Toggle
                  checked={draft.custom_scoring_enabled ?? false}
                  onChange={(v) => update('custom_scoring_enabled', v)}
                  label="Enable custom scoring weights"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Override default 5-factor composite scoring weights. When disabled, defaults (30/20/20/20/10) are used.
                </p>
                {(draft.custom_scoring_enabled ?? false) && (
                  <div className="grid grid-cols-2 gap-4">
                    <NumberField
                      label="Variance weight"
                      value={draft.score_weight_variance ?? 30}
                      onChange={(v) => update('score_weight_variance', v)}
                      min={0} max={100} step={5}
                      helpText="Weight for amount variance factor"
                    />
                    <NumberField
                      label="Date weight"
                      value={draft.score_weight_date ?? 20}
                      onChange={(v) => update('score_weight_date', v)}
                      min={0} max={100} step={5}
                      helpText="Weight for date proximity factor"
                    />
                    <NumberField
                      label="Section weight"
                      value={draft.score_weight_section ?? 20}
                      onChange={(v) => update('score_weight_section', v)}
                      min={0} max={100} step={5}
                      helpText="Weight for section match factor"
                    />
                    <NumberField
                      label="Clearing weight"
                      value={draft.score_weight_clearing ?? 20}
                      onChange={(v) => update('score_weight_clearing', v)}
                      min={0} max={100} step={5}
                      helpText="Weight for clearing doc match factor"
                    />
                    <NumberField
                      label="Historical weight"
                      value={draft.score_weight_historical ?? 10}
                      onChange={(v) => update('score_weight_historical', v)}
                      min={0} max={100} step={5}
                      helpText="Weight for historical pattern factor"
                    />
                  </div>
                )}

                {/* 5C: Variance Tier Ceilings */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Variance Ceilings (Per Match Type)</h4>
                <Toggle
                  checked={draft.custom_variance_ceilings_enabled ?? false}
                  onChange={(v) => update('custom_variance_ceilings_enabled', v)}
                  label="Enable per-type variance ceilings"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Set different variance caps for each match type. When disabled, default caps (2%/3%/5%/2%) are used.
                </p>
                {(draft.custom_variance_ceilings_enabled ?? false) && (
                  <div className="grid grid-cols-2 gap-4">
                    <NumberField
                      label="Single match ceiling"
                      value={draft.variance_ceiling_single_pct ?? 2.0}
                      onChange={(v) => update('variance_ceiling_single_pct', v)}
                      min={0} max={100} step={0.5} suffix="%"
                      helpText="Max variance for SINGLE matches"
                    />
                    <NumberField
                      label="Combo match ceiling"
                      value={draft.variance_ceiling_combo_pct ?? 3.0}
                      onChange={(v) => update('variance_ceiling_combo_pct', v)}
                      min={0} max={100} step={0.5} suffix="%"
                      helpText="Max variance for COMBO matches"
                    />
                    <NumberField
                      label="Force-single ceiling"
                      value={draft.variance_ceiling_force_single_pct ?? 5.0}
                      onChange={(v) => update('variance_ceiling_force_single_pct', v)}
                      min={0} max={100} step={0.5} suffix="%"
                      helpText="Max variance for FORCE_SINGLE matches"
                    />
                    <NumberField
                      label="Force-combo ceiling"
                      value={draft.variance_ceiling_force_combo_pct ?? 2.0}
                      onChange={(v) => update('variance_ceiling_force_combo_pct', v)}
                      min={0} max={100} step={0.5} suffix="%"
                      helpText="Max variance for FORCE_COMBO matches"
                    />
                  </div>
                )}

                {/* 5D: Combo Matching Heuristics */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Combo Heuristics</h4>
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    label="Iteration budget"
                    value={draft.combo_iteration_budget ?? 50000}
                    onChange={(v) => update('combo_iteration_budget', v)}
                    min={1000} max={500000} step={5000}
                    helpText="Max iterations per combo search (prevents runaway)"
                  />
                  <NumberField
                    label="Pool cap"
                    value={draft.combo_pool_cap ?? 5000}
                    onChange={(v) => update('combo_pool_cap', v)}
                    min={100} max={50000} step={500}
                    helpText="Max candidate invoices in combo pool"
                  />
                  <NumberField
                    label="Date window"
                    value={draft.combo_date_window_days ?? 30}
                    onChange={(v) => update('combo_date_window_days', v)}
                    min={1} max={365} suffix="days"
                    helpText="Combo candidates must fall within this window"
                  />
                </div>

                {/* 5E: Date Proximity Profiles */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Date Proximity</h4>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Proximity profile
                  </label>
                  <select
                    value={draft.date_proximity_profile ?? 'STANDARD'}
                    onChange={(e) => update('date_proximity_profile', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                  >
                    <option value="STRICT">Strict (15-day window)</option>
                    <option value="STANDARD">Standard (45-day window)</option>
                    <option value="LENIENT">Lenient (90-day window)</option>
                    <option value="CUSTOM">Custom</option>
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    How strictly to penalize date gaps between invoice and 26AS entry
                  </p>
                </div>
                <NumberField
                  label="Filing lag tolerance"
                  value={draft.filing_lag_days_tolerance ?? 45}
                  onChange={(v) => update('filing_lag_days_tolerance', v)}
                  min={0} max={180} suffix="days"
                  helpText="Allowed lag between invoice date and 26AS filing date"
                />

                {/* 5F: Clearing Document Rules */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Clearing Document</h4>
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    label="Clearing doc bonus"
                    value={draft.clearing_doc_bonus_score ?? 20}
                    onChange={(v) => update('clearing_doc_bonus_score', v)}
                    min={0} max={100} step={5}
                    helpText="Score bonus when clearing doc matches"
                  />
                  <NumberField
                    label="Proxy clearing window"
                    value={draft.proxy_clearing_date_window_days ?? 30}
                    onChange={(v) => update('proxy_clearing_date_window_days', v)}
                    min={1} max={180} suffix="days"
                    helpText="Date window for proxy clearing fallback grouping"
                  />
                </div>

                {/* 5G: Rate & Section Validation */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Rate & Section Validation</h4>
                <NumberField
                  label="Rate tolerance"
                  value={draft.rate_tolerance_pct ?? 2.0}
                  onChange={(v) => update('rate_tolerance_pct', v)}
                  min={0} max={100} step={0.5} suffix="%"
                  helpText="Allowed TDS rate deviation before flagging"
                />
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Rate mismatch severity
                  </label>
                  <select
                    value={draft.rate_mismatch_severity ?? 'MEDIUM'}
                    onChange={(e) => update('rate_mismatch_severity', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                  >
                    <option value="CRITICAL">Critical</option>
                    <option value="HIGH">High</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="LOW">Low</option>
                    <option value="INFO">Info</option>
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    Severity for exceptions triggered by TDS rate mismatches
                  </p>
                </div>

                {/* 5H: Parser & Cleaner Profiles */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Parser & Cleaner</h4>
                <Toggle
                  checked={draft.parser_lenient_mode ?? true}
                  onChange={(v) => update('parser_lenient_mode', v)}
                  label="Lenient parser mode"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Accept minor formatting issues in uploaded files (extra whitespace, date format variations).
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Duplicate strategy
                  </label>
                  <select
                    value={draft.cleaner_duplicate_strategy ?? 'FIRST_OCCURRENCE'}
                    onChange={(e) => update('cleaner_duplicate_strategy', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                  >
                    <option value="FIRST_OCCURRENCE">First occurrence (keep earliest)</option>
                    <option value="LAST_OCCURRENCE">Last occurrence (keep latest)</option>
                    <option value="SUM_AMOUNTS">Sum amounts (consolidate)</option>
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    How to handle duplicate invoice entries in SAP data
                  </p>
                </div>

                {/* 5I: Excel Export */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Excel Export</h4>
                <Toggle
                  checked={draft.export_show_score_breakdown ?? true}
                  onChange={(v) => update('export_show_score_breakdown', v)}
                  label="Show score breakdown in export"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Include per-factor score columns in the matched pairs Excel sheet.
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Export template
                  </label>
                  <select
                    value={draft.export_template_active ?? 'standard'}
                    onChange={(e) => update('export_template_active', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                  >
                    <option value="standard">Standard</option>
                    <option value="ca_review">CA Review</option>
                    <option value="itr_filing">ITR Filing</option>
                    <option value="management">Management Summary</option>
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    Excel template preset for single-run downloads
                  </p>
                </div>

                {/* 5J: Dashboard Metrics */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Dashboard Metrics</h4>
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    label="Match rate target"
                    value={draft.dashboard_match_rate_target_pct ?? 75}
                    onChange={(v) => update('dashboard_match_rate_target_pct', v)}
                    min={0} max={100} step={5} suffix="%"
                    helpText="Target match rate shown as dashboard KPI"
                  />
                  <NumberField
                    label="Variance warning"
                    value={draft.dashboard_variance_warning_pct ?? 5}
                    onChange={(v) => update('dashboard_variance_warning_pct', v)}
                    min={0} max={100} step={1} suffix="%"
                    helpText="Threshold for variance warning indicators"
                  />
                </div>
                <Toggle
                  checked={draft.dashboard_exclude_failed_from_trends ?? true}
                  onChange={(v) => update('dashboard_exclude_failed_from_trends', v)}
                  label="Exclude failed runs from trends"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Skip FAILED runs when calculating match rate trend charts.
                </p>
              </SettingsSection>

              {/* Section 11: Reporting, Intelligence & Safety (Phase 6) */}
              <SettingsSection title="Reporting, Intelligence & Safety">
                {/* 6A: Confidence Tier Thresholds */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1">Confidence Tiers</h4>
                <div className="grid grid-cols-3 gap-4">
                  <NumberField
                    label="HIGH threshold"
                    value={draft.confidence_high_variance_threshold ?? 1.0}
                    onChange={(v) => update('confidence_high_variance_threshold', v)}
                    min={0} max={100} step={0.5} suffix="%"
                    helpText="Variance % below this = HIGH confidence"
                  />
                  <NumberField
                    label="MEDIUM threshold"
                    value={draft.confidence_medium_variance_threshold ?? 5.0}
                    onChange={(v) => update('confidence_medium_variance_threshold', v)}
                    min={0} max={100} step={0.5} suffix="%"
                    helpText="Variance % below this = MEDIUM confidence"
                  />
                  <NumberField
                    label="Score boost cutoff"
                    value={draft.confidence_score_boost_threshold ?? 70}
                    onChange={(v) => update('confidence_score_boost_threshold', v)}
                    min={0} max={100} step={5}
                    helpText="Composite score to boost 1-2% variance to HIGH"
                  />
                </div>

                {/* 6B: Exact Match Tolerance */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Exact Match Tolerance</h4>
                <NumberField
                  label="Tolerance (Rs.)"
                  value={draft.exact_tolerance_rupees ?? 0.01}
                  onChange={(v) => update('exact_tolerance_rupees', v)}
                  min={0} max={10} step={0.01} suffix="Rs."
                  helpText="Amounts within this range are treated as exact match (default: 1 paisa)"
                />

                {/* 6C: Auto-Approval Rules */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Auto-Approval</h4>
                <Toggle
                  checked={draft.auto_approval_enabled ?? false}
                  onChange={(v) => update('auto_approval_enabled', v)}
                  label="Enable auto-approval for high-quality runs"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Automatically approve runs that meet match rate and exception count thresholds.
                </p>
                {(draft.auto_approval_enabled ?? false) && (
                  <div className="grid grid-cols-2 gap-4">
                    <NumberField
                      label="Min match rate"
                      value={draft.auto_approval_min_match_rate ?? 75}
                      onChange={(v) => update('auto_approval_min_match_rate', v)}
                      min={0} max={100} step={5} suffix="%"
                      helpText="Run must achieve this match rate"
                    />
                    <NumberField
                      label="Max exceptions"
                      value={draft.auto_approval_max_exceptions ?? 10}
                      onChange={(v) => update('auto_approval_max_exceptions', v)}
                      min={0} max={1000}
                      helpText="Run must have fewer exceptions than this"
                    />
                  </div>
                )}

                {/* 6D: Section Confidence Boost */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Section Confidence</h4>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    High-confidence sections
                  </label>
                  <input
                    type="text"
                    value={draft.high_confidence_sections ?? '194C,194J,194H,194I,194A'}
                    onChange={(e) => update('high_confidence_sections', e.target.value)}
                    placeholder="194C,194J,194H,194I,194A"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Comma-separated TDS sections that get a scoring confidence boost
                  </p>
                </div>
                <NumberField
                  label="Confidence boost"
                  value={draft.section_confidence_boost_pct ?? 60}
                  onChange={(v) => update('section_confidence_boost_pct', v)}
                  min={0} max={100} step={5}
                  helpText="Base confidence score for high-confidence sections (0-100)"
                />

                {/* 6E: Unmatched Amount Alerting */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Unmatched Alerting</h4>
                <Toggle
                  checked={draft.unmatched_alerting_enabled ?? true}
                  onChange={(v) => update('unmatched_alerting_enabled', v)}
                  label="Enable unmatched amount alerts"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Generate alerts when unmatched amounts exceed thresholds.
                </p>
                {(draft.unmatched_alerting_enabled ?? true) && (
                  <div className="grid grid-cols-2 gap-4">
                    <NumberField
                      label="Critical amount (Rs.)"
                      value={draft.unmatched_critical_amount_threshold ?? 500000}
                      onChange={(v) => update('unmatched_critical_amount_threshold', v)}
                      min={0} step={50000} suffix="Rs."
                      helpText="Alert if any single unmatched entry exceeds this"
                    />
                    <NumberField
                      label="Critical count"
                      value={draft.unmatched_critical_count_threshold ?? 50}
                      onChange={(v) => update('unmatched_critical_count_threshold', v)}
                      min={0}
                      helpText="Alert if total unmatched entries exceed this"
                    />
                  </div>
                )}

                {/* 6F: Force Match Distribution Alert */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Force Match Alerts</h4>
                <Toggle
                  checked={draft.force_match_alert_enabled ?? true}
                  onChange={(v) => update('force_match_alert_enabled', v)}
                  label="Alert on high force-match percentage"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Flag runs where force matches exceed a threshold — may indicate data quality issues.
                </p>
                {(draft.force_match_alert_enabled ?? true) && (
                  <NumberField
                    label="Force match alert threshold"
                    value={draft.force_match_alert_pct_threshold ?? 10}
                    onChange={(v) => update('force_match_alert_pct_threshold', v)}
                    min={0} max={100} step={5} suffix="%"
                    helpText="Warn if force matches exceed this % of total matches"
                  />
                )}

                {/* 6G: Audit Log Retention */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Audit Log Retention</h4>
                <Toggle
                  checked={draft.audit_log_retention_enabled ?? false}
                  onChange={(v) => update('audit_log_retention_enabled', v)}
                  label="Enable audit log retention policy"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Automatically purge audit logs older than the retention period.
                </p>
                {(draft.audit_log_retention_enabled ?? false) && (
                  <>
                    <NumberField
                      label="Retention period"
                      value={draft.audit_log_retention_days ?? 1095}
                      onChange={(v) => update('audit_log_retention_days', v)}
                      min={90} max={3650} suffix="days"
                      helpText="Days to retain audit logs (90 to 3650)"
                    />
                    <Toggle
                      checked={draft.audit_log_redact_amounts ?? false}
                      onChange={(v) => update('audit_log_redact_amounts', v)}
                      label="Redact financial amounts in logs"
                    />
                    <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                      Replace exact amounts with ranges in audit logs for data privacy.
                    </p>
                  </>
                )}

                {/* 6H: Excel Sheet Selection */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Excel Sheets</h4>
                <Toggle
                  checked={draft.excel_include_match_distribution ?? true}
                  onChange={(v) => update('excel_include_match_distribution', v)}
                  label="Include Match Distribution sheet"
                />
                <Toggle
                  checked={draft.excel_include_control_totals ?? true}
                  onChange={(v) => update('excel_include_control_totals', v)}
                  label="Include Control Totals sheet"
                />
                <Toggle
                  checked={draft.excel_include_variance_analysis ?? true}
                  onChange={(v) => update('excel_include_variance_analysis', v)}
                  label="Include Variance Analysis sheet"
                />

                {/* 6I: Run Display Preferences */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Run Detail Display</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Default sort
                    </label>
                    <select
                      value={draft.run_detail_default_sort ?? 'variance'}
                      onChange={(e) => update('run_detail_default_sort', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                    >
                      <option value="variance">Variance %</option>
                      <option value="amount">Amount</option>
                      <option value="date">Date</option>
                      <option value="score">Composite Score</option>
                      <option value="match_type">Match Type</option>
                    </select>
                    <p className="text-xs text-gray-400 mt-1">
                      Default sort order for matched pairs table
                    </p>
                  </div>
                  <NumberField
                    label="Items per page"
                    value={draft.run_detail_items_per_page ?? 50}
                    onChange={(v) => update('run_detail_items_per_page', v)}
                    min={10} max={500}
                    helpText="Rows per page in run detail tables"
                  />
                </div>
                <Toggle
                  checked={draft.run_detail_show_score_columns ?? true}
                  onChange={(v) => update('run_detail_show_score_columns', v)}
                  label="Show score breakdown columns"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Display per-factor score columns (variance, date, section, clearing, historical).
                </p>

                {/* 6J: Batch Display Preferences */}
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 pb-1 mt-4">Batch Display</h4>
                <Toggle
                  checked={draft.batch_hide_zero_match_parties ?? false}
                  onChange={(v) => update('batch_hide_zero_match_parties', v)}
                  label="Hide zero-match parties in batch summary"
                />
                <p className="text-xs text-gray-400 -mt-2 ml-[52px]">
                  Exclude parties with 0% match rate from batch summary view.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Batch sort by
                    </label>
                    <select
                      value={draft.batch_summary_sort_by ?? 'match_rate'}
                      onChange={(e) => update('batch_summary_sort_by', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
                    >
                      <option value="match_rate">Match Rate</option>
                      <option value="name">Deductor Name</option>
                      <option value="amount">26AS Amount</option>
                      <option value="status">Status</option>
                      <option value="run_number">Run Number</option>
                    </select>
                    <p className="text-xs text-gray-400 mt-1">
                      Default sort for batch summary parties
                    </p>
                  </div>
                  <NumberField
                    label="Trend window"
                    value={draft.batch_trend_window_days ?? 90}
                    onChange={(v) => update('batch_trend_window_days', v)}
                    min={7} max={365} suffix="days"
                    helpText="Days to show in match rate trend charts"
                  />
                </div>
              </SettingsSection>

              {/* Section 12: Security, Governance & Data Controls (Phase 7) */}
              <SettingsSection title="Security, Governance & Data Controls" defaultOpen={false}>
                {/* 7A: Session Policies */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-2 mb-3">7A: Session Policies</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <NumberField
                    label="Inactivity timeout"
                    value={draft.session_inactivity_timeout_min ?? 30}
                    onChange={(v) => update('session_inactivity_timeout_min', v)}
                    min={0} max={480} suffix="min"
                    helpText="Auto-logout after idle (0=disabled)"
                  />
                  <NumberField
                    label="Max concurrent sessions"
                    value={draft.max_concurrent_sessions ?? 3}
                    onChange={(v) => update('max_concurrent_sessions', v)}
                    min={0} max={10}
                    helpText="Per user (0=unlimited)"
                  />
                </div>
                <Toggle
                  checked={draft.force_reauth_on_approve ?? false}
                  onChange={(v) => update('force_reauth_on_approve', v)}
                  label="Require re-authentication for approve/reject"
                />

                {/* 7B: Password Rules */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-6 mb-3">7B: Password Rules</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <NumberField
                    label="Min password length"
                    value={draft.password_min_length ?? 8}
                    onChange={(v) => update('password_min_length', v)}
                    min={6} max={128}
                    helpText="Minimum characters required"
                  />
                  <NumberField
                    label="Password expiry"
                    value={draft.password_expiry_days ?? 0}
                    onChange={(v) => update('password_expiry_days', v)}
                    min={0} max={365} suffix="days"
                    helpText="Force change after N days (0=disabled)"
                  />
                </div>
                <Toggle
                  checked={draft.password_require_mixed_case ?? true}
                  onChange={(v) => update('password_require_mixed_case', v)}
                  label="Require upper + lowercase"
                />
                <Toggle
                  checked={draft.password_require_number ?? true}
                  onChange={(v) => update('password_require_number', v)}
                  label="Require at least one digit"
                />

                {/* 7C: Login Protection */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-6 mb-3">7C: Login Protection</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <NumberField
                    label="Max failed login attempts"
                    value={draft.max_failed_login_attempts ?? 5}
                    onChange={(v) => update('max_failed_login_attempts', v)}
                    min={1} max={20}
                    helpText="Lock account after N failures"
                  />
                  <NumberField
                    label="Lockout duration"
                    value={draft.login_lockout_duration_min ?? 15}
                    onChange={(v) => update('login_lockout_duration_min', v)}
                    min={1} max={1440} suffix="min"
                    helpText="Minutes before auto-unlock"
                  />
                </div>
                <Toggle
                  checked={draft.notify_admin_on_lockout ?? false}
                  onChange={(v) => update('notify_admin_on_lockout', v)}
                  label="Notify admin on account lockout"
                />

                {/* 7D: Data Retention */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-6 mb-3">7D: Data Retention Policies</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <NumberField
                    label="Run retention"
                    value={draft.run_retention_days ?? 365}
                    onChange={(v) => update('run_retention_days', v)}
                    min={0} max={3650} suffix="days"
                    helpText="Auto-purge old runs (0=disabled)"
                  />
                  <NumberField
                    label="Auto-archive after"
                    value={draft.auto_archive_after_days ?? 90}
                    onChange={(v) => update('auto_archive_after_days', v)}
                    min={0} max={3650} suffix="days"
                    helpText="Archive completed runs (0=disabled)"
                  />
                  <NumberField
                    label="Purge exports after"
                    value={draft.purge_exports_after_days ?? 30}
                    onChange={(v) => update('purge_exports_after_days', v)}
                    min={0} max={365} suffix="days"
                    helpText="Delete cached Excel files (0=disabled)"
                  />
                </div>

                {/* 7E: Export Security */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-6 mb-3">7E: Export Security</h4>
                <Toggle
                  checked={draft.export_watermark_enabled ?? false}
                  onChange={(v) => update('export_watermark_enabled', v)}
                  label="Add watermark to Excel exports"
                />
                {draft.export_watermark_enabled && (
                  <div className="mt-2 mb-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Watermark text</label>
                    <input
                      type="text"
                      value={draft.export_watermark_text ?? 'CONFIDENTIAL'}
                      onChange={(e) => update('export_watermark_text', e.target.value)}
                      maxLength={100}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#1B3A5C] focus:ring-1 focus:ring-[#1B3A5C] outline-none"
                    />
                  </div>
                )}
                <Toggle
                  checked={draft.export_require_approval ?? false}
                  onChange={(v) => update('export_require_approval', v)}
                  label="Require REVIEWER approval before PREPARER can download"
                />

                {/* 7F: PII Protection */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-6 mb-3">7F: PII Protection</h4>
                <Toggle
                  checked={draft.redact_tan_in_logs ?? false}
                  onChange={(v) => update('redact_tan_in_logs', v)}
                  label="Redact TAN numbers in audit logs"
                />
                <Toggle
                  checked={draft.redact_pan_in_exports ?? false}
                  onChange={(v) => update('redact_pan_in_exports', v)}
                  label="Redact PAN numbers in Excel exports"
                />
                <Toggle
                  checked={draft.mask_amounts_in_preview ?? false}
                  onChange={(v) => update('mask_amounts_in_preview', v)}
                  label="Mask amounts in UI for PREPARER role"
                />

                {/* 7G: Import Validation */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-6 mb-3">7G: Import Validation</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <NumberField
                    label="Max upload size"
                    value={draft.max_upload_size_mb ?? 50}
                    onChange={(v) => update('max_upload_size_mb', v)}
                    min={1} max={500} suffix="MB"
                    helpText="Reject files above this size"
                  />
                  <NumberField
                    label="Max rows per file"
                    value={draft.max_rows_per_file ?? 100000}
                    onChange={(v) => update('max_rows_per_file', v)}
                    min={1000} max={1000000}
                    helpText="Reject sheets with too many rows"
                  />
                </div>
                <Toggle
                  checked={draft.reject_empty_columns ?? false}
                  onChange={(v) => update('reject_empty_columns', v)}
                  label="Reject files with empty critical columns"
                />

                {/* 7H: Anomaly Detection */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-6 mb-3">7H: Anomaly Detection</h4>
                <Toggle
                  checked={draft.anomaly_detection_enabled ?? false}
                  onChange={(v) => update('anomaly_detection_enabled', v)}
                  label="Enable post-match anomaly flagging"
                />
                {draft.anomaly_detection_enabled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                    <NumberField
                      label="Amount outlier threshold"
                      value={draft.amount_outlier_stddev ?? 3.0}
                      onChange={(v) => update('amount_outlier_stddev', v)}
                      min={1} max={10} suffix="stddev"
                      helpText="Flag amounts beyond N standard deviations"
                    />
                    <NumberField
                      label="Match rate drop alert"
                      value={draft.match_rate_drop_alert_pct ?? 20.0}
                      onChange={(v) => update('match_rate_drop_alert_pct', v)}
                      min={1} max={100} suffix="%"
                      helpText="Alert if rate drops vs prior run for same party"
                    />
                  </div>
                )}

                {/* 7I: Batch Recovery */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-6 mb-3">7I: Batch Recovery</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <NumberField
                    label="Retry backoff base"
                    value={draft.batch_retry_backoff_seconds ?? 2}
                    onChange={(v) => update('batch_retry_backoff_seconds', v)}
                    min={1} max={60} suffix="sec"
                    helpText="Base backoff for failed run retry"
                  />
                  <NumberField
                    label="Stop batch on failure count"
                    value={draft.batch_stop_on_failure_count ?? 0}
                    onChange={(v) => update('batch_stop_on_failure_count', v)}
                    min={0} max={50}
                    helpText="Halt batch after N failures (0=disabled)"
                  />
                </div>
                <Toggle
                  checked={draft.batch_partial_resume_enabled ?? false}
                  onChange={(v) => update('batch_partial_resume_enabled', v)}
                  label="Allow resuming batch from failure point"
                />

                {/* 7J: System Health Alerts */}
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-6 mb-3">7J: System Health Alerts</h4>
                <Toggle
                  checked={draft.system_alerts_enabled ?? false}
                  onChange={(v) => update('system_alerts_enabled', v)}
                  label="Enable system health monitoring"
                />
                {draft.system_alerts_enabled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                    <NumberField
                      label="Slow run threshold"
                      value={draft.slow_run_threshold_seconds ?? 300}
                      onChange={(v) => update('slow_run_threshold_seconds', v)}
                      min={30} max={3600} suffix="sec"
                      helpText="Flag runs taking longer than this"
                    />
                    <NumberField
                      label="High exception rate"
                      value={draft.high_exception_rate_pct ?? 50.0}
                      onChange={(v) => update('high_exception_rate_pct', v)}
                      min={1} max={100} suffix="%"
                      helpText="Flag if exceptions exceed this % of entries"
                    />
                  </div>
                )}
              </SettingsSection>

              {/* Section 13: Cross-FY & Advances */}
              <SettingsSection title="Cross-FY & Advances">
                <Toggle
                  checked={draft.exclude_sgl_v ?? false}
                  onChange={(v) => update('exclude_sgl_v', v)}
                  label="Exclude SGL_V (advances)"
                />
                <Toggle
                  checked={draft.allow_cross_fy ?? false}
                  onChange={(v) => update('allow_cross_fy', v)}
                  label="Allow cross-FY matching"
                />
                <NumberField
                  label="Cross-FY lookback years"
                  value={draft.cross_fy_lookback_years ?? 1}
                  onChange={(v) => update('cross_fy_lookback_years', v)}
                  min={0}
                  max={5}
                  suffix="years"
                  helpText="Number of prior FYs to search"
                />
              </SettingsSection>

              {/* Footer with save button and timestamp */}
              <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                <div className="text-xs text-gray-400">
                  {settings?.updated_at ? (
                    <>Last updated: {formatDateTime(settings.updated_at)}</>
                  ) : (
                    'Default settings'
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saveMut.isPending}
                  className={cn(
                    'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold',
                    'bg-[#1B3A5C] text-white hover:bg-[#15304d] transition-colors',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                  )}
                >
                  {saveMut.isPending ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                      Saving...
                    </>
                  ) : saveMut.isSuccess ? (
                    <>
                      <Check className="h-4 w-4" />
                      Saved
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4" />
                      Save Settings
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Create User Form ──────────────────────────────────────────────────────────

const schema = z
  .object({
    full_name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Enter a valid email'),
    password: z.string().min(8, 'Minimum 8 characters'),
    confirm_password: z.string().min(1, 'Confirm password'),
    role: z.enum(['ADMIN', 'REVIEWER', 'PREPARER'] as const),
  })
  .refine((d) => d.password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

type FormData = z.infer<typeof schema>;

const ROLE_OPTIONS: Array<{ value: Role; label: string; desc: string }> = [
  {
    value: 'PREPARER',
    label: 'Preparer',
    desc: 'Can upload files and start reconciliation runs',
  },
  {
    value: 'REVIEWER',
    label: 'Reviewer',
    desc: 'Can approve or reject runs prepared by others',
  },
  {
    value: 'ADMIN',
    label: 'Admin',
    desc: 'Full access including user management',
  },
];

function CreateUserForm({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { role: 'PREPARER' },
  });

  const mut = useMutation({
    mutationFn: (data: FormData) =>
      authApi.createUser(data.email, data.password, data.full_name, data.role),
    onSuccess: (user) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast('User created', `${user.full_name} (${user.role})`, 'success');
      reset();
      onSuccess();
    },
    onError: (err) => {
      setError('root', { message: getErrorMessage(err) });
    },
  });

  const inputClass = (hasError: boolean) =>
    cn(
      'w-full pl-9 pr-4 py-2.5 text-sm border rounded-lg outline-none transition-colors',
      hasError
        ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100'
        : 'border-gray-300 focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10',
    );

  return (
    <form onSubmit={handleSubmit((d) => mut.mutate(d))} noValidate className="space-y-4">
      {errors.root && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {errors.root.message}
        </div>
      )}

      {/* Full name */}
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1.5">
          Full name
        </label>
        <div className="relative">
          <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Ravi Kumar"
            className={inputClass(!!errors.full_name)}
            {...register('full_name')}
          />
        </div>
        {errors.full_name && (
          <p className="text-xs text-red-600 mt-1">{errors.full_name.message}</p>
        )}
      </div>

      {/* Email */}
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1.5">
          Email address
        </label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="email"
            placeholder="user@firm.com"
            className={inputClass(!!errors.email)}
            {...register('email')}
          />
        </div>
        {errors.email && (
          <p className="text-xs text-red-600 mt-1">{errors.email.message}</p>
        )}
      </div>

      {/* Password */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1.5">
            Password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="password"
              placeholder="Min 8 chars"
              className={inputClass(!!errors.password)}
              {...register('password')}
            />
          </div>
          {errors.password && (
            <p className="text-xs text-red-600 mt-1">{errors.password.message}</p>
          )}
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1.5">
            Confirm password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="password"
              placeholder="Repeat"
              className={inputClass(!!errors.confirm_password)}
              {...register('confirm_password')}
            />
          </div>
          {errors.confirm_password && (
            <p className="text-xs text-red-600 mt-1">
              {errors.confirm_password.message}
            </p>
          )}
        </div>
      </div>

      {/* Role */}
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1.5">Role</label>
        <div className="space-y-2">
          {ROLE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
            >
              <input
                type="radio"
                value={opt.value}
                className="mt-0.5"
                {...register('role')}
              />
              <div>
                <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                <p className="text-xs text-gray-500">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
        {errors.role && (
          <p className="text-xs text-red-600 mt-1">{errors.role.message}</p>
        )}
      </div>

      <button
        type="submit"
        disabled={isSubmitting || mut.isPending}
        className={cn(
          'w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg',
          'bg-[#1B3A5C] text-white text-sm font-semibold',
          'hover:bg-[#15304d] transition-colors',
          'disabled:opacity-60 disabled:cursor-not-allowed',
        )}
      >
        <UserPlus className="h-4 w-4" />
        {mut.isPending ? 'Creating...' : 'Create user'}
      </button>
    </form>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user: me } = useAuth();
  const [showForm, setShowForm] = useState(false);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: authApi.users,
  });

  const cols: Column<UserType>[] = [
    {
      key: 'full_name',
      header: 'Name',
      sortable: true,
      render: (u) => (
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-[#1B3A5C]/10 flex items-center justify-center text-[#1B3A5C] text-xs font-semibold shrink-0">
            {u.full_name[0]?.toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">{u.full_name}</p>
            {u.id === me?.id && (
              <p className="text-xs text-gray-400">(you)</p>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      render: (u) => <span className="text-sm text-gray-600">{u.email}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      sortable: true,
      render: (u) => <Badge variant={roleVariant(u.role)}>{u.role}</Badge>,
    },
    {
      key: 'id',
      header: 'User ID',
      render: (u) => (
        <span className="font-mono text-xs text-gray-400">{u.id.slice(0, 8)}...</span>
      ),
    },
  ];

  if (isLoading) {
    return (
      <PageWrapper className="max-w-4xl">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="h-6 w-40 bg-gray-200/70 rounded-md animate-pulse" />
            <div className="h-4 w-56 bg-gray-200/70 rounded-md animate-pulse" />
          </div>
          <div className="h-10 w-28 bg-gray-200/70 rounded-lg animate-pulse" />
        </div>
        <Card padding={false}>
          <TableSkeleton columns={4} rows={4} />
        </Card>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper className="max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Administration</h1>
          <p className="text-sm text-gray-500 mt-0.5">User management and platform settings</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-[#1B3A5C] text-white text-sm font-semibold rounded-lg hover:bg-[#15304d] transition-colors"
        >
          <UserPlus className="h-4 w-4" />
          {showForm ? 'Cancel' : 'Add User'}
        </button>
      </div>

      {/* Algorithm Settings — ADMIN only, above user management */}
      {me?.role === 'ADMIN' && <AlgorithmSettingsCard />}

      {/* Maker-checker notice */}
      <Card className="bg-blue-50 border-blue-100 flex gap-3">
        <Shield className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-blue-800">Maker-Checker Policy</p>
          <p className="text-xs text-blue-600 mt-1">
            A PREPARER cannot approve or reject runs they submitted.
            REVIEWER/ADMIN with <code className="bg-blue-100 px-1 rounded">run.created_by !== user.id</code>{' '}
            can perform approval actions. This separation is enforced by the backend.
          </p>
        </div>
      </Card>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* User list */}
        <div className="lg:col-span-2">
          <Card padding={false}>
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
              <Users className="h-4 w-4 text-gray-400" />
              <p className="text-sm font-semibold text-gray-900">
                Users ({users.length})
              </p>
            </div>
            <Table
              columns={cols}
              data={users}
              keyExtractor={(u) => u.id}
              emptyMessage="No users found"
            />
          </Card>
        </div>

        {/* Create user form */}
        {showForm && (
          <div>
            <Card>
              <CardHeader title="Create New User" />
              <CreateUserForm onSuccess={() => setShowForm(false)} />
            </Card>
          </div>
        )}
      </div>
    </PageWrapper>
  );
}
