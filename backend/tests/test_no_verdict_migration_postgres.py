# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false, reportArgumentType=false

"""v44/v49/v50 migrations on PostgreSQL.

The SQLite suite cannot catch dialect faults: driver SQL with ``:name``
placeholders (psycopg2 wants ``%(name)s``), ``boolean = integer``
comparisons, SQLite-only types. Runs against a throwaway database created on
``APO_TEST_POSTGRES_URL`` and is skipped when that is unset, like the
PostgreSQL claim-race gate in ``test_execution_leases.py``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from uuid import uuid4

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy import text
from sqlalchemy.engine import Engine, make_url
from sqlmodel import Session, SQLModel, create_engine

import apo.db as apo_db
from apo.models.db import AgentTaskJudgmentDB
from tests.test_judge_no_verdict import RULE_1_OF_3
from tests.test_no_verdict_migration import _DOMINATED, _batch, _run, _v48_state_with_correction


@pytest.fixture(name="pg_engine")
def pg_engine_fixture(monkeypatch: MonkeyPatch) -> Iterator[Engine]:
    database_url = os.environ.get("APO_TEST_POSTGRES_URL")
    if database_url is None:
        pytest.skip("set APO_TEST_POSTGRES_URL to run the PostgreSQL migration gate")

    name = f"apo_migration_{uuid4().hex}"
    admin_engine = create_engine(database_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = make_url(database_url).set(database=name).render_as_string(hide_password=False)
    engine = create_engine(url)
    try:
        SQLModel.metadata.create_all(engine)
        # The migration helpers pick their dialect from the module URL.
        monkeypatch.setattr(apo_db, "DATABASE_URL", url)
        monkeypatch.setattr(apo_db, "engine", engine)
        yield engine
    finally:
        engine.dispose()
        with admin_engine.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin_engine.dispose()


def test_v49_v50_on_postgres(pg_engine: Engine) -> None:
    with Session(pg_engine) as session:
        # A human set_fail on the judge-errored check (batch b1) — the row
        # v49 wrongly moves to no verdict and v50 restores. Seeded first: it
        # creates the project the other rows' foreign keys need.
        _v48_state_with_correction(session, "set_fail")
        _batch(session, 6)
        session.add(_run("run-outage", failed=0, errored=1, error_message="adapter note"))
        session.add(_run("run-genuine", failed=1, errored=1))
        session.add(_run("run-generations", failed=0, errored=1, generation_execution=_DOMINATED))
        session.add(
            _run(
                "run-149",
                failed=0,
                errored=1,
                status="error",
                error_message="3 of 4 generations ended in error. No PASS/FAIL verdict.",
                generation_execution=_DOMINATED,
            )
        )
        session.add(
            _run("run-crash", failed=0, errored=1, status="error", error_message="adapter crashed")
        )
        session.add(
            _run(
                "run-old-wording",
                failed=0,
                errored=1,
                status="error",
                error_message=(
                    "No verdict: 1 of 3 checks got no answer from the judge (judge error); "
                    "the other 2 passed."
                ),
            )
        )
        session.flush()
        for judgment_id, pass_result, failed, errored in [
            ("jdg-no-verdict", False, 0, 1),
            ("jdg-genuine", False, 1, 1),
            ("jdg-pass", True, 0, 0),
        ]:
            session.add(
                AgentTaskJudgmentDB(
                    id=judgment_id,
                    task_run_id="run-outage",
                    project="p1",
                    trigger="rejudge",
                    samples=1,
                    pass_result=pass_result,
                    total_checks=3,
                    passed_checks=3 - failed - errored,
                    failed_checks=failed,
                    errored_checks=errored,
                )
            )
        session.commit()

    # Schema as v48 left it: no reason column yet.
    with pg_engine.begin() as conn:
        conn.execute(text("ALTER TABLE agent_task_runs DROP COLUMN no_verdict_reason"))

    apo_db._migrate_to_v49()
    with pg_engine.connect() as conn:
        after_v49 = {
            row.id: (row.status, row.pass_result)
            for row in conn.execute(text("SELECT id, status, pass_result FROM agent_task_runs"))
        }
    assert after_v49["run-outage"] == ("error", None)
    assert after_v49["r1"] == ("error", None)
    assert after_v49["run-genuine"] == ("failed", False)
    assert after_v49["run-generations"] == ("failed", False)

    apo_db._migrate_to_v50()
    apo_db._migrate_to_v50()  # idempotent

    with pg_engine.connect() as conn:
        runs = {
            row.id: row
            for row in conn.execute(
                text(
                    "SELECT id, status, pass_result, failed_checks, errored_checks,"
                    " error_message, no_verdict_reason FROM agent_task_runs"
                )
            )
        }
        batches = {
            row.id: (row.failed_tasks, row.errored_tasks)
            for row in conn.execute(
                text("SELECT id, failed_tasks, errored_tasks FROM agent_task_batch_runs")
            )
        }
        judgments = {
            row.id: row.pass_result
            for row in conn.execute(text("SELECT id, pass_result FROM agent_task_judgments"))
        }

    def state(run_id: str) -> tuple[object, object, object]:
        row = runs[run_id]
        return row.status, row.pass_result, row.no_verdict_reason

    assert state("run-outage") == ("error", None, "judge")
    assert runs["run-outage"].error_message == f"{RULE_1_OF_3}\nadapter note"
    assert state("run-genuine") == ("failed", False, None)
    assert state("run-generations") == ("failed", False, None)
    assert state("run-149") == ("error", None, "generations")
    assert state("run-crash") == ("error", None, "executor")
    assert runs["run-crash"].error_message == "adapter crashed"
    assert state("run-old-wording") == ("error", None, "judge")
    assert runs["run-old-wording"].error_message == RULE_1_OF_3

    assert state("r1") == ("failed", False, None)
    assert (runs["r1"].failed_checks, runs["r1"].errored_checks) == (1, 0)
    assert runs["r1"].error_message is None

    assert batches == {"batch-1": (2, 4), "b1": (1, 0)}
    assert judgments == {"jdg-no-verdict": None, "jdg-genuine": False, "jdg-pass": True}


def test_v44_creates_result_evidence_on_postgres(pg_engine: Engine) -> None:
    with pg_engine.begin() as conn:
        conn.execute(text("DROP TABLE agent_task_result_evidence"))

    apo_db._migrate_to_v44()
    apo_db._migrate_to_v44()  # idempotent

    with pg_engine.connect() as conn:
        columns = {
            row.column_name: row.data_type
            for row in conn.execute(
                text(
                    "SELECT column_name, data_type FROM information_schema.columns"
                    " WHERE table_name = 'agent_task_result_evidence'"
                )
            )
        }
    assert columns["created_at"] == "timestamp without time zone"
    assert columns["ready_at"] == "timestamp without time zone"
