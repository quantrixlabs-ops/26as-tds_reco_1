"""
Batch notification service — fires webhooks when batches complete or fail.
Enhanced (Phase 4J): retry logic, HMAC-SHA256 signatures, configurable payload.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import AdminSettings, ReconciliationRun

logger = logging.getLogger(__name__)


async def _get_notification_config(db: AsyncSession) -> dict:
    """Read notification settings from active admin config."""
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    s = result.scalar_one_or_none()
    if not s:
        return {"enabled": False, "url": None, "enhanced": False, "retry_count": 3, "secret": None}
    return {
        "enabled": bool(s.batch_notification_enabled),
        "url": s.batch_notification_webhook_url,
        "enhanced": bool(s.enhanced_webhook_enabled) if s.enhanced_webhook_enabled is not None else False,
        "retry_count": s.webhook_retry_count if s.webhook_retry_count is not None else 3,
        "secret": s.webhook_secret,
    }


async def check_and_notify_batch_complete(
    db: AsyncSession,
    batch_id: str,
    completed_run_id: str,
) -> None:
    """
    Check if all runs in a batch are done (non-PROCESSING).
    If so, build a summary payload and fire the webhook.
    """
    config = await _get_notification_config(db)
    if not config["enabled"] or not config["url"]:
        return

    # Load all runs in this batch
    result = await db.execute(
        select(ReconciliationRun)
        .where(ReconciliationRun.batch_id == batch_id)
        .order_by(ReconciliationRun.run_number)
    )
    runs = list(result.scalars().all())

    # Any still processing? Not done yet
    if any(r.status == "PROCESSING" for r in runs):
        return

    # All runs done — build summary
    completed = [r for r in runs if r.status in ("PENDING_REVIEW", "APPROVED", "REJECTED")]
    failed = [r for r in runs if r.status == "FAILED"]
    total_matched = sum(r.matched_count or 0 for r in runs)
    total_26as = sum(r.total_26as_entries or 0 for r in runs)
    overall_rate = round((total_matched / total_26as * 100), 2) if total_26as > 0 else 0

    payload = {
        "event": "batch_complete",
        "batch_id": batch_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "total_parties": len(runs),
            "completed": len(completed),
            "failed": len(failed),
            "overall_match_rate_pct": overall_rate,
            "total_matched": total_matched,
            "total_26as": total_26as,
        },
        "parties": [
            {
                "run_id": r.id,
                "run_number": r.run_number,
                "deductor_name": r.deductor_name,
                "status": r.status,
                "match_rate_pct": r.match_rate_pct,
                "matched_count": r.matched_count,
                "unmatched_count": r.unmatched_26as_count,
            }
            for r in runs
        ],
    }

    # Fire webhook (enhanced or basic)
    if config["enhanced"]:
        asyncio.create_task(_send_webhook_enhanced(
            config["url"], payload,
            retry_count=config["retry_count"],
            secret=config["secret"],
        ))
    else:
        asyncio.create_task(_send_webhook(config["url"], payload))


async def send_run_webhook(db: AsyncSession, run: ReconciliationRun, event: str = "run_complete") -> None:
    """Send webhook for single-run events (Phase 4J)."""
    config = await _get_notification_config(db)
    if not config["enabled"] or not config["url"]:
        return

    payload = {
        "event": event,
        "run_id": run.id,
        "run_number": run.run_number,
        "deductor_name": run.deductor_name,
        "status": run.status,
        "match_rate_pct": run.match_rate_pct,
        "matched_count": run.matched_count,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if config["enhanced"]:
        asyncio.create_task(_send_webhook_enhanced(
            config["url"], payload,
            retry_count=config["retry_count"],
            secret=config["secret"],
        ))
    else:
        asyncio.create_task(_send_webhook(config["url"], payload))


async def _send_webhook(url: str, payload: dict) -> None:
    """POST the payload to the webhook URL with a timeout (basic mode)."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
            logger.info(
                f"Batch notification sent to {url}: status={resp.status_code}"
            )
    except Exception as e:
        logger.warning(f"Batch notification webhook failed: {e}")


async def _send_webhook_enhanced(
    url: str,
    payload: dict,
    retry_count: int = 3,
    secret: Optional[str] = None,
) -> None:
    """POST with HMAC-SHA256 signature, retry logic, and exponential backoff (Phase 4J)."""
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True)

    headers = {"Content-Type": "application/json"}
    if secret:
        signature = hmac.new(
            secret.encode("utf-8"),
            body.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        headers["X-Webhook-Signature"] = f"sha256={signature}"
        headers["X-Webhook-Timestamp"] = datetime.now(timezone.utc).isoformat()

    attempts = max(retry_count, 1)
    last_error = None

    for attempt in range(attempts):
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(url, content=body, headers=headers)
                if resp.status_code < 400:
                    logger.info(
                        f"Enhanced webhook delivered to {url}: "
                        f"status={resp.status_code}, attempt={attempt + 1}"
                    )
                    return
                last_error = f"HTTP {resp.status_code}"
                logger.warning(
                    f"Webhook attempt {attempt + 1}/{attempts} failed: {last_error}"
                )
        except Exception as e:
            last_error = str(e)
            logger.warning(
                f"Webhook attempt {attempt + 1}/{attempts} error: {last_error}"
            )

        # Exponential backoff: 1s, 2s, 4s, ...
        if attempt < attempts - 1:
            await asyncio.sleep(2 ** attempt)

    logger.error(f"Enhanced webhook exhausted all {attempts} retries for {url}: {last_error}")
