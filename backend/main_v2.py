"""
26AS Matcher — Enterprise API v2.0
FastAPI application with full auth, audit, and persistence.
"""
from __future__ import annotations

import structlog
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware

from core.settings import settings
from db.base import create_all_tables, auto_migrate

# Configure structured logging
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.stdlib.add_log_level,
        structlog.dev.ConsoleRenderer() if settings.DEBUG else structlog.processors.JSONRenderer(),
    ]
)

logger = structlog.get_logger(__name__)


_DEFAULT_SECRET = "CHANGE-ME-IN-PRODUCTION-use-openssl-rand-hex-32"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    # Block startup with default SECRET_KEY in non-dev environments
    if settings.SECRET_KEY == _DEFAULT_SECRET and settings.ENVIRONMENT != "development":
        raise RuntimeError(
            "SECRET_KEY is still the default! Set a secure key in .env: "
            "SECRET_KEY=$(openssl rand -hex 32)"
        )
    if settings.SECRET_KEY == _DEFAULT_SECRET:
        logger.warning(
            "⚠ Using default SECRET_KEY — acceptable for local dev only. "
            "Set SECRET_KEY in .env before deploying."
        )
    logger.info("startup", version=settings.APP_VERSION, env=settings.ENVIRONMENT)
    await create_all_tables()
    await auto_migrate()
    logger.info("database_ready")

    # Clean up orphaned PROCESSING runs from previous server crashes/restarts.
    # Background asyncio tasks are killed when uvicorn reloads, leaving DB rows stuck.
    from db.base import AsyncSessionLocal
    from sqlalchemy import text as sql_text, select, func
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            sql_text("UPDATE reconciliation_runs SET status='FAILED' WHERE status='PROCESSING'")
        )
        if result.rowcount > 0:
            logger.warning("orphaned_runs_cleaned", count=result.rowcount)

        # One-time recount: fix any stale matched_count / match_rate_pct from prior bugs.
        # This replaces per-request self-healing — runs once on startup, fast and done.
        from db.models import ReconciliationRun, MatchedPair
        recount_result = await session.execute(
            select(
                MatchedPair.run_id,
                func.count(func.distinct(MatchedPair.as26_row_hash)),
            ).group_by(MatchedPair.run_id)
        )
        actual_counts = {row[0]: row[1] for row in recount_result.all()}
        if actual_counts:
            runs_result = await session.execute(
                select(ReconciliationRun).where(
                    ReconciliationRun.id.in_(list(actual_counts.keys()))
                )
            )
            fixed = 0
            for run in runs_result.scalars().all():
                actual = actual_counts.get(run.id, 0)
                if actual != (run.matched_count or 0):
                    run.matched_count = actual
                    if run.total_26as_entries and run.total_26as_entries > 0:
                        run.match_rate_pct = (actual / run.total_26as_entries) * 100
                    fixed += 1
            if fixed:
                logger.info("recount_healed", runs_fixed=fixed)

        await session.commit()

    yield
    logger.info("shutdown")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description=(
        "Enterprise TDS Reconciliation Platform — "
        "Audit-compliant, deterministic, reproducible."
    ),
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# ── Middleware ────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────

from api.routes.auth import router as auth_router
from api.routes.runs import router as runs_router
from api.routes.settings import router as settings_router

app.include_router(auth_router)
app.include_router(runs_router)
app.include_router(settings_router)


# ── Health + Meta ─────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "version": settings.APP_VERSION,
        "algorithm_version": settings.ALGORITHM_VERSION,
        "environment": settings.ENVIRONMENT,
    }


@app.get("/api/financial-years")
async def financial_years():
    from config import SUPPORTED_FINANCIAL_YEARS, DEFAULT_FINANCIAL_YEAR
    return {"years": SUPPORTED_FINANCIAL_YEARS, "default": DEFAULT_FINANCIAL_YEAR}
