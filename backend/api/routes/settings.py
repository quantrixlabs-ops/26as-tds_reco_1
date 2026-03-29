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
from db.models import AdminSettings, User

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

    from pydantic import field_validator

    @field_validator(
        "date_hard_cutoff_days", "date_soft_preference_days",
        "max_combo_size", "cross_fy_lookback_years",
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


# ── Helpers ──────────────────────────────────────────────────────────────────

_SETTINGS_FIELDS = [
    "doc_types_include", "doc_types_exclude", "date_hard_cutoff_days",
    "date_soft_preference_days", "enforce_books_before_26as",
    "variance_normal_ceiling_pct", "variance_suggested_ceiling_pct",
    "exclude_sgl_v", "max_combo_size", "date_clustering_preference",
    "allow_cross_fy", "cross_fy_lookback_years", "force_match_enabled",
    "noise_threshold",
    "clearing_group_enabled", "clearing_group_variance_pct", "proxy_clearing_enabled",
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
