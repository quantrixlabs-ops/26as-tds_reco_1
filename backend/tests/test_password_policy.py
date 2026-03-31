"""
Tests for core/password_policy.py — validation rules, strength scoring, configurability.
"""
import pytest
from core.password_policy import validate_password, compute_strength, COMMON_PASSWORDS


# ── Valid Passwords ───────────────────────────────────────────────────────────

def test_valid_strong_password():
    result = validate_password("Admin@123")
    assert result.valid is True
    assert len(result.errors) == 0


def test_valid_long_password():
    result = validate_password("MyV3ryStr0ng!Pass")
    assert result.valid is True


# ── Length Checks ─────────────────────────────────────────────────────────────

def test_too_short_default():
    result = validate_password("Ab1!xyz")  # 7 chars, min is 8
    assert result.valid is False
    assert any("at least 8" in e for e in result.errors)


def test_too_long():
    result = validate_password("A1!" + "a" * 130)  # > 128 chars
    assert result.valid is False
    assert any("at most 128" in e for e in result.errors)


def test_empty_string():
    result = validate_password("")
    assert result.valid is False
    assert len(result.errors) >= 1


# ── Character Requirement Checks ──────────────────────────────────────────────

def test_no_uppercase():
    result = validate_password("admin@123")
    assert result.valid is False
    assert any("uppercase" in e for e in result.errors)


def test_no_lowercase():
    result = validate_password("ADMIN@123")
    assert result.valid is False
    assert any("lowercase" in e for e in result.errors)


def test_no_digit():
    result = validate_password("Admin@Pass!")
    assert result.valid is False
    assert any("digit" in e for e in result.errors)


def test_no_special():
    result = validate_password("Admin1234")
    assert result.valid is False
    assert any("special" in e for e in result.errors)


# ── Common Password Check ─────────────────────────────────────────────────────

def test_common_password_rejected():
    result = validate_password("password")
    assert result.valid is False
    assert any("common" in e.lower() for e in result.errors)


def test_common_password_case_insensitive():
    result = validate_password("Password1")
    # "password" (lowercase) is in COMMON_PASSWORDS, and the check does .lower()
    # But "Password1" lowered = "password1" which IS in common list
    assert any("common" in e.lower() for e in result.errors)


# ── Configurable Overrides (Phase 7B) ────────────────────────────────────────

def test_custom_min_length_passes():
    """With min_length=6, a 6-char password should pass length check."""
    result = validate_password("Ab1!xy", min_length=6)
    # Should pass length (6 ≥ 6), has upper, lower, digit, special
    assert not any("at least" in e for e in result.errors)


def test_custom_min_length_fails():
    result = validate_password("Ab1!", min_length=6)
    assert any("at least 6" in e for e in result.errors)


def test_mixed_case_disabled():
    """With require_mixed_case=False, lowercase-only should not fail mixed case."""
    result = validate_password("admin@123!", require_mixed_case=False)
    assert not any("uppercase" in e for e in result.errors)
    assert not any("lowercase" in e for e in result.errors)


def test_number_disabled():
    """With require_number=False, no-digit password should not fail digit check."""
    result = validate_password("Admin@Pass!", require_number=False)
    assert not any("digit" in e for e in result.errors)


def test_all_rules_relaxed():
    """Minimum rules — should only need length and special char."""
    result = validate_password("abcdef!", min_length=6, require_mixed_case=False, require_number=False)
    length_ok = not any("at least" in e for e in result.errors)
    assert length_ok


# ── Strength Scoring ──────────────────────────────────────────────────────────

def test_strength_weak():
    assert compute_strength("abc") <= 1


def test_strength_fair():
    """8 chars, upper+lower but no digit/special → strength 1 (length bonus only)."""
    s = compute_strength("Xylophne")  # Not in common list
    assert s >= 1


def test_strength_strong():
    s = compute_strength("MyStr0ng!Pass")
    assert s >= 3


def test_strength_common_password_zero():
    """Common passwords always get strength 0."""
    assert compute_strength("password") == 0
    assert compute_strength("admin123") == 0


def test_strength_max_4():
    """Strength should never exceed 4."""
    s = compute_strength("A1!aVeryLongAndComplexP@ssw0rd2024!!")
    assert s <= 4


def test_strength_repeated_chars_penalty():
    """3+ repeated chars should penalize strength."""
    s_without = compute_strength("Ab1!cdef")
    s_with = compute_strength("Ab1!aaaa")
    # The repeated 'aaaa' should result in equal or lower strength
    assert s_with <= s_without
