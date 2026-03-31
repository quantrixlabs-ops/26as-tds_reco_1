"""
Audit service — every significant action writes an immutable AuditLog row.
Also writes structured JSON logs to disk (audit_logs/ directory).

Tamper-evident: each JSONL line includes an HMAC-SHA256 chaining the previous
line's hash, creating a verifiable audit chain. Any insertion, deletion, or
modification of a line breaks the chain and is detectable.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Optional, Any
from pathlib import Path

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from core.settings import settings

logger = structlog.get_logger(__name__)

# Ensure audit log directory exists
_audit_dir = Path(settings.AUDIT_LOG_DIR)
_audit_dir.mkdir(parents=True, exist_ok=True)

# HMAC key for tamper-evident chaining (per-instance; for production use env-based secret)
_HMAC_KEY = getattr(settings, "AUDIT_HMAC_KEY", "tds-reco-audit-integrity-key").encode()

# In-memory cache of the last hash per log file (for chaining within a session)
_last_hash_cache: dict[str, str] = {}


async def log_event(
    db: AsyncSession,
    event_type: str,
    description: str,
    run_id: Optional[str] = None,
    user_id: Optional[str] = None,
    metadata: Optional[dict] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
) -> None:
    """
    Write an immutable audit event to:
    1. Database (audit_logs table)
    2. Disk (HMAC-chained JSON lines in audit_logs/{date}.jsonl)
    3. Structured log (stdout)
    """
    from db.models import AuditLog  # avoid circular import

    now = datetime.now(timezone.utc)

    # 1. Database row
    log_entry = AuditLog(
        run_id=run_id,
        user_id=user_id,
        event_type=event_type,
        description=description,
        event_metadata=metadata,
        ip_address=ip_address,
        user_agent=user_agent,
        created_at=now,
    )
    db.add(log_entry)
    # Note: commit handled by get_db() dependency

    # 2. Disk — append to daily JSONL file with HMAC chain
    _write_to_disk(event_type, description, run_id, user_id, metadata, now)

    # 3. Structured log
    logger.info(
        event_type,
        description=description,
        run_id=run_id,
        user_id=user_id,
        **({} if metadata is None else metadata),
    )


def _get_last_hash(log_file: Path) -> str:
    """Get the last HMAC hash from the log file for chaining, or '0' for a new file."""
    file_key = str(log_file)

    # Check in-memory cache first (fast path within same session)
    if file_key in _last_hash_cache:
        return _last_hash_cache[file_key]

    # Read last line from existing file
    if log_file.exists() and log_file.stat().st_size > 0:
        try:
            with open(log_file, "rb") as f:
                # Seek to end and read backward to find last newline
                f.seek(0, 2)
                pos = f.tell()
                if pos == 0:
                    return "0"
                # Read last non-empty line
                f.seek(max(0, pos - 4096))
                lines = f.read().decode("utf-8").strip().split("\n")
                last_line = lines[-1] if lines else ""
                if last_line:
                    last_record = json.loads(last_line)
                    return last_record.get("_hmac", "0")
        except (json.JSONDecodeError, OSError, KeyError):
            pass
    return "0"


def _compute_hmac(record_json: str, prev_hash: str) -> str:
    """Compute HMAC-SHA256 over (previous_hash + record_json) for tamper-evident chaining."""
    msg = f"{prev_hash}|{record_json}".encode()
    return hmac.new(_HMAC_KEY, msg, hashlib.sha256).hexdigest()


def _write_to_disk(
    event_type: str,
    description: str,
    run_id: Optional[str],
    user_id: Optional[str],
    metadata: Optional[dict],
    ts: datetime,
    redact_amounts: bool = False,
    redact_tan: bool = False,
) -> None:
    """Append an HMAC-chained JSON line to the daily audit log file."""
    date_str = ts.strftime("%Y-%m-%d")
    log_file = _audit_dir / f"audit_{date_str}.jsonl"

    # Phase 6G: optionally redact financial amounts
    if redact_amounts:
        description = _redact_amounts(description)
    # Phase 7F: optionally redact TAN numbers (ABCD12345X → ABCD*****X)
    if redact_tan:
        description = _redact_tans(description)

    record = {
        "ts": ts.isoformat(),
        "event_type": event_type,
        "description": description,
        "run_id": run_id,
        "user_id": user_id,
        "metadata": metadata or {},
    }

    # Chain HMAC from previous line's hash
    prev_hash = _get_last_hash(log_file)
    record_json = json.dumps(record, default=str, sort_keys=True)
    record["_prev_hash"] = prev_hash
    record["_hmac"] = _compute_hmac(record_json, prev_hash)

    try:
        # Open with restricted permissions (owner read+write, group read, no world access)
        fd = os.open(str(log_file), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, default=str, sort_keys=True) + "\n")
        # Update in-memory cache
        _last_hash_cache[str(log_file)] = record["_hmac"]
    except OSError as e:
        logger.error("audit_disk_write_failed", error=str(e))


def verify_audit_chain(log_file_path: str) -> dict:
    """
    Verify the HMAC chain integrity of a JSONL audit log file.

    Returns:
        {"valid": bool, "total_lines": int, "broken_at": int|None, "error": str|None}
    """
    log_file = Path(log_file_path)
    if not log_file.exists():
        return {"valid": False, "total_lines": 0, "broken_at": None, "error": "File not found"}

    prev_hash = "0"
    line_num = 0
    try:
        with open(log_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                line_num += 1
                record = json.loads(line)

                stored_hmac = record.pop("_hmac", "")
                stored_prev = record.pop("_prev_hash", "")

                if stored_prev != prev_hash:
                    return {"valid": False, "total_lines": line_num, "broken_at": line_num,
                            "error": f"Chain break: expected prev_hash={prev_hash[:16]}..., got {stored_prev[:16]}..."}

                record_json = json.dumps(record, default=str, sort_keys=True)
                expected_hmac = _compute_hmac(record_json, prev_hash)

                if not hmac.compare_digest(stored_hmac, expected_hmac):
                    return {"valid": False, "total_lines": line_num, "broken_at": line_num,
                            "error": f"HMAC mismatch at line {line_num}: record may have been tampered"}

                prev_hash = stored_hmac
    except (json.JSONDecodeError, OSError) as e:
        return {"valid": False, "total_lines": line_num, "broken_at": line_num,
                "error": f"Parse error at line {line_num}: {e}"}

    return {"valid": True, "total_lines": line_num, "broken_at": None, "error": None}


def log_sync(
    event_type: str,
    description: str,
    run_id: Optional[str] = None,
    user_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Synchronous disk-only audit log (for use in engine code without async context)."""
    now = datetime.now(timezone.utc)
    _write_to_disk(event_type, description, run_id, user_id, metadata, now)
    logger.info(event_type, description=description, run_id=run_id, **({} if metadata is None else metadata))


