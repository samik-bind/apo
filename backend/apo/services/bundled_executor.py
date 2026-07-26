"""Bundled Executor provider bootstrap.

Creates the provider-owned Bundled Pool for writable Projects and hands a
single installation-scoped enrollment token to the separate Executor process
through a restrictive, atomic bootstrap file. The long-lived Executor
credential is never written by the Control Plane.
"""

# pyright: reportPrivateUsage=false

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from apo.db_helpers import _as_column
from apo.models.db import (
    AgentTaskScheduleDB,
    ExecutorDB,
    ExecutorPoolDB,
    ProjectDB,
)
from apo.services.executor_auth import (
    generate_enrollment_token,
    resolve_enrollment_token,
)

BUNDLED_POOL_NAME = "Bundled Executor"
BUNDLED_POOL_SLUG = "bundled"
DEFAULT_BOOTSTRAP_TOKEN_FILE = (
    "/var/lib/apo/executor-bootstrap/enrollment-token"
)


def bundled_executor_enabled() -> bool:
    return os.environ.get(
        "APO_BUNDLED_EXECUTOR_ENABLED",
        "",
    ).strip().lower() in {"1", "true", "yes", "on"}


def ensure_bundled_pool(
    session: Session,
    *,
    project_id: str,
) -> ExecutorPoolDB:
    """Ensure one provider-owned Bundled Pool and a stable Project default."""
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise ValueError(f"project not found: {project_id}")
    existing = session.exec(
        select(ExecutorPoolDB).where(
            ExecutorPoolDB.project == project_id,
            ExecutorPoolDB.slug == BUNDLED_POOL_SLUG,
        )
    ).first()
    if existing is not None:
        if existing.kind != "bundled":
            raise ValueError(
                f"reserved Pool slug {BUNDLED_POOL_SLUG!r} is not bundled"
            )
        if _set_default_if_missing(session, project, existing):
            session.commit()
        return existing

    now = datetime.now(timezone.utc)
    pool = ExecutorPoolDB(
        project=project_id,
        name=BUNDLED_POOL_NAME,
        slug=BUNDLED_POOL_SLUG,
        kind="bundled",
        enabled=True,
        required_driver_kind="subprocess",
        created_by_user_id=None,
        created_at=now,
        updated_at=now,
    )
    session.add(pool)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        concurrent = session.exec(
            select(ExecutorPoolDB).where(
                ExecutorPoolDB.project == project_id,
                ExecutorPoolDB.slug == BUNDLED_POOL_SLUG,
                ExecutorPoolDB.kind == "bundled",
            )
        ).first()
        if concurrent is None:
            raise
        project = session.get(ProjectDB, project_id)
        if project is None:
            raise ValueError(f"project not found: {project_id}")
        if _set_default_if_missing(session, project, concurrent):
            session.commit()
        return concurrent

    _ = _set_default_if_missing(session, project, pool)
    session.commit()
    session.refresh(pool)
    return pool


def bootstrap_bundled_executor(
    session: Session,
    *,
    token_file: Path | None = None,
) -> None:
    """Idempotently provision Bundled Pools and the installation enrollment."""
    if not bundled_executor_enabled():
        return
    _ensure_writable_project_pools(session)
    path = token_file or Path(
        os.environ.get(
            "APO_EXECUTOR_BOOTSTRAP_TOKEN_FILE",
            DEFAULT_BOOTSTRAP_TOKEN_FILE,
        )
    )
    if _active_installation_executor(session) is not None:
        path.unlink(missing_ok=True)
        return
    if _has_live_bootstrap_token(session, path):
        return
    path.unlink(missing_ok=True)
    raw_token, row = generate_enrollment_token(
        session,
        scope_kind="installation",
        project_id=None,
        pool_id=None,
    )
    try:
        _atomic_write_secret(path, raw_token)
    except OSError:
        row.revoked_at = datetime.now(timezone.utc)
        session.add(row)
        session.commit()
        raise


def _set_default_if_missing(
    session: Session,
    project: ProjectDB,
    pool: ExecutorPoolDB,
) -> bool:
    if project.default_executor_pool_id is None:
        project.default_executor_pool_id = pool.id
        project.updated_at = datetime.now(timezone.utc)
        session.add(project)
        return True
    return False


def _ensure_writable_project_pools(session: Session) -> None:
    projects = session.exec(
        select(ProjectDB).where(
            _as_column(ProjectDB.created_by).is_not(None)
        )
    ).all()
    for project in projects:
        pool = ensure_bundled_pool(session, project_id=project.id)
        schedules = session.exec(
            select(AgentTaskScheduleDB).where(
                AgentTaskScheduleDB.project == project.id,
                _as_column(AgentTaskScheduleDB.executor_pool_id).is_(None),
            )
        ).all()
        for schedule in schedules:
            schedule.executor_pool_id = pool.id
            schedule.queue_ttl_seconds = pool.queue_ttl_seconds
            if schedule.disabled_reason == "executor_pool_required":
                schedule.disabled_reason = None
            session.add(schedule)
        if schedules:
            session.commit()


def _active_installation_executor(session: Session) -> ExecutorDB | None:
    return session.exec(
        select(ExecutorDB).where(
            ExecutorDB.scope_kind == "installation",
            _as_column(ExecutorDB.enabled).is_(True),
            _as_column(ExecutorDB.revoked_at).is_(None),
        )
    ).first()


def _has_live_bootstrap_token(session: Session, path: Path) -> bool:
    try:
        raw_token = path.read_text(encoding="utf-8").strip()
    except (FileNotFoundError, OSError):
        return False
    row = resolve_enrollment_token(session, raw_token)
    if row is None:
        return False
    now = datetime.now(timezone.utc)
    return (
        row.scope_kind == "installation"
        and row.project is None
        and row.executor_pool_id is None
        and row.used_at is None
        and row.revoked_at is None
        and row.expires_at > now
    )


def _atomic_write_secret(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            _ = handle.write(value + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


__all__ = [
    "BUNDLED_POOL_NAME",
    "BUNDLED_POOL_SLUG",
    "DEFAULT_BOOTSTRAP_TOKEN_FILE",
    "bootstrap_bundled_executor",
    "bundled_executor_enabled",
    "ensure_bundled_pool",
]
