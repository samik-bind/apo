# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

import pytest
from types import SimpleNamespace
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session
from datetime import datetime, timedelta, timezone

from apo.models import LoggedCallDB, RunDB
from apo.models.db import ProjectDB, ProjectMembershipDB, UserDB
from apo.routes.runs.crud import get_run_details, get_distinct_projects


def test_list_runs(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)

    r1 = RunDB(id="r1", project="p1", task_id="t1", flow_name="flow1", created_at=now - timedelta(minutes=10), call_count=2)
    c1 = LoggedCallDB(
        id="c1",
        project="p1",
        model="gpt-4",
        task_id="t1",
        run_id="r1",
        flow_name="flow1",
        created_at=now - timedelta(minutes=10),
        input={"prompt": "hi"},
        messages=[],
        output={"text": "hello"},
        step_index=0
    )
    c2 = LoggedCallDB(
        id="c2",
        project="p1",
        model="gpt-4",
        task_id="t1",
        run_id="r1",
        flow_name="flow1",
        created_at=now - timedelta(minutes=5),
        input={"prompt": "bye"},
        messages=[],
        output={"text": "goodbye"},
        step_index=1
    )

    r2 = RunDB(id="r2", project="p1", task_id="t2", flow_name=None, created_at=now, call_count=1)
    c3 = LoggedCallDB(
        id="c3",
        project="p1",
        model="gpt-4",
        task_id="t2",
        run_id="r2",
        flow_name=None,
        created_at=now,
        input={"prompt": "solo"},
        messages=[],
        output={"text": "solo"},
    )

    c4 = LoggedCallDB(
        id="c4",
        project="p1",
        model="gpt-4",
        task_id="t3",
        created_at=now,
        input={"prompt": "no run"},
        messages=[],
        output={"text": "no run"},
    )

    session.add(r1)
    session.add(r2)
    session.add(c1)
    session.add(c2)
    session.add(c3)
    session.add(c4)
    session.commit()

    response = client.get("/v1/runs")
    assert response.status_code == 200
    result = response.json()

    data = result["data"]
    assert len(data) == 2

    assert data[0]["id"] == "r2"
    assert data[1]["id"] == "r1"

    r1_data = data[1]
    assert r1_data["call_count"] == 2
    assert r1_data["flow_name"] == "flow1"
    assert r1_data["task_id"] == "t1"

    r2_data = data[0]
    assert r2_data["call_count"] == 1
    assert r2_data["flow_name"] is None

def test_get_run_details(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)

    r1 = RunDB(id="r1", project="p", task_id="t", flow_name="flow1", created_at=now, call_count=3)

    c1 = LoggedCallDB(
        id="c1", project="p", model="m", task_id="t", run_id="r1", flow_name="flow1",
        created_at=now, step_index=1,
        input={"a": "b"}, messages=[], output={"c": "d"}
    )
    c2 = LoggedCallDB(
        id="c2", project="p", model="m", task_id="t", run_id="r1", flow_name="flow1",
        created_at=now - timedelta(seconds=1), step_index=0,
        input={"a": "b"}, messages=[], output={"c": "d"}
    )
    c3 = LoggedCallDB(
        id="c3", project="p", model="m", task_id="t", run_id="r1", flow_name="flow1",
        created_at=now + timedelta(seconds=1), step_index=None,
        input={"long": "x"*400}, messages=[], output={"long": "y"*400}
    )

    session.add(r1)
    session.add(c1)
    session.add(c2)
    session.add(c3)
    session.commit()

    response = client.get("/v1/runs/r1?project=p")
    assert response.status_code == 200
    data = response.json()

    assert data["run"]["id"] == "r1"
    assert len(data["calls"]) == 3

    calls = data["calls"]
    assert calls[0]["id"] == "c2"
    assert calls[1]["id"] == "c1"
    assert calls[2]["id"] == "c3"

    assert calls[2]["input"]["long"] == "x"*400
    assert calls[2]["output"]["long"] == "y"*400


