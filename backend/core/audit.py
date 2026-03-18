"""
Audit service — every significant action writes an immutable AuditLog row.
Also writes structured JSON logs to disk (audit_logs/ directory).
"""
from __future__ import annotations

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
Path(settings.AUDIT_LOG_DIR).mkdir(parents=True, exist_ok=True)


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
    2. Disk (JSON lines in audit_logs/{date}.jsonl)
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

    # 2. Disk — append to daily JSONL file
    _write_to_disk(event_type, description, run_id, user_id, metadata, now)

    # 3. Structured log
    logger.info(
        event_type,
        description=description,
        run_id=run_id,
        user_id=user_id,
        **({} if metadata is None else metadata),
    )


def _write_to_disk(
    event_type: str,
    description: str,
    run_id: Optional[str],
    user_id: Optional[str],
    metadata: Optional[dict],
    ts: datetime,
) -> None:
    """Append a JSON line to the daily audit log file."""
    date_str = ts.strftime("%Y-%m-%d")
    log_file = Path(settings.AUDIT_LOG_DIR) / f"audit_{date_str}.jsonl"

    record = {
        "ts": ts.isoformat(),
        "event_type": event_type,
        "description": description,
        "run_id": run_id,
        "user_id": user_id,
        "metadata": metadata or {},
    }

    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, default=str) + "\n")
    except OSError as e:
        logger.error("audit_disk_write_failed", error=str(e))


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
