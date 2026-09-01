# pyright: reportAny=false, reportAttributeAccessIssue=false, reportDeprecated=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportOptionalMemberAccess=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedParameter=false

"""Traces-list Service column (runs.service_name): projector maintenance,
v38 backfill, and the list response carrying it.
"""

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select

from apo.models.db import OtlpSpanDB, RunDB
from apo.routes.runs.list_query import (
    RunListFilters,
    RunListPagination,
    list_run_summaries,
)

NOW = datetime.now(timezone.utc)
TRACE = "0102030405060708090a0b0c0d0e0f10"


def test_projector_sets_run_service(session: Session) -> None:
    from apo.services.trace_projector import get_trace_projector

    span = OtlpSpanDB(
        project_id="p1",
        trace_id=TRACE,
        span_id=TRACE[:16],
        span_name="GET /x",
        service_name="billing-api",
        start_time=NOW,
        attributes={},
    )
    session.add(span)
    session.commit()
    get_trace_projector().project(span, session)
    session.commit()

    run = session.exec(select(RunDB).where(RunDB.id == TRACE)).one()
    assert run.service_name == "billing-api"

    # A later span from another library in the same trace keeps the first
    # service (a trace is one service in practice).
    second = OtlpSpanDB(
        project_id="p1",
        trace_id=TRACE,
        span_id="a1a2a3a4a5a6a7a8",
        parent_span_id=TRACE[:16],
        span_name="db.query",
        service_name="billing-api/db",
        start_time=NOW,
        attributes={},
    )
    session.add(second)
    session.commit()
    get_trace_projector().project(second, session)
    session.commit()
    run = session.exec(select(RunDB).where(RunDB.id == TRACE)).one()
    assert run.service_name == "billing-api"


def test_list_summary_carries_service(session: Session) -> None:
    session.add(
        RunDB(
            id=TRACE,
            project="p1",
            environment="default",
            created_at=NOW,
            call_count=0,
            service_name="auth-api",
        )
    )
    session.commit()
    page = list_run_summaries(
        session,
        RunListFilters(project="p1"),
        RunListPagination(page=0, page_size=10, sort_by=None, sort_order=None),
    )
    assert page.data and page.data[0].service_name == "auth-api"


def test_v38_backfill_fills_from_spans() -> None:
    import apo.models.db as mdb
    from sqlalchemy import create_engine

    from apo.db import _add_run_service_column, _backfill_run_service

    eng = create_engine("sqlite://")
    mdb.SQLModel.metadata.create_all(
        eng, tables=[mdb.OtlpSpanDB.__table__, mdb.RunDB.__table__]
    )
    with eng.begin() as conn:
        conn.exec_driver_sql(
            "INSERT INTO otlp_spans (project_id, trace_id, span_id, span_name, "
            "span_kind, status_code, trace_flags, content_policy, projection_version, service_name) "
            "VALUES ('p', 't1', 's1', 'n', 0, 0, 0, 'default', 0, 'billing-api')"
        )
        conn.exec_driver_sql(
            "INSERT INTO runs (id, project, environment, call_count, bookmarked, is_public, created_at) "
            "VALUES ('t1', 'p', 'default', 0, 0, 0, '2026-01-01 00:00:00')"
        )
    with eng.begin() as conn:
        _add_run_service_column(conn)
        _backfill_run_service(conn)
        _backfill_run_service(conn)  # idempotent
        value = conn.exec_driver_sql(
            "SELECT service_name FROM runs WHERE id = 't1'"
        ).fetchone()
    assert value is not None and value[0] == "billing-api"


def test_migration_rerun_safe() -> None:
    from apo.db import _migrate_to_v38, engine

    import apo.models.db as mdb

    mdb.SQLModel.metadata.create_all(engine)
    _migrate_to_v38()
    _migrate_to_v38()