def test_get_run_details_omits_messages_unless_included(client: TestClient, session: Session):
    # `messages` duplicates input/output content (the projector copies
    # input.messages + output.messages verbatim), roughly doubling the payload
    # of agentic traces. Default response drops it; ?include=messages restores
    # it for the CLI's verbose view.
    now = datetime.now(timezone.utc)
    msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]

    session.add(RunDB(id="r-msg", project="p", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="c-msg", project="p", model="m", task_id="t", run_id="r-msg",
        created_at=now, input={"messages": msgs}, messages=msgs, output={"c": "d"},
    ))
    session.commit()

    default = client.get("/v1/runs/r-msg?project=p")
    assert default.status_code == 200
    call = default.json()["calls"][0]
    assert "messages" not in call
    assert call["input"]["messages"] == msgs  # nested content untouched

    included = client.get("/v1/runs/r-msg?project=p&include=messages")
    assert included.status_code == 200
    assert included.json()["calls"][0]["messages"] == msgs


def test_get_run_details_accepts_nondict_json_fields(client: TestClient, session: Session):
    # Regression for issue #23: a trace written via the projection path can hold
    # a non-dict tool_result / input / output (e.g. a plain string, number, or
    # list). The DB column is JSON and accepts it; the read model must not 500.
    now = datetime.now(timezone.utc)

    r1 = RunDB(id="r-nondict", project="p", task_id="t", created_at=now, call_count=1)

    c1 = LoggedCallDB(
        id="c-nondict", project="p", model="m", task_id="t", run_id="r-nondict",
        created_at=now, observation_type="TOOL", tool_name="reminder",
        tool_result="Before using DOCX tools, ...",  # string, not dict
        input="plain string input",                  # string
        output=42,                                   # int
        messages=[],
    )

    session.add(r1)
    session.add(c1)
    session.commit()

    response = client.get("/v1/runs/r-nondict?project=p")
    assert response.status_code == 200, response.text

    calls = response.json()["calls"]
    assert len(calls) == 1
    assert calls[0]["tool_result"] == "Before using DOCX tools, ..."
    assert calls[0]["input"] == "plain string input"
    assert calls[0]["output"] == 42


def _req(user_id: str | None) -> SimpleNamespace:
    """Fake request for direct route-function calls. ``user_id=None`` takes the
    dev/open-mode permissive path; a value exercises membership enforcement."""
    state = SimpleNamespace()
    if user_id is not None:
        state.user_id = user_id
    return SimpleNamespace(state=state)


def _seed_membership_project(session: Session, project: str, member_id: str) -> None:
    """A real ProjectDB row (so legacy tolerance does not apply) with one member."""
    session.add(UserDB(id=member_id, email=f"{member_id}@t.co", name=member_id, password_hash="x"))
    session.commit()
    session.add(ProjectDB(id=project, name=project, created_by=member_id))
    session.commit()
    session.add(
        ProjectMembershipDB(project_id=project, user_id=member_id, role="owner")
    )
    session.commit()


def test_get_run_details_enforces_project_membership(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)
    _seed_membership_project(session, "proj-a", "member-a")
    session.add(RunDB(id="ra", project="proj-a", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="ca", project="proj-a", model="m", task_id="t", run_id="ra",
        created_at=now, input={}, messages=[], output={},
    ))
    session.commit()

    # Member reads their own project's trace.
    detail = get_run_details("ra", _req("member-a"), project="proj-a", session=session)
    assert detail["run"]["id"] == "ra"

    # Non-member passing ?project=proj-a is rejected — the pre-fix leak.
    with pytest.raises(HTTPException) as exc:
        get_run_details("ra", _req("outsider"), project="proj-a", session=session)
    assert exc.value.status_code == 403


def test_distinct_projects_scoped_to_caller(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)
    _seed_membership_project(session, "iso-a", "iso-member-a")
    _seed_membership_project(session, "iso-b", "iso-member-b")
    session.add(RunDB(id="iso-ra", project="iso-a", created_at=now, call_count=0))
    session.add(RunDB(id="iso-rb", project="iso-b", created_at=now, call_count=0))
    session.commit()

    # A member of iso-a sees iso-a but cannot enumerate iso-b's existence.
    scoped = get_distinct_projects(_req("iso-member-a"), session=session)
    assert "iso-a" in scoped
    assert "iso-b" not in scoped

    # Dev/open mode (no user_id) stays unscoped: sees both.
    unscoped = set(get_distinct_projects(_req(None), session=session))
    assert {"iso-a", "iso-b"} <= unscoped


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main(["-v", __file__]))
