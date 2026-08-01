"""Canonical Task Revision manifest (Python twin).

Pure canonicalizer. Both this module and its TypeScript twin
(``packages/sdk/src/agent-task/task-revision-manifest.ts``) MUST produce
byte-identical canonical JSON and digests for every fixture under
``contracts/task-revision/v1/cases/``.

Canonicalization rules:
  - ``/`` path separators (caller ``\\`` normalized to ``/``);
  - Unicode NFC normalization of the path;
  - bytewise lexical ordering of normalized UTF-8 paths;
  - exact file-byte SHA-256 (lowercase hex);
  - mode reduced to ``regular`` | ``executable``;
  - ownership, timestamps, inode metadata, and absolute paths excluded.

``content_sha256`` is the SHA-256 of the compact canonical JSON built from
``schema_version`` and the sorted ``files`` array. The ``summary`` block is NOT
part of source identity.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

SCHEMA_VERSION: Literal[1] = 1

ModeClass = Literal["regular", "executable"]


@dataclass(frozen=True)
class ManifestFile:
    path: str
    size_bytes: int
    sha256: str
    mode_class: ModeClass


@dataclass(frozen=True)
class ManifestSummary:
    file_count: int
    uncompressed_size_bytes: int
    excluded_file_count: int
    excluded_directory_count: int


@dataclass(frozen=True)
class TaskRevisionManifestV1:
    schema_version: Literal[1]
    files: list[ManifestFile]
    summary: ManifestSummary


@dataclass(frozen=True)
class ManifestFileInput:
    """Caller-reported file, before canonicalization. ``content`` is the exact bytes."""

    path: str
    mode_class: ModeClass
    content: bytes


def normalize_manifest_path(path: str) -> str:
    """Normalize a caller-reported path to canonical POSIX + NFC form.

    Validation (no leading slash, no ``.``/``..`` segments) is the filesystem
    walker's responsibility; this function only makes representation canonical.
    """
    return unicodedata.normalize("NFC", path.replace("\\", "/"))


def sha256_hex(data: bytes) -> str:
    """SHA-256 of exact bytes, lowercase hex."""
    return hashlib.sha256(data).hexdigest()


def _canonical_files_payload(files: Sequence[ManifestFile]) -> list[dict[str, object]]:
    return [
        {
            "modeClass": f.mode_class,
            "path": f.path,
            "sha256": f.sha256,
            "sizeBytes": f.size_bytes,
        }
        for f in files
    ]


def build_manifest(
    files: Sequence[ManifestFileInput],
    *,
    excluded_file_count: int = 0,
    excluded_directory_count: int = 0,
) -> TaskRevisionManifestV1:
    """Build the canonical V1 manifest from already-included files."""
    entries = [
        ManifestFile(
            path=normalize_manifest_path(f.path),
            size_bytes=len(f.content),
            sha256=sha256_hex(f.content),
            mode_class=f.mode_class,
        )
        for f in files
    ]
    entries.sort(key=lambda m: m.path.encode("utf-8"))
    return TaskRevisionManifestV1(
        schema_version=SCHEMA_VERSION,
        files=entries,
        summary=ManifestSummary(
            file_count=len(entries),
            uncompressed_size_bytes=sum(f.size_bytes for f in entries),
            excluded_file_count=excluded_file_count,
            excluded_directory_count=excluded_directory_count,
        ),
    )


def canonical_manifest_json(manifest: TaskRevisionManifestV1) -> str:
    """Compact canonical JSON over ``schema_version`` + the sorted ``files`` only.

    ``sort_keys=True`` (alphabetical at every level), ``ensure_ascii=False``
    (non-ASCII emitted as UTF-8), no whitespace. Mirrors JS ``JSON.stringify``
    with alphabetically-inserted keys. The ``summary`` is excluded from identity.
    """
    payload: dict[str, object] = {
        "files": _canonical_files_payload(manifest.files),
        "schemaVersion": manifest.schema_version,
    }
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def content_sha256(manifest: TaskRevisionManifestV1) -> str:
    """SHA-256 (lowercase hex) of the canonical manifest JSON's UTF-8 bytes."""
    return sha256_hex(canonical_manifest_json(manifest).encode("utf-8"))
