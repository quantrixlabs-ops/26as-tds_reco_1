"""
Tests for api/routes/settings.py — schema validation, field lists, defaults.

These tests validate the AdminSettings configuration layer WITHOUT needing a database.
They test Pydantic models, validator logic, and the _SETTINGS_FIELDS / _to_schema integrity.
"""
import pytest
from pydantic import ValidationError

# Import the schemas and helpers
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.routes.settings import (
    AdminSettingsSchema,
    AdminSettingsUpdate,
    _SETTINGS_FIELDS,
    _to_schema,
)


# ── _SETTINGS_FIELDS Integrity ────────────────────────────────────────────────

def test_settings_fields_no_duplicates():
    """No field name should appear twice in the list."""
    assert len(_SETTINGS_FIELDS) == len(set(_SETTINGS_FIELDS))


def test_settings_fields_all_strings():
    for field in _SETTINGS_FIELDS:
        assert isinstance(field, str), f"Non-string field: {field}"


def test_settings_fields_not_empty():
    assert len(_SETTINGS_FIELDS) > 100  # We have 112+ from Phase 5-7


# ── _to_schema with None (defaults) ──────────────────────────────────────────

def test_to_schema_none_crashes():
    """_to_schema(None) is not designed to handle None — it accesses s.id.
    This documents that _to_schema REQUIRES an ORM instance."""
    with pytest.raises(AttributeError):
        _to_schema(None)


def test_to_schema_fields_match_settings_list():
    """Verify _SETTINGS_FIELDS covers all fields that _to_schema would produce.
    We check this by inspecting the _to_schema source code keys."""
    import inspect
    source = inspect.getsource(_to_schema)
    # Every field in _SETTINGS_FIELDS should appear as a key in _to_schema
    for field in _SETTINGS_FIELDS:
        assert f'"{field}"' in source, f"Field '{field}' in _SETTINGS_FIELDS but not in _to_schema"


# ── AdminSettingsUpdate Validators ────────────────────────────────────────────

def test_update_all_fields_optional():
    """AdminSettingsUpdate with no args should be valid (all Optional)."""
    update = AdminSettingsUpdate()
    assert update is not None


# Phase 7 validators

def test_password_min_length_too_low():
    with pytest.raises(ValidationError, match="between 6 and 128"):
        AdminSettingsUpdate(password_min_length=3)


def test_password_min_length_too_high():
    with pytest.raises(ValidationError, match="between 6 and 128"):
        AdminSettingsUpdate(password_min_length=200)


def test_password_min_length_valid():
    update = AdminSettingsUpdate(password_min_length=10)
    assert update.password_min_length == 10


def test_upload_size_too_low():
    with pytest.raises(ValidationError, match="between 1 and 500"):
        AdminSettingsUpdate(max_upload_size_mb=0)


def test_upload_size_too_high():
    with pytest.raises(ValidationError, match="between 1 and 500"):
        AdminSettingsUpdate(max_upload_size_mb=501)


def test_upload_size_valid():
    update = AdminSettingsUpdate(max_upload_size_mb=50)
    assert update.max_upload_size_mb == 50


def test_max_rows_too_high():
    with pytest.raises(ValidationError, match="cannot exceed 1,000,000"):
        AdminSettingsUpdate(max_rows_per_file=2_000_000)


def test_max_rows_valid():
    update = AdminSettingsUpdate(max_rows_per_file=100_000)
    assert update.max_rows_per_file == 100_000


def test_retention_days_too_high():
    with pytest.raises(ValidationError, match="cannot exceed 10 years"):
        AdminSettingsUpdate(run_retention_days=5000)


def test_retention_days_valid():
    update = AdminSettingsUpdate(run_retention_days=365)
    assert update.run_retention_days == 365


def test_retention_days_zero_valid():
    """0 means disabled — should be valid."""
    update = AdminSettingsUpdate(run_retention_days=0)
    assert update.run_retention_days == 0


def test_watermark_text_too_long():
    with pytest.raises(ValidationError, match="cannot exceed 100"):
        AdminSettingsUpdate(export_watermark_text="x" * 101)


def test_watermark_text_valid():
    update = AdminSettingsUpdate(export_watermark_text="CONFIDENTIAL")
    assert update.export_watermark_text == "CONFIDENTIAL"


# Pre-existing validators (sanity check they still work)

def test_negative_int_rejected():
    with pytest.raises(ValidationError, match="non-negative"):
        AdminSettingsUpdate(max_combo_size=-1)


def test_lookback_years_max():
    with pytest.raises(ValidationError, match="cannot exceed 5"):
        AdminSettingsUpdate(cross_fy_lookback_years=10)


def test_auto_retry_max():
    with pytest.raises(ValidationError, match="cannot exceed 5"):
        AdminSettingsUpdate(batch_auto_retry_count=6)


def test_severity_invalid():
    with pytest.raises(ValidationError, match="Severity must be one of"):
        AdminSettingsUpdate(force_match_exception_severity="INVALID")


def test_severity_valid():
    update = AdminSettingsUpdate(force_match_exception_severity="HIGH")
    assert update.force_match_exception_severity == "HIGH"


def test_date_proximity_profile_invalid():
    with pytest.raises(ValidationError, match="Profile must be one of"):
        AdminSettingsUpdate(date_proximity_profile="INVALID")


def test_items_per_page_too_low():
    with pytest.raises(ValidationError, match="between 10 and 500"):
        AdminSettingsUpdate(run_detail_items_per_page=5)


def test_items_per_page_too_high():
    with pytest.raises(ValidationError, match="between 10 and 500"):
        AdminSettingsUpdate(run_detail_items_per_page=1000)
