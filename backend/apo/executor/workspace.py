"""SPEC-144: per-Attempt workspace + result-path management.

Each Attempt runs in an isolated, fresh workspace under the configured
workspace root. The result file lives at ``<workspace>/.apo-result/result.json``
with its parent created (and writable by the Task user) by the Executor before
launch. Workspaces are removed in a ``finally`` on every exit path.
"""

from __future__ import annotations

import os
import pwd
import shutil
import tempfile
from pathlib import Path

RESULT_REL_PATH = ".apo-result/result.json"


def make_workspace(root: Path, attempt_id: str) -> Path:
    """Create a fresh per-Attempt workspace directory under ``root``."""
    root.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix=f"attempt-{attempt_id}-", dir=str(root)))
    return workspace


def result_path(workspace: Path) -> Path:
    """The result-file path; its parent is created and writable by the Task user."""
    path = workspace / RESULT_REL_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def prepare_workspace_for_user(workspace: Path, task_user: str | None) -> None:
    """Make an extracted workspace private to the configured Task user.

    The supervisor remains root so it can clean up afterward, while customer
    code runs under a uid that cannot read the supervisor's state or process
    environment. Native same-user development leaves ownership unchanged.
    """
    if task_user is None:
        return
    try:
        account = pwd.getpwnam(task_user)
    except KeyError as exc:
        raise ValueError(f"configured task user does not exist: {task_user!r}") from exc

    for root, directories, files in os.walk(workspace):
        root_path = Path(root)
        os.chown(root_path, account.pw_uid, account.pw_gid)
        for name in directories:
            os.chown(root_path / name, account.pw_uid, account.pw_gid)
        for name in files:
            os.chown(root_path / name, account.pw_uid, account.pw_gid)
    workspace.chmod(0o700)


def cleanup_workspace(workspace: Path) -> None:
    """Best-effort remove a workspace, ignoring errors (used in ``finally``)."""
    shutil.rmtree(workspace, ignore_errors=True)


__all__ = [
    "RESULT_REL_PATH",
    "cleanup_workspace",
    "make_workspace",
    "prepare_workspace_for_user",
    "result_path",
]
