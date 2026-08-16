# pyright: reportAny=false, reportArgumentType=false, reportCallIssue=false, reportDeprecated=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportPrivateUsage=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedParameter=false

"""Deliverable service placement and manifests.

Centralizes JSON validation, compact serialization, inline-vs-object placement,
and manifest construction so list/detail routes never load a body.
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, reset_apo_file_db
from apo.models.db import AgentTaskBatchRunDB, AgentTaskDeliverableDB, AgentTaskRunDB
from apo.services.agent_task_deliverables import (
    INLINE_THRESHOLD_BYTES,
    build_deliverable_manifest,
    persist_json_deliverable,
    read_json_deliverable_value,
    synthesize_legacy_manifest,
)
from apo.services.artifact_stores.local import LocalArtifactStore


@pytest.fixture(autouse=True)
def setup_database(tmp_path):
    reset_apo_file_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM agent_task_deliverables"))
        session.execute(text("DELETE FROM agent_task_runs"))
        session.execute(text("DELETE FROM agent_task_batch_runs"))
        session.commit()


@pytest.fixture
def store(tmp_path) -> LocalArtifactStore:
    s = LocalArtifactStore(root=tmp_path / "store")
    asyncio.run(s.check_ready())
    return s


def _seed_run(session: Session, run_id: str = "run-1", project: str = "p1") -> None:
    session.add(
        AgentTaskBatchRunDB(
            id=f"batch-{run_id}", project=project, selection_type="manual", status="completed"
        )
    )
    session.add(
        AgentTaskRunDB(
            id=run_id, batch_run_id=f"batch-{run_id}", task_id="t", task_path="p", status="running"
        )
    )
    session.flush()


def _compact(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


pytestmark = pytest.mark.asyncio


class TestJsonDeliverablePlacement:
    async def test_small_json_is_inline(self, store: LocalArtifactStore):
        value = {"benchmark": "terminal-bench", "reward": 1}
        with Session(engine) as session:
            _seed_run(session)
            row = await persist_json_deliverable(
                session, project="p1", task_run_id="run-1", name="verdict", value=value, store=store
            )
            session.commit()
            session.refresh(row)

            assert row.kind == "json"
            assert row.status == "ready"
            assert row.storage_backend is None
            assert row.storage_key is None
            assert row.inline_value_json == {"value": value}
            body = _compact(value)
            assert row.size_bytes == len(body)
            assert row.sha256 == _sha(body)
            assert row.media_type == "application/json"
            assert row.content_encoding == "identity"
            assert row.stored_size_bytes == len(body)

    async def test_inline_boundary_exactly_threshold_is_inline(
        self, store: LocalArtifactStore
    ):
        """A value whose compact form is at/under 64 KiB is inline."""
        assert INLINE_THRESHOLD_BYTES == 64 * 1024
        payload = "a" * (INLINE_THRESHOLD_BYTES - 12)
        with Session(engine) as session:
            _seed_run(session)
            row = await persist_json_deliverable(
                session, project="p1", task_run_id="run-1", name="s", value=payload, store=store
            )
            session.commit()
            session.refresh(row)
            assert row.storage_backend is None
            assert row.inline_value_json == {"value": payload}

    async def test_large_json_is_object_backed(self, store: LocalArtifactStore):
        value = {"big": "x" * (INLINE_THRESHOLD_BYTES + 2048)}
        with Session(engine) as session:
            _seed_run(session)
            row = await persist_json_deliverable(
                session, project="p1", task_run_id="run-1", name="big", value=value, store=store
            )
            session.commit()
            session.refresh(row)

            assert row.kind == "json"
            assert row.storage_backend == "local"
            assert row.storage_key is not None
            assert row.inline_value_json is None
            assert row.media_type == "application/json"
            assert row.content_encoding == "gzip"
            body = _compact(value)
            assert row.size_bytes == len(body)
            assert row.sha256 == _sha(body)
            # The stored object is gzip-compressed.
            raw = b"".join([c async for c in store.open(row.storage_key)])
            assert gzip.decompress(raw) == body

    async def test_large_json_round_trips_through_read(self, store: LocalArtifactStore):
        value = ["line", "x" * (INLINE_THRESHOLD_BYTES + 1024), {"k": 1}]
        with Session(engine) as session:
            _seed_run(session)
            row = await persist_json_deliverable(
                session, project="p1", task_run_id="run-1", name="arr", value=value, store=store
            )
            session.commit()
            fetched = await read_json_deliverable_value(session, row.id, store=store)
        assert fetched == value

    async def test_inline_json_round_trips_through_read(self, store: LocalArtifactStore):
        with Session(engine) as session:
            _seed_run(session)
            row = await persist_json_deliverable(
                session, project="p1", task_run_id="run-1", name="n", value=None, store=store
            )
            session.commit()
            assert await read_json_deliverable_value(session, row.id, store=store) is None

    @pytest.mark.parametrize(
        "value",
        [
            None,
            True,
            False,
            42,
            3.14,
            "hello",
            "unicode café ☃ 🚀",
            [1, "two", None, True],
            {"a": 1, "b": [2, 3], "c": {"nested": True}},
            [],
            {},
            0,
            "",
        ],
    )
    async def test_top_level_primitives_round_trip(
        self, store: LocalArtifactStore, value: object
    ):
        with Session(engine) as session:
            _seed_run(session)
            row = await persist_json_deliverable(
                session,
                project="p1",
                task_run_id="run-1",
                name=f"v-{abs(hash(repr(value))) % 100000}",
                value=value,
                store=store,
            )
            session.commit()
            fetched = await read_json_deliverable_value(session, row.id, store=store)
        assert fetched == value


class TestManifest:
    async def test_manifest_is_metadata_only(self, store: LocalArtifactStore):
        with Session(engine) as session:
            _seed_run(session)
            await persist_json_deliverable(
                session, project="p1", task_run_id="run-1", name="verdict",
                value={"reward": 1}, store=store,
            )
            session.commit()

            items = build_deliverable_manifest(session, "run-1")
        assert len(items) == 1
        item = items[0]
        assert item.name == "verdict"
        assert item.kind == "json"
        assert item.status == "ready"
        assert item.media_type == "application/json"
        assert item.size_bytes > 0
        assert len(item.sha256) == 64
        # download_url shape is opaque; populated for ready rows.
        assert item.download_url is not None
        assert "run-1" in item.download_url

    async def test_manifest_excludes_bodies_and_storage_keys(
        self, store: LocalArtifactStore
    ):
        big = "x" * (INLINE_THRESHOLD_BYTES + 1024)
        with Session(engine) as session:
            _seed_run(session)
            await persist_json_deliverable(
                session, project="p1", task_run_id="run-1", name="big", value=big, store=store
            )
            session.commit()

            items = build_deliverable_manifest(session, "run-1")
            item = items[0]
        # The summary schema never carries storage internals.
        dumped = json.dumps(item.model_dump())
        assert "storage_key" not in dumped
        assert "storage_backend" not in dumped
        assert "inline_value_json" not in dumped

    async def test_legacy_manifest_synthesis_from_deliverables_json(self):
        legacy = {
            "verdict": {"reward": 1},
            "log": "x" * 100,
        }
        items = synthesize_legacy_manifest(legacy)
        names = {i.name for i in items}
        assert names == {"verdict", "log"}
        for item in items:
            assert item.kind == "json"
            assert item.status == "ready"

    def test_legacy_manifest_handles_empty_and_invalid(self):
        assert synthesize_legacy_manifest(None) == []
        assert synthesize_legacy_manifest({}) == []
        assert synthesize_legacy_manifest("not a dict") == []

