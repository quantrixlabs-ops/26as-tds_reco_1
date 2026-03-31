"""
Tests for core/audit.py — HMAC chain, redaction, purge.
"""
import json
import os
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest

# Import internals — these are module-level functions
from core.audit import (
    _redact_amounts,
    _redact_tans,
    _compute_hmac,
    verify_audit_chain,
    purge_old_audit_logs,
    _HMAC_KEY,
)


# ── Amount Redaction ──────────────────────────────────────────────────────────

def test_redact_amounts_basic():
    assert _redact_amounts("Paid ₹1,234.56 to vendor") == "Paid ₹[REDACTED] to vendor"


def test_redact_amounts_multiple():
    result = _redact_amounts("₹100 and ₹200.50 total")
    assert result.count("₹[REDACTED]") == 2
    assert "₹100" not in result
    assert "₹200.50" not in result


def test_redact_amounts_no_match():
    text = "No rupee amounts here"
    assert _redact_amounts(text) == text


def test_redact_amounts_integer():
    assert _redact_amounts("₹5000") == "₹[REDACTED]"


def test_redact_amounts_large():
    assert "₹[REDACTED]" in _redact_amounts("Total: ₹12,34,56,789.00")


# ── TAN Redaction ─────────────────────────────────────────────────────────────

def test_redact_tans_basic():
    result = _redact_tans("TAN ABCD12345X found")
    assert "ABCD*****X" in result
    assert "ABCD12345X" not in result


def test_redact_tans_multiple():
    result = _redact_tans("TANs: ABCD12345X and WXYZ67890A")
    assert "ABCD*****X" in result
    assert "WXYZ*****A" in result


def test_redact_tans_no_match():
    text = "No TANs here at all"
    assert _redact_tans(text) == text


def test_redact_tans_too_short():
    """8-char string should NOT match TAN pattern (needs 10)."""
    text = "ABC1234X is too short"
    assert _redact_tans(text) == text


def test_redact_tans_lowercase_no_match():
    """TAN pattern is uppercase only — lowercase should not match."""
    text = "abcd12345x should not match"
    assert _redact_tans(text) == text


# ── HMAC Computation ──────────────────────────────────────────────────────────

def test_compute_hmac_deterministic():
    """Same inputs → same hash."""
    record = '{"event": "test"}'
    h1 = _compute_hmac(record, "0")
    h2 = _compute_hmac(record, "0")
    assert h1 == h2
    assert len(h1) == 64  # SHA-256 hex length


def test_compute_hmac_different_inputs():
    h1 = _compute_hmac('{"a": 1}', "0")
    h2 = _compute_hmac('{"b": 2}', "0")
    assert h1 != h2


def test_compute_hmac_chain_depends_on_prev():
    """Same record with different prev_hash → different HMAC (chain property)."""
    record = '{"event": "test"}'
    h1 = _compute_hmac(record, "0")
    h2 = _compute_hmac(record, "abc123")
    assert h1 != h2


# ── Chain Verification ────────────────────────────────────────────────────────

def _write_chained_log(path: Path, num_lines: int = 3):
    """Helper: write a valid HMAC-chained JSONL file."""
    prev_hash = "0"
    for i in range(num_lines):
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event_type": "TEST",
            "description": f"Test event {i}",
            "run_id": None,
            "user_id": None,
            "metadata": {},
        }
        record_json = json.dumps(record, default=str, sort_keys=True)
        hmac_val = _compute_hmac(record_json, prev_hash)
        record["_prev_hash"] = prev_hash
        record["_hmac"] = hmac_val
        with open(path, "a") as f:
            f.write(json.dumps(record, default=str, sort_keys=True) + "\n")
        prev_hash = hmac_val


def test_verify_chain_valid():
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as f:
        path = Path(f.name)
    try:
        _write_chained_log(path, 3)
        result = verify_audit_chain(str(path))
        assert result["valid"] is True
        assert result["total_lines"] == 3
        assert result["broken_at"] is None
    finally:
        path.unlink(missing_ok=True)


def test_verify_chain_tampered():
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as f:
        path = Path(f.name)
    try:
        _write_chained_log(path, 3)
        # Tamper with the second line
        lines = path.read_text().strip().split("\n")
        record = json.loads(lines[1])
        record["description"] = "TAMPERED"
        lines[1] = json.dumps(record, default=str, sort_keys=True)
        path.write_text("\n".join(lines) + "\n")

        result = verify_audit_chain(str(path))
        assert result["valid"] is False
        assert result["broken_at"] == 2  # second line is where it breaks
    finally:
        path.unlink(missing_ok=True)


def test_verify_chain_missing_file():
    result = verify_audit_chain("/nonexistent/path/file.jsonl")
    assert result["valid"] is False
    assert "File not found" in result["error"]


def test_verify_chain_empty_file():
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as f:
        path = Path(f.name)
    try:
        result = verify_audit_chain(str(path))
        assert result["valid"] is True
        assert result["total_lines"] == 0
    finally:
        path.unlink(missing_ok=True)


def test_verify_chain_single_line():
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as f:
        path = Path(f.name)
    try:
        _write_chained_log(path, 1)
        result = verify_audit_chain(str(path))
        assert result["valid"] is True
        assert result["total_lines"] == 1
    finally:
        path.unlink(missing_ok=True)


# ── Purge Old Logs ────────────────────────────────────────────────────────────

def test_purge_old_logs():
    """Create files with old and recent dates, verify purge deletes only old ones."""
    import core.audit as audit_module

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        original_dir = audit_module._audit_dir

        try:
            # Temporarily redirect audit dir
            audit_module._audit_dir = tmpdir_path

            # Create "old" file (2 years ago)
            old_date = (datetime.now(timezone.utc) - timedelta(days=800)).strftime("%Y-%m-%d")
            (tmpdir_path / f"audit_{old_date}.jsonl").write_text("old data\n")

            # Create "recent" file (today)
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            (tmpdir_path / f"audit_{today}.jsonl").write_text("recent data\n")

            result = purge_old_audit_logs(retention_days=365)
            assert result["deleted"] == 1
            assert result["kept"] == 1
            assert len(result["errors"]) == 0

            # Verify the old file is gone and recent file remains
            assert not (tmpdir_path / f"audit_{old_date}.jsonl").exists()
            assert (tmpdir_path / f"audit_{today}.jsonl").exists()
        finally:
            audit_module._audit_dir = original_dir
