# pyright: reportAny=false, reportArgumentType=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportExplicitAny=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedVariable=false

"""Prove no production module references removed execution symbols.

The old Control-Plane subprocess runner was deleted. This test searches the
production codebase and fails if any module imports or calls the removed
symbols, ensuring the cutover is complete and no dead reference survives a
future refactor.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1] / "apo"

_REMOVED_SYMBOLS = [
    "start_batch_run_execution",
    "_run_task_subprocess",
    "_run_batch_in_background",
    "_execute_task_run",
    "recover_stuck_runs",
    "_batch_pool",
    "_batch_pool_executor",
    "_batch_pool_lock",
    "_mark_batch_as_error",
    "TASK_SUBPROCESS_TIMEOUT_SECONDS",
    "_build_task_subprocess_env",
    "_detect_task_workspace_dir",
    "ThreadPoolExecutor",
]


def _scan_production_code() -> list[tuple[str, int, str]]:
    """Scan apo/ for CODE references to removed execution symbols.

    Skips comments, docstrings, and the legitimate ThreadPoolExecutor usage in
    runtime_config (which runs an async readiness check, not batch execution).
    """
    hits: list[tuple[str, int, str]] = []
    code_symbols = [s for s in _REMOVED_SYMBOLS if s != "ThreadPoolExecutor"]
    pattern = re.compile(r"\b(" + "|".join(_REMOVED_SYMBOLS) + r")\b")
    for py_file in _BACKEND.rglob("*.py"):
        rel = py_file.relative_to(_BACKEND)
        rel_str = str(rel)
        for lineno, line in enumerate(py_file.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            # Skip comments and docstring fragments.
            if stripped.startswith("#") or '"""' in stripped or "'''" in stripped:
                continue
            # ThreadPoolExecutor is legitimate in runtime_config (async check).
            if "ThreadPoolExecutor" in line and "runtime_config" in rel_str:
                continue
            match = pattern.search(line)
            if match:
                hits.append((rel_str, lineno, stripped))
    return hits


def test_no_production_module_references_removed_execution_symbols() -> None:
    """No production module under apo/ may import or call removed symbols."""
    hits = _scan_production_code()
    if hits:
        detail = "\n".join(f"  {f}:{n}: {line}" for f, n, line in hits)
        pytest.fail(f"Found references to removed execution symbols:\n{detail}")
