# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false
"""SPEC-142: Execution Bundle create / verify / extract.

Covers acceptance tests #2 (deterministic bundles), #5 (traversal extraction
rejection), #6 (limits), and the bundle round-trip consumed by SPEC-144.
"""

from __future__ import annotations

import gzip
import io
import os
import tarfile
from pathlib import Path

import pytest

from apo.execution.execution_bundle import (
    DEFAULT_BUNDLE_LIMITS,
    BundleEntry,
    BundleError,
    BundleLimits,
    extract_verified_bundle,
    manifest_from_json,
    manifest_to_json,
    verify_bundle_file,
    write_bundle,
)
from apo.execution.task_revision_manifest import ManifestFileInput, build_manifest


def _entry(path: str, content: bytes, *, executable: bool = False) -> BundleEntry:
    return BundleEntry(
        path=path,
        mode_class="executable" if executable else "regular",
        content=content,
    )


def _manifest_inputs(entries: list[BundleEntry]) -> list[ManifestFileInput]:
    return [
        ManifestFileInput(path=e.path, mode_class=e.mode_class, content=e.content)
        for e in entries
    ]


def _build(tmp_path: Path, entries: list[BundleEntry]) -> tuple[Path, int, str]:
    import hashlib

    out = tmp_path / "bundle.tar.gz"
    size, sha = write_bundle(entries, out)
    assert out.exists()
    assert size == out.stat().st_size
    assert sha == hashlib.sha256(out.read_bytes()).hexdigest()
    return out, size, sha


# ── manifest serialization ────────────────────────────────────────────────


def test_manifest_round_trips_through_json() -> None:
    manifest = build_manifest(
        _manifest_inputs([_entry("a.txt", b"hi"), _entry("b/run.sh", b"echo", executable=True)])
    )
    serialized = manifest_to_json(manifest)
    restored = manifest_from_json(serialized)
    assert restored == manifest


# ── determinism (acceptance #2) ───────────────────────────────────────────


def test_bundle_is_deterministic_regardless_of_entry_order(tmp_path: Path) -> None:
    entries_a = [_entry("a.txt", b"aaa"), _entry("z.txt", b"zzz"), _entry("m/run.sh", b"x", executable=True)]
    entries_b = list(reversed(entries_a))
    out_a = tmp_path / "a.tar.gz"
    out_b = tmp_path / "b.tar.gz"
    _, sha_a = write_bundle(entries_a, out_a)
    _, sha_b = write_bundle(entries_b, out_b)
    assert sha_a == sha_b
    assert out_a.read_bytes() == out_b.read_bytes()


def test_bundle_digest_changes_with_content(tmp_path: Path) -> None:
    _, sha1 = write_bundle([_entry("a.txt", b"aaa")], tmp_path / "1.tar.gz")
    _, sha2 = write_bundle([_entry("a.txt", b"aab")], tmp_path / "2.tar.gz")
    assert sha1 != sha2


# ── structure ──────────────────────────────────────────────────────────────


def test_bundle_has_manifest_at_root_and_files_under_workspace(tmp_path: Path) -> None:
    out, _, _ = _build(tmp_path, [_entry("src/main.ts", b"export {}\n"), _entry("run.sh", b"echo", executable=True)])
    with gzip.open(out, "rb") as gz:
        with tarfile.open(fileobj=gz, mode="r|") as tar:
            names = tar.getnames()
    assert names[0] == "manifest.json"
    assert set(names[1:]) == {"workspace/src/main.ts", "workspace/run.sh"}


def test_bundle_modes_are_deterministic_from_modeclass(tmp_path: Path) -> None:
    out, _, _ = _build(tmp_path, [_entry("reg.txt", b"x"), _entry("exe.sh", b"y", executable=True)])
    with gzip.open(out, "rb") as gz:
        with tarfile.open(fileobj=gz, mode="r|") as tar:
            modes = {m.name: m.mode for m in tar.getmembers() if m.name.startswith("workspace/")}
    assert modes["workspace/reg.txt"] == 0o644
    assert modes["workspace/exe.sh"] == 0o755


