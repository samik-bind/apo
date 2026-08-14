# pyright: reportAny=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedParameter=false
# pyright: reportAttributeAccessIssue=false

"""Always store full Trace Content.

These tests assert that OTLP content is stored unchanged regardless of any
legacy Project policy column, and that the content-policy interface is gone.
"""

from __future__ import annotations

import json

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _content_payload() -> bytes:
    """OTLP/JSON with sentinel strings in resource, scope, span, event, and link attrs."""
    return json.dumps({
        "resourceSpans": [{
            "resource": {"attributes": [
                {"key": "service.name", "value": {"stringValue": "SENTINEL_SERVICE"}},
            ]},
            "scopeSpans": [{
                "scope": {"attributes": [
                    {"key": "scope.attr", "value": {"stringValue": "SENTINEL_SCOPE"}},
                ]},
                "spans": [{
                    "traceId": "aabbccddeeff00112233445566778899",
                    "spanId": "aabbccddeeff0011",
                    "name": "SENTINEL_SPAN_NAME",
                    "kind": 0,
                    "startTimeUnixNano": "1700000000000000000",
                    "endTimeUnixNano": "1700000001000000000",
                    "attributes": [
                        {"key": "gen.prompt", "value": {"stringValue": "SENTINEL_PROMPT"}},
                        {"key": "gen.output", "value": {"stringValue": "SENTINEL_OUTPUT"}},
                        {"key": "tool.input", "value": {"stringValue": "SENTINEL_TOOL_INPUT"}},
                    ],
                    "events": [{
                        "name": "SENTINEL_EVENT",
                        "timeUnixNano": "1700000000500000000",
                        "attributes": [
                            {"key": "event.data", "value": {"stringValue": "SENTINEL_EVENT_DATA"}},
                        ],
                    }],
                    "links": [{
                        "traceId": "112233445566778899aabbccddeeff00",
                        "spanId": "1122334455667788",
                        "attributes": [
                            {"key": "link.attr", "value": {"stringValue": "SENTINEL_LINK"}},
                        ],
                    }],
                }],
            }],
        }]
    }).encode()


class TestFullTraceContent:
    """Decoded OTLP content is unchanged by the receiver."""

    def test_full_content_preserved_for_off_project(self, session: Session) -> None:
        """A Project with legacy policy='off' still stores full content."""
        from apo.models.db import OtlpSpanDB, ProjectDB
        from apo.services.otlp_receiver import OtlpReceiver

        project = ProjectDB(id="test-off", name="test", created_by="tester",
                            trace_content_policy="off")
        session.add(project)
        session.commit()

        receiver = OtlpReceiver()
        receiver.ingest(
            payload=_content_payload(),
            content_type="application/json",
            project_id="test-off",
            session=session,
        )

        spans = list(session.exec(select(OtlpSpanDB).where(OtlpSpanDB.project_id == "test-off")).all())
        assert len(spans) == 1
        attrs = spans[0].attributes or {}
        assert attrs.get("gen.prompt") == "SENTINEL_PROMPT"
        assert attrs.get("gen.output") == "SENTINEL_OUTPUT"
        assert attrs.get("tool.input") == "SENTINEL_TOOL_INPUT"

    def test_full_content_preserved_for_redacted_project(self, session: Session) -> None:
        """A Project with legacy policy='redacted' still stores full content."""
        from apo.models.db import OtlpSpanDB, ProjectDB
        from apo.services.otlp_receiver import OtlpReceiver

        project = ProjectDB(id="test-redacted", name="test", created_by="tester",
                            trace_content_policy="redacted")
        session.add(project)
        session.commit()

        receiver = OtlpReceiver()
        receiver.ingest(
            payload=_content_payload(),
            content_type="application/json",
            project_id="test-redacted",
            session=session,
        )

        spans = list(session.exec(select(OtlpSpanDB).where(OtlpSpanDB.project_id == "test-redacted")).all())
        assert len(spans) == 1
        attrs = spans[0].attributes or {}
        assert attrs.get("gen.prompt") == "SENTINEL_PROMPT"

    def test_receiver_has_no_content_policy_param(self) -> None:
        """The ingest() method signature has no content_policy parameter."""
        import inspect
        from apo.services.otlp_receiver import OtlpReceiver

        sig = inspect.signature(OtlpReceiver.ingest)
        assert "content_policy" not in sig.parameters

    def test_project_response_omits_policy(self, session: Session) -> None:
        """Project API response models do not include trace_content_policy."""
        from apo.models.schemas import ProjectSummary

        assert "trace_content_policy" not in ProjectSummary.model_fields
