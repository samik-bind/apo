"""Bundled Executor provider bootstrap.

Creates the provider-owned Bundled Pool for writable Projects and hands a
single installation-scoped enrollment token to the separate Executor process
through a restrictive, atomic bootstrap file. The long-lived Executor
credential is never written by the Control Plane.
"""

# pyright: reportImplicitStringConcatenation=false, reportPrivateUsage=false

from __future__ import annotations

import logging
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

logger = logging.getLogger(__name__)

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
        # An installation executor is already enrolled — the on-disk token file
        # is only a bootstrap convenience, not authoritative. Best-effort delete
        # so a root-owned leftover (or a read-only fs) can't block startup.
        _try_unlink(path)
        return
    if _has_live_bootstrap_token(session, path):
        return
    _try_unlink(path)
    raw_token, row = generate_enrollment_token(
        session,
        scope_kind="installation",
        project_id=None,
        pool_id=None,
    )
    try:
        _atomic_write_secret(path, raw_token)
    except OSError as exc:
        # The token file is a bootstrap convenience for the bundled executor
        # (the enrollment row in the DB is authoritative). A write failure —
        # e.g. a read-only or permission-restricted volume — must not prevent
        # the backend from starting. Revoke the row so it can't be reused, but
        # surface an ERROR (not a warning): the bundled executor cannot enroll
        # until the path is writable, which manifests upstream as a permanent
        # restart loop that's easy to miss when this is only a WARNING.
        # See issue #38: a root-owned named volume is the common cause.
        row.revoked_at = datetime.now(timezone.utc)
        session.add(row)
        session.commit()
        logger.error(
            "Bundled executor is enabled but the bootstrap token file could not be written to %s (%s). "
            "The bundled executor will restart-loop until the path is writable by the backend process. "
            "Fix: ensure the directory exists and is owned by the backend user (uid 1000). "
            "For existing stacks with a root-owned volume, run "
            "`docker compose run --rm --user 0:0 backend chown -R 1000:1000 /var/lib/apo/executor-bootstrap` "
            "or remove the apo_executor_bootstrap volume and recreate the stack.",
            path,
            exc,
        )


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
    # chmod is defense-in-depth (restrict the secret dir to the owner). Some
    # container storage drivers reject chmod for non-root even on owned files
    # (EPERM); a permissions hardening must not prevent startup, so log and
    # continue — the file is still written atomically with 0o600 at create.
    _try_chmod(path.parent, 0o700)
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
        _try_chmod(path, 0o600)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _try_chmod(path: Path, mode: int) -> None:
    """Best-effort chmod: warn (not raise) on filesystems that reject it."""
    try:
        path.chmod(mode)
    except OSError as exc:
        logger.warning(
            "Could not chmod %s to 0o%o (%s); the file is still written. "
            "This is expected on some container storage drivers.",
            path,
            mode,
            exc,
        )


def _try_unlink(path: Path) -> None:
    """Best-effort unlink: the enrollment DB row is authoritative, not the file."""
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning(
            "Could not remove bootstrap token file %s (%s); continuing. "
            "The enrollment state is tracked in the database.",
            path,
            exc,
        )


__all__ = [
    "BUNDLED_POOL_NAME",
    "BUNDLED_POOL_SLUG",
    "DEFAULT_BOOTSTRAP_TOKEN_FILE",
    "bootstrap_bundled_executor",
    "bundled_executor_enabled",
    "ensure_bundled_pool",
]