def test_bundle_tar_metadata_is_fixed(tmp_path: Path) -> None:
    out, _, _ = _build(tmp_path, [_entry("a.txt", b"x")])
    with gzip.open(out, "rb") as gz:
        with tarfile.open(fileobj=gz, mode="r|") as tar:
            for m in tar.getmembers():
                assert m.mtime == 0
                assert m.uid == 0
                assert m.gid == 0
                assert m.uname == ""
                assert m.gname == ""


# ── verify + extract round-trip ────────────────────────────────────────────


def test_verify_and_extract_round_trip(tmp_path: Path) -> None:
    entries = [_entry("README.md", b"hi\n"), _entry("src/run.sh", b"echo hi\n", executable=True)]
    out, size, sha = _build(tmp_path, entries)
    verified = verify_bundle_file(out, expected_bundle_sha256=sha)
    assert verified.bundle_size_bytes == size
    assert verified.bundle_sha256 == sha
    assert verified.manifest.summary.file_count == 2
    assert verified.manifest.summary.uncompressed_size_bytes == len(b"hi\n") + len(b"echo hi\n")

    dest = tmp_path / "extracted"
    extract_verified_bundle(verified, dest)
    assert (dest / "README.md").read_bytes() == b"hi\n"
    extracted_exe = dest / "src/run.sh"
    assert extracted_exe.read_bytes() == b"echo hi\n"
    assert os.access(extracted_exe, os.X_OK)


def test_verify_rejects_bundle_digest_mismatch(tmp_path: Path) -> None:
    out, _, _ = _build(tmp_path, [_entry("a.txt", b"x")])
    with pytest.raises(BundleError):
        verify_bundle_file(out, expected_bundle_sha256="0" * 64)


# ── verify rejection: malicious archive structure ─────────────────────────


def _write_raw_tar_gz(path: Path, members: list[tuple[str, bytes, int]]) -> bytes:
    """Build an arbitrary deterministic tar.gz with the given (name, bytes, mode)."""
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as tar:
            for name, data, mode in members:
                info = tarfile.TarInfo(name=name)
                info.size = len(data)
                info.mtime = 0
                info.mode = mode
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.type = tarfile.REGTYPE
                tar.addfile(info, io.BytesIO(data))
    data = buf.getvalue()
    path.write_bytes(data)
    return data


def test_verify_rejects_absolute_path(tmp_path: Path) -> None:
    out = tmp_path / "mal.tar.gz"
    raw = _write_raw_tar_gz(out, [("workspace/a.txt", b"x", 0o644), ("/etc/evil", b"pwn", 0o644)])
    import hashlib

    with pytest.raises(BundleError):
        verify_bundle_file(out, expected_bundle_sha256=hashlib.sha256(raw).hexdigest())


def test_verify_rejects_parent_traversal(tmp_path: Path) -> None:
    out = tmp_path / "mal.tar.gz"
    raw = _write_raw_tar_gz(out, [("workspace/../escape.txt", b"x", 0o644)])
    import hashlib

    with pytest.raises(BundleError):
        verify_bundle_file(out, expected_bundle_sha256=hashlib.sha256(raw).hexdigest())


def test_verify_rejects_entries_outside_workspace(tmp_path: Path) -> None:
    out = tmp_path / "mal.tar.gz"
    raw = _write_raw_tar_gz(out, [("workspace/a.txt", b"x", 0o644), ("secret.txt", b"x", 0o644)])
    import hashlib

    with pytest.raises(BundleError):
        verify_bundle_file(out, expected_bundle_sha256=hashlib.sha256(raw).hexdigest())


def test_verify_rejects_link_entries(tmp_path: Path) -> None:
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as tar:
            info = tarfile.TarInfo(name="workspace/link.txt")
            info.type = tarfile.SYMTYPE
            info.linkname = "../../etc/passwd"
            info.mtime = 0
            tar.addfile(info)
    data = buf.getvalue()
    out = tmp_path / "mal.tar.gz"
    out.write_bytes(data)
    import hashlib

    with pytest.raises(BundleError):
        verify_bundle_file(out, expected_bundle_sha256=hashlib.sha256(data).hexdigest())


