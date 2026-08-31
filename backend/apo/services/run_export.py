"""Assemble a complete export bundle for one Task Run.

The backup side of two-tier retention: evidence expires on a window, so
the operator needs one authoritative, self-contained dump of everything a
run holds before it does. The bundle is a versioned JSON document —
verdict, recorded + projected checks, corrections, judgment evidence,
deliverables (inline values and artifact bytes, base64), attempt
diagnostics, and the trace (calls, optionally raw OTel spans).

Everything is embedded, not referenced: after evidence expiry the bundle
still fully explains the run. The CLI writes it to a file
(``apo runs export``); the dashboard can reuse the endpoint later.
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from typing import Any

# pyright: reportAny=false, reportDeprecated=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportPrivateLocalImportUsage=false, reportUnusedCallResult=false

from sqlalchemy import text as sql_text
from sqlmodel import Session, select

from ..db_helpers import as_column
from ..models.db import (
    AgentTaskDeliverableDB,
    AgentTaskJudgmentDB,
    AgentTaskTestResultCorrectionDB,
    AgentTaskRunDB,
    LoggedCallDB,
    OtlpSpanDB,
    TaskDefinitionRevisionDB,
    TaskExecutionAttemptDB,
)
from .artifact_stores.registry import get_store

BUNDLE_VERSION = 2
# v2 (storage single-homing): span objects no longer carry a ``raw_span``
# key — the typed columns are the canonical form. No consumer read it.


async def build_run_export_bundle(
    session: Session,
    task_run: AgentTaskRunDB,
    *,
    include_spans: bool = False,
) -> dict[str, Any]:
    """Everything a run holds, embedded. Caller has authorized the read.

    ``include_spans`` adds the canonical raw OTel spans (largest section —
    the calls projection is usually enough and is always included).
    """
    bundle: dict[str, Any] = {
        "bundle_version": BUNDLE_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "run_id": task_run.id,
    }

    bundle["corrections"] = [
        row.model_dump(mode="json")
        for row in session.exec(
            select(AgentTaskTestResultCorrectionDB).where(
                AgentTaskTestResultCorrectionDB.task_run_id == task_run.id
            )
        ).all()
    ]
    bundle["judgments"] = [
        row.model_dump(mode="json")
        for row in session.exec(
            select(AgentTaskJudgmentDB).where(
                AgentTaskJudgmentDB.task_run_id == task_run.id
            )
        ).all()
    ]
    bundle["deliverables"] = await _deliverables_section(session, task_run)
    attempt = session.exec(
        select(TaskExecutionAttemptDB).where(
            TaskExecutionAttemptDB.task_run_id == task_run.id
        )
    ).first()
    bundle["attempt"] = (
        attempt.model_dump(mode="json") if attempt is not None else None
    )
    bundle["task_definition_source"] = _task_definition_source(session, task_run)
    bundle["trace"] = _trace_section(
        session, task_run, include_spans=include_spans
    )
    return bundle


def _task_definition_source(
    session: Session, task_run: AgentTaskRunDB
) -> dict[str, Any] | None:
    """The pinned eval source, so the bundle replays without the server."""
    if not task_run.task_definition_revision_id:
        return None
    revision = session.get(
        TaskDefinitionRevisionDB, task_run.task_definition_revision_id
    )
    if revision is None:
        return None
    dumped: dict[str, Any] = revision.model_dump(mode="json")
    return dumped


async def _deliverables_section(
    session: Session, task_run: AgentTaskRunDB
) -> dict[str, Any]:
    """Manifest + inline values + artifact bytes (base64)."""
    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.task_run_id == task_run.id
        )
    ).all()
    section: dict[str, Any] = {
        "manifest": [
            row.model_dump(mode="json", exclude={"inline_value_json"})
            for row in rows
        ],
        "values": {},
        "artifacts": {},
    }
    for row in rows:
        if row.kind == "json" and row.inline_value_json is not None:
            value = row.inline_value_json.get("value")
            section["values"][row.name] = value
        elif (
            row.kind == "artifact"
            and row.status == "ready"
            and row.storage_key is not None
        ):
            store = get_store(row.storage_backend or "local")
            chunks: list[bytes] = []
            async for chunk in store.open(row.storage_key):
                chunks.append(chunk)
            body = b"".join(chunks)
            section["artifacts"][row.name] = {
                "content_base64": base64.b64encode(body).decode("ascii"),
                "media_type": row.media_type,
                "sha256": row.sha256,
                "size_bytes": len(body),
            }
    return section


def _trace_section(
    session: Session, task_run: AgentTaskRunDB, *, include_spans: bool
) -> dict[str, Any] | None:
    """The run's trace: calls projection always, raw spans on request.

    The trace id resolves through both links (``trace_run_id`` backlink and
    the projection's ``task_run_id``); either may be missing on legacy or
    already-expired runs — an expired run exports with ``trace: null``.
    """
    trace_ids = {
        task_run.trace_run_id,
        *[
            row[0]
            for row in session.execute(
                sql_text(
                    "SELECT id FROM runs WHERE task_run_id = :r AND project = "
                    "(SELECT b.project FROM agent_task_batch_runs b "
                    "JOIN agent_task_runs a ON a.batch_run_id = b.id "
                    "WHERE a.id = :r)"
                ),
                {"r": task_run.id},
            ).all()
        ],
    }
    trace_ids.discard(None)
    if not trace_ids:
        return None

    # Project scoping on every select: OTel trace ids are only unique per
    # project, so an unscoped select could embed another project's calls
    # and spans in this bundle when ids collide.
    project_row = session.execute(
        sql_text(
            "SELECT b.project FROM agent_task_batch_runs b "
            "JOIN agent_task_runs a ON a.batch_run_id = b.id "
            "WHERE a.id = :r"
        ),
        {"r": task_run.id},
    ).first()
    project = str(project_row[0]) if project_row is not None else ""

    ordered = sorted(str(t) for t in trace_ids)
    section: dict[str, Any] = {"trace_ids": ordered, "calls": [], "spans": []}
    calls = session.exec(
        select(LoggedCallDB).where(
            as_column(LoggedCallDB.run_id).in_(ordered),
            LoggedCallDB.project == project,
        )
    ).all()
    section["calls"] = [c.model_dump(mode="json") for c in calls]
    if include_spans:
        spans = session.exec(
            select(OtlpSpanDB).where(
                as_column(OtlpSpanDB.trace_id).in_(ordered),
                OtlpSpanDB.project_id == project,
            )
        ).all()
        section["spans"] = [s.model_dump(mode="json") for s in spans]
    return section
