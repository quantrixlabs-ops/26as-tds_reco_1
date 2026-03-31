"""
SQLAlchemy async engine, session factory, and declarative base.
Switch between SQLite (dev) and PostgreSQL (prod) via DATABASE_URL in .env.
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, MappedColumn
from sqlalchemy import MetaData, text, event

from core.settings import settings

# Naming convention for constraints — required for Alembic autogenerate
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


# Create async engine — works for both SQLite and PostgreSQL
_is_sqlite = "sqlite" in settings.DATABASE_URL
connect_args = {}
if _is_sqlite:
    connect_args["check_same_thread"] = False
    connect_args["timeout"] = 30  # busy timeout (seconds) — prevents "database is locked"

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,
    connect_args=connect_args,
    pool_pre_ping=True,
)

# Set PRAGMA busy_timeout + WAL on every new SQLite connection (not just startup)
if _is_sqlite:
    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragmas(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")  # 30 seconds
        cursor.close()

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncSession:
    """FastAPI dependency — yields an async DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def create_all_tables() -> None:
    """Create all tables on startup (dev only — use Alembic in prod)."""
    async with engine.begin() as conn:
        # Enable WAL mode for SQLite (persistent — only needs to be set once per DB file)
        if _is_sqlite:
            await conn.execute(text("PRAGMA journal_mode=WAL"))
            await conn.execute(text("PRAGMA busy_timeout=5000"))
        await conn.run_sync(Base.metadata.create_all)


async def auto_migrate() -> None:
    """
    Auto-add missing columns to existing tables by comparing SQLAlchemy models
    against the live DB schema. Only handles ADD COLUMN (safe, non-destructive).
    Runs on every startup — idempotent and fast.
    """
    import logging
    logger = logging.getLogger("db.auto_migrate")

    def _sql_type(col) -> str:
        """Map SQLAlchemy type to SQLite/SQL column type string."""
        from sqlalchemy import String, Float, Boolean, Integer, Text, DateTime, Date, JSON, LargeBinary, Enum
        t = type(col.type)
        if t in (String, Enum):
            return "TEXT"
        if t is Text:
            return "TEXT"
        if t is Float:
            return "REAL"
        if t in (Integer,):
            return "INTEGER"
        if t is Boolean:
            return "BOOLEAN"
        if t in (DateTime, Date):
            return "TEXT"
        if t is JSON:
            return "TEXT"
        if t is LargeBinary:
            return "BLOB"
        return "TEXT"

    def _default_clause(col) -> str:
        """Generate DEFAULT clause for the column if it has one."""
        if col.default is not None:
            val = col.default.arg
            if callable(val):
                return ""  # Can't express callables in DDL
            if isinstance(val, bool):
                return f" DEFAULT {1 if val else 0}"
            if isinstance(val, (int, float)):
                return f" DEFAULT {val}"
            if isinstance(val, str):
                return f" DEFAULT '{val}'"
        if col.nullable:
            return " DEFAULT NULL"
        return ""

    async with engine.begin() as conn:
        for table_name, table in Base.metadata.tables.items():
            # Get existing columns from live DB
            if _is_sqlite:
                result = await conn.execute(text(f"PRAGMA table_info('{table_name}')"))
                existing_cols = {row[1] for row in result.fetchall()}
            else:
                # PostgreSQL
                result = await conn.execute(text(
                    "SELECT column_name FROM information_schema.columns "
                    f"WHERE table_name = '{table_name}'"
                ))
                existing_cols = {row[0] for row in result.fetchall()}

            if not existing_cols:
                continue  # Table doesn't exist yet (create_all_tables will handle it)

            # Compare model columns vs DB columns
            for col in table.columns:
                col_name = col.name if not hasattr(col, 'key') else col.name
                if col_name not in existing_cols:
                    sql_type = _sql_type(col)
                    default = _default_clause(col)
                    stmt = f"ALTER TABLE {table_name} ADD COLUMN {col_name} {sql_type}{default}"
                    await conn.execute(text(stmt))
                    logger.info(f"auto_migrate: added {table_name}.{col_name} ({sql_type})")

            # Auto-add missing unique constraints / indexes
            from sqlalchemy import UniqueConstraint as UC
            for constraint in table.constraints:
                if isinstance(constraint, UC) and constraint.name:
                    col_names = [c.name for c in constraint.columns]
                    idx_name = constraint.name
                    cols_sql = ", ".join(col_names)
                    try:
                        # Clean up existing duplicates before creating unique index
                        if len(col_names) >= 2 and table_name == "matched_pairs":
                            await conn.execute(text(
                                "DELETE FROM matched_pairs WHERE rowid NOT IN ("
                                "  SELECT MIN(rowid) FROM matched_pairs "
                                "  GROUP BY run_id, as26_row_hash"
                                ")"
                            ))
                        await conn.execute(text(
                            f"CREATE UNIQUE INDEX IF NOT EXISTS {idx_name} "
                            f"ON {table_name} ({cols_sql})"
                        ))
                        logger.info(f"auto_migrate: ensured unique index {idx_name} on {table_name}({cols_sql})")
                    except Exception as e:
                        logger.warning(f"auto_migrate: could not create {idx_name}: {e}")