def test_verify_rejects_duplicate_normalized_paths(tmp_path: Path) -> None:
    out = tmp_path / "mal.tar.gz"
    raw = _write_raw_tar_gz(
        out,
        [("workspace/a.txt", b"x", 0o644), ("workspace/./a.txt", b"y", 0o644)],
    )
    import hashlib

    with pytest.raises(BundleError):
        verify_bundle_file(out, expected_bundle_sha256=hashlib.sha256(raw).hexdigest())


def test_verify_rejects_content_digest_mismatch(tmp_path: Path) -> None:
    # Build a real bundle, then corrupt one file's bytes in the archive while
    # keeping the manifest's claimed sha256 — verifier must catch it.
    entries = [_entry("a.txt", b"original")]
    manifest = build_manifest(_manifest_inputs(entries))
    manifest_json = manifest_to_json(manifest).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as tar:
            mi = tarfile.TarInfo(name="manifest.json")
            mi.size = len(manifest_json)
            mi.mtime = 0
            mi.mode = 0o644
            mi.uid = mi.gid = 0
            mi.uname = mi.gname = ""
            tar.addfile(mi, io.BytesIO(manifest_json))
            fi = tarfile.TarInfo(name="workspace/a.txt")
            tampered = b"TAMPERED"  # != "original"
            fi.size = len(tampered)
            fi.mtime = 0
            fi.mode = 0o644
            fi.uid = fi.gid = 0
            fi.uname = fi.gname = ""
            tar.addfile(fi, io.BytesIO(tampered))
    data = buf.getvalue()
    out = tmp_path / "bad.tar.gz"
    out.write_bytes(data)
    import hashlib

    with pytest.raises(BundleError):
        verify_bundle_file(out, expected_bundle_sha256=hashlib.sha256(data).hexdigest())


# ── extraction safety ──────────────────────────────────────────────────────


def test_extract_refuses_non_empty_destination(tmp_path: Path) -> None:
    out, _, sha = _build(tmp_path, [_entry("a.txt", b"x")])
    verified = verify_bundle_file(out, expected_bundle_sha256=sha)
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "stale.txt").write_text("preexisting")
    with pytest.raises(BundleError):
        extract_verified_bundle(verified, dest)


# ── limits (acceptance #6) ────────────────────────────────────────────────


def test_limit_rejects_too_many_files(tmp_path: Path) -> None:
    limits = BundleLimits(max_file_count=2)
    with pytest.raises(BundleError):
        write_bundle([_entry("a", b""), _entry("b", b""), _entry("c", b"")], tmp_path / "x.tar.gz", limits=limits)


def test_limit_rejects_file_too_large(tmp_path: Path) -> None:
    limits = BundleLimits(max_file_bytes=4)
    with pytest.raises(BundleError):
        write_bundle([_entry("big", b"xxxxxx")], tmp_path / "x.tar.gz", limits=limits)


def test_limit_rejects_total_too_large(tmp_path: Path) -> None:
    limits = BundleLimits(max_total_uncompressed_bytes=8)
    with pytest.raises(BundleError):
        write_bundle([_entry("a", b"xxxxx"), _entry("b", b"xxxxx")], tmp_path / "x.tar.gz", limits=limits)


def test_limit_rejects_path_segment_too_long(tmp_path: Path) -> None:
    limits = BundleLimits(max_path_segment_bytes=4)
    with pytest.raises(BundleError):
        write_bundle([_entry("aaaaaaaa.txt", b"")], tmp_path / "x.tar.gz", limits=limits)


def test_limit_rejects_oversized_compressed_bundle(tmp_path: Path) -> None:
    # Compressed-size cap enforced after writing.
    limits = BundleLimits(max_compressed_bytes=1)
    with pytest.raises(BundleError):
        write_bundle([_entry("a", b"x" * 1000)], tmp_path / "x.tar.gz", limits=limits)


def test_default_limits_match_spec_constants() -> None:
    d = DEFAULT_BUNDLE_LIMITS
    assert d.max_file_count == 50_000
    assert d.max_total_uncompressed_bytes == 256 * 1024 * 1024
    assert d.max_file_bytes == 64 * 1024 * 1024
    assert d.max_compressed_bytes == 128 * 1024 * 1024
    assert d.max_path_segment_bytes == 256
    assert d.max_path_bytes == 4_096
    assert d.max_manifest_summary_bytes == 256 * 1024
