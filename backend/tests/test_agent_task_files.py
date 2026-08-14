# pyright: reportAny=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnusedCallResult=false

"""Unit tests for the project-scoped task-file listing/reading helpers.

The legacy unscoped ``/v1/agent-tasks/{id}/files`` routes were removed
(SPEC-178 cleanup); these tests pin the behavior of the helpers the
canonical ``/v1/projects/{pid}/agent-tasks/{id}/files`` routes share.
"""

import os
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from apo.routes.agent_task_files import (
    _build_file_list_response,
    _read_file_response,
)


def _create_task_folder(root: str, task_id: str) -> Path:
    task_dir = Path(root) / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / f"{task_id}.eval.ts").write_text(
        'import { task } from "@apo-ai/sdk/agent-task";\ntask("t", { adapter: "a" });'
    )
    return task_dir


def test_list_files_returns_all_task_files_sorted_dirs_first() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "my-task")
        (task_dir / "checks.ts").write_text("export function check() {}")
        (task_dir / "files").mkdir()
        (task_dir / "files" / "instructions.md").write_text("# Instructions")

        response = _build_file_list_response("my-task", task_dir, str(task_dir))

        paths = [entry.path for entry in response.files]
        assert "my-task.eval.ts" in paths
        assert "checks.ts" in paths
        assert "files/instructions.md" in paths
        # directories sort before files
        types = [entry.type for entry in response.files]
        assert types.index("directory") < types.index("file")


def test_list_files_skips_hidden_and_ignored() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "hidden-task")
        (task_dir / ".hidden").write_text("hidden")
        (task_dir / "node_modules").mkdir()
        (task_dir / "__pycache__").mkdir()

        response = _build_file_list_response("hidden-task", task_dir, str(task_dir))

        paths = [entry.path for entry in response.files]
        assert ".hidden" not in paths
        assert "node_modules" not in paths
        assert "__pycache__" not in paths


def test_read_file_returns_content_and_metadata() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "read-task")
        (task_dir / "checks.ts").write_text("export function check() { return true; }\n")

        response = _read_file_response(task_dir, "checks.ts")

        assert response.name == "checks.ts"
        assert response.language == "typescript"
        assert "export function check" in response.content
        assert response.lines >= 1
        assert response.size_bytes > 0


def test_read_file_language_detection() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "lang-task")
        cases = {
            "script.py": ("def hello():\n    pass\n", "python"),
            "data.json": ('{"key": "value"}\n', "json"),
            "notes.txt": ("some notes\n", "text"),
            "changes.diff": ("--- a/file\n+++ b/file\n+added\n", "diff"),
        }
        for filename, (content, expected_lang) in cases.items():
            (task_dir / filename).write_text(content)
            assert _read_file_response(task_dir, filename).language == expected_lang


def test_read_file_with_unicode_content() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "unicode-task")
        (task_dir / "unicode.ts").write_text('// Hello 世界 🌍\n')

        response = _read_file_response(task_dir, "unicode.ts")

        assert "世界" in response.content


def test_read_file_path_traversal_via_symlink_blocked() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "safe-task")
        outside_dir = Path(tmp) / "outside"
        outside_dir.mkdir()
        (outside_dir / "secret.txt").write_text("secret data")
        os.symlink(outside_dir, task_dir / "escape")

        with pytest.raises(HTTPException) as exc:
            _read_file_response(task_dir, "escape/secret.txt")
        assert exc.value.status_code == 403  # pyright: ignore[reportAttributeAccessIssue]


def test_read_file_sibling_directory_prefix_blocked() -> None:
    """A directory whose name extends the task dir's name must not pass a
    string-prefix containment check (pinned to ``Path.is_relative_to``)."""
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "safe-task")
        sibling_dir = Path(tmp) / "safe-task-secret"
        sibling_dir.mkdir()
        (sibling_dir / "secret.txt").write_text("secret data")

        with pytest.raises(HTTPException) as exc:
            _read_file_response(task_dir, "../safe-task-secret/secret.txt")
        assert exc.value.status_code == 403  # pyright: ignore[reportAttributeAccessIssue]


def test_read_file_nonexistent_returns_404() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "exist-task")

        with pytest.raises(HTTPException) as exc:
            _read_file_response(task_dir, "nonexistent.ts")
        assert exc.value.status_code == 404  # pyright: ignore[reportAttributeAccessIssue]


def test_read_file_directory_returns_400() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "dir-task")
        (task_dir / "files").mkdir()

        with pytest.raises(HTTPException) as exc:
            _read_file_response(task_dir, "files")
        assert exc.value.status_code == 400  # pyright: ignore[reportAttributeAccessIssue]


def test_read_file_size_limit() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "big-task")
        (task_dir / "big.txt").write_text("x" * 1_000_001)

        with pytest.raises(HTTPException) as exc:
            _read_file_response(task_dir, "big.txt")
        assert exc.value.status_code == 413  # pyright: ignore[reportAttributeAccessIssue]
