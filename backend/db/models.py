"""
Full normalized database schema — enterprise grade.
All tables include created_at, updated_at for audit trail.
"""
from __future__ import annotations

import uuid
from datetime import datetime, date, timezone
from typing import Optional, List

from sqlalchemy import (
    String, Float, Boolean, Integer, Text, Date, DateTime,
    ForeignKey, Enum, Index, UniqueConstraint, JSON, LargeBinary
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from db.base import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── Users & Auth ──────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(
        Enum("ADMIN", "PREPARER", "REVIEWER", name="user_role"),
        nullable=False, default="PREPARER"
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    api_keys: Mapped[List["ApiKey"]] = relationship("ApiKey", back_populates="user", cascade="all, delete-orphan")
    runs: Mapped[List["ReconciliationRun"]] = relationship("ReconciliationRun", foreign_keys="ReconciliationRun.created_by_id", back_populates="created_by_user")
    audit_logs: Mapped[List["AuditLog"]] = relationship("AuditLog", back_populates="user")


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)  # SHA-256 of key
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    last_used: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship("User", back_populates="api_keys")


# ── Reconciliation Runs ───────────────────────────────────────────────────────

class ReconciliationRun(Base):
    """
    Master record for every reconciliation run.
    Enables full replay, audit trail, and version tracking.
    """
    __tablename__ = "reconciliation_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_number: Mapped[int] = mapped_column(Integer, nullable=False)  # Human-readable sequence
    financial_year: Mapped[str] = mapped_column(String(20), nullable=False)
    deductor_name: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    tan: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)

    # File integrity
    sap_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    as26_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    sap_file_hash: Mapped[str] = mapped_column(String(64), nullable=False)   # SHA-256
    as26_file_hash: Mapped[str] = mapped_column(String(64), nullable=False)  # SHA-256
    output_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # File storage for replay (original bytes, enables rerun without re-upload)
    sap_file_blob: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    as26_file_blob: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    deductor_filter_parties: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # [{deductor_name, tan}]

    # Versioning
    algorithm_version: Mapped[str] = mapped_column(String(20), nullable=False)
    config_snapshot: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # config.py state at run time
    admin_settings_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("admin_settings.id"), nullable=True)  # exact settings version used

    # Status
    status: Mapped[str] = mapped_column(
        Enum("PENDING", "PROCESSING", "PENDING_REVIEW", "APPROVED", "REJECTED", "FAILED", name="run_status"),
        default="PENDING", nullable=False
    )
    mode: Mapped[str] = mapped_column(
        Enum("SINGLE", "BATCH", name="run_mode"),
        nullable=False, default="SINGLE"
    )
    batch_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    batch_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    batch_tags: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # ["quarterly", "urgent"]
    parent_batch_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)  # rerun lineage

    # Results summary
    total_26as_entries: Mapped[int] = mapped_column(Integer, default=0)
    total_sap_entries: Mapped[int] = mapped_column(Integer, default=0)
    matched_count: Mapped[int] = mapped_column(Integer, default=0)
    unmatched_26as_count: Mapped[int] = mapped_column(Integer, default=0)
    unmatched_books_count: Mapped[int] = mapped_column(Integer, default=0)
    match_rate_pct: Mapped[float] = mapped_column(Float, default=0.0)
    high_confidence_count: Mapped[int] = mapped_column(Integer, default=0)
    medium_confidence_count: Mapped[int] = mapped_column(Integer, default=0)
    low_confidence_count: Mapped[int] = mapped_column(Integer, default=0)
    constraint_violations: Mapped[int] = mapped_column(Integer, default=0)
    suggested_count: Mapped[int] = mapped_column(Integer, default=0)

    # Per-run config overrides (snapshot of AdminSettings at run time)
    run_config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Control totals
    total_26as_amount: Mapped[float] = mapped_column(Float, default=0.0)
    total_sap_amount: Mapped[float] = mapped_column(Float, default=0.0)
    matched_amount: Mapped[float] = mapped_column(Float, default=0.0)
    unmatched_26as_amount: Mapped[float] = mapped_column(Float, default=0.0)
    control_total_balanced: Mapped[bool] = mapped_column(Boolean, default=False)

    # Validation flags
    validation_errors: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    has_pan_issues: Mapped[bool] = mapped_column(Boolean, default=False)
    has_rate_mismatches: Mapped[bool] = mapped_column(Boolean, default=False)
    has_section_mismatches: Mapped[bool] = mapped_column(Boolean, default=False)
    has_duplicate_26as: Mapped[bool] = mapped_column(Boolean, default=False)

    # Error message (set when status=FAILED)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Review workflow
    reviewed_by_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    review_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    assigned_reviewer_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    assigned_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # Timestamps
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    created_by_user: Mapped["User"] = relationship("User", foreign_keys=[created_by_id], back_populates="runs")
    matched_pairs: Mapped[List["MatchedPair"]] = relationship("MatchedPair", back_populates="run", cascade="all, delete-orphan")
    unmatched_26as: Mapped[List["Unmatched26AS"]] = relationship("Unmatched26AS", back_populates="run", cascade="all, delete-orphan")
    unmatched_books: Mapped[List["UnmatchedBook"]] = relationship("UnmatchedBook", back_populates="run", cascade="all, delete-orphan")
    audit_logs: Mapped[List["AuditLog"]] = relationship("AuditLog", back_populates="run")
    exceptions: Mapped[List["ExceptionRecord"]] = relationship("ExceptionRecord", back_populates="run", cascade="all, delete-orphan")
    suggested_matches: Mapped[List["SuggestedMatch"]] = relationship("SuggestedMatch", back_populates="run", cascade="all, delete-orphan")


