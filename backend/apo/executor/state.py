"""SPEC-144: persisted Executor identity (supervisor-owned, 0600).

The credential is returned once at enrollment and never printed or logged.
State is written atomically (temp file + fsync + rename) with supervisor-only
``0600`` permissions so a dropped-privilege Task user cannot read it. Loss of
state requires explicit bundled credential rotation.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Literal, cast

from pydantic import BaseModel


class StateError(ValueError):
    """Raised when persisted state is corrupt or unreadable."""


class ExecutorState(BaseModel):
    schema_version: Literal[1] = 1
    executor_id: str
    executor_credential: str
    control_plane_url: str


def save_state(path: Path, state: ExecutorState) -> None:
    """Atomically persist state with 0600 permissions (parent dir created)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = state.model_dump_json().encode("utf-8")
    # Temp file in the same directory for atomic rename; restrictive perms.
    fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            _ = fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_state(path: Path) -> ExecutorState | None:
    """Load state if present; None if absent; raise on corrupt state."""
    if not path.exists():
        return None
    try:
        data = cast(object, json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        raise StateError(f"corrupt executor state at {path}") from exc
    try:
        return ExecutorState.model_validate(data)
    except Exception as exc:
        raise StateError(f"invalid executor state at {path}") from exc


__all__ = ["ExecutorState", "StateError", "load_state", "save_state"]
