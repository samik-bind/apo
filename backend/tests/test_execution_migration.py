# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""SPEC-143: execution control-plane schema migration (v13).

Mirrors the hand-rolled old-schema SQLite pattern: build a pre-v13 schema by
hand, run the migration, assert the post-shape. Idempotent, no backfill, no I/O.
"""

from __future__ import annotations

from apo.db import _SCHEMA_MIGRATIONS, _migrate_execution_schema
from sqlmodel import create_engine


def test_v13_migration_is_registered() -> None:
    """v13 (execution control plane) is registered. Later specs bump LATEST."""
    assert 13 in _SCHEMA_MIGRATIONS


def test_v13_migration_is_registered() -> None:
    assert 13 in _SCHEMA_MIGRATIONS


def test_migration_creates_execution_tables_and_columns() -> None:
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v13_tables(conn)
        _migrate_execution_schema(conn)

        tables = _table_names(conn)
        for expected in (
            "executor_pools",
            "executors",
            "executor_enrollment_tokens",
            "task_execution_attempts",
        ):
            assert expected in tables, f"missing table {expected!r}"

        pool_cols = _column_names(conn, "executor_pools")
        for c in (
            "id", "project", "name", "slug", "kind", "enabled", "archived_at",
            "queue_ttl_seconds", "required_driver_kind", "created_by_user_id",
            "created_at", "updated_at",
        ):
            assert c in pool_cols, f"executor_pools missing {c!r}"
        assert "uq_executor_pool_project_slug" in _index_names(conn, "executor_pools")

        ex_cols = _column_names(conn, "executors")
        for c in (
            "id", "scope_kind", "project", "executor_pool_id", "name", "enabled",
            "credential_prefix", "credential_hash", "protocol_version",
            "executor_version", "driver_kinds_json", "capabilities_json",
            "max_concurrency", "last_seen_at", "enrolled_at", "revoked_at",
            "created_at", "updated_at",
        ):
            assert c in ex_cols, f"executors missing {c!r}"

        att_cols = _column_names(conn, "task_execution_attempts")
        for c in (
            "id", "project", "batch_run_id", "task_run_id", "task_revision_id",
            "sequence_index", "target_kind", "executor_pool_id", "executor_id",
            "status", "phase", "lease_generation", "lease_expires_at",
            "queue_expires_at", "queued_at", "claimed_at", "started_at",
            "heartbeat_at", "completed_at", "cancel_requested_at", "driver_kind",
            "executor_snapshot_json", "completion_id", "completion_sha256",
            "exit_code", "failure_kind", "error_message", "stdout_tail",
            "stderr_tail", "created_at", "updated_at",
        ):
            assert c in att_cols, f"task_execution_attempts missing {c!r}"
        assert "uq_task_execution_attempt_run" in _index_names(conn, "task_execution_attempts")
        assert "ix_task_attempt_claim" in _index_names(conn, "task_execution_attempts")
        assert "ix_task_attempt_lease" in _index_names(conn, "task_execution_attempts")

        # Column additions to existing tables.
        batch_cols = _column_names(conn, "agent_task_batch_runs")
        assert "execution_target_json" in batch_cols
        assert "cancelled_tasks" in batch_cols
        assert "sequence_index" in _column_names(conn, "agent_task_runs")
        assert "default_executor_pool_id" in _column_names(conn, "projects")


def test_migration_is_idempotent() -> None:
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v13_tables(conn)
        _migrate_execution_schema(conn)
        _migrate_execution_schema(conn)
        assert "task_execution_attempts" in _table_names(conn)


def _create_pre_v13_tables(conn) -> None:
    conn.exec_driver_sql("CREATE TABLE IF NOT EXISTS projects (id VARCHAR PRIMARY KEY)")
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS agent_task_batch_runs (id VARCHAR PRIMARY KEY)"
    )
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS agent_task_runs (id VARCHAR PRIMARY KEY)"
    )
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS task_revisions (id VARCHAR PRIMARY KEY)"
    )
    conn.exec_driver_sql("CREATE TABLE IF NOT EXISTS users (id VARCHAR PRIMARY KEY)")


def _table_names(conn) -> set[str]:
    rows = conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").all()
    return {r[0] for r in rows}


def _column_names(conn, table: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").all()
    return {r[1] for r in rows}


def _index_names(conn, table: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA index_list({table})").all()
    return {r[1] for r in rows}
