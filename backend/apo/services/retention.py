"""Data retention / size control for the SQLite-backed store.

Two independent mechanisms keep the database from growing without bound:

1. **Time-based retention** (``APO_RETENTION_DAYS``): periodically deletes
   old traces, runs, and agent-task outputs older than the configured
   window, then ``VACUUM``s to reclaim file space. Driven by parent age so
   that child rows (metrics, call spans) are removed before their parents
   and FK constraints stay satisfied. Bookmarked runs are always kept.

2. **Hard size cap** (``APO_MAX_DB_PAGES``): sets SQLite's
   ``PRAGMA max_page_count``. Once the DB file reaches the cap, further
   writes fail with ``SQLITE_FULL`` rather than growing the file. This is a
   blunt safety valve — retention is the graceful path, the cap is the
   last line of defence.

Both default to off (0) so existing deployments are unaffected until an
operator opts in. Non-SQLite backends ignore the size cap (it is a SQLite
pragma) and simply skip the SQLite-specific optimisations.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, cast

from sqlalchemy import bindparam, text
from sqlalchemy.engine import CursorResult
from sqlmodel import Session, select

from ..db import DATA_DIR, SQLITE_FILE_NAME, engine, _is_sqlite
from ..db_helpers import _as_column
from ..models.db import AgentTaskDeliverableDB
from .artifact_stores.registry import artifact_limits, get_store

logger = logging.getLogger(__name__)

# Age-based retention. 0 = disabled (no automatic deletion).
RETENTION_DAYS = int(os.environ.get("APO_RETENTION_DAYS", "0"))

# Hard ceiling on the DB file size expressed in SQLite pages (4 KiB each
# by default). 0 = unlimited. e.g. 65536 pages ~= 256 MiB. SQLite-only.
MAX_DB_PAGES = int(os.environ.get("APO_MAX_DB_PAGES", "0"))


def _table_exists(session: Session, table_name: str) -> bool:
    if _is_sqlite():
        row = session.execute(
            text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": table_name},
        ).first()
    else:
        row = session.execute(
            text("SELECT 1 FROM information_schema.tables WHERE table_name=:n"),
            {"n": table_name},
        ).first()
    return row is not None


def _delete_old_runs(session: Session, cutoff: datetime) -> int:
    """Delete non-bookmarked runs (and their children) older than ``cutoff``.

    Driven by parent age so children (run_metrics, logged_calls, and the
    call_metrics under those calls) are removed before the parents, keeping
    FK constraints (run_metrics.run_id, call_metrics.call_id) satisfied.
    """
    # Collect the IDs of runs to expire first — children reference these.
    old_run_ids = [
        row[0]
        for row in session.execute(
            text("SELECT id FROM runs WHERE created_at < :c AND bookmarked = 0"),
            {"c": cutoff},
        ).all()
    ]
    if not old_run_ids:
        return 0

    def _exec_in(sql: str, ids: list[str]) -> int:
        # expanding bindparam turns ``IN :ids`` into one bind per value.
        stmt = text(sql).bindparams(bindparam("ids", expanding=True))
        result = cast(CursorResult[Any], session.execute(stmt, {"ids": ids}))
        return result.rowcount or 0

    deleted = 0
    if _table_exists(session, "call_metrics"):
        deleted += _exec_in(
            "DELETE FROM call_metrics WHERE call_id IN "
            "(SELECT id FROM logged_calls WHERE run_id IN :ids)",
            old_run_ids,
        )
    if _table_exists(session, "logged_calls"):
        deleted += _exec_in(
            "DELETE FROM logged_calls WHERE run_id IN :ids", old_run_ids
        )
    if _table_exists(session, "run_metrics"):
        deleted += _exec_in(
            "DELETE FROM run_metrics WHERE run_id IN :ids", old_run_ids
        )
    deleted += _exec_in("DELETE FROM runs WHERE id IN :ids", old_run_ids)
    return deleted


def _old_batch_ids(session: Session, cutoff: datetime) -> list[str]:
    return [
        row[0]
        for row in session.execute(
            text("SELECT id FROM agent_task_batch_runs WHERE created_at < :c"),
            {"c": cutoff},
        ).all()
    ]


def _delete_old_batch_runs(session: Session, cutoff: datetime) -> int:
    """Delete agent-task batch runs (and their task runs) older than cutoff."""
    old_batch_ids = _old_batch_ids(session, cutoff)
    if not old_batch_ids:
        return 0

    def _exec_in(sql: str, ids: list[str]) -> int:
        stmt = text(sql).bindparams(bindparam("ids", expanding=True))
        result = cast(CursorResult[Any], session.execute(stmt, {"ids": ids}))
        return result.rowcount or 0

    deleted = 0
    # SPEC-143: attempts FK task_runs; remove them first.
    if _table_exists(session, "task_execution_attempts"):
        deleted += _exec_in(
            "DELETE FROM task_execution_attempts WHERE task_run_id IN "
            "(SELECT id FROM agent_task_runs WHERE batch_run_id IN :ids)",
            old_batch_ids,
        )
    if _table_exists(session, "agent_task_runs"):
        deleted += _exec_in(
            "DELETE FROM agent_task_runs WHERE batch_run_id IN :ids",
            old_batch_ids,
        )
    # SPEC-142: task_revisions rows go after their bundle objects (removed in
    # run_retention_cleanup). Guarded so pre-v12 databases don't break.
    if _table_exists(session, "task_revisions"):
        deleted += _exec_in(
            "DELETE FROM task_revisions WHERE batch_run_id IN :ids", old_batch_ids
        )
    deleted += _exec_in(
        "DELETE FROM agent_task_batch_runs WHERE id IN :ids", old_batch_ids
    )
    return deleted


async def delete_deliverable_objects_for_runs(
    session: Session,
    run_ids: list[str],
) -> None:
    """Delete external Deliverable objects for the given runs BEFORE their rows.

    SPEC-140 §Retention and deletion: objects are removed idempotently first;
    only after success may the database rows go. A store failure raises so the
    caller retains the rows and retries on the next cleanup — objects are never
    orphaned by deleting the manifest first. Inline JSON rows need no object
    deletion and delete transactionally with the task run.
    """
    if not run_ids:
        return
    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            _as_column(AgentTaskDeliverableDB.task_run_id).in_(run_ids),
            _as_column(AgentTaskDeliverableDB.storage_key).is_not(None),
        )
    ).all()
    # Group by backend so each store is resolved once; reads use the backend
    # recorded on the row so changing the write backend never reinterprets a row.
    by_backend: dict[str, list[AgentTaskDeliverableDB]] = {}
    for row in rows:
        backend = row.storage_backend or "local"
        by_backend.setdefault(backend, []).append(row)

    for backend, group in by_backend.items():
        store = get_store(backend)
        for row in group:
            if row.storage_key is not None:
                await store.delete(row.storage_key)


async def cleanup_expired_artifact_uploads(session: Session) -> dict[str, int]:
    """Fail pending uploads past their TTL and remove their staging bytes.

    A pending upload older than ``APO_ARTIFACT_UPLOAD_TTL_SECONDS`` becomes
    ``failed``; its staging object (if any) is removed idempotently. Ready
    objects are never deleted merely because their Task Run is non-terminal —
    errored runs retain successfully uploaded evidence.
    """
    _, _, ttl_seconds = artifact_limits()
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=ttl_seconds)
    pending = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.status == "pending",
            AgentTaskDeliverableDB.created_at < cutoff,
        )
    ).all()
    if not pending:
        return {"failed_uploads": 0}

    by_backend: dict[str, list[AgentTaskDeliverableDB]] = {}
    for row in pending:
        backend = row.storage_backend or "local"
        by_backend.setdefault(backend, []).append(row)

    failed = 0
    for backend, group in by_backend.items():
        store = get_store(backend)
        for row in group:
            # Remove any partial staging bytes idempotently.
            if row.storage_key is not None:
                try:
                    await store.delete(row.storage_key)
                except Exception:  # noqa: BLE001 - retain row, just mark failed
                    logger.warning(
                        "could not remove staging bytes for expired upload %s",
                        row.id,
                        exc_info=True,
                    )
            row.status = "failed"
            row.error_message = "upload expired before completion"
            session.add(row)
            failed += 1
    return {"failed_uploads": failed}


def run_retention_cleanup() -> dict[str, int]:
    """Delete data older than the retention window and reclaim space.

    Returns a per-table deleted-row summary. Safe to call when retention
    is disabled — it then reports zeros without touching the DB.
    """
    if RETENTION_DAYS <= 0:
        return {"runs": 0, "agent_task_batch_runs": 0, "total": 0}

    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    summary: dict[str, int] = {}
    with Session(engine) as session:
        # SPEC-140: collect the task-run ids whose batch is old, delete their
        # external Deliverable objects first, then drop the rows. A store
        # failure raises here so the rows are retained for the next cleanup.
        old_run_ids = [
            row[0]
            for row in session.execute(
                text(
                    "SELECT agent_task_runs.id FROM agent_task_runs "
                    "JOIN agent_task_batch_runs "
                    "ON agent_task_runs.batch_run_id = agent_task_batch_runs.id "
                    "WHERE agent_task_batch_runs.created_at < :c"
                ),
                {"c": cutoff},
            ).all()
        ]
        if old_run_ids:
            asyncio.run(delete_deliverable_objects_for_runs(session, old_run_ids))
            session.commit()

        # SPEC-142: remove Task Revision bundle objects for old batches BEFORE
        # their rows go. A store failure raises so the rows are retained for the
        # next cleanup — objects are never orphaned by deleting the manifest first.
        old_batch_ids = _old_batch_ids(session, cutoff)
        if old_batch_ids:
            from apo.services.task_revisions import delete_task_revision_bundles_for_batches

            asyncio.run(delete_task_revision_bundles_for_batches(session, old_batch_ids))
            session.commit()

        summary["runs"] = _delete_old_runs(session, cutoff)
        summary["agent_task_batch_runs"] = _delete_old_batch_runs(session, cutoff)
        session.commit()

    summary["total"] = summary["runs"] + summary["agent_task_batch_runs"]

    # VACUUM reclaims file space after deletes. It must run outside a
    # transaction (its own autocommit connection), so we use the raw
    # engine connection. SQLite-only; a no-op elsewhere.
    if summary["total"] > 0 and _is_sqlite():
        with engine.connect() as conn:
            _ = conn.exec_driver_sql("VACUUM")

    logger.info(
        "retention cleanup: removed %s rows older than %s days",
        summary["total"],
        RETENTION_DAYS,
    )
    return summary


def get_db_size_info() -> dict[str, object]:
    """Report the current DB footprint. SQLite-only stats are best-effort."""
    info: dict[str, object] = {"dialect": "sqlite" if _is_sqlite() else "postgres"}
    if not _is_sqlite():
        return info

    sqlite_path = os.path.join(DATA_DIR, SQLITE_FILE_NAME)
    try:
        file_bytes = os.path.getsize(sqlite_path)
    except OSError:
        file_bytes = 0

    with engine.connect() as conn:
        page_size = conn.exec_driver_sql("PRAGMA page_size").scalar() or 0
        page_count = conn.exec_driver_sql("PRAGMA page_count").scalar() or 0
        freelist = conn.exec_driver_sql("PRAGMA freelist_count").scalar() or 0

    info["file_bytes"] = file_bytes
    info["page_size"] = page_size
    info["page_count"] = page_count
    info["freelist_pages"] = freelist
    info["max_page_count"] = MAX_DB_PAGES or None
    return info


def apply_max_page_count() -> None:
    """Apply the hard size ceiling as a SQLite PRAGMA if configured.

    Called once at startup. ``max_page_count`` persists for the connection
    pool, so setting it via the maintenance connection is sufficient.
    """
    if not _is_sqlite() or MAX_DB_PAGES <= 0:
        return
    with engine.connect() as conn:
        _ = conn.exec_driver_sql(f"PRAGMA max_page_count={int(MAX_DB_PAGES)}")
    logger.info("SQLite max_page_count set to %s", MAX_DB_PAGES)


# --- Background loop -------------------------------------------------------

import threading  # noqa: E402

# Daily cleanup cadence. Short enough to keep the DB bounded, long enough
# to avoid overlapping VACUUMs.
_RETENTION_INTERVAL_SECONDS = 24 * 60 * 60

_retention_thread: threading.Thread | None = None
_retention_stop = threading.Event()


def start_retention_loop() -> None:
    """Run retention cleanup once now, then daily, on a daemon thread.

    No-op (does not start a thread) when retention is disabled, so idle
    deployments pay nothing.
    """
    global _retention_thread
    if RETENTION_DAYS <= 0:
        return
    if _retention_thread is not None and _retention_thread.is_alive():
        return

    _retention_stop.clear()

    def _loop() -> None:
        try:
            _ = run_retention_cleanup()
        except Exception:
            logger.exception("Initial retention cleanup failed")
        while not _retention_stop.wait(_RETENTION_INTERVAL_SECONDS):
            try:
                _ = run_retention_cleanup()
            except Exception:
                logger.exception("Retention cleanup failed")

    _retention_thread = threading.Thread(
        target=_loop, name="data-retention", daemon=True
    )
    _retention_thread.start()
    logger.info(
        "data retention loop started (window=%s days)", RETENTION_DAYS
    )


def stop_retention_loop() -> None:
    _retention_stop.set()
