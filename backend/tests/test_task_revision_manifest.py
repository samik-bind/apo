# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false
"""SPEC-142: Task Revision manifest canonicalizer — Python parity corpus.

Each fixture under ``contracts/task-revision/v1/cases/`` carries inputs and an
``expected.contentSha256`` derived independently from the canonical algorithm.
The Python canonicalizer MUST reproduce the exact digest and summary for every
case, byte-for-byte with its TypeScript twin in @apo/sdk.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import pytest

from apo.execution.task_revision_manifest import (
    ManifestFileInput,
    ModeClass,
    build_manifest,
    canonical_manifest_json,
    content_sha256,
)

_CASES_DIR = Path(__file__).parents[2] / "contracts" / "task-revision" / "v1" / "cases"


def _load_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for path in sorted(_CASES_DIR.glob("*.json")):
        cases.append(json.loads(path.read_text(encoding="utf-8")))
    return cases


def _decode_content(c: dict[str, Any]) -> bytes:
    if "contentHex" in c:
        return bytes.fromhex(c["contentHex"])
    return str(c.get("contentText", "")).encode("utf-8")


_ALLOWED_MODES = {"regular", "executable"}


def _to_inputs(case: dict[str, Any]) -> list[ManifestFileInput]:
    inputs: list[ManifestFileInput] = []
    for f in case["files"]:
        mode = str(f["modeClass"])
        assert mode in _ALLOWED_MODES, f"unknown modeClass: {mode!r}"
        inputs.append(
            ManifestFileInput(
                path=str(f["path"]),
                mode_class=cast(ModeClass, mode),
                content=_decode_content(f),
            )
        )
    return inputs


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: str(c["name"]))
def test_case_reproduces_canonical_digest(case: dict[str, Any]) -> None:
    expected = case["expected"]
    manifest = build_manifest(_to_inputs(case))
    assert manifest.schema_version == 1
    assert manifest.summary.file_count == expected["fileCount"]
    assert manifest.summary.uncompressed_size_bytes == expected["uncompressedSizeBytes"]
    assert content_sha256(manifest) == expected["contentSha256"]


def test_files_sorted_by_bytewise_utf8_of_normalized_path() -> None:
    manifest = build_manifest(
        [
            ManifestFileInput(path="apple.txt", mode_class="regular", content=b"a\n"),
            ManifestFileInput(path="Zebra.txt", mode_class="regular", content=b"z\n"),
            ManifestFileInput(path="éclair.txt", mode_class="regular", content="é\n".encode("utf-8")),
        ]
    )
    assert [f.path for f in manifest.files] == ["Zebra.txt", "apple.txt", "éclair.txt"]


def test_backslash_separators_normalized_to_posix() -> None:
    manifest = build_manifest(
        [ManifestFileInput(path="src\\utils\\time.ts", mode_class="regular", content=b"")]
    )
    assert manifest.files[0].path == "src/utils/time.ts"


def test_canonical_json_is_compact_sorted_ascii_false_over_files_and_schema_only() -> None:
    manifest = build_manifest(
        [ManifestFileInput(path="README.md", mode_class="regular", content=b"hi\n")]
    )
    assert canonical_manifest_json(manifest) == (
        '{"files":[{"modeClass":"regular","path":"README.md",'
        '"sha256":"98ea6e4f216f2fb4b69fff9b3a44842c38686ca685f3f55dc48c5d3fb1107be4",'
        '"sizeBytes":3}],"schemaVersion":1}'
    )


def test_default_exclusion_counts_are_zero() -> None:
    manifest = build_manifest(
        [ManifestFileInput(path="a.txt", mode_class="regular", content=b"")]
    )
    assert manifest.summary.excluded_file_count == 0
    assert manifest.summary.excluded_directory_count == 0
