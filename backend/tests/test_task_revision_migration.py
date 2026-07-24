# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""SPEC-142: task_revisions schema migration (v12).

Mirrors the hand-rolled old-schema SQLite pattern in
``test_agent_task_deliverable_migration.py``: build a pre-v12 schema by hand,
run the migration, assert the post-shape. The migration must be idempotent,
perform no body backfill, and do no external I/O.
"""

from __future__ import annotations

from apo.db import LATEST_SCHEMA_VERSION, _SCHEMA_MIGRATIONS, _migrate_task_revision_schema
from sqlmodel import create_engine


def test_latest_schema_version_bumped_to_v12() -> None:
    assert LATEST_SCHEMA_VERSION == 12


def test_v12_migration_is_registered() -> None:
    assert 12 in _SCHEMA_MIGRATIONS


def test_migration_creates_task_revisions_table_on_pre_v12_schema() -> None:
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v12_tables(conn)

        _migrate_task_revision_schema(conn)

        tables = _table_names(conn)
        assert "task_revisions" in tables

        cols = _column_names(conn, "task_revisions")
        for expected in (
            "id",
            "project",
            "batch_run_id",
            "materialization",
            "source_type",
            "source_ref",
            "commit_sha",
            "dirty",
            "content_sha256",
            "file_count",
            "uncompressed_size_bytes",
            "manifest_summary_json",
            "bundle_storage_backend",
            "bundle_storage_key",
            "bundle_sha256",
            "bundle_size_bytes",
            "created_at",
        ):
            assert expected in cols, f"missing column {expected!r}"

        assert "uq_task_revisions_batch_run_id" in _index_names(conn, "task_revisions")
        assert "ix_task_revisions_project" in _index_names(conn, "task_revisions")
        assert "ix_task_revisions_content_sha256" in _index_names(conn, "task_revisions")


def test_migration_is_idempotent() -> None:
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v12_tables(conn)
        _migrate_task_revision_schema(conn)
        # Running again must not raise.
        _migrate_task_revision_schema(conn)
        assert "task_revisions" in _table_names(conn)


# ── helpers (mirror existing migration tests) ─────────────────────────────


def _create_pre_v12_tables(conn) -> None:
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS projects (id VARCHAR PRIMARY KEY)"
    )
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS agent_task_batch_runs (id VARCHAR PRIMARY KEY)"
    )


def _table_names(conn) -> set[str]:
    rows = conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").all()
    return {r[0] for r in rows}


def _column_names(conn, table: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").all()
    return {r[1] for r in rows}


def _index_names(conn, table: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA index_list({table})").all()
    return {r[1] for r in rows}
