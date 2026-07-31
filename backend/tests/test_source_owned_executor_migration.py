# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportPrivateUsage=false, reportUnusedCallResult=false, reportMissingTypeArgument=false

"""SPEC-162: v17 source-owned heartbeat observations migration.

Covers fresh install (create_all includes the columns) and upgrade from the
preceding v16 schema. The migration is idempotent, backfills to NULL, and
keeps the digest/slot values out of public Batch/Attempt JSON.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlmodel import SQLModel, create_engine

from apo.db import _migrate_executor_heartbeat_observations
from apo.models import db as models_db  # noqa: F401 - registers models


def test_fresh_create_all_has_heartbeat_columns() -> None:
    """SQLModel fresh create_all includes the new executor columns."""
    assert models_db is not None
    fresh_engine = create_engine("sqlite://")
    with fresh_engine.begin() as conn:
        SQLModel.metadata.create_all(conn)
        cols = _column_names(conn, "executors")

    assert "reported_catalog_digest" in cols
    assert "reported_available_slots" in cols


def test_migration_adds_columns_on_pre_v17_schema() -> None:
    """The v17 migration adds the observation columns to an existing schema."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v17_executors(conn)
        # No observation columns yet.
        pre_cols = _column_names(conn, "executors")
        assert "reported_catalog_digest" not in pre_cols
        assert "reported_available_slots" not in pre_cols

        _migrate_executor_heartbeat_observations(conn)

        post_cols = _column_names(conn, "executors")
        assert "reported_catalog_digest" in post_cols
        assert "reported_available_slots" in post_cols


def test_migration_backfills_existing_rows_to_null() -> None:
    """Existing Executors keep readable; observations default to NULL."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v17_executors(conn)
        conn.execute(
            text(
                "INSERT INTO executors "
                "(id, scope_kind, name, credential_prefix, credential_hash, "
                "protocol_version, executor_version, max_concurrency) "
                "VALUES ('ex-1', 'pool', 'old', 'apo_ex_ab', 'h', 1, '0.0.1', 4)"
            )
        )

        _migrate_executor_heartbeat_observations(conn)

        row = conn.execute(
            text(
                "SELECT reported_catalog_digest, reported_available_slots "
                "FROM executors WHERE id = 'ex-1'"
            )
        ).one()
        assert row[0] is None
        assert row[1] is None


def test_migration_is_idempotent() -> None:
    """Re-running the migration on a migrated schema is a safe no-op."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v17_executors(conn)
        _migrate_executor_heartbeat_observations(conn)

    with test_engine.begin() as conn:
        _migrate_executor_heartbeat_observations(conn)
        cols = _column_names(conn, "executors")
        assert "reported_catalog_digest" in cols
        assert "reported_available_slots" in cols


# --- helpers ----------------------------------------------------------------


def _create_pre_v17_executors(conn) -> None:
    conn.exec_driver_sql(
        """
        CREATE TABLE executors (
            id VARCHAR PRIMARY KEY,
            scope_kind VARCHAR NOT NULL,
            project VARCHAR,
            executor_pool_id VARCHAR,
            name VARCHAR NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            credential_prefix VARCHAR NOT NULL,
            credential_hash VARCHAR NOT NULL UNIQUE,
            protocol_version INTEGER NOT NULL,
            executor_version VARCHAR NOT NULL,
            enrolled_by_user_id VARCHAR,
            driver_kinds_json JSON,
            capabilities_json JSON,
            max_concurrency INTEGER NOT NULL DEFAULT 1,
            last_seen_at DATETIME,
            enrolled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            revoked_at DATETIME,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def _column_names(conn, table_name: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
    return {str(r[1]) for r in rows}