# ── Core Match Data ───────────────────────────────────────────────────────────

class MatchedPair(Base):
    """
    One row per 26AS entry that was successfully matched.
    Stores full traceability: why this match, what the alternatives were.
    """
    __tablename__ = "matched_pairs"
    __table_args__ = (
        Index("ix_matched_pairs_run_id", "run_id"),
        Index("ix_matched_pairs_section", "section"),
        UniqueConstraint("run_id", "as26_row_hash", name="uq_matched_pairs_run_hash"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("reconciliation_runs.id", ondelete="CASCADE"), nullable=False)

    # 26AS side
    as26_row_hash: Mapped[str] = mapped_column(String(64), nullable=False)  # SHA-256 of the raw 26AS row
    as26_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    as26_amount: Mapped[float] = mapped_column(Float, nullable=False)
    as26_tds_amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    as26_date: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    section: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    tan: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    deductor_name: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    derived_gross: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # TDS / expected_rate
    rate_mismatch: Mapped[bool] = mapped_column(Boolean, default=False)

    # Books (SAP) side — stored as JSON arrays
    invoice_refs: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    invoice_amounts: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    invoice_dates: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    clearing_doc: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    books_sum: Mapped[float] = mapped_column(Float, nullable=False)

    # Match quality
    match_type: Mapped[str] = mapped_column(String(30), nullable=False)  # EXACT / SINGLE / COMBO_N / FORCE_* / CLR_GROUP
    variance_amt: Mapped[float] = mapped_column(Float, nullable=False)
    variance_pct: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[str] = mapped_column(String(10), nullable=False)  # HIGH / MEDIUM / LOW
    composite_score: Mapped[float] = mapped_column(Float, default=0.0)   # 0–100 composite score

    # Score breakdown
    score_variance: Mapped[float] = mapped_column(Float, default=0.0)    # 30%
    score_date_proximity: Mapped[float] = mapped_column(Float, default=0.0)  # 20%
    score_section_match: Mapped[float] = mapped_column(Float, default=0.0)   # 20%
    score_clearing_doc: Mapped[float] = mapped_column(Float, default=0.0)    # 20%
    score_historical: Mapped[float] = mapped_column(Float, default=0.0)      # 10%

    # Flags
    cross_fy: Mapped[bool] = mapped_column(Boolean, default=False)
    is_prior_year: Mapped[bool] = mapped_column(Boolean, default=False)
    ai_risk_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    ai_risk_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Alternatives — top 3 other valid candidates, stored as JSON
    alternative_matches: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Remark — auto-generated when promoted from suggested match with high variance
    remark: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    alert_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    run: Mapped["ReconciliationRun"] = relationship("ReconciliationRun", back_populates="matched_pairs")


class Unmatched26AS(Base):
    """26AS entries with no matching SAP invoice. Soft-deleted when promoted to matched."""
    __tablename__ = "unmatched_26as"
    __table_args__ = (
        Index("ix_unmatched_26as_run_id", "run_id"),
        UniqueConstraint("run_id", "as26_row_hash", name="uq_unmatched_26as_run_hash"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("reconciliation_runs.id", ondelete="CASCADE"), nullable=False)

    as26_row_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    deductor_name: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    tan: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    transaction_date: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    tds_amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    section: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    reason_code: Mapped[str] = mapped_column(String(10), nullable=False)   # U01 / U02 / U04
    reason_detail: Mapped[str] = mapped_column(Text, nullable=False)
    best_candidate_invoice: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    best_candidate_variance_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Soft-delete: ACTIVE → PROMOTED (when authorized as suggested match) or ARCHIVED
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ACTIVE")
    promoted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    promoted_by_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    run: Mapped["ReconciliationRun"] = relationship("ReconciliationRun", back_populates="unmatched_26as")


class UnmatchedBook(Base):
    """SAP book entries not consumed by any match."""
    __tablename__ = "unmatched_books"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("reconciliation_runs.id", ondelete="CASCADE"), nullable=False)

    invoice_ref: Mapped[str] = mapped_column(String(200), nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    doc_date: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    doc_type: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    clearing_doc: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    flag: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    sap_fy: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    run: Mapped["ReconciliationRun"] = relationship("ReconciliationRun", back_populates="unmatched_books")


# ── Exception Records ─────────────────────────────────────────────────────────

class ExceptionRecord(Base):
    """
    Auto-generated exceptions requiring mandatory CA review.
    Includes FORCE matches, rate mismatches, section mismatches, high variance.
    """
    __tablename__ = "exception_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("reconciliation_runs.id", ondelete="CASCADE"), nullable=False)
    matched_pair_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("matched_pairs.id"), nullable=True)
    unmatched_26as_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)

    exception_type: Mapped[str] = mapped_column(
        String(50),  # FORCE_MATCH / HIGH_VARIANCE / CROSS_FY / etc.
        nullable=False
    )
    severity: Mapped[str] = mapped_column(
        String(20),  # CRITICAL / HIGH / MEDIUM / LOW / INFO
        nullable=False
    )
    description: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    section: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)

    # Review workflow
    reviewed: Mapped[bool] = mapped_column(Boolean, default=False)
    reviewed_by_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    review_action: Mapped[Optional[str]] = mapped_column(
        Enum("ACCEPTED", "REJECTED", "ESCALATED", name="review_action"),
        nullable=True
    )
    review_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    run: Mapped["ReconciliationRun"] = relationship("ReconciliationRun", back_populates="exceptions")


