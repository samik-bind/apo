# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""SPEC-143: execution_pools — Pool CRUD, default Pool, ProjectActor."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from apo.models.db import ExecutorPoolDB, ProjectDB, UserDB
from apo.models.execution import ProjectActor
from apo.services.execution_pools import (
    PoolError,
    create_executor_pool,
    resolve_project_actor,
    set_default_pool,
    slugify,
)
from sqlmodel import Session


def _seed_user(session: Session, email: str = "owner@test") -> UserDB:
    user = UserDB(email=email, name=email, password_hash="x", is_active=True)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _seed_project(session: Session, project_id: str, owner_id: str, *, role: str = "owner") -> None:
    from apo.models.db import ProjectMembershipDB

    session.add(ProjectDB(id=project_id, name=project_id, created_by=owner_id, created_at=datetime.now(timezone.utc)))
    session.add(ProjectMembershipDB(
        project_id=project_id, user_id=owner_id, role=role,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ))
    session.commit()


def test_slugify_is_stable_and_lowercase() -> None:
    assert slugify("My Pool #1") == "my-pool-1"
    assert slugify("  a  b ") == "a-b"


def test_create_executor_pool_requires_real_project(session: Session) -> None:
    user = _seed_user(session)
    with pytest.raises(PoolError):
        create_executor_pool(
            session, project_id="nope", actor=ProjectActor("nope", user.id, "owner"),
            name="P", kind="connected",
        )


def test_create_executor_pool_requires_owner_role(session: Session) -> None:
    user = _seed_user(session)
    _seed_project(session, "proj-p", user.id, role="member")
    with pytest.raises(PoolError):
        create_executor_pool(
            session, project_id="proj-p", actor=ProjectActor("proj-p", user.id, "member"),
            name="P", kind="connected",
        )


def test_create_executor_pool_persists_and_dedupes_slug(session: Session) -> None:
    user = _seed_user(session)
    _seed_project(session, "proj-p", user.id)
    pool = create_executor_pool(
        session, project_id="proj-p", actor=ProjectActor("proj-p", user.id, "owner"),
        name="My Pool", kind="connected",
    )
    assert pool.slug == "my-pool"
    assert pool.kind == "connected"
    assert pool.enabled is True
    with pytest.raises(PoolError):
        create_executor_pool(
            session, project_id="proj-p", actor=ProjectActor("proj-p", user.id, "owner"),
            name="My Pool", kind="connected",
        )


def test_resolve_project_actor_strict(session: Session) -> None:
    user = _seed_user(session)
    _seed_project(session, "proj-a", user.id)
    actor = resolve_project_actor(session, project_id="proj-a", user_id=user.id, minimum_role="owner")
    assert actor.project_id == "proj-a"
    assert actor.user_id == user.id
    # missing membership -> error
    other = _seed_user(session, "other@test")
    with pytest.raises(PoolError):
        resolve_project_actor(session, project_id="proj-a", user_id=other.id, minimum_role="member")


def test_set_default_pool_validates_ownership(session: Session) -> None:
    user = _seed_user(session)
    _seed_project(session, "proj-a", user.id)
    _seed_project(session, "proj-b", user.id)
    pool_a = create_executor_pool(
        session, project_id="proj-a", actor=ProjectActor("proj-a", user.id, "owner"),
        name="PA", kind="connected",
    )
    # pool from proj-a cannot be set as default for proj-b
    with pytest.raises(PoolError):
        set_default_pool(session, project_id="proj-b", pool_id=pool_a.id)
    set_default_pool(session, project_id="proj-a", pool_id=pool_a.id)
    session.refresh(session.get(ProjectDB, "proj-a"))  # type: ignore[arg-type]
    assert session.get(ProjectDB, "proj-a").default_executor_pool_id == pool_a.id  # type: ignore[union-attr]
