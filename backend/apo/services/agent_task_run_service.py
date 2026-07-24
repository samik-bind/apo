"""SPEC-143: shared Task Run finalization boundary.

The spec extracts the shared Task-result finalization from
``agent_task_runner`` so the old subprocess path and the new executor protocol
call the SAME function until SPEC-146 deletes the old path. This module is that
boundary: it re-exports the existing finalizers so callers depend on a stable
name regardless of where the implementation currently lives. When the body is
physically moved here later, these re-exports keep every caller working.
"""

from __future__ import annotations

from apo.services.agent_task_runner import (  # noqa: F401  (re-exported boundary)
    finalize_task_run_with_result,
    update_batch_run_status,
)

__all__ = ["finalize_task_run_with_result", "update_batch_run_status"]
