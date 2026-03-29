"""
Enterprise settings — all config via environment variables.
Copy .env.example → .env and fill in values.
"""
from __future__ import annotations
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── App ──────────────────────────────────────────────────────────────────
    APP_NAME: str = "26AS Matcher"
    APP_VERSION: str = "2.0.0"
    ALGORITHM_VERSION: str = "v5.3"
    DEBUG: bool = False
    ENVIRONMENT: str = "development"   # development | staging | production

    # ── Database ──────────────────────────────────────────────────────────────
    # SQLite for dev (zero install): sqlite+aiosqlite:///./reco.db
    # PostgreSQL for prod:           postgresql+asyncpg://user:pass@host/db
    DATABASE_URL: str = "sqlite+aiosqlite:///./reco.db"
    DATABASE_SYNC_URL: str = "sqlite:///./reco.db"  # for Alembic migrations

    # ── Security ─────────────────────────────────────────────────────────────
    SECRET_KEY: str = "CHANGE-ME-IN-PRODUCTION-use-openssl-rand-hex-32"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # ── Redis / Celery ────────────────────────────────────────────────────────
    REDIS_URL: str = "redis://localhost:6379/0"
    USE_FAKE_REDIS: bool = True   # True = fakeredis (no Redis install needed)
    CELERY_BROKER: str = "redis://localhost:6379/0"
    CELERY_BACKEND: str = "redis://localhost:6379/1"

    # ── Storage ───────────────────────────────────────────────────────────────
    UPLOAD_DIR: str = "./uploads"
    AUDIT_LOG_DIR: str = "./audit_logs"
    MAX_UPLOAD_MB: int = 50

    # ── Reconciliation engine ─────────────────────────────────────────────────
    SESSION_TTL_SECONDS: int = 1800
    DEFAULT_FINANCIAL_YEAR: str = "FY2023-24"

    # ── CORS ─────────────────────────────────────────────────────────────────
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost:5173"]

    # ── Frontend URL (for email links) ────────────────────────────────────
    FRONTEND_URL: str = "http://localhost:3000"

    # ── Email / SMTP ──────────────────────────────────────────────────────
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_TLS: bool = True
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM_EMAIL: str = "noreply@tds-matcher.com"

    # ── Auth Security ─────────────────────────────────────────────────────
    PASSWORD_RESET_EXPIRE_HOURS: int = 1
    EMAIL_VERIFY_EXPIRE_HOURS: int = 24
    MAX_LOGIN_ATTEMPTS: int = 5
    LOCKOUT_DURATION_MINUTES: int = 15
    ALLOW_SELF_REGISTRATION: bool = True

    # ── Workflow ─────────────────────────────────────────────────────────
    ALLOW_SELF_REVIEW: bool = False   # Maker-checker: run creator cannot approve their own run


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
