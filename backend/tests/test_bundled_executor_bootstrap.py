# pyright: reportCallInDefaultInitializer=false

"""Bundled Executor provider bootstrap and default-Pool tests."""

from __future__ import annotations

import stat
from datetime import datetime, timezone
from pathlib import Path

from _pytest.monkeypatch import MonkeyPatch
from sqlmodel import Session, select

from apo.models.db import (
    ExecutorEnrollmentTokenDB,
    ExecutorPoolDB,
    ProjectDB,
    UserDB,
)
from apo.models.execution import ExecutorCapabilities
from apo.services.bundled_executor import (
    bootstrap_bundled_executor,
    ensure_bundled_pool,
)
from apo.services.executor_auth import exchange_enrollment_token


def _project(session: Session, project_id: str = "project-1") -> ProjectDB:
    user = UserDB(
        id="owner-1",
        email="owner@example.test",
        name="Owner",
        password_hash="x",
        is_active=True,
    )
    session.add(user)
    session.flush()
    project = ProjectDB(
        id=project_id,
        name="Project",
        created_by=user.id,
        created_at=datetime.now(timezone.utc),
    )
    session.add(project)
    session.commit()
    return project


def test_bootstrap_is_idempotent_and_writes_restrictive_token(
    session: Session,
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    project = _project(session)
    token_file = tmp_path / "bootstrap" / "enrollment-token"
    monkeypatch.setenv("APO_BUNDLED_EXECUTOR_ENABLED", "true")

    bootstrap_bundled_executor(session, token_file=token_file)
    original_token = token_file.read_text(encoding="utf-8")
    bootstrap_bundled_executor(session, token_file=token_file)

    session.refresh(project)
    pools = session.exec(select(ExecutorPoolDB)).all()
    tokens = session.exec(select(ExecutorEnrollmentTokenDB)).all()
    assert len(pools) == 1
    assert pools[0].kind == "bundled"
    assert project.default_executor_pool_id == pools[0].id
    assert len(tokens) == 1
    assert token_file.read_text(encoding="utf-8") == original_token
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600


def test_bootstrap_stops_exposing_token_after_enrollment(
    session: Session,
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    _ = _project(session)
    token_file = tmp_path / "bootstrap" / "enrollment-token"
    monkeypatch.setenv("APO_BUNDLED_EXECUTOR_ENABLED", "true")
    bootstrap_bundled_executor(session, token_file=token_file)
    raw_token = token_file.read_text(encoding="utf-8").strip()
    _ = exchange_enrollment_token(
        session,
        raw_token=raw_token,
        name="bundled-1",
        capabilities=ExecutorCapabilities(
            protocol_version=1,
            executor_version="v",
            driver_kinds=["subprocess"],
            os="linux",
            architecture="x86_64",
            runtimes={"node": "22"},
            max_concurrency=1,
        ),
    )

    bootstrap_bundled_executor(session, token_file=token_file)

    assert not token_file.exists()
    assert len(session.exec(select(ExecutorEnrollmentTokenDB)).all()) == 1


def test_existing_project_default_is_preserved(session: Session) -> None:
    project = _project(session)
    connected = ExecutorPoolDB(
        id="connected-1",
        project=project.id,
        name="Connected",
        slug="connected",
        kind="connected",
        enabled=True,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    project.default_executor_pool_id = connected.id
    session.add(connected)
    session.add(project)
    session.commit()

    bundled = ensure_bundled_pool(session, project_id=project.id)

    session.refresh(project)
    assert bundled.kind == "bundled"
    assert project.default_executor_pool_id == connected.id
