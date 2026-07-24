# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""SPEC-140 ticket 01: agent_task_deliverables schema migration (v11).

Mirrors the hand-rolled old-schema SQLite pattern in
``test_cost_migration.py``: build the OLD schema by hand, run the migration,
assert the post-shape. The migration must be idempotent, perform no body
backfill, and do no external I/O.
"""

from __future__ import annotations

from apo.db import _migrate_deliverable_schema
from sqlalchemy import text
from sqlmodel import create_engine


def test_v11_migration_is_registered() -> None:
    """v11 (deliverables) is registered. Later specs bump LATEST_SCHEMA_VERSION."""
    from apo.db import _SCHEMA_MIGRATIONS

    assert 11 in _SCHEMA_MIGRATIONS


def test_migration_creates_deliverables_table_on_pre_v11_schema() -> None:
    """The v11 migration creates agent_task_deliverables with the full shape."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v11_tables(conn)

        _migrate_deliverable_schema(conn)

        tables = _table_names(conn)
        assert "agent_task_deliverables" in tables

        cols = _column_names(conn, "agent_task_deliverables")
        for expected in (
            "id",
            "project",
            "task_run_id",
            "name",
            "kind",
            "status",
            "storage_backend",
            "storage_key",
            "inline_value_json",
            "display_filename",
            "media_type",
            "content_encoding",
            "size_bytes",
            "stored_size_bytes",
            "sha256",
            "error_message",
            "created_at",
            "ready_at",
        ):
            assert expected in cols, f"missing column {expected!r}"

        # project and task_run_id are indexed for scoped lookups.
        assert _has_index(conn, "agent_task_deliverables", "project")
        assert _has_index(conn, "agent_task_deliverables", "task_run_id")
        # unique name-per-task-run constraint is registered.
        assert _has_unique_index(
            conn, "agent_task_deliverables", "project, task_run_id, name"
        )


def test_migration_does_not_touch_legacy_columns() -> None:
    """v11 never drops or rewrites transcript_json / deliverables_json."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v11_tables(conn)

        _migrate_deliverable_schema(conn)

        runs_cols = _column_names(conn, "agent_task_runs")
        assert "transcript_json" in runs_cols
        assert "deliverables_json" in runs_cols
        assert "checks_json" in runs_cols


def test_migration_is_idempotent() -> None:
    """Re-running the migration on an already-migrated schema is a safe no-op."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v11_tables(conn)
        _migrate_deliverable_schema(conn)

    with test_engine.begin() as conn:
        _migrate_deliverable_schema(conn)
        assert "agent_task_deliverables" in _table_names(conn)
        assert _has_unique_index(
            conn, "agent_task_deliverables", "project, task_run_id, name"
        )


def test_migration_creates_table_if_not_exists_for_upgrade_safety() -> None:
    """Even if the table already exists partially, migration must not fail."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v11_tables(conn)
        # Pre-create the table (simulating a partially-migrated DB).
        conn.exec_driver_sql(
            """
            CREATE TABLE IF NOT EXISTS agent_task_deliverables (
                id VARCHAR PRIMARY KEY,
                project VARCHAR NOT NULL,
                task_run_id VARCHAR NOT NULL,
                name VARCHAR NOT NULL
            )
            """
        )

        _migrate_deliverable_schema(conn)
        cols = _column_names(conn, "agent_task_deliverables")
        # The migration must bring the table up to the full shape.
        assert "storage_backend" in cols
        assert "sha256" in cols
        assert "inline_value_json" in cols


def test_migration_performs_no_backfill() -> None:
    """The migration never copies deliverables_json bodies into new rows."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v11_tables(conn)
        conn.execute(
            text(
                "INSERT INTO agent_task_runs "
                "(id, batch_run_id, task_id, task_path, status, deliverables_json) "
                "VALUES ('run-1', 'batch-1', 't', 'p', 'completed', :body)"
            ).bindparams(body='{"verdict":{"reward":1}}')
        )

        _migrate_deliverable_schema(conn)

        rows = conn.execute(
            text("SELECT COUNT(*) FROM agent_task_deliverables")
        ).scalar_one()
        assert rows == 0  # no automatic backfill


def test_fresh_create_all_matches_migrated_shape() -> None:
    """SQLModel fresh create_all and the v11 migration agree on table shape."""
    from sqlmodel import SQLModel

    import apo.models.db as models_db  # noqa: F401 - registers models

    assert models_db is not None

    fresh_engine = create_engine("sqlite://")
    with fresh_engine.begin() as conn:
        SQLModel.metadata.create_all(conn)
        fresh_cols = _column_names(conn, "agent_task_deliverables")
        fresh_has_table = "agent_task_deliverables" in _table_names(conn)

    migrated_engine = create_engine("sqlite://")
    with migrated_engine.begin() as conn:
        _create_pre_v11_tables(conn)
        _migrate_deliverable_schema(conn)
        migrated_cols = _column_names(conn, "agent_task_deliverables")

    assert fresh_has_table
    # The migrated shape must be at least as rich as the fresh shape so an
    # upgraded database can serve the same model.
    assert fresh_cols <= migrated_cols


# --- helpers (mirror test_cost_migration.py) ---------------------------------


def _create_pre_v11_tables(conn) -> None:
    conn.exec_driver_sql(
        """
        CREATE TABLE agent_task_batch_runs (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            selection_type VARCHAR NOT NULL,
            environment VARCHAR NOT NULL DEFAULT 'default',
            status VARCHAR NOT NULL,
            total_tasks INTEGER NOT NULL DEFAULT 0,
            passed_tasks INTEGER NOT NULL DEFAULT 0,
            failed_tasks INTEGER NOT NULL DEFAULT 0,
            errored_tasks INTEGER NOT NULL DEFAULT 0,
            total_checks INTEGER NOT NULL DEFAULT 0,
            passed_checks INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.exec_driver_sql(
        """
        CREATE TABLE agent_task_runs (
            id VARCHAR PRIMARY KEY,
            batch_run_id VARCHAR NOT NULL,
            task_id VARCHAR NOT NULL,
            task_path VARCHAR NOT NULL,
            status VARCHAR NOT NULL,
            checks_json JSON,
            transcript_json JSON,
            deliverables_json JSON
        )
        """
    )


def _table_names(conn) -> set[str]:
    rows = conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {str(r[0]) for r in rows}


def _column_names(conn, table_name: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
    return {str(r[1]) for r in rows}


def _index_names(conn, table_name: str) -> set[str]:
    rows = conn.exec_driver_sql(
        f"PRAGMA index_list('{table_name}')"
    ).fetchall()
    return {str(r[1]) for r in rows}


def _has_index(conn, table_name: str, column: str) -> bool:
    """True when any index on the table covers the given column."""
    for name in _index_names(conn, table_name):
        cols = conn.exec_driver_sql(f"PRAGMA index_info('{name}')").fetchall()
        covered = {str(c[2]) for c in cols}
        if column in covered:
            return True
    return False


def _has_unique_index(conn, table_name: str, columns_csv: str) -> bool:
    """True when a UNIQUE index covers exactly the given columns (in order)."""
    wanted = {c.strip() for c in columns_csv.split(",")}
    for name in _index_names(conn, table_name):
        info = conn.exec_driver_sql(f"PRAGMA index_info('{name}')").fetchall()
        is_unique = conn.exec_driver_sql(
            f"PRAGMA index_list('{table_name}')"
        ).fetchall()
        unique_flag = {str(r[1]): bool(r[2]) for r in is_unique}
        if not unique_flag.get(name):
            continue
        covered = {str(c[2]) for c in info}
        if covered == wanted:
            return True
    return False
