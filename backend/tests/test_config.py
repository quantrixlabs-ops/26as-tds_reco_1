"""
Tests for config.py — FY helpers, MatchConfig, constants.
"""
import pytest
from datetime import date
from config import (
    fy_date_range, sap_date_window, fy_label_from_date_range, date_to_fy_label,
    MatchConfig, SUPPORTED_FINANCIAL_YEARS, DEFAULT_FINANCIAL_YEAR,
    VARIANCE_CAP_SINGLE, VARIANCE_CAP_COMBO, VARIANCE_CAP_CLR_GROUP,
    VARIANCE_CAP_FORCE_SINGLE, FORCE_COMBO_MAX_VARIANCE, MAX_COMBO_SIZE,
    EXACT_TOLERANCE, SAP_LOOKBACK_YEARS,
)


# ── fy_date_range ─────────────────────────────────────────────────────────────

def test_fy_date_range_2023_24():
    start, end = fy_date_range("FY2023-24")
    assert start == date(2023, 4, 1)
    assert end == date(2024, 3, 31)


def test_fy_date_range_2020_21():
    start, end = fy_date_range("FY2020-21")
    assert start == date(2020, 4, 1)
    assert end == date(2021, 3, 31)


def test_fy_date_range_2025_26():
    start, end = fy_date_range("FY2025-26")
    assert start == date(2025, 4, 1)
    assert end == date(2026, 3, 31)


def test_fy_date_range_no_prefix_accepted():
    """BUG/WARN: '2023-24' (without FY prefix) is silently accepted.
    The function does .replace('FY', '') which is a no-op here, then parses '2023'.
    This is not validated — flagged as a finding."""
    start, end = fy_date_range("2023-24")
    # It actually works — produces the same as FY2023-24
    assert start == date(2023, 4, 1)
    assert end == date(2024, 3, 31)


def test_fy_date_range_garbage():
    with pytest.raises(ValueError):
        fy_date_range("GARBAGE")


def test_fy_date_range_empty():
    with pytest.raises((ValueError, IndexError)):
        fy_date_range("")


# ── sap_date_window ───────────────────────────────────────────────────────────

def test_sap_date_window_lookback_1():
    start, end = sap_date_window("FY2023-24")
    assert start == date(2022, 4, 1)
    assert end == date(2024, 3, 31)


def test_sap_date_window_end_matches_fy():
    _, fy_end = fy_date_range("FY2023-24")
    _, sap_end = sap_date_window("FY2023-24")
    assert sap_end == fy_end


# ── date_to_fy_label ─────────────────────────────────────────────────────────

def test_date_to_fy_label_june():
    assert date_to_fy_label(date(2023, 6, 15)) == "FY2023-24"


def test_date_to_fy_label_january():
    assert date_to_fy_label(date(2024, 1, 15)) == "FY2023-24"


def test_date_to_fy_label_march_31():
    """March 31 is the LAST day of FY — should still be in the FY that started the previous April."""
    assert date_to_fy_label(date(2024, 3, 31)) == "FY2023-24"


def test_date_to_fy_label_april_1():
    """April 1 is the FIRST day of a NEW FY."""
    assert date_to_fy_label(date(2024, 4, 1)) == "FY2024-25"


def test_date_to_fy_label_april_30():
    assert date_to_fy_label(date(2023, 4, 30)) == "FY2023-24"


def test_date_to_fy_label_december():
    assert date_to_fy_label(date(2023, 12, 25)) == "FY2023-24"


# ── fy_label_from_date_range ─────────────────────────────────────────────────

def test_fy_label_from_date_range_roundtrip():
    """fy_label_from_date_range(fy_date_range(label)[0]) == label"""
    for label in SUPPORTED_FINANCIAL_YEARS:
        start, _ = fy_date_range(label)
        assert fy_label_from_date_range(start) == label


def test_fy_label_from_date_range_2023():
    assert fy_label_from_date_range(date(2023, 4, 1)) == "FY2023-24"


# ── MatchConfig ───────────────────────────────────────────────────────────────

def test_match_config_defaults():
    cfg = MatchConfig()
    assert cfg.max_combo_size == 5
    assert cfg.exact_tolerance == 0.01
    assert cfg.allow_cross_fy is False
    assert cfg.force_match_enabled is True
    assert cfg.clearing_group_enabled is True


def test_match_config_custom_values():
    cfg = MatchConfig(max_combo_size=3, allow_cross_fy=True)
    assert cfg.max_combo_size == 3
    assert cfg.allow_cross_fy is True


def test_match_config_to_dict():
    cfg = MatchConfig()
    d = cfg.to_dict()
    assert isinstance(d, dict)
    assert "max_combo_size" in d
    assert "exact_tolerance" in d
    assert d["max_combo_size"] == 5


def test_match_config_to_dict_all_fields_present():
    """Every field in the dataclass should appear in to_dict output."""
    cfg = MatchConfig()
    d = cfg.to_dict()
    import dataclasses
    field_names = {f.name for f in dataclasses.fields(cfg)}
    assert field_names == set(d.keys())


def test_match_config_scoring_weights_sum_to_100():
    """Default scoring weights should sum to 100."""
    cfg = MatchConfig()
    total = (cfg.score_weight_variance + cfg.score_weight_date +
             cfg.score_weight_section + cfg.score_weight_clearing +
             cfg.score_weight_historical)
    assert total == 100.0


# ── Constants ─────────────────────────────────────────────────────────────────

def test_variance_caps_hierarchy():
    """SINGLE < COMBO ≤ CLR_GROUP < FORCE_SINGLE."""
    assert VARIANCE_CAP_SINGLE < VARIANCE_CAP_COMBO
    assert VARIANCE_CAP_COMBO <= VARIANCE_CAP_CLR_GROUP
    assert VARIANCE_CAP_CLR_GROUP < VARIANCE_CAP_FORCE_SINGLE


def test_force_combo_tighter_than_force_single():
    assert FORCE_COMBO_MAX_VARIANCE < VARIANCE_CAP_FORCE_SINGLE


def test_max_combo_size_is_5():
    assert MAX_COMBO_SIZE == 5


def test_exact_tolerance_is_small():
    assert EXACT_TOLERANCE <= 0.01


def test_supported_financial_years():
    assert len(SUPPORTED_FINANCIAL_YEARS) == 6
    assert SUPPORTED_FINANCIAL_YEARS[0] == "FY2020-21"
    assert SUPPORTED_FINANCIAL_YEARS[-1] == "FY2025-26"


def test_default_financial_year():
    assert DEFAULT_FINANCIAL_YEAR in SUPPORTED_FINANCIAL_YEARS


def test_lookback_years():
    assert SAP_LOOKBACK_YEARS >= 0
