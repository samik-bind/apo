# pyright: reportDeprecated=false, reportUnusedCallResult=false

"""Regression coverage for durable trace projection version stamps."""

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text

from apo.db import engine, init_db
from apo.models.db import OtlpSpanDB
from apo.services.otel_normalization import NORMALIZER_VERSION
from apo.services.trace_projector import TraceProjector

_TRACE_ID = "projection-version-trace"
_SPAN_ID = "projection-version-span"
_PROJECT_ID = "projection-version-project"


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        params = {"project": _PROJECT_ID}
        session.execute(
            text("DELETE FROM logged_calls WHERE project = :project"), params
        )
        session.execute(text("DELETE FROM runs WHERE project = :project"), params)
        session.execute(
            text("DELETE FROM otlp_spans WHERE project_id = :project"), params
        )
        session.commit()


def test_projection_and_replay_stamp_current_normalizer_version():
    """Initial projection and replay persist the current normalizer version."""
    span = OtlpSpanDB(
        project_id=_PROJECT_ID,
        trace_id=_TRACE_ID,
        span_id=_SPAN_ID,
        parent_span_id="projection-version-parent",
        start_time=datetime.now(timezone.utc),
        end_time=datetime.now(timezone.utc),
        span_name="chat gpt-4o",
        attributes={"gen_ai.request.model": "gpt-4o"},
    )
    projector = TraceProjector()

    with Session(engine) as session:
        session.add(span)
        session.flush()
        projector.project(span, session)
        session.commit()

    with Session(engine) as session:
        stored = _stored_span(session)
        assert stored.projection_version == NORMALIZER_VERSION
        stored.projection_version = NORMALIZER_VERSION - 1
        session.add(stored)
        session.commit()

    with Session(engine) as session:
        stale = _stored_span(session)
        projector.project(stale, session)
        session.commit()

    with Session(engine) as session:
        assert _stored_span(session).projection_version == NORMALIZER_VERSION


def _stored_span(session: Session) -> OtlpSpanDB:
    return session.exec(
        select(OtlpSpanDB).where(
            OtlpSpanDB.project_id == _PROJECT_ID,
            OtlpSpanDB.span_id == _SPAN_ID,
        )
    ).one()
