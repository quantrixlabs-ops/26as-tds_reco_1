"""
Batch scheduling service — in-memory scheduler for batch reruns.
Uses asyncio tasks to wait until the scheduled time, then triggers the rerun.
For production, replace with Celery beat or APScheduler.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# In-memory schedule store: batch_id → schedule info
_schedules: Dict[str, dict] = {}
# Active asyncio tasks for scheduled reruns
_schedule_tasks: Dict[str, asyncio.Task] = {}


def get_schedule(batch_id: str) -> Optional[dict]:
    """Get the current schedule for a batch."""
    return _schedules.get(batch_id)


def list_schedules() -> list[dict]:
    """List all active schedules."""
    return list(_schedules.values())


def cancel_schedule(batch_id: str) -> bool:
    """Cancel a pending scheduled rerun."""
    if batch_id in _schedule_tasks:
        _schedule_tasks[batch_id].cancel()
        del _schedule_tasks[batch_id]
    if batch_id in _schedules:
        _schedules[batch_id]["status"] = "cancelled"
        del _schedules[batch_id]
        return True
    return False


async def schedule_batch_rerun(
    batch_id: str,
    scheduled_at: datetime,
    user_id: str,
    rerun_callback,
) -> dict:
    """
    Schedule a batch rerun at the specified time.

    Args:
        batch_id: The batch to rerun
        scheduled_at: When to trigger the rerun (UTC)
        user_id: Who scheduled it
        rerun_callback: Async function(batch_id, user_id) that performs the actual rerun

    Returns:
        Schedule info dict.
    """
    # Cancel any existing schedule for this batch
    cancel_schedule(batch_id)

    now = datetime.now(timezone.utc)
    delay_seconds = max(0, (scheduled_at - now).total_seconds())

    schedule_info = {
        "batch_id": batch_id,
        "scheduled_at": scheduled_at.isoformat(),
        "scheduled_by": user_id,
        "created_at": now.isoformat(),
        "delay_seconds": round(delay_seconds),
        "status": "pending",
    }
    _schedules[batch_id] = schedule_info

    # Create the delayed task
    task = asyncio.create_task(
        _wait_and_rerun(batch_id, delay_seconds, user_id, rerun_callback)
    )
    _schedule_tasks[batch_id] = task

    logger.info(f"Batch {batch_id} scheduled for rerun at {scheduled_at.isoformat()} (in {delay_seconds:.0f}s)")
    return schedule_info


async def _wait_and_rerun(
    batch_id: str,
    delay_seconds: float,
    user_id: str,
    rerun_callback,
) -> None:
    """Wait for the scheduled time, then trigger the rerun."""
    try:
        await asyncio.sleep(delay_seconds)

        if batch_id not in _schedules:
            return  # was cancelled

        _schedules[batch_id]["status"] = "executing"
        logger.info(f"Executing scheduled rerun for batch {batch_id}")

        await rerun_callback(batch_id, user_id)

        _schedules[batch_id]["status"] = "completed"
        logger.info(f"Scheduled rerun completed for batch {batch_id}")

    except asyncio.CancelledError:
        logger.info(f"Scheduled rerun cancelled for batch {batch_id}")
    except Exception as e:
        logger.error(f"Scheduled rerun failed for batch {batch_id}: {e}")
        if batch_id in _schedules:
            _schedules[batch_id]["status"] = "failed"
            _schedules[batch_id]["error"] = str(e)[:500]
    finally:
        _schedule_tasks.pop(batch_id, None)