# ── Audit Logs ────────────────────────────────────────────────────────────────

class AuditLog(Base):
    """
    Immutable audit trail — every user action and system event.
    Never updated, only inserted.
    """
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_run_id", "run_id"),
        Index("ix_audit_logs_user_id", "user_id"),
        Index("ix_audit_logs_created_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("reconciliation_runs.id"), nullable=True)
    user_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)

    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    # e.g. RUN_STARTED, RUN_COMPLETED, ALIGNMENT_CONFIRMED, OVERRIDE_APPLIED,
    #      EXCEPTION_REVIEWED, FILE_UPLOADED, USER_LOGIN, EXPORT_DOWNLOADED

    description: Mapped[str] = mapped_column(Text, nullable=False)
    event_metadata: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True, name="metadata")  # arbitrary extra data
    ip_address: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    run: Mapped[Optional["ReconciliationRun"]] = relationship("ReconciliationRun", back_populates="audit_logs")
    user: Mapped[Optional["User"]] = relationship("User", back_populates="audit_logs")


# ── Run Counter ───────────────────────────────────────────────────────────────

# ── Admin Settings ────────────────────────────────────────────────────────────

class AdminSettings(Base):
    """
    Singleton-with-history pattern: only one row has is_active=True at a time.
    Each update creates a new row and deactivates the previous one, preserving full audit history.
    """
    __tablename__ = "admin_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)

    # Document Filters
    doc_types_include: Mapped[Optional[list]] = mapped_column(JSON, default=lambda: ["RV", "DR"])
    doc_types_exclude: Mapped[Optional[list]] = mapped_column(JSON, default=lambda: ["CC", "BR"])

    # Date Rules
    date_hard_cutoff_days: Mapped[int] = mapped_column(Integer, default=90)
    date_soft_preference_days: Mapped[int] = mapped_column(Integer, default=180)
    enforce_books_before_26as: Mapped[bool] = mapped_column(Boolean, default=True)

    # Variance Thresholds
    variance_normal_ceiling_pct: Mapped[float] = mapped_column(Float, default=3.0)
    variance_suggested_ceiling_pct: Mapped[float] = mapped_column(Float, default=20.0)

    # Advance Payment
    exclude_sgl_v: Mapped[bool] = mapped_column(Boolean, default=True)

    # Combo Settings
    max_combo_size: Mapped[int] = mapped_column(Integer, default=5)  # Default to MAX_COMBO_SIZE from config.py
    date_clustering_preference: Mapped[bool] = mapped_column(Boolean, default=True)

    # Cross-FY
    allow_cross_fy: Mapped[bool] = mapped_column(Boolean, default=False)
    cross_fy_lookback_years: Mapped[int] = mapped_column(Integer, default=1)

    # Force Match
    force_match_enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    # Noise
    noise_threshold: Mapped[float] = mapped_column(Float, default=1.0)

    # Clearing Group (Phase A)
    clearing_group_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True, default=None)
    clearing_group_variance_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=None)
    proxy_clearing_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True, default=None)

    # ── Batch Processing (Phase 1) ───────────────────────────────────────────
    batch_concurrency_limit: Mapped[int] = mapped_column(Integer, default=10)  # max parallel runs per batch
    batch_parse_cache_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # parse 26AS once per batch
    batch_invoice_dedup_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # cross-run invoice uniqueness
    batch_control_total_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # batch-level sum assertion

    # ── Batch Processing (Phase 2) ───────────────────────────────────────────
    batch_auto_retry_count: Mapped[int] = mapped_column(Integer, default=0)  # 0 = disabled, 1-3 retries on failure
    batch_duplicate_detection_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # cross-batch same-file detection
    batch_progress_dashboard_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # aggregate progress view
    batch_comparison_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # side-by-side batch comparison
    batch_variance_trend_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # historical trend analysis
    batch_export_template: Mapped[str] = mapped_column(String(50), default="standard")  # standard | ca_review | itr_filing | management
    batch_notification_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # webhook on batch complete/fail
    batch_notification_webhook_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    batch_scheduling_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # scheduled batch reruns

    # ── Reconciliation Intelligence (Phase 3) ─────────────────────────────────
    section_filter_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # match within same tax section only
    invoice_date_proximity_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # penalize large date gaps in scoring
    max_date_gap_days: Mapped[int] = mapped_column(Integer, default=90)  # max days between 26AS and invoice date
    as26_duplicate_check_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # flag duplicate Status=F entries
    credit_note_handling_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # parse negative SAP amounts as adjustments
    bipartite_matching_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # graph-based global optimization
    enumerate_alternatives_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # top 3 alternatives per suggested match
    amount_control_totals_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # verify amount balancing in Excel
    match_type_distribution_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # track EXACT/SINGLE/COMBO/FORCE breakdown
    pan_detection_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # PAN & 206AA TDS rate analysis
    large_batch_mode_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # memory limits & perf tuning
    max_sap_rows_per_run: Mapped[int] = mapped_column(Integer, default=100000)  # cap per-run SAP row count

    # ── Workflow & Compliance (Phase 4) ────────────────────────────────────────
    approval_workflow_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # approve/reject on run detail
    comment_threads_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # per-run comment system
    reviewer_assignment_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # assign runs to reviewers
    bulk_operations_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # bulk approve/reject/export
    run_archival_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # archive old runs
    archival_retention_days: Mapped[int] = mapped_column(Integer, default=365)  # days before archiving
    compliance_report_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # audit-ready compliance Excel
    data_quality_precheck_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # pre-match data profiling
    custom_exception_rules_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # user-defined exception triggers
    run_comparison_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # side-by-side run diff
    enhanced_webhook_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # retry, signatures, payload config
    webhook_retry_count: Mapped[int] = mapped_column(Integer, default=3)  # webhook delivery retries
    webhook_secret: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, default=None)  # HMAC signing secret

    # ── Advanced Tuning & Profiles (Phase 5) ──────────────────────────────────
    # 5A: Exception severity thresholds
    high_value_threshold: Mapped[float] = mapped_column(Float, default=1000000.0)
    auto_escalate_high_value: Mapped[bool] = mapped_column(Boolean, default=True)
    force_match_exception_severity: Mapped[str] = mapped_column(String(20), default="HIGH")
    # 5B: Scoring weight configuration
    score_weight_variance: Mapped[float] = mapped_column(Float, default=30.0)
    score_weight_date: Mapped[float] = mapped_column(Float, default=20.0)
    score_weight_section: Mapped[float] = mapped_column(Float, default=20.0)
    score_weight_clearing: Mapped[float] = mapped_column(Float, default=20.0)
    score_weight_historical: Mapped[float] = mapped_column(Float, default=10.0)
    custom_scoring_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # 5C: Variance tier ceilings
    variance_ceiling_single_pct: Mapped[float] = mapped_column(Float, default=2.0)
    variance_ceiling_combo_pct: Mapped[float] = mapped_column(Float, default=3.0)
    variance_ceiling_force_single_pct: Mapped[float] = mapped_column(Float, default=5.0)
    variance_ceiling_force_combo_pct: Mapped[float] = mapped_column(Float, default=2.0)
    custom_variance_ceilings_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # 5D: Combo heuristics
    combo_iteration_budget: Mapped[int] = mapped_column(Integer, default=50000)
    combo_pool_cap: Mapped[int] = mapped_column(Integer, default=5000)
    combo_date_window_days: Mapped[int] = mapped_column(Integer, default=30)
    # 5E: Date proximity profiles
    date_proximity_profile: Mapped[str] = mapped_column(String(20), default="STANDARD")
    filing_lag_days_tolerance: Mapped[int] = mapped_column(Integer, default=45)
    # 5F: Clearing document rules
    clearing_doc_bonus_score: Mapped[float] = mapped_column(Float, default=20.0)
    proxy_clearing_date_window_days: Mapped[int] = mapped_column(Integer, default=30)
    # 5G: Rate & section validation
    rate_tolerance_pct: Mapped[float] = mapped_column(Float, default=2.0)
    rate_mismatch_severity: Mapped[str] = mapped_column(String(20), default="MEDIUM")
    # 5H: Parser & cleaner profiles
    parser_lenient_mode: Mapped[bool] = mapped_column(Boolean, default=True)
    cleaner_duplicate_strategy: Mapped[str] = mapped_column(String(30), default="FIRST_OCCURRENCE")
    # 5I: Excel export templates
    export_show_score_breakdown: Mapped[bool] = mapped_column(Boolean, default=True)
    export_template_active: Mapped[str] = mapped_column(String(30), default="standard")
    # 5J: Dashboard metrics
    dashboard_match_rate_target_pct: Mapped[float] = mapped_column(Float, default=75.0)
    dashboard_variance_warning_pct: Mapped[float] = mapped_column(Float, default=5.0)
    dashboard_exclude_failed_from_trends: Mapped[bool] = mapped_column(Boolean, default=True)

    # ── Reporting, Intelligence & Safety (Phase 6) ─────────────────────────────
    # 6A: Confidence tier thresholds
    confidence_high_variance_threshold: Mapped[float] = mapped_column(Float, default=1.0)
    confidence_medium_variance_threshold: Mapped[float] = mapped_column(Float, default=5.0)
    confidence_score_boost_threshold: Mapped[float] = mapped_column(Float, default=70.0)
    # 6B: Exact match tolerance
    exact_tolerance_rupees: Mapped[float] = mapped_column(Float, default=0.01)
    # 6C: Auto-approval rules
    auto_approval_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_approval_min_match_rate: Mapped[float] = mapped_column(Float, default=75.0)
    auto_approval_max_exceptions: Mapped[int] = mapped_column(Integer, default=10)
    # 6D: Section confidence boost
    high_confidence_sections: Mapped[str] = mapped_column(String(200), default="194C,194J,194H,194I,194A")
    section_confidence_boost_pct: Mapped[float] = mapped_column(Float, default=60.0)
    # 6E: Unmatched amount alerting
    unmatched_alerting_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    unmatched_critical_amount_threshold: Mapped[float] = mapped_column(Float, default=500000.0)
    unmatched_critical_count_threshold: Mapped[int] = mapped_column(Integer, default=50)
    # 6F: Force match distribution alert
    force_match_alert_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    force_match_alert_pct_threshold: Mapped[float] = mapped_column(Float, default=10.0)
    # 6G: Audit log retention
    audit_log_retention_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    audit_log_retention_days: Mapped[int] = mapped_column(Integer, default=1095)
    audit_log_redact_amounts: Mapped[bool] = mapped_column(Boolean, default=False)
    # 6H: Excel sheet selection
    excel_include_match_distribution: Mapped[bool] = mapped_column(Boolean, default=True)
    excel_include_control_totals: Mapped[bool] = mapped_column(Boolean, default=True)
    excel_include_variance_analysis: Mapped[bool] = mapped_column(Boolean, default=True)
    # 6I: Run display preferences
    run_detail_default_sort: Mapped[str] = mapped_column(String(20), default="variance")
    run_detail_items_per_page: Mapped[int] = mapped_column(Integer, default=50)
    run_detail_show_score_columns: Mapped[bool] = mapped_column(Boolean, default=True)
    # 6J: Batch display preferences
    batch_hide_zero_match_parties: Mapped[bool] = mapped_column(Boolean, default=False)
    batch_summary_sort_by: Mapped[str] = mapped_column(String(20), default="match_rate")
    batch_trend_window_days: Mapped[int] = mapped_column(Integer, default=90)

    # ── Security, Governance & Data Controls (Phase 7) ──────────────────────────
    # 7A: Session policies
    session_inactivity_timeout_min: Mapped[int] = mapped_column(Integer, default=30)
    max_concurrent_sessions: Mapped[int] = mapped_column(Integer, default=3)
    force_reauth_on_approve: Mapped[bool] = mapped_column(Boolean, default=False)
    # 7B: Password rules
    password_min_length: Mapped[int] = mapped_column(Integer, default=8)
    password_require_mixed_case: Mapped[bool] = mapped_column(Boolean, default=True)
    password_require_number: Mapped[bool] = mapped_column(Boolean, default=True)
    password_expiry_days: Mapped[int] = mapped_column(Integer, default=0)
    # 7C: Login protection
    max_failed_login_attempts: Mapped[int] = mapped_column(Integer, default=5)
    login_lockout_duration_min: Mapped[int] = mapped_column(Integer, default=15)
    notify_admin_on_lockout: Mapped[bool] = mapped_column(Boolean, default=False)
    # 7D: Data retention policies
    run_retention_days: Mapped[int] = mapped_column(Integer, default=365)
    auto_archive_after_days: Mapped[int] = mapped_column(Integer, default=90)
    purge_exports_after_days: Mapped[int] = mapped_column(Integer, default=30)
    # 7E: Export security
    export_watermark_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    export_watermark_text: Mapped[str] = mapped_column(String(100), default="CONFIDENTIAL")
    export_require_approval: Mapped[bool] = mapped_column(Boolean, default=False)
    # 7F: PII protection
    redact_tan_in_logs: Mapped[bool] = mapped_column(Boolean, default=False)
    redact_pan_in_exports: Mapped[bool] = mapped_column(Boolean, default=False)
    mask_amounts_in_preview: Mapped[bool] = mapped_column(Boolean, default=False)
    # 7G: Import validation
    max_upload_size_mb: Mapped[int] = mapped_column(Integer, default=50)
    max_rows_per_file: Mapped[int] = mapped_column(Integer, default=100000)
    reject_empty_columns: Mapped[bool] = mapped_column(Boolean, default=False)
    # 7H: Anomaly detection
    anomaly_detection_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    amount_outlier_stddev: Mapped[float] = mapped_column(Float, default=3.0)
    match_rate_drop_alert_pct: Mapped[float] = mapped_column(Float, default=20.0)
    # 7I: Batch recovery
    batch_retry_backoff_seconds: Mapped[int] = mapped_column(Integer, default=2)
    batch_stop_on_failure_count: Mapped[int] = mapped_column(Integer, default=0)
    batch_partial_resume_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # 7J: System health alerts
    system_alerts_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    slow_run_threshold_seconds: Mapped[int] = mapped_column(Integer, default=300)
    high_exception_rate_pct: Mapped[float] = mapped_column(Float, default=50.0)

    # Metadata
    updated_by_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