# ── Phase 6G: Audit log retention ─────────────────────────────────────────

import re
from datetime import timedelta


def purge_old_audit_logs(retention_days: int = 1095) -> dict:
    """
    Delete JSONL audit log files older than retention_days.
    Returns summary: {"deleted": int, "kept": int, "errors": list}.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    cutoff_str = cutoff.strftime("%Y-%m-%d")
    deleted, kept, errors = 0, 0, []
    date_pattern = re.compile(r"audit_(\d{4}-\d{2}-\d{2})\.jsonl")
    for f in _audit_dir.iterdir():
        m = date_pattern.match(f.name)
        if not m:
            continue
        file_date = m.group(1)
        if file_date < cutoff_str:
            try:
                f.unlink()
                deleted += 1
            except OSError as e:
                errors.append(f"{f.name}: {e}")
        else:
            kept += 1
    return {"deleted": deleted, "kept": kept, "errors": errors}


async def purge_old_db_audit_logs(db: AsyncSession, retention_days: int = 1095) -> int:
    """
    Delete AuditLog DB rows older than retention_days.
    Returns count of deleted rows.
    """
    from db.models import AuditLog
    from sqlalchemy import delete

    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    result = await db.execute(
        delete(AuditLog).where(AuditLog.created_at < cutoff)
    )
    return result.rowcount or 0


_AMOUNT_PATTERN = re.compile(r"₹[\d,]+\.?\d*")


def _redact_amounts(text: str) -> str:
    """Replace financial amounts (₹1,234.56) with ₹[REDACTED]."""
    return _AMOUNT_PATTERN.sub("₹[REDACTED]", text)


_TAN_PATTERN = re.compile(r"\b([A-Z]{4})[A-Z0-9]{5}([A-Z])\b")


def _redact_tans(text: str) -> str:
    """Mask TAN numbers: ABCD12345X → ABCD*****X."""
    return _TAN_PATTERN.sub(r"\1*****\2", text)
