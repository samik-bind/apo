"""SPEC-143: Executor Pool management and ProjectActor resolution.

A Pool is a stable Project-owned execution/trust target. Dashboard runs and
schedules target a Pool rather than a transient machine. ``ProjectActor``
closes the legacy gap where batch creation trusted ``request.project`` from the
body — it forces the caller to resolve a verified membership first.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlmodel import Session, select

from apo.models.db import ExecutorPoolDB, ProjectDB
from apo.models.execution import ProjectActor
from apo.services.project_memberships import require_project_role_strict


class PoolError(ValueError):
    """Raised on invalid Pool/actor input (missing project, wrong role, dup slug)."""


_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    """Stable lowercase slug: non-alphanumerics collapse to single hyphens."""
    return _SLUG_STRIP.sub("-", name.strip().lower()).strip("-")


def resolve_project_actor(
    session: Session,
    *,
    project_id: str,
    user_id: str,
    minimum_role: str,
) -> ProjectActor:
    """Resolve a verified Project membership into a ProjectActor.

    Uses ``require_project_role_strict`` (404 on missing ProjectDB, 403 on
    missing membership). Raises :class:`PoolError` so routes can map cleanly.
    """
    try:
        membership = require_project_role_strict(
            session, project_id, user_id, minimum_role=minimum_role
        )
    except Exception as exc:
        raise PoolError(str(exc)) from exc
    return ProjectActor(project_id=project_id, user_id=user_id, role=membership.role)


def create_executor_pool(
    session: Session,
    *,
    project_id: str,
    actor: ProjectActor,
    name: str,
    kind: str,
    required_driver_kind: str = "subprocess",
    queue_ttl_seconds: int = 86_400,
) -> ExecutorPoolDB:
    """Create a Project-owned Executor Pool. Requires owner role.

    Rejects unknown kinds and duplicate ``(project, slug)``. The Pool is enabled
    on creation.
    """
    if kind not in ("bundled", "connected", "managed"):
        raise PoolError(f"unknown pool kind: {kind!r}")
    # Always re-verify membership server-side; the ProjectActor is only a carrier
    # and must not be trusted on its own (spec: no authorization from request
    # bodies alone). Pool creation requires admin role.
    _ = resolve_project_actor(
        session, project_id=project_id, user_id=actor.user_id, minimum_role="admin"
    )
    slug = slugify(name)
    existing = session.exec(
        select(ExecutorPoolDB).where(
            ExecutorPoolDB.project == project_id,
            ExecutorPoolDB.slug == slug,
        )
    ).first()
    if existing is not None:
        raise PoolError(f"a pool with slug {slug!r} already exists in this project")
    now = datetime.now(timezone.utc)
    pool = ExecutorPoolDB(
        project=project_id,
        name=name,
        slug=slug,
        kind=kind,
        enabled=True,
        queue_ttl_seconds=queue_ttl_seconds,
        required_driver_kind=required_driver_kind,
        created_by_user_id=actor.user_id,
        created_at=now,
        updated_at=now,
    )
    session.add(pool)
    session.commit()
    session.refresh(pool)
    return pool


def set_default_pool(session: Session, *, project_id: str, pool_id: str) -> ProjectDB:
    """Set a Project's default Pool, validating the Pool belongs to that Project."""
    pool = session.get(ExecutorPoolDB, pool_id)
    if pool is None or pool.project != project_id:
        raise PoolError("pool does not belong to this project")
    if pool.archived_at is not None:
        raise PoolError("archived pool cannot be the project default")
    if not pool.enabled:
        raise PoolError("disabled pool cannot be the project default")
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise PoolError("project not found")
    project.default_executor_pool_id = pool_id
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


def get_pool(session: Session, pool_id: str) -> ExecutorPoolDB | None:
    return session.get(ExecutorPoolDB, pool_id)


__all__ = [
    "PoolError",
    "create_executor_pool",
    "get_pool",
    "resolve_project_actor",
    "set_default_pool",
    "slugify",
]