# ── Run Comments (Phase 4B) ──────────────────────────────────────────────────

class RunComment(Base):
    """Thread-style comments on a reconciliation run."""
    __tablename__ = "run_comments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("reconciliation_runs.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    parent_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("run_comments.id"), nullable=True)  # reply threading
    context_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)  # 'match', 'exception', 'general'
    context_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)  # ID of match/exception if contextual
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, onupdate=_utcnow)


# ── Custom Exception Rules (Phase 4H) ───────────────────────────────────────

class CustomExceptionRule(Base):
    """User-defined exception rules that trigger during reconciliation."""
    __tablename__ = "custom_exception_rules"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    field: Mapped[str] = mapped_column(String(50), nullable=False)  # 'amount', 'variance_pct', 'section', 'match_type'
    operator: Mapped[str] = mapped_column(String(20), nullable=False)  # 'gt', 'lt', 'eq', 'gte', 'lte', 'contains', 'in'
    value: Mapped[str] = mapped_column(String(500), nullable=False)  # threshold value (string, parsed at runtime)
    severity: Mapped[str] = mapped_column(String(20), default="MEDIUM")  # CRITICAL, HIGH, MEDIUM, LOW
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, onupdate=_utcnow)


# ── Suggested Matches ────────────────────────────────────────────────────────

