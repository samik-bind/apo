"""Data retention / size control for the SQLite-backed store.

Three mechanisms keep the database from growing without bound:

1. **Daily maintenance** (always on): trims raw OTLP ingest payloads past
   their replay window, fails artifact uploads abandoned past their TTL,
   reaps expired credential tokens, and — when retention is configured —
   purges old data. Runs once at startup then every 24 h.

2. **Time-based retention** (``APO_RETENTION_DAYS``, default 0 = off):
   deletes old traces, runs, and agent-task outputs older than the
   configured window, then ``VACUUM``s to reclaim file space. Driven by
   parent age so that child rows (metrics, call spans) are removed before
   their parents and FK constraints stay satisfied. Bookmarked runs are
   always kept.

3. **Hard size cap** (``APO_MAX_DB_PAGES``): sets SQLite's
   ``PRAGMA max_page_count``. Once the DB file reaches the cap, further
   writes fail with ``SQLITE_FULL`` rather than growing the file. This is a
   blunt safety valve — retention is the graceful path, the cap is the
   last line of defence.

Retention defaults to off (0) so existing deployments are unaffected until
an operator opts in; the maintenance tasks are pure hygiene (inbox
payloads, abandoned uploads, dead credentials) and always run. Non-SQLite
backends ignore the size cap (it is a SQLite pragma) and simply skip the
SQLite-specific optimisations.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, cast

# pyright: reportDeprecated=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false

from sqlalchemy import bindparam, text
from sqlalchemy.engine import CursorResult
from sqlmodel import Session, select

from fastapi import HTTPException

from ..db import DATA_DIR, SQLITE_FILE_NAME, engine, is_sqlite
from ..db_helpers import as_column, table_exists
from ..models.db import AgentTaskDeliverableDB
from .artifact_stores.registry import artifact_limits, get_store

logger = logging.getLogger(__name__)

# Age-based retention. 0 = disabled (no automatic deletion).
RETENTION_DAYS = int(os.environ.get("APO_RETENTION_DAYS", "0"))

# Hard ceiling on the DB file size, expressed in SQLite pages (4 KiB each
# by default). 0 = unlimited. e.g. 65536 pages ~= 256 MiB. SQLite-only.
MAX_DB_PAGES = int(os.environ.get("APO_MAX_DB_PAGES", "0"))

# How long raw OTLP ingest payloads (``otlp_ingest_batches.payload``, up to
# 10 MiB per request) stay replayable. The payload is a replay inbox for
# convention changes — after the window it is blanked (the audit row with
# its accepted/rejected counts stays). Read fresh each run so operators can
# change it without a restart, unlike the module-level knobs above.
INGEST_PAYLOAD_RETENTION_DAYS_ENV = "APO_INGEST_RETENTION_DAYS"
DEFAULT_INGEST_PAYLOAD_RETENTION_DAYS = 7


def ingest_payload_retention_days() -> int:
    value = os.environ.get(INGEST_PAYLOAD_RETENTION_DAYS_ENV, "")
    try:
        days = int(value)
    except ValueError:
        days = DEFAULT_INGEST_PAYLOAD_RETENTION_DAYS
    return max(days, 0)


def trim_old_ingest_payloads(session: Session, cutoff: datetime) -> int:
    """Blank raw OTLP ingest payloads older than ``cutoff``.

    ``otlp_ingest_batches`` rows are the durable inbox for replaying
    received telemetry after convention changes; the payload Text is by far
    the largest column in the database (a permanent second copy of every
    trace). Past the replay window the payload is blanked in place — the
    row keeps its received/accepted/rejected audit counts, matching the
    ``payload=""`` convention failed batches already use. 0-day window
    disables trimming (nothing is ever blanked).
    """
    if not table_exists(session, "otlp_ingest_batches"):
        return 0
    result = cast(
        CursorResult[Any],
        session.execute(
            text(
                "UPDATE otlp_ingest_batches SET payload = '' "
                "WHERE received_at < :c AND payload != ''"
            ),
            {"c": cutoff},
        ),
    )
    return result.rowcount or 0


def delete_orphaned_spans(session: Session, cutoff: datetime) -> int:
    """Delete OTLP spans older than ``cutoff`` whose trace is gone.

    Spans belong to the canonical store (``otlp_spans``); the trace
    projection (``runs``) is what retention expires. This sweep runs after
    the projection delete and removes spans that no surviving ``runs`` row
    claims in the same project — so spans of purged traces die with them,
    while spans of bookmarked (surviving) traces stay. It also clears
    orphans left by older deletions that predate span cleanup.
    """
    if not table_exists(session, "otlp_spans"):
        return 0
    result = cast(
        CursorResult[Any],
        session.execute(
            text(
                "DELETE FROM otlp_spans WHERE created_at < :c AND NOT EXISTS ("
                "SELECT 1 FROM runs WHERE runs.project = otlp_spans.project_id "
                "AND runs.id = otlp_spans.trace_id)"
            ),
            {"c": cutoff},
        ),
    )
    return result.rowcount or 0


def reap_expired_credentials(session: Session) -> int:
    """Delete credential tokens past their expiry.

    Verification/reset/enrollment tokens are unusable after ``expires_at``
    whether or not they were consumed; the rows are pure dead weight.
    Invitations are deliberately NOT reaped — they carry invite history.
    """
    deleted = 0
    now = datetime.now(timezone.utc)
    for table in (
        "email_verification_tokens",
        "password_reset_tokens",
        "executor_enrollment_tokens",
    ):
        if not table_exists(session, table):
            continue
        result = cast(
            CursorResult[Any],
            session.execute(
                text(f"DELETE FROM {table} WHERE expires_at < :n"),  # noqa: S608
                {"n": now},
            ),
        )
        deleted += result.rowcount or 0
    return deleted


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
    if table_exists(session, "call_metrics"):
        deleted += _exec_in(
            "DELETE FROM call_metrics WHERE call_id IN "
            "(SELECT id FROM logged_calls WHERE run_id IN :ids)",
            old_run_ids,
        )
    if table_exists(session, "logged_calls"):
        deleted += _exec_in(
            "DELETE FROM logged_calls WHERE run_id IN :ids", old_run_ids
        )
    if table_exists(session, "run_metrics"):
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


def _exec_in(session: Session, sql: str, params: dict[str, Any]) -> int:
    """Run one ``IN :ids`` statement (expanding bindparam) and return rowcount."""
    stmt = text(sql).bindparams(bindparam("ids", expanding=True))
    result = cast(CursorResult[Any], session.execute(stmt, params))
    return result.rowcount or 0


def delete_agent_task_rows(session: Session, run_ids: list[str]) -> int:
    """Delete agent-task rows for the given Task Run ids, children first.

    The shared cascade behind both retention's purge and manual run deletion
    (``run_deletion``), so the two can never drift apart. The trace
    projection (``runs`` and its children) is NOT touched — retention
    expires traces by their own age (keeping bookmarked ones) and manual
    deletion handles traces explicitly.

    Row deletes are explicit and pragma-independent: SQLite only fires
    ``ON DELETE CASCADE`` when ``PRAGMA foreign_keys=ON`` (true in
    production, not in every test engine), so the child-first ordering here
    is the contract, not a duplication of the FK metadata.
    """
    if not run_ids:
        return 0

    deleted = 0
    # attempts FK task_runs; remove them first.
    if table_exists(session, "task_execution_attempts"):
        deleted += _exec_in(
            session,
            "DELETE FROM task_execution_attempts WHERE task_run_id IN :ids",
            {"ids": run_ids},
        )
    # Check reports FK task_runs (ON DELETE CASCADE — see the note above).
    if table_exists(session, "agent_task_check_reports"):
        deleted += _exec_in(
            session,
            "DELETE FROM agent_task_check_reports WHERE run_id IN :ids",
            {"ids": run_ids},
        )
    # Rejudge judgments and corrected tests FK task_runs the same way.
    if table_exists(session, "agent_task_judgments"):
        deleted += _exec_in(
            session,
            "DELETE FROM agent_task_judgments WHERE task_run_id IN :ids",
            {"ids": run_ids},
        )
    if table_exists(session, "agent_task_test_result_corrections"):
        deleted += _exec_in(
            session,
            "DELETE FROM agent_task_test_result_corrections WHERE task_run_id IN :ids",
            {"ids": run_ids},
        )
    # Deliverable manifest rows (their stored objects went earlier).
    if table_exists(session, "agent_task_deliverables"):
        deleted += _exec_in(
            session,
            "DELETE FROM agent_task_deliverables WHERE task_run_id IN :ids",
            {"ids": run_ids},
        )
    deleted += _exec_in(
        session, "DELETE FROM agent_task_runs WHERE id IN :ids", {"ids": run_ids}
    )
    return deleted


def detach_batch_references(session: Session, batch_ids: list[str]) -> None:
    """Null the soft references Schedules keep to a Batch before it goes.

    ``agent_task_schedules.active_batch_run_id`` is a real FK — deleting a
    batch it still points at fails the purge under ``PRAGMA
    foreign_keys=ON``. Occurrences keep batch_run_id as history, so theirs
    is nulled rather than deleted.
    """
    if not batch_ids:
        return
    params = {"ids": batch_ids}
    _ = _exec_in(
        session,
        "UPDATE agent_task_schedules SET active_batch_run_id = NULL "
        "WHERE active_batch_run_id IN :ids",
        params,
    )
    _ = _exec_in(
        session,
        "UPDATE agent_task_schedules SET last_batch_run_id = NULL "
        "WHERE last_batch_run_id IN :ids",
        params,
    )
    _ = _exec_in(
        session,
        "UPDATE agent_task_schedule_occurrences SET batch_run_id = NULL "
        "WHERE batch_run_id IN :ids",
        params,
    )


def delete_batch_rows(session: Session, batch_ids: list[str]) -> int:
    """Delete Batch rows and their task_revisions; returns batches deleted.

    Any Schedule references are detached first (see
    ``detach_batch_references``) so the delete cannot FK-fail on a batch a
    schedule still points at. task_revisions rows go next — their bundle
    objects were removed by the caller before this runs. The count covers
    Batch rows only; revision rows are dependents, not batches.
    """
    if not batch_ids:
        return 0
    detach_batch_references(session, batch_ids)
    # Guarded so pre-v12 databases don't break.
    if table_exists(session, "task_revisions"):
        _ = _exec_in(
            session,
            "DELETE FROM task_revisions WHERE batch_run_id IN :ids",
            {"ids": batch_ids},
        )
    return _exec_in(
        session,
        "DELETE FROM agent_task_batch_runs WHERE id IN :ids",
        {"ids": batch_ids},
    )


def _delete_old_batch_runs(session: Session, cutoff: datetime) -> int:
    """Delete agent-task batch runs (and their task runs) older than cutoff.

    The trace projection is intentionally untouched here — traces expire by
    their own age via ``_delete_old_runs`` (which keeps bookmarked runs).
    """
    old_batch_ids = _old_batch_ids(session, cutoff)
    if not old_batch_ids:
        return 0

    run_ids = [
        row[0]
        for row in session.execute(
            text("SELECT id FROM agent_task_runs WHERE batch_run_id IN :ids")
            .bindparams(bindparam("ids", expanding=True)),
            {"ids": old_batch_ids},
        ).all()
    ]
    deleted = delete_agent_task_rows(session, run_ids)
    deleted += delete_batch_rows(session, old_batch_ids)
    return deleted


async def delete_deliverable_objects_for_runs(
    session: Session,
    run_ids: list[str],
) -> None:
    """Delete external Deliverable objects for the given runs BEFORE their rows.

    Objects are removed idempotently first;
    only after success may the database rows go. A store failure raises so the
    caller retains the rows and retries on the next cleanup — objects are never
    orphaned by deleting the manifest first. Inline JSON rows need no object
    deletion and delete transactionally with the task run.
    """
    if not run_ids:
        return
    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            as_column(AgentTaskDeliverableDB.task_run_id).in_(run_ids),
            as_column(AgentTaskDeliverableDB.storage_key).is_not(None),
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


async def delete_deliverable_objects_for_project(
    session: Session,
    project_id: str,
) -> None:
    """Delete Deliverable stored objects for every run in a project.

    Object cleanup happens while relational
    metadata still exists, so the manifest rows are readable when deciding
    which backend/key to delete. Missing objects are idempotent success
    (the ArtifactStore contract). A non-missing object that cannot be
    deleted raises a retryable 503 BEFORE any row is removed, so cleanup
    can be retried and bytes are never orphaned. The denial body carries
    no object keys or storage paths.
    """
    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.project == project_id,
            as_column(AgentTaskDeliverableDB.storage_key).is_not(None),
        )
    ).all()
    by_backend: dict[str, list[AgentTaskDeliverableDB]] = {}
    for row in rows:
        backend = row.storage_backend or "local"
        by_backend.setdefault(backend, []).append(row)
    for backend, group in by_backend.items():
        store = get_store(backend)
        for row in group:
            if row.storage_key is not None:
                try:
                    await store.delete(row.storage_key)
                except Exception as exc:
                    raise HTTPException(
                        status_code=503,
                        detail=(
                            "artifact storage cleanup failed; "
                            "project data was kept — retry deletion"
                        ),
                    ) from exc


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


def run_maintenance_cleanup() -> dict[str, int]:
    """Run the daily maintenance pass; retention purge only if configured.

    Always-on hygiene: blank past-window OTLP ingest payloads, fail
    abandoned artifact uploads, reap expired credential tokens. When
    ``APO_RETENTION_DAYS`` is set, also purge old traces/runs/batches (the
    span orphan sweep runs inside that window). Returns a per-task summary;
    ``VACUUM`` runs when anything freed pages.
    """
    summary: dict[str, int] = {}
    now = datetime.now(timezone.utc)

    with Session(engine) as session:
        ingest_days = ingest_payload_retention_days()
        if ingest_days > 0:
            summary["trimmed_ingest_payloads"] = trim_old_ingest_payloads(
                session, now - timedelta(days=ingest_days)
            )
        summary["failed_uploads"] = asyncio.run(
            cleanup_expired_artifact_uploads(session)
        ).get("failed_uploads", 0)
        summary["expired_tokens"] = reap_expired_credentials(session)
        session.commit()

        if RETENTION_DAYS > 0:
            cutoff = now - timedelta(days=RETENTION_DAYS)
            # collect the task-run ids whose batch is old, delete their
            # external Deliverable objects first, then drop the rows. A store
            # failure raises here so the rows are retained for the next
            # cleanup.
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

            # remove Task Revision bundle objects for old batches BEFORE
            # their rows go. A store failure raises so the rows are retained
            # for the next cleanup — objects are never orphaned by deleting
            # the manifest first.
            old_batch_ids = _old_batch_ids(session, cutoff)
            if old_batch_ids:
                from apo.services.task_revisions import delete_task_revision_bundles_for_batches

                _ = asyncio.run(
                    delete_task_revision_bundles_for_batches(session, old_batch_ids)
                )
                session.commit()

            summary["runs"] = _delete_old_runs(session, cutoff)
            summary["agent_task_batch_runs"] = _delete_old_batch_runs(session, cutoff)
            # Spans of the just-purged traces are now orphans; the sweep
            # also clears strays older than the window from earlier eras.
            summary["otlp_spans"] = delete_orphaned_spans(session, cutoff)
            session.commit()

    summary["total"] = sum(
        count for key, count in summary.items() if key not in ("total", "failed_uploads", "expired_tokens")
    )

    # VACUUM reclaims file space after deletes/trims. It must run outside a
    # transaction (its own autocommit connection), so we use the raw
    # engine connection. SQLite-only; a no-op elsewhere.
    # Row deletes and payload trims free DB pages; upload failures free
    # staging bytes on disk. Only the former need a VACUUM.
    freed_rows = summary["total"] > 0
    if freed_rows and is_sqlite():
        with engine.connect() as conn:
            _ = conn.exec_driver_sql("VACUUM")

    logger.info(
        "maintenance cleanup: %s (retention window=%s days, ingest payload window=%s days)",
        summary,
        RETENTION_DAYS,
        ingest_payload_retention_days(),
    )
    return summary


def run_retention_cleanup() -> dict[str, int]:
    """Back-compat alias: the retention-only view of the maintenance pass."""
    return run_maintenance_cleanup()


def get_db_size_info() -> dict[str, object]:
    """Report the current DB footprint. SQLite-only stats are best-effort."""
    info: dict[str, object] = {"dialect": "sqlite" if is_sqlite() else "postgres"}
    if not is_sqlite():
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
    if not is_sqlite() or MAX_DB_PAGES <= 0:
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
    """Run the maintenance pass once now, then daily, on a daemon thread.

    Always starts: the ingest-payload trim, abandoned-upload cleanup, and
    credential reaping are hygiene every deployment wants, independent of
    whether age-based retention is configured.
    """
    global _retention_thread
    if _retention_thread is not None and _retention_thread.is_alive():
        return

    _retention_stop.clear()

    def _loop() -> None:
        try:
            _ = run_maintenance_cleanup()
        except Exception:
            logger.exception("Initial maintenance cleanup failed")
        while not _retention_stop.wait(_RETENTION_INTERVAL_SECONDS):
            try:
                _ = run_maintenance_cleanup()
            except Exception:
                logger.exception("Maintenance cleanup failed")

    _retention_thread = threading.Thread(
        target=_loop, name="data-maintenance", daemon=True
    )
    _retention_thread.start()
    logger.info(
        "data maintenance loop started (retention=%s days, ingest payload window=%s days)",
        RETENTION_DAYS,
        ingest_payload_retention_days(),
    )


def stop_retention_loop() -> None:
    _retention_stop.set()
