"""SPEC-144: per-Attempt workspace + result-path management.

Each Attempt runs in an isolated, fresh workspace under the configured
workspace root. The result file lives at ``<workspace>/.apo-result/result.json``
with its parent created (and writable by the Task user) by the Executor before
launch. Workspaces are removed in a ``finally`` on every exit path.
"""

from __future__ import annotations

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


def cleanup_workspace(workspace: Path) -> None:
    """Best-effort remove a workspace, ignoring errors (used in ``finally``)."""
    shutil.rmtree(workspace, ignore_errors=True)


__all__ = ["RESULT_REL_PATH", "cleanup_workspace", "make_workspace", "result_path"]