class SuggestedMatch(Base):
    """
    Matches that fall outside normal auto-match criteria but are worth presenting
    to the reviewer for manual authorization. Categories include high-variance,
    date-soft-preference violations, advance payments, and force matches.
    """
    __tablename__ = "suggested_matches"
    __table_args__ = (
        Index("ix_suggested_matches_run_id", "run_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("reconciliation_runs.id", ondelete="CASCADE"), nullable=False)

    # 26AS side
    as26_row_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    as26_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    as26_amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    as26_date: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    section: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    tan: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    deductor_name: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # Books side
    invoice_refs: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    invoice_amounts: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    invoice_dates: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    clearing_doc: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    books_sum: Mapped[float] = mapped_column(Float, default=0)

    # Match quality
    match_type: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    variance_amt: Mapped[float] = mapped_column(Float, default=0)
    variance_pct: Mapped[float] = mapped_column(Float, default=0)
    confidence: Mapped[str] = mapped_column(String(10), default="LOW")
    composite_score: Mapped[float] = mapped_column(Float, default=0)
    score_variance: Mapped[float] = mapped_column(Float, default=0)
    score_date_proximity: Mapped[float] = mapped_column(Float, default=0)
    score_section_match: Mapped[float] = mapped_column(Float, default=0)
    score_clearing_doc: Mapped[float] = mapped_column(Float, default=0)
    score_historical: Mapped[float] = mapped_column(Float, default=0)
    cross_fy: Mapped[bool] = mapped_column(Boolean, default=False)
    is_prior_year: Mapped[bool] = mapped_column(Boolean, default=False)

    # Suggested-specific
    category: Mapped[str] = mapped_column(String(50), nullable=False)  # HIGH_VARIANCE_3_20, HIGH_VARIANCE_20_PLUS, DATE_SOFT_PREFERENCE, ADVANCE_PAYMENT, FORCE
    requires_remarks: Mapped[bool] = mapped_column(Boolean, default=False)
    alert_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Authorization workflow
    authorized: Mapped[bool] = mapped_column(Boolean, default=False)
    authorized_by_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    authorized_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    remarks: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    rejected: Mapped[bool] = mapped_column(Boolean, default=False)
    rejected_by_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    rejected_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    rejection_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    # Relationships
    run: Mapped["ReconciliationRun"] = relationship("ReconciliationRun", back_populates="suggested_matches")


# ── Run Counter ───────────────────────────────────────────────────────────────

# ── Auth Security Tables ─────────────────────────────────────────────────────

class PasswordResetToken(Base):
    """Time-limited, single-use password reset tokens."""
    __tablename__ = "password_reset_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)  # SHA-256 of token
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmailVerificationToken(Base):
    """Email verification tokens sent on registration."""
    __tablename__ = "email_verification_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SecurityQuestion(Base):
    """Hashed security question answers set during registration."""
    __tablename__ = "security_questions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    question: Mapped[str] = mapped_column(String(255), nullable=False)
    answer_hash: Mapped[str] = mapped_column(String(255), nullable=False)  # bcrypt hash
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class LoginAttempt(Base):
    """Audit trail for login attempts (successful and failed)."""
    __tablename__ = "login_attempts"
    __table_args__ = (
        Index("ix_login_attempts_email", "email"),
        Index("ix_login_attempts_created_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    ip_address: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    failure_reason: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Run Counter ───────────────────────────────────────────────────────────────

class RunCounter(Base):
    """Global monotonic run number for human-readable run IDs (RUN-0001, RUN-0002...)."""
    __tablename__ = "run_counter"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    current_value: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
